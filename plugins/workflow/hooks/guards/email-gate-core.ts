/**
 * Shared PURE decision logic for the outbound-email approval gate.
 *
 * This module is PURE LOGIC ONLY. It performs NO I/O: no bun:sqlite, no fs, no
 * writeMessageOut / awaitDeliveryAck, no process.exit. It takes a bash command
 * string plus an env snapshot and returns a verdict (allow | gate) with the
 * pre-built approval-card `label` + `summary`. The provider adapter (Claude SDK
 * hook, OpenCode plugin, Codex runner) owns the staging + delivery-ack round-trip
 * — it stages the verdict via the session-DB `request_bash_gate` primitive
 * (see runEmailGate in block-destructive-core.ts) and emits the deny message.
 *
 * Ported verbatim from nanoclaw-v2 container/agent-runner/src/providers/claude.ts
 * lines 514-664 (GWS_EMAIL_SEND_RE, EMAIL_BYPASS_RE, envelopeFromJsonRaw,
 * createEmailGateHook's parse + card-build). The I/O tail (claude.ts:666-702)
 * is intentionally NOT relocated here — it stays in the adapter.
 *
 * Two send surfaces, both via the gws CLI, both gated:
 *   1. Helper verbs:   gws gmail +send | +reply | +reply-all | +forward
 *   2. Raw API form:   gws gmail users (messages|drafts) send …
 * The raw form takes the same code path as the helper verbs and produces an
 * identical send — matching only (1) would let an agent reaching for the raw
 * API surface bypass the gate entirely.
 *
 * Drafts are intentionally NOT gated when only being created
 * (`gws gmail users drafts create`) — drafts never deliver until separately
 * sent. The helper-verb `--draft` flag and `--dry-run` likewise bypass.
 *
 * Out of scope (cannot be caught at this layer reliably): direct REST calls,
 * Python/Node SDK calls, SMTP CLIs, eval/alias/base64-decoded subshells. The
 * only sound place to catch all of those is the egress proxy.
 */

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
    const unquoted = gwsSegment
        .replace(/\$'(?:[^'\\]|\\.)*'/g, QUOTED_SPAN_SENTINEL) // ANSI-C $'…' (escapes, incl. \')
        .replace(/\$"(?:[^"\\]|\\.)*"/g, QUOTED_SPAN_SENTINEL) // locale $"…"
        .replace(/'[^']*'/g, QUOTED_SPAN_SENTINEL) // single-quoted (literal, no escapes)
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

/** Snapshot of the only env input the email gate decision depends on. */
export interface EnvSnapshot {
    /** True when the send originates from a scheduled task. Source:
     * NANOCLAW_IS_SCHEDULED_TASK === '1'. Scheduled tasks intentionally
     * bypass the gate (v1 parity) so automated email reports aren't prompted
     * every run. */
    isScheduledTask: boolean;
}

/** Verdict for the email gate. PURE — no I/O. On `gate`, `label` + `summary`
 *  carry the pre-built approval-card content. */
export interface EmailGateVerdict {
    action: 'allow' | 'gate';
    label?: string;
    summary?: string;
    reason?: string;
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
 * approval, and if so, build the approval-card content. PURE — the only inputs
 * are the command string and the env snapshot; no I/O, no process.exit.
 *
 * Decision ordering:
 *   1. Not an email send (GWS_EMAIL_SEND_RE miss) → allow.
 *   2. WHOLE command is a single, simple send carrying a real bypass flag
 *      (--dry-run / --draft / --help / -h) → allow.
 *   3. Scheduled task (env.isScheduledTask) → allow (v1 parity bypass).
 *   4. Otherwise → gate, with the parsed envelope rendered into label + summary.
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
    if (bypassFlagIsRealArgvToken(command)) return { action: 'allow' };

    // Scheduled tasks intentionally bypass — v1 also did this so
    // automated email reports aren't prompted every run.
    if (env.isScheduledTask) return { action: 'allow' };

    // Build the approval-card fields from the WHOLE command. In a decoy chain the
    // real send (and its recipient) may live in a segment that doesn't cleanly
    // match GWS_EMAIL_SEND_RE (e.g. an obfuscated `+se''nd` verb), so a
    // per-segment pick can miss it; scanning the whole command surfaces the first
    // --to/--subject/--body. The gate has already fired — the card is best-effort
    // and the raw command is in the adapter's tool-call log for the approver.
    const gwsSegment = command;

    // Parse the email envelope so the card shows structured fields
    // instead of raw shell. Each matcher handles both --flag 'quoted'
    // and --flag unquoted. Helper-verb sends carry envelope as flags;
    // raw-API sends carry it as base64url RFC 822 inside `--json '{"raw":…}'`.
    const matchFlag = (flag: string): string | undefined => {
        const quoted = gwsSegment.match(new RegExp(`${flag}\\s+['"]([^'"]+)['"]`));
        if (quoted) return quoted[1];
        const bare = gwsSegment.match(new RegExp(`${flag}\\s+(\\S+)`));
        return bare?.[1];
    };
    const flagTo = matchFlag('--to');
    const envelope = !flagTo ? envelopeFromJsonRaw(gwsSegment) : {};
    const to = flagTo ?? envelope.to ?? 'unknown recipient';
    const subject = matchFlag('--subject') ?? envelope.subject ?? '';
    const body = matchFlag('--body') ?? '';
    const cc = matchFlag('--cc') ?? envelope.cc;
    const bcc = matchFlag('--bcc') ?? envelope.bcc;
    const isHtml = /\s--html(?:\s|$)/.test(gwsSegment);
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
    const action = gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
    const label = subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`;

    // No `command` field on the payload → host's buildCardBody skips
    // its code-block branch entirely. The adapter still has the raw
    // command in the SDK tool-call log for audit; we don't surface shell
    // noise to the approver in the card body.
    const lines: string[] = [`*From:* ${fromAccount}`, `*To:* ${to}`];
    if (cc) lines.push(`*Cc:* ${cc}`);
    if (bcc) lines.push(`*Bcc:* ${bcc}`);
    if (subject) lines.push(`*Subject:* ${subject}`);
    if (body) {
        const bodyPreview = body.length > 400 ? body.slice(0, 400) + '…' : body;
        lines.push('', isHtml ? '*Body* (HTML):' : '*Body:*', `> ${bodyPreview.replace(/\n/g, '\n> ')}`);
    }
    const summary = lines.join('\n');

    return { action: 'gate', label, summary };
}
