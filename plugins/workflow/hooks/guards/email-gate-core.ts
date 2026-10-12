/**
 * Shared decision logic for the outbound-email approval gate.
 *
 * The verdict is pure: no bun:sqlite, no writeMessageOut / awaitDeliveryAck, no
 * process.exit, and nothing it reads can change allow vs gate. The one I/O is a
 * read-only display read: when a send's body is `$(cat /absolute/path)`, the
 * description shows that file. It takes a bash command string or native
 * email-tool call plus an env snapshot and returns a verdict (allow | gate)
 * with a plain-text `label` + `summary` for the approver. The harness adapter
 * (Claude hook, OpenCode plugin, Codex runner) shows them in its own approval
 * surface: a native ask locally, or the session-DB `request_bash_gate`
 * primitive under NanoClaw (see runEmailGate in block-destructive-core.ts).
 *
 * Ported verbatim from nanoclaw-v2 container/agent-runner/src/providers/claude.ts
 * lines 514-664 (GWS_EMAIL_SEND_RE, EMAIL_BYPASS_RE, envelopeFromJsonRaw,
 * createEmailGateHook's parse + card-build). The I/O tail (claude.ts:666-702)
 * is intentionally NOT relocated here — it stays in the adapter.
 *
 * Gated send surfaces:
 *   1. Helper verbs:   gws gmail +send | +reply | +reply-all | +forward
 *   2. Raw API form:   gws gmail users (messages|drafts) send …
 *   3. Native connector/MCP tools whose names identify an email send, reply,
 *      or forward (for example `send_email` or `mcp__gmail__send_email`).
 * The raw form takes the same code path as the helper verbs and produces an
 * identical send — matching only (1) would let an agent reaching for the raw
 * API surface bypass the gate entirely.
 *
 * Drafts are intentionally NOT gated when only being created
 * (`gws gmail users drafts create`) — drafts never deliver until separately
 * sent. The helper-verb `--draft` flag and `--dry-run` likewise bypass.
 *
 * Out of scope (cannot be caught at this layer reliably): direct REST calls,
 * Python/Node SDK calls, SMTP CLIs, and eval/alias/base64-decoded subshells. The
 * only sound place to catch all of those is the egress proxy.
 */
import { CARD_SUMMARY_MAX_CHARS, clip, code, expandKnown, fitLines, htmlToText, quoteBlock, readDisplayFile, viewShell, type ShellView } from './gate-card-core';

// `gws gmail +send|+reply|+reply-all|+forward` (helper verbs) OR
// `gws gmail users (messages|drafts) send` (raw API form).
export const GWS_EMAIL_SEND_RE =
    /\bgws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)\b/;

// The bypass flags, matched as WHOLE argv tokens (see bypassFlagIsRealArgvToken
// below). Matching whole tokens — not a regex over the raw segment — is what
// (a) keeps `--dry-run=false` from bypassing (it's a single token `--dry-run=false`
// ≠ `--dry-run`), and (b) stops a flag-shaped substring inside quoted email
// content (`--body "… --dry-run …"`) from tripping the bypass while the mail
// still sends. `--help`/`-h` are exempt because they print the CLI manpage and
// never send — without this, every `gws gmail +send --help` exploration would
// light up an approval card.
export const EMAIL_BYPASS_FLAGS = new Set(['--dry-run', '--draft', '--help', '-h']);

// Shell metacharacters / separators that can divert a token away from the gws
// argv OR introduce a second command — redirections (< > >> << <<< 2> >& <& all
// contain < or >), pipes (|), control operators (; &), command/parameter
// expansion ($ ` ${), grouping (( ) { }), the comment introducer (#), and the
// NEWLINE command separator (\n \r). Newline is load-bearing here: the bypass
// check runs on the WHOLE command, so a `--dry-run\n<real send>` decoy must be
// caught by this set — `\s+` token-splitting would otherwise treat the newline
// as plain whitespace and see the decoy's --dry-run as a real argv token while
// bash runs the second line and sends. A bypass-flag token appearing alongside
// any of these may be a redirect operand, expansion, comment, or a different
// command entirely, so its mere textual presence can't be trusted. QA codex
// re-pass #1 (subshell) + #3 (redirection) + #4 (comment) + #5 (newline decoy).
const SHELL_METACHAR_RE = /[<>|;&$`(){}#\n\r]/;

/**
 * True only when a bypass flag (--dry-run/--draft/--help/-h) is a real OPTION of
 * a DIRECT gws invocation — not text inside quoted email content, not alongside
 * shell metacharacters, not consumed by a wrapper, and not the value of a prior
 * option.
 *
 * Step 1 — quote handling (fail-closed by construction): replace each quoted span
 * (subject/body values) in all four bash quote forms — ANSI-C `$'…'` and locale
 * `$"…"` first (so their leading `$` doesn't read as an expansion metachar), then
 * plain `'…'` and `"…"` (escape-aware for the double-quote forms) — with a single
 * NON-IFS SENTINEL char (NUL), NOT a space. Using a sentinel (not a space) keeps
 * the check faithful to bash WORD-CONCATENATION: bash joins adjacent
 * quoted+unquoted fragments into one word (`--body 'x'--dry-run` → the word
 * `x--dry-run`, no real flag, mail sends), so the replacement must keep them in
 * one token too — a space would manufacture a bogus `--dry-run` token (codex #7).
 * The sentinel survives into the token, so a token that touched quoted content can
 * never equal a bare flag.
 *
 * Step 2 — reject anything we don't model: a surviving quote (unbalanced) → no
 * bypass; an unquoted BACKSLASH (`--body \ --dry-run` joins `\ ` into the body,
 * gws gets no real flag — codex #6) → no bypass; any shell metacharacter
 * (separators / redirects / expansions / `#` / `\n`) → no bypass.
 *
 * Step 3 — bind to a DIRECT gws invocation and OPTION position. Split on bash IFS
 * (space/tab/newline — NOT JS \s, which splits form-feed/NBSP that bash keeps in
 * a word). Skip leading `VAR=value` assignments (the real form leads with
 * `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…`). The next word MUST be exactly `gws`
 * — otherwise a wrapper builtin (`exec -a --dry-run gws …`, `env`, `command`,
 * `nice`, `time`, …) could swallow the flag as argv0/its own option while gws
 * still sends (codex #8). Finally honor a bypass flag only if the token
 * immediately before it is NOT a bare value-consuming option (`-x` / `--opt`
 * without `=`) — `gws gmail +send --subject --dry-run …` would otherwise feed
 * `--dry-run` to `--subject` as its value while gws sends (codex #8). `--opt=val`
 * is self-contained, so a flag after it is honored.
 *
 * Fail-closed invariant: every step can only make the recognizer MORE reluctant
 * to bypass — it reports a bypass flag iff bash passes that exact flag to gws as a
 * standalone option. Anything outside the modeled simple-direct-gws subset gates.
 * QA codex re-pass #6 (backslash) + #7 (adjacent-quote) + #8 (wrapper / value-of-
 * option) + #9 (approve). NOTE accepted false-positives (fail-closed, gate):
 * quote-spliced flags like `--dry'-'run`, fully-quoted `'--dry-run'`, a bypass
 * flag right after a boolean option, a non-gws wrapper that doesn't actually
 * consume the flag (`command gws … --dry-run`), and an ABSOLUTE-PATH gws
 * (`/usr/bin/gws … --dry-run`) — all rare and deliberately not "fixed": matching
 * the bare `gws` word avoids a path-spoofing vector (any file named `gws`), and
 * reconstructing quoted flags would need a heavier lexer that could fail OPEN.
 */
// Non-IFS, non-flag, non-metachar placeholder for a stripped quoted span. Keeps
// bash's word-concatenation: a token that touched quoted content carries this
// char and so can never equal a bare bypass flag.
const QUOTED_SPAN_SENTINEL = '\x00';
// A leading `NAME=value` shell assignment (skipped before the command word).
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
export function bypassFlagIsRealArgvToken(gwsSegment: string): boolean {
    // Strip the NON-expanding quote forms first — single-quoted (literal) and
    // ANSI-C $'…' (C escapes, no expansion). Bash runs NO command/parameter
    // expansion inside these, so their contents are inert.
    const safeStripped = gwsSegment
        .replace(/\$'(?:[^'\\]|\\.)*'/g, QUOTED_SPAN_SENTINEL) // ANSI-C $'…' (escapes, incl. \') — no expansion
        .replace(/'[^']*'/g, QUOTED_SPAN_SENTINEL); // single-quoted (literal, no escapes)
    // EXPANDING quotes — "…" and locale $"…" — still run COMMAND SUBSTITUTION
    // ($(…) and backticks) inside them. A bypass command whose double-quoted value
    // carries one (e.g. `gws … --dry-run --body "$(gws … +send --to victim)"`)
    // would shell out a REAL send before the --dry-run/--help no-op takes effect;
    // the NUL-strip below would otherwise hide it from the metachar check. Inspect
    // each expanding span's CONTENT (capture group, so the locale `$` prefix itself
    // isn't counted) and fail closed on a `$(` or backtick. NOTE: only command
    // substitution executes — bare `$VAR`/`${VAR}`/`$5` is parameter expansion (no
    // command run), so it must NOT block a legit `--body "cost is $5"`. (codex #126 P1)
    const expandingQuoteRe = /\$?"((?:[^"\\]|\\.)*)"/g;
    for (let m = expandingQuoteRe.exec(safeStripped); m !== null; m = expandingQuoteRe.exec(safeStripped)) {
        if (m[1].includes('$(') || m[1].includes('`')) return false; // command substitution in expanding quotes → don't bypass
    }
    const unquoted = safeStripped
        .replace(/\$"(?:[^"\\]|\\.)*"/g, QUOTED_SPAN_SENTINEL) // locale $"…"
        .replace(/"(?:[^"\\]|\\.)*"/g, QUOTED_SPAN_SENTINEL); // double-quoted (escape-aware)
    if (unquoted.includes("'") || unquoted.includes('"')) return false; // unbalanced/escaped quoting → don't bypass
    if (unquoted.includes('\\')) return false; // unquoted backslash escape → don't bypass (codex #6)
    if (SHELL_METACHAR_RE.test(unquoted)) return false; // non-simple command → don't bypass
    const tokens = unquoted.split(/[ \t\n]+/).filter((t) => t.length > 0); // bash IFS, not JS \s
    let i = 0;
    while (i < tokens.length && LEADING_ASSIGNMENT_RE.test(tokens[i])) i++; // skip VAR=value
    if (tokens[i] !== 'gws') return false; // must be a DIRECT gws invocation, no wrapper (codex #8)
    for (let j = i + 1; j < tokens.length; j++) {
        if (!EMAIL_BYPASS_FLAGS.has(tokens[j])) continue;
        const prev = tokens[j - 1];
        const prevConsumesValue = prev.startsWith('-') && !prev.includes('='); // bare -x/--opt eats next word
        if (!prevConsumesValue) return true; // a real, standalone gws option
    }
    return false;
}

// A deliberately narrow exception for the normal CLI-help probe an agent uses
// to learn a send command without sending mail. It accepts only optional export
// assignments, one direct gws invocation, stderr-to-stdout, and head -N.
// The captured gws segment still goes through the regular argv verifier, which
// proves help is an option rather than (for example) a subject value.
const SAFE_HELP_PROBE_RE =
    /^(?:export\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)*\s+&&\s+)?((?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+\s+)*gws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)(?:\s+[^\s;&|<>\x60$(){}#'"]+)*)\s+2>&1\s*\|\s*head\s+-\d+\s*$/;

export function safeHelpProbeIsReadOnly(command: string): boolean {
    const match = command.match(SAFE_HELP_PROBE_RE);
    if (!match) return false;
    const gwsSegment = match[1];
    return /(?:^|[ \t])(?:--help|-h)(?:$|[ \t])/.test(gwsSegment) && bypassFlagIsRealArgvToken(gwsSegment);
}

/** Snapshot of the only env input the email gate decision depends on. */
export interface EnvSnapshot {
    /** True when the send originates from a scheduled task. Source:
     * NANOCLAW_IS_SCHEDULED_TASK === '1'. Scheduled tasks intentionally
     * bypass the gate (v1 parity) so automated email reports aren't prompted
     * every run. */
    isScheduledTask: boolean;
}

/** Verdict for the email gate. On `gate`, `label` + `summary`
 *  describe the send for the approver. */
export interface EmailGateVerdict {
    action: 'allow' | 'gate';
    label?: string;
    summary?: string;
    reason?: string;
}

function normalizedToolName(toolName: string): string {
    return toolName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function nativeEmailAction(toolName: string): 'send' | 'reply-all' | 'reply' | 'forward' | null {
    const normalized = normalizedToolName(toolName);
    if (!normalized) return null;
    if (!/(?:^|_)(?:gmail|email)(?:_|$)/.test(normalized)) return null;
    // A tool that sends an existing draft still delivers mail and must gate.
    // Draft-only create/update/save actions remain non-delivering and allowed.
    if (/(?:^|_)send(?:_|$)/.test(normalized)) return 'send';
    if (/(?:^|_)draft(?:_|$)/.test(normalized)) return null;
    if (/(?:^|_)reply_all(?:_|$)/.test(normalized)) return 'reply-all';
    if (/(?:^|_)reply(?:_|$)/.test(normalized)) return 'reply';
    if (/(?:^|_)forward(?:_|$)/.test(normalized)) return 'forward';
    return null;
}

function toolValueAsString(value: unknown, depth = 0): string | undefined {
    if (depth > 3 || value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const strings = value.filter((item): item is string => typeof item === 'string');
        if (strings.length > 0) return strings.join(', ');
        for (const item of value) {
            const nested = toolValueAsString(item, depth + 1);
            if (nested) return nested;
        }
        return undefined;
    }
    if (typeof value !== 'object') return undefined;
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
        const match = toolValueAsString(nestedValue, depth + 1);
        if (match) return match;
    }
    return undefined;
}

function firstToolInputValue(
    value: unknown,
    wantedKeys: Set<string>,
    depth = 0,
): string | undefined {
    if (depth > 3 || value === null || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (!wantedKeys.has(normalizedKey)) continue;
        const match = toolValueAsString(nestedValue, depth + 1);
        if (match) return match;
    }
    for (const nestedValue of Object.values(record)) {
        const match = firstToolInputValue(nestedValue, wantedKeys, depth + 1);
        if (match) return match;
    }
    return undefined;
}

/**
 * Gate native connector/MCP email actions that do not pass through Bash. Tool
 * names must contain an email/gmail token plus send/reply/forward. Draft-only
 * tools remain allowed, but tools that send a saved draft gate. The card shows
 * the message text so the approver reads what will actually be sent.
 */
export function evaluateEmailToolCall(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    env: EnvSnapshot,
): EmailGateVerdict {
    const action = nativeEmailAction(toolName);
    if (!action || env.isScheduledTask) return { action: 'allow' };

    const input = toolInput ?? {};
    const to = firstToolInputValue(
        input,
        new Set(['to', 'to_email', 'recipient', 'recipients', 'recipient_email', 'recipient_emails']),
    ) ?? 'unknown recipient';
    const subject = firstToolInputValue(input, new Set(['subject', 'email_subject'])) ?? '';
    const label = subject
        ? `Email ${action} to ${to}: "${subject}"`
        : `Email ${action} to ${to}`;
    const lines = [`Tool: ${toolName}`, `To: ${to}`];
    if (subject) lines.push(`Subject: ${subject}`);
    const html = firstToolInputValue(input, new Set(['html', 'html_body', 'body_html']));
    const body = html ?? firstToolInputValue(input, new Set(['body', 'text', 'plain_text', 'text_body', 'body_text', 'content', 'message_body']));
    if (body) {
        const isHtml = html !== undefined || /<(?:p|div|br|html|body|table|span|a)\b[^>]*>/i.test(body);
        const header = `Message${isHtml ? ' (HTML, shown as text)' : ''}:`;
        const used = Array.from(lines.join('\n')).length + header.length + 8;
        lines.push('', header, quoteBlock(clip((isHtml ? htmlToText(body) : body.trim()) || '(empty)', Math.max(200, CARD_SUMMARY_MAX_CHARS - used))));
    }

    return {
        action: 'gate',
        label,
        reason: label,
        summary: fitLines(lines, CARD_SUMMARY_MAX_CHARS),
    };
}

/**
 * Decode the RFC 822 envelope from `--json '{"raw":"<base64url>"}'` so the
 * approval card shows real recipient/subject when the agent uses the raw API
 * form. Returns {} on any failure — caller falls back to "unknown recipient".
 */
export function envelopeFromJsonRaw(segment: string): {
    to?: string;
    from?: string;
    subject?: string;
    cc?: string;
    bcc?: string;
} {
    const m = segment.match(/--json\s+(['"])((?:(?!\1).)*)\1/);
    if (!m) return {};
    let payload: unknown;
    try {
        payload = JSON.parse(m[2]);
    } catch {
        return {};
    }
    const raw =
        (payload as { raw?: unknown })?.raw ??
        (payload as { message?: { raw?: unknown } })?.message?.raw;
    if (typeof raw !== 'string') return {};
    let decoded: string;
    try {
        let b = raw.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        decoded = Buffer.from(b, 'base64').toString('utf-8');
    } catch {
        return {};
    }
    const blankIdx = decoded.search(/\r?\n\r?\n/);
    const headerBlock = blankIdx === -1 ? decoded : decoded.slice(0, blankIdx);
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
    const out: { to?: string; from?: string; subject?: string; cc?: string; bcc?: string } = {};
    for (const line of unfolded.split(/\r?\n/)) {
        const hm = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
        if (!hm) continue;
        const k = hm[1].toLowerCase();
        if (k === 'to') out.to = hm[2].trim();
        else if (k === 'from') out.from = hm[2].trim();
        else if (k === 'subject') out.subject = hm[2].trim();
        else if (k === 'cc') out.cc = hm[2].trim();
        else if (k === 'bcc') out.bcc = hm[2].trim();
    }
    return out;
}

/**
 * Decide whether a bash command is an outbound-email send that needs admin
 * approval, and if so, describe it for the approver. The verdict depends only
 * on the command string and the env snapshot.
 *
 * Decision ordering:
 *   1. Not an email send (GWS_EMAIL_SEND_RE miss) → allow.
 *   2. Exact bounded read-only `gws … --help 2>&1 | head -N` probe → allow.
 *   3. WHOLE command is a single, simple send carrying a real bypass flag
 *      (--dry-run / --draft / --help / -h) → allow.
 *   4. Scheduled task (env.isScheduledTask) → allow (v1 parity bypass).
 *   5. Otherwise → gate, with the parsed envelope rendered into label + summary.
 *
 * SCOPE — what this layer can and cannot do (read before "fixing" step 1):
 * This is a best-effort shell-text gate. It reliably gates the email sends an
 * agent constructs NORMALLY (`gws gmail +send …`). It CANNOT detect a send whose
 * verb/command an adversary deliberately OBFUSCATES so the regex can't see it —
 * `gws gmail +se''nd …`, `+s$(true)end`, `gw''s gma''il …`, `eval`, base64-decode
 * pipes, or a direct REST/SMTP/SDK call. Those evade DETECTION (step 1 returns
 * allow because GWS_EMAIL_SEND_RE never matches), and no regex over shell text
 * can close that — bash applies quote-removal and expansion we cannot replay
 * statically. The SOUND boundary for a determined adversary is the egress proxy
 * (see the "Out of scope" note at the top of this file). What this layer DOES
 * guarantee: once a send IS detected, no decoy/quoting trick lets it skip the
 * gate (step 2 is fail-closed by construction — see below).
 *
 * The GWS creds account is parsed from the COMMAND string
 * (GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…/accounts/<slug>.json), NOT from env.
 */
export function evaluateEmailSend(command: string, env: EnvSnapshot): EmailGateVerdict {
    if (!command || !GWS_EMAIL_SEND_RE.test(command)) return { action: 'allow' };

    // Bypass ONLY when the WHOLE command is a single, simple send carrying a real
    // bypass flag — no shell separators, no metacharacters, no second command.
    // bypassFlagIsRealArgvToken strips quoted spans first, then fails closed on
    // any surviving quote OR any shell metacharacter (which INCLUDES the
    // separators ; & |). Checking the whole command — not a per-segment slice —
    // is what collapses the decoy class (QA codex #4/#5): a prefixed
    // `: gws gmail +send --dry-run; <real send>` contains a `;`, so the bypass is
    // refused and the gate fires — and this holds whether the real send is
    // regex-visible OR obfuscated (`+se''nd`, `+s$(true)end`), because the
    // disqualifier is the separator, not our ability to parse the second command.
    // It also fixes the over-block where a quoted separator in a dry-run body
    // (`--body "a;b" --dry-run`) used to split mid-quote: the quoted span is
    // stripped before the metacharacter test, so the real --dry-run still bypasses.
    if (safeHelpProbeIsReadOnly(command) || bypassFlagIsRealArgvToken(command)) return { action: 'allow' };

    // Scheduled tasks intentionally bypass — v1 also did this so
    // automated email reports aren't prompted every run.
    if (env.isScheduledTask) return { action: 'allow' };

    // The approval text is built from the parsed send when the shell parser finds one
    // and from regexes over the WHOLE command otherwise: in a decoy chain the
    // real send may sit in a segment the parser reads differently (an
    // obfuscated `+se''nd` verb), and the gate has already fired either way.
    const view = viewShell(command);
    const send = primarySendInvocation(view);
    const matchFlag = (flag: string): string | undefined => {
        const parsed = send ? argFlag(send.args, flag) : undefined;
        if (parsed !== undefined) return parsed;
        const quoted = command.match(new RegExp(`${flag}\\s+(['"])((?:(?!\\1)[\\s\\S])+)\\1`));
        if (quoted) return quoted[2];
        const bare = command.match(new RegExp(`${flag}\\s+(\\S+)`));
        return bare?.[1];
    };
    const flagTo = matchFlag('--to');
    const envelope = !flagTo ? envelopeFromJsonRaw(command) : {};
    const subject = matchFlag('--subject') ?? envelope.subject ?? '';
    const cc = matchFlag('--cc') ?? envelope.cc;
    const bcc = matchFlag('--bcc') ?? envelope.bcc;
    const removed = matchFlag('--remove');
    const messageId = matchFlag('--message-id');
    const isHtml = send ? send.args.includes('--html') : /\s--html(?:\s|$)/.test(command);
    // Parse the sending identity from GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
    // Path convention: /home/node/.config/gws/accounts/<slug>.json.
    // The slug is the human-facing account name the user configured.
    // Parsed from the COMMAND string — NOT from env.
    const credsMatch = command.match(
        /GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/,
    );
    const fromAccount = credsMatch?.[1] ?? 'default';
    // Anchor to the four allowed helper verbs only — the prior `\+(\w[\w-]*)`
    // could capture spurious `+ABC` substrings from a base64 payload in the
    // raw-API form. Falls back to "send" for the raw form (which has no +verb).
    const action = send?.verb ?? command.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
    const isRawApi = send ? send.verb === 'send' && !send.helper : !/\+(send|reply|reply-all|forward)\b/.test(command);

    const threadRecipients = action === 'reply' ? 'the original sender'
        : action === 'reply-all' ? 'the original sender and everyone on To/Cc'
        : null;
    const to = threadRecipients
        ? (flagTo ? `${threadRecipients}, plus ${flagTo}` : threadRecipients)
        : flagTo ?? envelope.to ?? 'unknown recipient';
    const probeFlag = send?.args.find(a => EMAIL_BYPASS_FLAGS.has(a));
    const label = (subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`)
        + (probeFlag ? ` (${probeFlag} — check the command)` : '');

    const alias = matchFlag('--from');
    const attachments = send
        ? send.args.flatMap((a, i) => (a === '-a' || a === '--attach') && send.args[i + 1] ? [send.args[i + 1]] : a.startsWith('--attach=') ? [a.slice(9)] : [])
        : [];
    const lines: string[] = [`From: ${fromAccount}${alias ? ` (as ${alias})` : ''}`, `To: ${to}`];
    if (probeFlag) {
        lines.unshift(`⚠️ The send parsed here carries ${code(probeFlag)}, which on its own sends nothing. The gate still asks because the command also pipes or chains other steps it can't rule out; check the full command.`, '');
    }
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);
    if (removed) lines.push(`Removed from the reply: ${removed}`);
    if (subject) lines.push(`Subject: ${subject}`);
    else if (threadRecipients) lines.push('Subject: Re: the original subject');
    if (messageId && threadRecipients) lines.push(`In reply to: Gmail message ${code(messageId)}, quoted under the reply`);
    if (attachments.length) lines.push(`Attachments: ${attachments.map(code).join(', ')}`);

    const body = resolveBody(matchFlag('--body'), view, send?.pos ?? Infinity);
    lines.push('');
    if (body.text !== null) {
        const text = isHtml ? htmlToText(body.text) : body.text.trim();
        const header = `Message${isHtml ? ' (HTML, shown as text)' : ''}:`;
        const used = Array.from(lines.join('\n')).length + header.length + 8;
        lines.push(header, quoteBlock(clip(text || '(empty)', Math.max(200, CARD_SUMMARY_MAX_CHARS - used))));
        if (body.note) lines.push(`_${body.note}_`);
    } else if (isRawApi) {
        lines.push('Message: not shown. This send passes a raw MIME message, so the text is only visible inside the encoded payload. Decline and ask the agent to show the draft if you need to read it first.');
    } else {
        lines.push(`Message: not shown. ${body.note ?? 'The command builds the text when it runs.'} Decline and ask the agent to show the draft if you need to read it first.`);
    }
    const summary = fitLines(lines, CARD_SUMMARY_MAX_CHARS);

    return { action: 'gate', label, summary };
}

const SEND_VERB = /^\+(send|reply|reply-all|forward)$/;

interface SendInvocation {
    verb: 'send' | 'reply' | 'reply-all' | 'forward';
    helper: boolean;
    args: string[];
    pos: number;
}

/** The first gws gmail send that is not itself a dry run, draft or help call. */
function primarySendInvocation(view: ShellView): SendInvocation | undefined {
    let first: SendInvocation | undefined;
    for (const c of view.commands) {
        const words = [c.name, ...c.args];
        const at = words.indexOf('gws');
        if (at < 0 || words[at + 1] !== 'gmail') continue;
        const rest = words.slice(at + 2);
        const helper = rest[0]?.match(SEND_VERB)?.[1] as SendInvocation['verb'] | undefined;
        const raw = rest[0] === 'users' && (rest[1] === 'messages' || rest[1] === 'drafts') && rest[2] === 'send';
        if (!helper && !raw) continue;
        const inv: SendInvocation = { verb: helper ?? 'send', helper: !!helper, args: rest.slice(helper ? 1 : 3), pos: c.pos };
        first ??= inv;
        if (!inv.args.some(a => EMAIL_BYPASS_FLAGS.has(a))) return inv;
    }
    return first;
}

function argFlag(args: string[], flag: string): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flag && i + 1 < args.length) return args[i + 1];
        if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return undefined;
}

/** Turn the `--body` argument into the text that will be sent, when the command shows it. */
function resolveBody(raw: string | undefined, view: ShellView, pos: number): { text: string | null; note?: string } {
    if (raw === undefined) return { text: null, note: 'No `--body` was given.' };
    const ref = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (ref) {
        const value = view.valueAt(ref[1], pos);
        if (value?.kind === 'text') return { text: value.value };
        if (value?.kind === 'file') {
            const file = readDisplayFile(value.path);
            return file === null
                ? { text: null, note: `The text is read from ${code(value.path)} when the command runs, and that file can't be read yet.` }
                : { text: file, note: `Read from ${code(value.path)} when approval was requested.` };
        }
        return { text: null, note: `The text comes from ${code(raw)}, which is only set when the command runs.` };
    }
    const expanded = expandKnown(raw, view, pos);
    return expanded.unresolved.length
        ? { text: expanded.text, note: `${expanded.unresolved.join(', ')} ${expanded.unresolved.length === 1 ? 'is' : 'are'} only filled in when the command runs.` }
        : { text: expanded.text };
}
