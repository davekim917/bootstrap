/**
 * Shared decision logic for the outbound-email approval gate.
 *
 * The verdict is pure: no bun:sqlite, no writeMessageOut / awaitDeliveryAck, no
 * process.exit, and nothing it reads can change allow vs gate. Its I/O is read-only:
 * display reads (a `$(cat /absolute/path)` body, the sender and signature on file, a
 * stored draft), and a stat of each attachment, which turns a gate into a refusal
 * when gws would refuse the file after approval. It takes a bash command string or native
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
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { CARD_SUMMARY_MAX_CHARS, HTML_MAX_CHARS, clip, code, defaultGwsConfigDir, defuse, evalWord, fitLines, gwsLoginIn, htmlToText, inEmptyDir, inline, quoteBlock, readBodyFile, senderOnFile, signatureOnFile, soleVariable, viewShell, type ShellView, withoutStoredHeredocs } from './gate-card-core';
import { readAttachments } from './gws-attachments-core';

// `gws gmail +send|+reply|+reply-all|+forward` (helper verbs) OR
// `gws gmail users (messages|drafts) send` (raw API form).
export const GWS_EMAIL_SEND_RE =
    /\bgws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)\b/;

// The flags that make gws send nothing, as whole argv tokens; a send carrying one is still described with a warning.
export const EMAIL_BYPASS_FLAGS = new Set(['--dry-run', '--draft', '--help', '-h']);

// Any character that could make bash do more than run one command with these exact words: separators, pipes,
// redirects, every kind of expansion, globs, history, tilde, comments, escapes, and any break but a space.
const NOT_A_PLAIN_COMMAND = /[;&|`$()<>{}\[\]*?!~#\\\n\t\r\0]/;
// gws gmail options that take no value, so a flag after one is still an option rather than that option's value.
const GWS_BOOLEAN_OPTIONS = new Set(['--html', '--dry-run', '--draft', '--help', '-h', '--no-original-attachments']);
// The one tail an agent adds to read a no-send call's output: stderr merged into stdout, then at most one pipe into a
// bare head or tail with a line count. It only moves output, so gws runs with the same words either way. Every space
// run is bounded: the regex is tried at each start position, so an unbounded run makes a long run of spaces quadratic.
const OUTPUT_TRIM_TAIL = /(?: {1,8}2>&1)?(?: {0,8}\| {0,8}(?:head|tail)(?: {1,8}-(?:\d{1,6}|n {0,8}\d{1,6}))?)? {0,8}$/;

/**
 * True when the command is one gws call with literal words and a real `--dry-run`, `--draft`, `--help` or `-h` option,
 * optionally followed by OUTPUT_TRIM_TAIL. It reasons about no other shell syntax: a command holding any character
 * that could make bash do more is never excused, and gets a card.
 */
export function sendsNothing(fullCommand: string): boolean {
    const command = fullCommand.slice(0, OUTPUT_TRIM_TAIL.exec(fullCommand)!.index);
    if (NOT_A_PLAIN_COMMAND.test(command)) return false;
    const tokens: Array<{ text: string; quoted: boolean }> = [];
    let i = 0;
    while (i < command.length) {
        if (command[i] === ' ') {
            i++;
            continue;
        }
        let end: number;
        if (command[i] === "'" || command[i] === '"') {
            end = command.indexOf(command[i], i + 1);
            const inner = end < 0 ? '' : command.slice(i + 1, end);
            if (end < 0 || /['"]/.test(inner)) return false;
            tokens.push({ text: inner, quoted: true });
            end++;
        } else {
            end = i;
            while (end < command.length && command[end] !== ' ') {
                if (command[end] === "'" || command[end] === '"') return false;
                end++;
            }
            tokens.push({ text: command.slice(i, end), quoted: false });
        }
        // A quoted pair joined to more text (`'x'--dry-run`) is one word to bash, not the flag.
        if (end < command.length && command[end] !== ' ') return false;
        i = end;
    }
    if (tokens[0]?.quoted !== false || tokens[0].text !== 'gws') return false;
    // bash removes the quotes, so a quoted `--` or option is the same word to gws; only an unquoted flag counts.
    for (let k = 1; k < tokens.length; k++) {
        const { text, quoted } = tokens[k];
        if (text === '--') return false;
        if (quoted || !EMAIL_BYPASS_FLAGS.has(text)) continue;
        const prev = tokens[k - 1].text;
        if (!prev.startsWith('-') || prev.includes('=') || GWS_BOOLEAN_OPTIONS.has(prev)) return true;
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
    /** Working directory of the tool call; a body file under it may be shown. */
    cwd?: string;
    /**
     * Where the host keeps, read-only, each account's `<account>.signature.html` and `identities.json` (the mailbox
     * each set of credential bytes belongs to); tests point it elsewhere.
     */
    signaturesDir?: string;
    /** The gws the draft read runs; tests point it at a stub. */
    gwsBin?: string;
    /** The config directory gws uses when a command names none (`defaultGwsConfigDir`); tests point it elsewhere. */
    gwsConfigDir?: string;
}

/** The stored draft a `users drafts send` will send, as it was read for the approval card. */
export interface DraftBinding {
    draftId: string;
    /** Gmail gives a draft a new message id whenever its content changes; the draft id stays. */
    messageId: string;
    userId: string;
    credentialsFile: string;
}

/** What the host is told about leaving the command off the card. */
export type EmailCard = Pick<EmailGateVerdict, 'pureSend' | 'fullSummary' | 'wholeEmail'>;

/** Verdict for the email gate. On `gate`, `label` + `summary`
 *  describe the send for the approver. */
export interface EmailGateVerdict {
    action: 'allow' | 'gate';
    label?: string;
    summary?: string;
    reason?: string;
    /**
     * Set when the send shares its command with other steps, or with words this module can't read exactly as bash
     * will: the adapter refuses the command with this text instead of asking. A consumer that predates the field
     * still asks, with the command on the card.
     */
    deny?: string;
    /** The command is the send alone and the summary shows all of it, so the card can leave the command off. */
    pureSend?: boolean;
    /**
     * Set instead of `pureSend` when the command is the send alone but `summary` had to cut the message: the whole
     * send, uncut, for a host whose card has room for it without the command. Too long for its card, the host shows
     * `summary` and the command.
     */
    fullSummary?: string;
    /**
     * Set when `summary` had to cut the message: every line of the summary, with the body exactly as the send carries
     * it (an HTML body also as the recipient reads it). A host that cannot show the whole message on the card puts this
     * in front of the approver, or posts no card.
     */
    wholeEmail?: string;
    /**
     * Set when the card shows a stored draft the command sends by id. After approval the adapter re-reads the draft
     * (`draftChangedSince`) and refuses the send if it is no longer this version.
     */
    draft?: DraftBinding;
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
        ? `Email ${action} to ${inline(to)}: "${inline(subject)}"`
        : `Email ${action} to ${inline(to)}`;
    const lines = [`Tool: ${inline(toolName)}`, `To: ${inline(to)}`];
    if (subject) lines.push(`Subject: ${inline(subject)}`);
    const html = firstToolInputValue(input, new Set(['html', 'html_body', 'body_html']));
    const body = html ?? firstToolInputValue(input, new Set(['body', 'text', 'plain_text', 'text_body', 'body_text', 'content', 'message_body']));
    if (body) {
        const isHtml = html !== undefined || /<(?:p|div|br|html|body|table|span|a)\b[^>]{0,500}>/i.test(body.slice(0, 20_000));
        const header = `Message${isHtml ? ' (HTML, shown as text)' : ''}:`;
        const text = (isHtml ? htmlToText(body) : body.trim()) || '(empty)';
        const htmlHead = isHtml && body.length > HTML_MAX_CHARS ? body.length : null;
        const cut = cutBody(text, CARD_SUMMARY_MAX_CHARS - (lines.join('\n').length + header.length + 4), quoteBlock, htmlHead);
        const fields = [...lines];
        lines.push('', ...cut.note, header, cut.block);
        const summary = fitLines(roomForBody(lines, lines.length - 1, cut), CARD_SUMMARY_MAX_CHARS);
        const whole = !cut.note.length && summary === lines.join('\n') ? null : [...fields, '', ...exactBody(isHtml && htmlHead === null ? text : null, body)].join('\n');
        return { action: 'gate', label, reason: label, summary, ...(whole === null ? {} : { wholeEmail: whole }) };
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
    const m = segment.match(/--json\s+(['"])((?:(?!\1)[\s\S])*)\1/);
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
 *   1. Not an email send (GWS_EMAIL_SEND_RE miss once stored heredoc bodies are removed) → allow.
 *   2. The command is one gws call with literal words and a real --dry-run, --draft,
 *      --help or -h option (sendsNothing) → allow.
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
 * gate (step 2 is fail-closed by construction).
 *
 * The GWS creds account is parsed from the COMMAND string
 * (GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=…/accounts/<slug>.json), NOT from env.
 */
export function evaluateEmailSend(command: string, env: EnvSnapshot): EmailGateVerdict {
    if (!command || !GWS_EMAIL_SEND_RE.test(withoutStoredHeredocs(command))) return { action: 'allow' };

    if (sendsNothing(command)) return { action: 'allow' };

    // Scheduled tasks intentionally bypass — v1 also did this so
    // automated email reports aren't prompted every run.
    if (env.isScheduledTask) return { action: 'allow' };

    // The description comes from the parsed send when the shell parser finds
    // one and from regexes over the command otherwise: in a decoy chain the real
    // send may sit in a segment the parser reads differently, and the gate has
    // already fired either way.
    const view = viewShell(command);
    const calls = gwsGmailCalls(view);
    const send = calls.find(c => c.verb && !c.values.some(v => EMAIL_BYPASS_FLAGS.has(v))) ?? calls.find(c => c.verb);
    const unresolved = new Set<string>();
    const evaluated = (text: string): string => {
        const r = evalWord(text, view, send?.pos ?? Infinity);
        r.unresolved.forEach(u => unresolved.add(u));
        return r.value;
    };
    const scanned = command.slice(0, FALLBACK_SCAN_CHARS);
    const matchFlag = (flag: string): string | undefined => {
        if (send) {
            const texts = argTexts(send, flag);
            return texts.length ? texts.map(evaluated).join(', ') : undefined;
        }
        const quoted = scanned.match(new RegExp(`${flag}\\s+(['"])((?:(?!\\1)[\\s\\S])+)\\1`));
        if (quoted) return quoted[2];
        return scanned.match(new RegExp(`${flag}\\s+(\\S+)`))?.[1];
    };
    // A command in the one shape is read exactly by it, even where the shell view's parser fails (an apostrophe in a
    // heredoc is enough); the summary then comes from the shape, and the shell view, when it parsed, must agree.
    const shape = sendShape(command);
    const exact = shape?.complete && shape.verb !== null ? shape : null;
    const configDir = env.gwsConfigDir ?? defaultGwsConfigDir(env.cwd);
    // A send gws would make from another account than its credentials file is refused, and nothing is read for it.
    const accountRefusal = shape ? sendAccountRefusal(shape, configDir) : null;
    // A send of a stored draft names no envelope, so the card reads the draft. A failed read keeps the card and the
    // gate as they were.
    const draftTarget = accountRefusal ? null : draftSendTarget(shape);
    const draftRead = draftTarget ? readDraft(draftTarget, 'full', env.gwsBin ?? GWS_BIN, configDir) : null;
    const draft = draftRead ? draftContent(draftRead) : null;
    const exactOption = (name: string) => exact?.options.get(name)?.join(', ');
    const exactAttachments = [...(exact?.options.get('-a') ?? []), ...(exact?.options.get('--attach') ?? [])];
    const viewRead = {
        to: matchFlag('--to'),
        subject: matchFlag('--subject'),
        cc: matchFlag('--cc'),
        bcc: matchFlag('--bcc'),
        removed: matchFlag('--remove'),
        messageId: matchFlag('--message-id'),
        alias: matchFlag('--from'),
        attachments: send ? [...argTexts(send, '-a'), ...argTexts(send, '--attach')].map(evaluated) : [],
        isHtml: send ? send.values.includes('--html') : /\s--html(?:\s|$)/.test(scanned),
    };
    const flagTo = exact ? exactOption('--to') : viewRead.to;
    // A raw-API payload names its own envelope; for a helper call it would be text that merely looks like one.
    const envelope = draft ? draft.envelope : !flagTo && !exact ? envelopeFromJsonRaw(command) : {};
    const subject = (exact ? exactOption('--subject') : viewRead.subject) ?? envelope.subject ?? '';
    const cc = (exact ? exactOption('--cc') : viewRead.cc) ?? envelope.cc;
    const bcc = (exact ? exactOption('--bcc') : viewRead.bcc) ?? envelope.bcc;
    const removed = exact ? exactOption('--remove') : viewRead.removed;
    const messageId = exact ? exactOption('--message-id') : viewRead.messageId;
    const alias = exact ? exactOption('--from') : viewRead.alias;
    const attachments = draft ? draft.attachments : exact ? exactAttachments : viewRead.attachments;
    const isHtml = exact ? exact.html : viewRead.isHtml;
    // Parse the sending identity from GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
    // Path convention: /home/node/.config/gws/accounts/<slug>.json.
    // The slug is the human-facing account name the user configured.
    // Parsed from the COMMAND string — NOT from env.
    const credsMatch = command.match(
        /GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/,
    );
    // A command in the one shape names the account in exactly one place, which the scan above could miss for a
    // credentials-looking string inside the body.
    const sender = shape ? senderOnFile(shape.credentialsFile, env.signaturesDir ?? SIGNATURES_DIR) : null;
    const fromAccount = sender ? sender.mailbox : shape ? shape.account ?? 'default' : credsMatch?.[1] ?? 'default';
    // Anchor to the four allowed helper verbs only — the prior `\+(\w[\w-]*)`
    // could capture spurious `+ABC` substrings from a base64 payload in the
    // raw-API form. Falls back to "send" for the raw form (which has no +verb).
    const action = send?.verb ?? command.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
    const isRawApi = send ? send.verb === 'send' && !send.helper : !/\+(send|reply|reply-all|forward)\b/.test(command);

    const isReply = action === 'reply' || action === 'reply-all';
    const replyAll = action === 'reply-all';
    const replyCreds = exact?.credentialsFile;
    const replyRead = isReply && exact && !accountRefusal && messageId && GMAIL_ID.test(messageId) && replyCreds?.startsWith('/')
        ? readReplyContext(messageId, replyAll, alias, replyCreds, env.gwsBin ?? GWS_BIN, configDir)
        : null;
    const resolution = replyRead ? replyRecipients(replyAll, replyRead, { to: flagTo, cc, bcc, remove: removed }) : null;
    const reached = resolution && !('unresolved' in resolution) ? resolution : null;
    const unresolvedWhy = !isReply || reached ? null
        : !exact ? 'this command is not a send the gate can read exactly'
        : !replyCreds?.startsWith('/') ? 'the command names no absolute GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE to read the original with'
        : resolution && 'unresolved' in resolution ? resolution.unresolved
        : `the gate could not read Gmail message ${code(inline(messageId ?? '(none)'))} and the account's own addresses with the send's credentials`;
    const plus = (known: string | undefined) => known ? `not resolved, plus ${known}` : 'not resolved';
    const to = inline(reached ? reached.to.join(', ')
        : isReply ? plus(flagTo)
        : flagTo ?? envelope.to ?? 'unknown recipient');
    const shownCc = reached ? reached.cc.join(', ') || undefined : replyAll ? plus(cc) : cc;
    const shownBcc = reached ? reached.bcc.join(', ') || undefined : bcc;
    // A send-shaped call, or one whose verb is hidden behind quoting or expansion.
    const sendLike = calls.filter(c => c.verb || /[$`'"\\]/.test(c.verbText)).length;
    const generatedWord = view.commands.some(c => /[$`\\]/.test(c.name));
    const gwsWords = Math.max(sendLike, (scanned.match(/\bgws\s+gmail\s+(?:\+\S|users\s+(?:messages|drafts)\s+send\b)/g) ?? []).length);
    const probeFlag = send?.values.find(v => EMAIL_BYPASS_FLAGS.has(v));
    const named = gwsWords > 1
        ? [...new Set([...scanned.matchAll(/--(?:to|cc|bcc)[=\s]+['"]?([^\s'";&|)]+)/g)].map(m => inline(m[1])))]
        : [];
    const label = gwsWords > 1
        ? `Email: ${gwsWords} gws calls; addresses named: ${named.join(', ') || 'none found'}`
        : `Email ${action}${unresolvedWhy ? ' (recipients not resolved)' : ` to ${to}`}${subject ? `: "${inline(subject)}"` : ''}`
            + (generatedWord ? ' (check the command)' : probeFlag ? ` (${probeFlag} — check the command)` : '');

    const lines: string[] = [];
    if (gwsWords > 1) {
        lines.push(
            `⚠️ This command makes ${gwsWords} gws calls; any of them may send mail, and only the first send is described below. Check the full command.`,
            `Addresses named anywhere in the command: ${named.join(', ') || 'none found'}`,
            '',
        );
    } else if (generatedWord) {
        lines.push('⚠️ A command name here is built when the command runs, so it may send mail this description cannot see. Check the full command.', '');
    } else if (probeFlag) {
        lines.push(`⚠️ This send carries ${code(probeFlag)}, which on its own sends nothing. The gate still asks because it could not confirm that flag takes effect: the command holds other shell syntax, or the flag may be another option's value. Check the full command.`, '');
    }
    if (unresolvedWhy) {
        lines.push(`⚠️ Recipients not resolved: ${unresolvedWhy}, so this card cannot list who the reply reaches. Decline unless you know everyone on the thread.`, '');
    }
    lines.push(
        `From: ${inline(fromAccount)}${alias ? ` (as ${inline(alias)})` : ''}${sender ? '' : ' (not confirmed: the host holds no mailbox for these credentials)'}`,
        ...(envelope.from ? [`From header in the message: ${inline(envelope.from)}`] : []),
        `To: ${to}`,
    );
    if (shownCc) lines.push(`Cc: ${inline(shownCc)}`);
    if (shownBcc) lines.push(`Bcc: ${inline(shownBcc)}`);
    if (removed) lines.push(`Removed from the reply: ${inline(removed)}`);
    if (subject) lines.push(`Subject: ${inline(subject)}`);
    else if (isReply) lines.push('Subject: Re: the original subject');
    if (messageId && isReply) lines.push(`In reply to: Gmail message ${code(inline(messageId))}, quoted under the reply${reached ? '; the recipients above are read from it' : ''}`);
    if (attachments.length) lines.push(`Attachments: ${attachments.map(a => code(inline(a))).join(', ')}`);

    const bodyText = send ? argTexts(send, '--body')[0] : matchFlag('--body');
    const resolved = send || bodyText === undefined
        ? resolveBody(bodyText, view, send?.pos ?? Infinity, env.cwd, evaluated)
        : { text: bodyText };
    // The shape reads its body exactly, a heredoc included, which the shell view can't read into a variable (and its
    // parser may not read at all, an apostrophe in the heredoc being enough).
    const body = shape?.body !== undefined ? { text: shape.body } : resolved;
    lines.push('');
    let bodyCut = false;
    let formatted: { text: string; signed: boolean } | null = null;
    let wholeMessage: { at: number; block: string; noteAt: number | null; exact: string[]; cut: BodyCut } | null = null;
    if (body.text !== null) {
        const signature = signatureOnFile(sender?.account ?? null, env.signaturesDir ?? SIGNATURES_DIR);
        formatted = isHtml ? formattedText(body.text, signature) : null;
        const text = formatted ? formatted.text : isHtml ? htmlToText(body.text) : body.text.trim();
        const header = `Message${formatted ? ' (formatted)' : isHtml ? ' (HTML, shown as text)' : ''}:`;
        const after = 112;
        const htmlHead = isHtml && !formatted && body.text.length > HTML_MAX_CHARS ? body.text.length : null;
        const cut = cutBody(text || '(empty)', CARD_SUMMARY_MAX_CHARS - (lines.join('\n').length + header.length + after), messageBlock, htmlHead);
        bodyCut = cut.note.length > 0;
        lines.push(...cut.note, header, cut.block);
        wholeMessage = {
            at: lines.length - 1,
            block: messageBlock(text || '(empty)'),
            noteAt: bodyCut ? lines.length - 3 : null,
            exact: exactBody(isHtml && htmlHead === null ? text : null, body.text),
            cut,
        };
        if (formatted?.signed) lines.push(`Signature: ${inline(sender!.mailbox)}'s Gmail signature, as the host keeps it on file`);
        if (body.note) lines.push(body.note);
    } else if (draft && draftRead && draftTarget) {
        const extent = draft.length === null ? `first ${DRAFT_PREVIEW_CHARS} of more than 20,000 characters`
            : draft.length > DRAFT_PREVIEW_CHARS ? `first ${DRAFT_PREVIEW_CHARS} of ${draft.length} characters` : `${draft.length} characters`;
        if (draft.warnings.length) lines.unshift(...draft.warnings, '');
        lines.push(
            `Message${draft.html ? ' (HTML, shown as text)' : ''}, ${extent}:`,
            messageBlock(clip(draft.text || '(no text part)', DRAFT_PREVIEW_CHARS)),
            `Draft ${code(inline(draftTarget.draftId))}, version ${code(inline(draftRead.message.id))}. If the draft is edited before the send runs, the send is refused.`,
        );
    } else if (isRawApi) {
        lines.push('Message: not shown. This send passes a raw MIME message, so the text is only visible inside the encoded payload. Decline and ask the agent to show the draft if you need to read it first.');
    } else {
        lines.push(`Message: not shown. ${body.note ?? 'The command builds the text when it runs.'} Decline and ask the agent to show the draft if you need to read it first.`);
    }
    if (unresolved.size) {
        const list = [...unresolved];
        lines.push(`⚠️ ${list.map(code).join(', ')} ${list.length === 1 ? 'is' : 'are'} only known when the command runs, so the value${list.length === 1 ? '' : 's'} above may differ.`);
    }
    const summary = fitLines(wholeMessage ? roomForBody(lines, wholeMessage.at, wholeMessage.cut) : lines, CARD_SUMMARY_MAX_CHARS);
    const exactly = wholeMessage && (bodyCut || summary !== lines.join('\n'))
        ? { wholeEmail: lines.flatMap((line, k) => k === wholeMessage!.noteAt || k === wholeMessage!.at - 1 ? [] : k === wholeMessage!.at ? wholeMessage!.exact : [line]).join('\n') }
        : {};
    if (!shape) return { action: 'gate', label, summary, deny: SEND_ALONE };
    if (accountRefusal) return { action: 'gate', label, summary, deny: accountRefusal };
    if (reached?.leftOff.length) return { action: 'gate', label, summary, deny: leftOffRefusal(reached.leftOff, replyAll) };
    const attachmentsRead = readAttachments([...shape.options.get('-a') ?? [], ...shape.options.get('--attach') ?? []], env.cwd);
    if (attachmentsRead.refusal) return { action: 'gate', label, summary, deny: attachmentsRead.refusal };
    if (draftTarget && draftRead) {
        // The command can't stand in for a draft's text, so a cut summary says so first.
        const fitted = summary === lines.join('\n') ? summary : fitLines([
            '⚠️ This draft is longer than the card can show, so lines below are cut. Check the draft before approving.',
            '',
            ...lines,
        ], CARD_SUMMARY_MAX_CHARS);
        return { action: 'gate', label, summary: fitted, draft: { ...draftTarget, messageId: draftRead.message.id } };
    }
    const viewAgrees = !send || (viewRead.to === exactOption('--to') && viewRead.subject === exactOption('--subject')
        && viewRead.cc === exactOption('--cc') && viewRead.bcc === exactOption('--bcc') && viewRead.removed === exactOption('--remove')
        && viewRead.messageId === exactOption('--message-id') && viewRead.alias === exactOption('--from')
        && viewRead.attachments.join('\n') === exactAttachments.join('\n') && viewRead.isHtml === exact?.html
        && (resolved.text === null || resolved.text === exact?.body));
    const agree = exact !== null && viewAgrees && action === exact.verb;
    const shownPlain = [fromAccount, flagTo, subject, cc, bcc, removed, alias, ...(reached ? [reached.to.join(', '), shownCc, shownBcc] : [])];
    const shownAsCode = [messageId, ...attachments];
    // HTML qualifies only as a formatted body: the summary can't show what other markup or styling would change.
    const bodyFaithful = isHtml ? formatted !== null && bodyShownAsIs(formatted.text) : body.text !== null && bodyShownAsIs(body.text);
    const faithful = agree && sender !== null && (shape.verb === 'reply' || shape.verb === 'reply-all' || (shape.verb === 'send' && !messageId))
        && shownPlain.every(v => !v || fieldShownAsIs(v, false))
        && shownAsCode.every(v => !v || fieldShownAsIs(v, true)) && gwsWords === 1 && !generatedWord && !probeFlag
        && !unresolved.size && body.text !== null && bodyFaithful && attachmentsRead.namesAsSent && !unresolvedWhy;
    if (faithful && !bodyCut && summary === lines.join('\n')) return { action: 'gate', label, summary, pureSend: true };
    const whole = faithful && wholeMessage
        ? lines.flatMap((line, k) => k === wholeMessage!.noteAt ? [] : [k === wholeMessage!.at ? wholeMessage!.block : line]).join('\n')
        : null;
    return { action: 'gate', label, summary, ...exactly, ...(whole !== null && whole.length <= FULL_SUMMARY_MAX_CHARS ? { fullSummary: whole } : {}) };
}

/**
 * The message lines of `wholeEmail`: the body exactly as the command or tool call gives it, after the text a recipient
 * reads when it is HTML and that text was read whole. A reply or forward also carries the original message under it.
 */
function exactBody(readAs: string | null, given: string): string[] {
    // Named by the body's own hash, so no line of the body can pose as the one that ends it.
    const mark = `-- ${createHash('sha256').update(given).digest('hex').slice(0, 16)} --`;
    const what = readAs === null ? 'Message' : 'Message source';
    return [
        ...(readAs === null ? [] : ['Message, as the recipient reads it:', readAs, '']),
        `${what}, exactly as the send gives it: ${[...given].length.toLocaleString('en-US')} characters between the two ${mark} lines.`,
        mark,
        given,
        mark,
    ];
}

interface BodyCut {
    block: string;
    note: string[];
    /** The note for a card with no room for any of the message. */
    none: string;
}

/**
 * The body's block as the card shows it: `render`ed, in `room` characters for the block itself or at least 200. A body
 * that does not fit is cut and `note` says so. Counts are Unicode code points of the text the card shows and of the
 * whole text; when that text was read from only the start of an HTML source (`htmlHead`, the source's length in the
 * UTF-16 units that start is measured in), the note says so.
 */
function cutBody(text: string, room: number, render: (shown: string) => string, htmlHead: number | null): BodyCut {
    const total = [...text].length;
    const n = (k: number) => k.toLocaleString('en-US');
    const of = htmlHead === null ? `${n(total)} characters` : `the text read from the first ${n(HTML_MAX_CHARS)} of the HTML source's ${n(htmlHead)} UTF-16 units`;
    const none = htmlHead === null
        ? `Body cut: this card has no room for the message's ${of}.`
        : `Body cut: this card has no room for the message, an HTML source of ${n(htmlHead)} UTF-16 units.`;
    const fit = Math.max(200, room);
    if (htmlHead === null && render(text).length <= fit) return { block: render(text), note: [], none };
    const say = (k: number) => `Body cut: showing ${n(k)} of ${of}.`;
    const limit = fit - say(total).length - 1;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (render(clip(text, mid)).length <= limit) lo = mid;
        else hi = mid - 1;
    }
    const shown = lo >= text.length ? text : clip(text, Math.max(lo, 2));
    const count = shown === text ? total : [...shown].length - 1;
    return { block: render(shown), note: [say(count)], none };
}

/**
 * `lines` as they fit the card: unchanged when everything up to the body's block survives `fitLines`, else with the
 * message dropped and the note that says so first, so the card never shows part of a body as if it were all of it.
 */
function roomForBody(lines: string[], blockAt: number, cut: BodyCut): string[] {
    if (lines.slice(0, blockAt + 1).join('\n').length + 1 <= CARD_SUMMARY_MAX_CHARS) return lines;
    const dropped = new Set([blockAt, blockAt - 1, ...(cut.note.length ? [blockAt - 2] : [])]);
    return [cut.none, ...lines.filter((_, k) => !dropped.has(k))];
}

// Slack's 2800-unit message, less the longest title, the resolution line and the footer: no NanoClaw card without the
// command has room for more. The host still checks its own fit.
const FULL_SUMMARY_MAX_CHARS = 2400;


// The card reaches the approver as chat Markdown. A code block shows the body literally; a line that opens or closes a
// fence would end it early, so such a body is shown quoted instead and never stands in for the command.
// Slack's mrkdwn also ends a block at backticks mid-line, and the adapter rewrites `{{emoji:…}}` placeholders anywhere.
const BREAKS_CODE_BLOCK = /^\s*(?:`{3,}|~{3,})|`{3,}|\{\{emoji:/im;
const EMOJI_PLACEHOLDER = /\{\{emoji:/i;

function messageBlock(text: string): string {
    return BREAKS_CODE_BLOCK.test(text) ? quoteBlock(text) : ['```', defuse(text), '```'].join('\n');
}

/**
 * The card shows the body as written: no edge whitespace trimmed, no fence line, no `<` defused against chat pings, and
 * nothing a chat client might decode as an entity.
 */
function bodyShownAsIs(text: string): boolean {
    return text === text.trim() && !BREAKS_CODE_BLOCK.test(text) && defuse(text) === text && !BIDI_CONTROL.test(text) && !/&#?\w+;/.test(text);
}

// Fields are shown as plain text, where chat Markdown would restyle or rewrite emphasis and code markers, escapes,
// link brackets, table pipes, entities and emoji codes.
const CHAT_SYNTAX = /[*_~`\\|[\]]|&#?\w+;|:[a-z0-9_+-]+:|\{\{emoji:/i;
// A word starting with @ or # is a mention or channel link to Slack's automatic parsing (`@everyone` notifies the
// workspace), though `pat@example.com` is not.
const CHAT_MENTION = /(?:^|[^\w.+-])[@#][\w.-]/;

/** A one-line field the card shows exactly as written, as plain text or inside a code span. */
function fieldShownAsIs(value: string, asCode: boolean): boolean {
    if (inline(value) !== value || BIDI_CONTROL.test(value) || EMOJI_PLACEHOLDER.test(value)) return false;
    return asCode ? !value.includes('`') : chatLiteral(value);
}

/** True when chat Markdown would show this one-line field exactly as written. */
export function chatLiteral(text: string): boolean {
    return !CHAT_SYNTAX.test(text) && !CHAT_MENTION.test(text);
}

// The session's host-owned directory, read-only, at a path whose every ancestor is a mountpoint or root-owned, so an
// agent can neither write it nor rename a parent away and recreate it. (A path under the agent's home, like the gws
// accounts directory, can be replaced that way even when the directory itself is mounted read-only.)
const SIGNATURES_DIR = '/workspace/.host/email-signatures';
// The email-composition skill's wrapper. A formatted body is this one fixed style, which hides nothing, around text.
export const FORMATTED_WRAPPER =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">';
const FORMATTED_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const FORMATTED_HREF = /^(?:https?:\/\/|mailto:)[^\s"'<>&]+$/;
// Bidi overrides and isolates can reorder text differently in a chat client and a mail client.
const BIDI_CONTROL = /[‪-‮⁦-⁩]/;

/**
 * The text a recipient reads from a formatted body, when the body is exactly the skill's wrapper holding `<p>`
 * paragraphs (with `<br>`), `<ul><li>` items and `<a href>` links of plain text, optionally followed by the account's
 * Gmail signature as the host keeps it on file. Any other tag, attribute, entity or style returns null, so the card
 * keeps the command.
 */
export function formattedText(html: string, signature: string | null): { text: string; signed: boolean } | null {
    if (BIDI_CONTROL.test(html)) return null;
    let i = 0;
    const take = (token: string): boolean => {
        if (!html.startsWith(token, i)) return false;
        i += token.length;
        return true;
    };
    const skipSpace = (): void => {
        while (html[i] === ' ' || html[i] === '\n') i++;
    };
    // Whitespace is collapsed once, over a whole composed line, as a mail client does: a link's edge spaces still separate words.
    const shownLine = (line: string): string => line.replace(/[ \t\n]+/g, ' ').trim();
    // A link's destination is listed after its block, never written into the text, so the text stays what the recipient
    // reads. The marker can't appear in the text, or a fake listing could sit beside a real one.
    const LINK_MARKER = '↳';
    let links: string[] = [];
    // Inline content up to `close`, unnormalized: text, the five escape entities, and, where allowed, `<br>` and links.
    const inline = (close: string, inBlock: boolean): string[] | null => {
        const lines: string[] = [''];
        for (;;) {
            if (take(close)) break;
            if (i >= html.length) return null;
            if (html[i] === '<') {
                if (inBlock && take('<br>')) {
                    lines.push('');
                    continue;
                }
                if (!inBlock || !take('<a href="')) return null;
                const end = html.indexOf('">', i);
                if (end < 0) return null;
                const href = html.slice(i, end);
                if (!FORMATTED_HREF.test(href)) return null;
                i = end + 2;
                const label = inline('</a>', false)?.join('');
                if (label === undefined || !shownLine(label)) return null;
                lines[lines.length - 1] += label;
                if (shownLine(label) !== href) links.push(`${LINK_MARKER} link "${shownLine(label)}": ${href}`);
                continue;
            }
            if (html[i] === '&') {
                const entity = /^&(?:amp|lt|gt|quot|#39);/.exec(html.slice(i, i + 6))?.[0];
                if (!entity) return null;
                lines[lines.length - 1] += FORMATTED_ENTITIES[entity];
                i += entity.length;
                continue;
            }
            if (html[i] === LINK_MARKER) return null;
            lines[lines.length - 1] += html[i++];
        }
        return lines;
    };
    const shownBlock = (lines: string[] | null): string | null => {
        const shown = lines?.map(shownLine);
        const listed = links;
        links = [];
        return shown?.every(Boolean) ? [...shown, ...listed].join('\n') : null;
    };
    skipSpace();
    if (!take(FORMATTED_WRAPPER)) return null;
    const blocks: string[] = [];
    for (;;) {
        skipSpace();
        if (take('</div>')) break;
        if (take('<p>')) {
            const paragraph = shownBlock(inline('</p>', true));
            if (paragraph === null) return null;
            blocks.push(paragraph);
        } else if (take('<ul>')) {
            const items: string[] = [];
            for (skipSpace(); !take('</ul>'); skipSpace()) {
                if (!take('<li>')) return null;
                const item = shownBlock(inline('</li>', false));
                if (item === null) return null;
                items.push(`- ${item}`);
            }
            if (!items.length) return null;
            blocks.push(items.join('\n'));
        } else {
            return null;
        }
    }
    if (!blocks.length) return null;
    skipSpace();
    const rest = html.slice(i);
    if (rest && rest !== signature) return null;
    return { text: blocks.join('\n\n'), signed: rest !== '' };
}

/** The refusal for a reply gws would send without people the original names in a header it does not read. */
export function leftOffRefusal(addresses: string[], replyAll: boolean): string {
    const list = addresses.join(',');
    return `Email reply refused: gws would leave off ${addresses.join(', ')}. The original message names ${addresses.length === 1 ? 'that address' : 'them'} ` +
        `in a ${replyAll ? 'To, Cc or Reply-To' : 'Reply-To'} header spelled another way (such as CC), which gws does not read. Run the send again ` +
        `with --cc ${list} added${replyAll ? `, or --remove ${list} if ${addresses.length === 1 ? 'they should' : 'they should all'} be left off` : ''}.`;
}

export const SEND_ALONE =
    'Email send refused: run it as its own Bash command. That command may hold only the gws gmail call, with ' +
    'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE and, beside it when needed, GOOGLE_WORKSPACE_CLI_CONFIG_DIR (an absolute ' +
    'path that does not exist yet) each set on it or exported on the line before, and, for the text, one ' +
    "BODY=$(cat <<'EOF' … EOF) or BODY='…' line before it. Make any folder, draft file or other step in a separate " +
    'Bash call first. Write values plainly: no globs, ~, $\'…\', escapes, command substitution or other variables. ' +
    'It may end with 2>&1 | tail -N or | head -N.';

const FRESH_CONFIG_DIR = 'an absolute path that does not exist yet, a new one for each send, since gws writes its token cache there';

/** Why gws would send from another account than the credentials file the command names; null when it would not. */
function sendAccountRefusal(shape: SendShape, defaultConfigDir: string): string | null {
    if (shape.credentialsFile === null) return null;
    if (shape.configDir !== null) {
        const held = gwsLoginIn(shape.configDir);
        if (held === null) {
            return `Email send refused: the gate could not read GOOGLE_WORKSPACE_CLI_CONFIG_DIR ${shape.configDir} to check that ` +
                `it holds no gws login. Set it to ${FRESH_CONFIG_DIR}.`;
        }
        if (!held.length) return null;
        return `Email send refused: GOOGLE_WORKSPACE_CLI_CONFIG_DIR ${shape.configDir} holds a gws login (${held.join(', ')}), ` +
            'and gws would send with it instead of GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, from a mailbox the approval card ' +
            `does not name. Set it to ${FRESH_CONFIG_DIR}.`;
    }
    const held = gwsLoginIn(defaultConfigDir);
    if (held !== null && !held.length) return null;
    return `Email send refused: gws keeps a login in ${defaultConfigDir}${held ? ` (${held.join(', ')})` : ''}, and would send with ` +
        'it instead of GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, from a mailbox the approval card does not name. Run the send ' +
        `again with GOOGLE_WORKSPACE_CLI_CONFIG_DIR set beside the credentials file to ${FRESH_CONFIG_DIR}, for example: ` +
        `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/gws-send-1 GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${shape.credentialsFile} gws gmail …`;
}

// ── The one shape a send may take ──
// A general shell parser can't prove a summary matches what bash runs; bash rewrites words in too many ways. So a send
// is its own command in a small grammar: unconditional lines, words bash leaves as written apart from a whole
// "$BODY", and a quoted heredoc only to fill the body.

const SHAPE_PLAIN = /^[\w@%+=:,./-]+/;
// Options whose values the summary shows; `--format` only shapes what gws prints back.
const SHAPE_OPTIONS = new Set(['--to', '--cc', '--bcc', '--subject', '--body', '--from', '--message-id', '--remove', '--format', '-a', '--attach']);
const SHAPE_REPEATABLE = new Set(['-a', '--attach']);
const SHAPE_CREDENTIALS = /^GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=(?:(?!\/accounts\/)[^\s'"$`\\])*\/accounts\/([\w.@+-]+)\.json$/;
const SHAPE_CONFIG_DIR = /^GOOGLE_WORKSPACE_CLI_CONFIG_DIR=(\/[\w@%+=:,./-]*)$/;

interface ShapeWord {
    source: string;
    value: string;
    variable: string | null;
}

interface ShapeStatement {
    words: ShapeWord[];
    pipe: ShapeWord[] | null;
    stderrToStdout: boolean;
    heredoc: { name: string; value: string } | null;
}

interface SendShape {
    verb: 'send' | 'reply' | 'reply-all' | 'forward' | null;
    options: Map<string, string[]>;
    html: boolean;
    body?: string;
    account: string | null;
    credentialsFile: string | null;
    configDir: string | null;
    /** Every option is one the summary shows, each single-valued one given once. */
    complete: boolean;
    /** The words after `users <resource> send` in the raw API form; null for a helper verb. */
    raw: { resource: string; words: ShapeWord[] } | null;
}

/** One word: a plain run, single-quoted text, double-quoted text with no expansion, or exactly "$NAME". */
function shapeWord(command: string, i: number): { word: ShapeWord; end: number } | null {
    let j = i;
    const assignment = /^[A-Za-z_]\w*=/.exec(command.slice(j, j + 256));
    const prefix = assignment && /['"]/.test(command[j + assignment[0].length] ?? '') ? assignment[0] : '';
    j += prefix.length;
    let value: string;
    let variable: string | null = null;
    if (command[j] === "'") {
        const close = command.indexOf("'", j + 1);
        if (close < 0) return null;
        value = command.slice(j + 1, close);
        j = close + 1;
    } else if (command[j] === '"') {
        const close = command.indexOf('"', j + 1);
        if (close < 0) return null;
        const inner = command.slice(j + 1, close);
        const named = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(inner);
        if (named && !prefix) {
            variable = named[1] ?? named[2];
            value = '';
        } else if (/^[^$`\\!]*$/.test(inner)) {
            value = inner;
        } else {
            return null;
        }
        j = close + 1;
    } else {
        const run = SHAPE_PLAIN.exec(command.slice(j));
        if (!run) return null;
        value = run[0];
        j += run[0].length;
    }
    // Two pieces joined into one word (`'a'"b"`, `x'y'`) are refused rather than read.
    if (j < command.length && !/[ \t\n;|]/.test(command[j])) return null;
    return { word: { source: command.slice(i, j), value: prefix + value, variable }, end: j };
}

function shapeStatements(command: string): ShapeStatement[] | null {
    // bash drops a NUL and may read other control characters differently (a NUL inside a heredoc's last line ends it early).
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) return null;
    const statements: ShapeStatement[] = [];
    const blank = (): ShapeStatement => ({ words: [], pipe: null, stderrToStdout: false, heredoc: null });
    let current = blank();
    let words = current.words;
    const flush = (): boolean => {
        if (current.words.length || current.heredoc) statements.push(current);
        else if (current.pipe || current.stderrToStdout) return false;
        current = blank();
        words = current.words;
        return true;
    };
    let i = 0;
    while (i < command.length) {
        const c = command[i];
        if (c === ' ' || c === '\t') {
            i++;
        } else if (c === '\n' || c === ';') {
            // bash refuses a `;` with nothing before it (`;;`, a leading `;`); a blank line is fine.
            if (c === ';' && !current.words.length && !current.heredoc) return null;
            if (!flush()) return null;
            i++;
        } else if (c === '|') {
            if (current.pipe || !current.words.length) return null;
            current.pipe = [];
            words = current.pipe;
            i++;
        } else if (command.startsWith('2>&1', i) && /^(?:[ \t\n;|]|$)/.test(command.slice(i + 4, i + 5))) {
            if (current.stderrToStdout || current.pipe || !current.words.length) return null;
            current.stderrToStdout = true;
            i += 4;
        } else {
            const heredoc = !current.words.length && !current.heredoc
                ? /^([A-Za-z_]\w*)=\$\(cat <<'([A-Za-z_]+)'\n/.exec(command.slice(i, i + 300))
                : null;
            if (heredoc) {
                const bodyStart = i + heredoc[0].length;
                const close = `\n${heredoc[2]}\n)`;
                const at = command.indexOf(close, bodyStart - 1);
                if (at < 0) return null;
                const text = command.slice(bodyStart, Math.max(bodyStart, at));
                // bash ends the heredoc at the first line that is the delimiter alone.
                if (text.split('\n').includes(heredoc[2])) return null;
                // Command substitution drops the trailing newlines.
                current.heredoc = { name: heredoc[1], value: text.replace(/\n+$/, '') };
                i = at + close.length;
                if (i < command.length && !/[ \t\n;]/.test(command[i])) return null;
                continue;
            }
            const read = shapeWord(command, i);
            if (!read) return null;
            words.push(read.word);
            i = read.end;
        }
    }
    return flush() ? statements : null;
}

type ShapeAssignment = { name: 'credentials'; account: string; file: string } | { name: 'configDir'; dir: string };

/** The one gws assignment a word makes, read from its source so no quoting can change it; null for any other word. */
function shapeAssignment(word: ShapeWord | undefined): ShapeAssignment | null {
    const creds = word ? SHAPE_CREDENTIALS.exec(word.source) : null;
    if (creds) return { name: 'credentials', account: creds[1], file: creds[0].slice(creds[0].indexOf('=') + 1) };
    const dir = word ? SHAPE_CONFIG_DIR.exec(word.source) : null;
    return dir ? { name: 'configDir', dir: dir[1] } : null;
}

/**
 * The send, read from the command, when the command is one optional credentials export, one optional body assignment,
 * then the gws gmail call with nothing after it but `2>&1` and one head or tail; null for anything else.
 */
function sendShape(command: string): SendShape | null {
    const statements = shapeStatements(command);
    const send = statements?.at(-1);
    if (!statements || !send || send.heredoc) return null;
    // Each of the two names once, exported on a line before the call or set on it.
    const set: { creds: { account: string; file: string } | null; configDir: string | null } = { creds: null, configDir: null };
    const assign = (word: ShapeWord | undefined): boolean => {
        const a = shapeAssignment(word);
        if (a?.name === 'credentials' && set.creds === null) set.creds = { account: a.account, file: a.file };
        else if (a?.name === 'configDir' && set.configDir === null) set.configDir = a.dir;
        else return false;
        return true;
    };
    let body: { name: string; value: string } | null = null;
    for (const s of statements.slice(0, -1)) {
        if (s.pipe || s.stderrToStdout) return null;
        // Only BODY: assigning any other name could change the account (the credentials file) or the program run (PATH).
        if (s.heredoc?.name === 'BODY' && !s.words.length && !body) {
            body = s.heredoc;
        } else if (s.words.length === 2 && !s.heredoc && s.words[0].source === 'export') {
            if (!assign(s.words[1])) return null;
        } else if (s.words.length === 1 && !s.heredoc && !body && /^BODY=['"]/.test(s.words[0].source)) {
            body = { name: 'BODY', value: s.words[0].value.slice('BODY='.length) };
        } else {
            return null;
        }
    }
    let words = send.words;
    while (/^[A-Za-z_]\w*=/.test(words[0]?.source ?? '')) {
        if (!assign(words[0])) return null;
        words = words.slice(1);
    }
    // A config directory with no credentials file leaves gws to find a login of its own.
    const { creds, configDir } = set;
    if (configDir !== null && creds === null) return null;
    if (words[0]?.source !== 'gws' || words[1]?.source !== 'gmail') return null;
    const pipe = send.pipe?.map(w => w.source).join(' ');
    if (pipe !== undefined && !/^(?:head|tail) (?:-\d+|-n \d+)$/.test(pipe)) return null;
    let rest = words.slice(2);
    let verb: SendShape['verb'];
    let raw: SendShape['raw'] = null;
    const helper = /^\+(send|reply|reply-all|forward)$/.exec(rest[0]?.source ?? '');
    if (helper) {
        verb = helper[1] as SendShape['verb'];
        rest = rest.slice(1);
    } else if (rest[0]?.source === 'users' && /^(?:messages|drafts)$/.test(rest[1]?.source ?? '') && rest[2]?.source === 'send') {
        verb = null;
        raw = { resource: rest[1].source, words: rest.slice(3) };
        rest = rest.slice(3);
    } else {
        return null;
    }
    const options = new Map<string, string[]>();
    let html = false;
    let complete = verb !== null;
    let bodyUsed = false;
    for (let k = 0; k < rest.length; k++) {
        const word = rest[k];
        if (word.variable !== null) {
            if (rest[k - 1]?.source !== '--body' || word.variable !== body?.name) return null;
            bodyUsed = true;
            continue;
        }
        if (!complete) continue;
        if (word.source === '--html') {
            if (html) complete = false;
            html = true;
            continue;
        }
        const value = rest[k + 1];
        if (!SHAPE_OPTIONS.has(word.source) || !value || (options.has(word.source) && !SHAPE_REPEATABLE.has(word.source))) {
            complete = false;
            continue;
        }
        k++;
        if (value.variable !== null) {
            if (word.source !== '--body' || value.variable !== body?.name) return null;
            bodyUsed = true;
        }
        options.set(word.source, [...(options.get(word.source) ?? []), value.variable !== null ? body!.value : value.value]);
    }
    // A variable set and never read is a step of its own.
    if (body && !bodyUsed) return null;
    return {
        verb, options, html, account: creds?.account ?? null, credentialsFile: creds?.file ?? null, configDir, complete, raw,
        body: options.get('--body')?.[0],
    };
}

// ── Who a reply reaches ──
// gws builds a reply's envelope from the original message, so the command alone never names who a reply reaches. The
// card reads the original with the send's own account and works the envelope out as gws 0.22.5 does
// (helpers/gmail/reply.rs and mod.rs): a reply goes To the Reply-To addresses, else the From address; a reply-all also
// puts the original To and Cc on Cc, leaves out the account's primary address, its From identity and `--remove`, and
// when the original came from that account goes To the original To with the original Cc on Cc. `--to`, `--cc` and
// `--bcc` add to those, and an address is kept only in the first of To, Cc and Bcc that names it. gws reads only the
// headers spelled exactly From, Reply-To, To and Cc; Gmail keeps the sender's spelling, and Outlook writes `CC`.

const READ_HEADERS: Record<string, 'replyTo' | 'to' | 'cc'> = { 'Reply-To': 'replyTo', To: 'to', Cc: 'cc' };
// Addresses from a third party's headers reach the card and the refusal's suggested option, so only plain ones are shown.
const PLAIN_ADDRESS = /^[^\s@<>()[\],;:"'`|\\$&*?!{}]+@[^\s@<>()[\],;:"'`|\\$&*?!{}]+$/;

/** gws's address-list split: commas outside double quotes, with a backslash escaping a quote inside them. */
function splitMailboxList(header: string): string[] {
    const out: string[] = [];
    let inQuotes = false;
    let start = 0;
    let escaped = false;
    for (let i = 0; i < header.length; i++) {
        const ch = header[i];
        if (ch === '\\' && inQuotes) {
            escaped = !escaped;
            continue;
        }
        if (ch === '"' && !escaped) inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) {
            const token = header.slice(start, i).trim();
            if (token) out.push(token);
            start = i + 1;
        }
        escaped = false;
    }
    const token = header.slice(start).trim();
    if (token) out.push(token);
    return out;
}

/** The address gws takes from one mailbox: what the last `<…>` holds, else the whole text, less ASCII control characters. */
function mailboxAddress(raw: string): string {
    const text = raw.trim();
    const open = text.lastIndexOf('<');
    const close = open < 0 ? -1 : text.indexOf('>', open);
    return (close < 0 ? text : text.slice(open + 1, close).trim()).replace(/[\x00-\x1f\x7f]/g, '');
}

function addressList(raw: string | undefined): string[] {
    return raw ? splitMailboxList(raw).map(mailboxAddress).filter(Boolean) : [];
}

/** Keep each address once, in order, leaving out any already in `taken` (which this fills). */
function firstOnly(addresses: string[], taken: Set<string>, excluded: Set<string> = new Set()): string[] {
    return addresses.filter(a => {
        const key = a.toLowerCase();
        if (!key || excluded.has(key) || taken.has(key)) return false;
        taken.add(key);
        return true;
    });
}

interface ReplyRecipients {
    to: string[];
    cc: string[];
    bcc: string[];
    /** Addresses the original names in a header gws does not read (`CC`, `TO`, `Reply-to`) that this reply leaves off. */
    leftOff: string[];
}

interface ReplyRead {
    headers: Array<{ name: string; value: string }>;
    /** The account's primary address and its From identity; reply-all leaves both out. */
    self: string[];
}

/** The original's headers and, for a reply-all, the account's own addresses; null when any read gws itself needs fails. */
function readReplyContext(messageId: string, replyAll: boolean, fromOption: string | undefined, credentialsFile: string, gwsBin: string, configDir: string): ReplyRead | null {
    const message = gwsRead(['users', 'messages', 'get'], {
        userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'Reply-To', 'To', 'Cc', 'Message-ID'],
    }, credentialsFile, gwsBin, configDir);
    const raw = (message?.payload as { headers?: unknown } | undefined)?.headers;
    if (message?.id !== messageId || !Array.isArray(raw)) return null;
    const headers = raw.flatMap(h => typeof h?.name === 'string' && typeof h?.value === 'string' ? [{ name: h.name as string, value: h.value as string }] : []);
    if (!replyAll) return { headers, self: [] };
    const primary = gwsRead(['users', 'getProfile'], { userId: 'me' }, credentialsFile, gwsBin, configDir)?.emailAddress;
    if (typeof primary !== 'string' || !primary) return null;
    // With no --from, gws sends as the default send-as identity. It goes on without one when its own read of that list
    // fails, which a failed read here does not show, so that case is left unresolved.
    let identity: string | undefined = addressList(fromOption)[0];
    if (identity === undefined) {
        const sendAs = gwsRead(['users', 'settings', 'sendAs', 'list'], { userId: 'me' }, credentialsFile, gwsBin, configDir)?.sendAs;
        if (!Array.isArray(sendAs)) return null;
        const fallback = sendAs.find(e => e?.isDefault === true)?.sendAsEmail;
        identity = typeof fallback === 'string' ? mailboxAddress(fallback) : undefined;
    }
    return { headers, self: [mailboxAddress(primary), ...(identity ? [identity] : [])] };
}

/** Who gws sends a reply to, from the original's headers and the command's options; null when gws would refuse to build it. */
function replyRecipients(
    replyAll: boolean,
    read: ReplyRead,
    options: { to?: string; cc?: string; bcc?: string; remove?: string },
): ReplyRecipients | { unresolved: string } {
    let from = '';
    let messageIdHeader = '';
    const lists = { replyTo: '', to: '', cc: '' };
    const unread: Array<{ replyTo: boolean; addresses: string[] }> = [];
    for (const { name, value } of read.headers) {
        if (name === 'From') from = value;
        else if (name === 'Message-ID' || name === 'Message-Id') messageIdHeader = value;
        else if (Object.hasOwn(READ_HEADERS, name)) {
            const key = READ_HEADERS[name];
            if (value) lists[key] = lists[key] ? `${lists[key]}, ${value}` : value;
        } else if (/^(?:reply-to|to|cc)$/i.test(name)) {
            unread.push({ replyTo: /^reply-to$/i.test(name), addresses: addressList(value) });
        }
    }
    const messageIdBare = messageIdHeader.trim().replace(/^<(.*)>$/, '$1');
    if (!from || !messageIdBare) return { unresolved: 'gws would refuse to build this reply: the original has no From or Message-ID header it reads' };
    const sender = mailboxAddress(from);
    const replyTo = addressList(lists.replyTo);
    const origTo = addressList(lists.to);
    const origCc = addressList(lists.cc);
    // gws falls back to From only when there is no Reply-To text at all, not when the text holds no address.
    const answerTo = lists.replyTo ? replyTo : [sender];
    const extraCc = addressList(options.cc);
    let to: string[];
    let cc: string[];
    const excluded = new Set<string>();
    const selfReply = replyAll && read.self.some(a => a.toLowerCase() === sender.toLowerCase());
    if (replyAll) {
        for (const a of [...addressList(options.remove), ...read.self]) if (a) excluded.add(a.toLowerCase());
        const inTo = new Set<string>();
        to = firstOnly(selfReply ? origTo : answerTo, inTo, excluded);
        cc = firstOnly([...(selfReply ? origCc : [...origTo, ...origCc]), ...extraCc], new Set(inTo), excluded);
    } else {
        to = answerTo;
        cc = extraCc;
    }
    const taken = new Set<string>();
    const final = {
        to: firstOnly([...to, ...addressList(options.to)], taken),
        cc: firstOnly(cc, taken),
        bcc: firstOnly(addressList(options.bcc), taken),
    };
    if (!final.to.length) return { unresolved: 'gws would refuse to build this reply: no To recipient remains' };
    // A plain reply never takes the original To or Cc, and a reply to the account's own message never takes its Reply-To.
    const missed = unread.filter(u => replyAll ? !(selfReply && u.replyTo) : u.replyTo).flatMap(u => u.addresses);
    const leftOff = firstOnly(missed, new Set(taken), excluded);
    if ([...final.to, ...final.cc, ...final.bcc, ...leftOff].some(a => !PLAIN_ADDRESS.test(a) || HIDDEN_OR_BIDI.test(a) || /\p{Cc}/u.test(a))) {
        return { unresolved: 'an address on the original is not a plain address this card can show as written' };
    }
    return { ...final, leftOff };
}

// ── Sending a stored draft ──
// `gws gmail users drafts send --json '{"id":"…"}'` names only the draft, so the card reads the draft itself.

// The image's root-owned gws: the hook's PATH may differ from the send's, and a gws the agent could write might describe
// one draft while another is sent.
const GWS_BIN = '/pnpm/gws';
const GWS_READ_TIMEOUT_MS = 4000;
const GWS_READ_MAX_BYTES = 8 * 1024 * 1024;
const DRAFT_PREVIEW_CHARS = 400;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,256}$/;
const GMAIL_USER_ID = /^[\w.@+-]{1,256}$/;

interface DraftPart {
    mimeType?: unknown;
    filename?: unknown;
    headers?: unknown;
    body?: { data?: unknown };
    parts?: unknown;
}

interface StoredDraft {
    id: string;
    message: { id: string; snippet?: unknown; payload?: DraftPart };
}

function jsonObjectWithKeys(text: string | undefined, keys: string[]): Record<string, unknown> | null {
    if (text === undefined) return null;
    try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const own = Object.keys(value);
        return own.length === keys.length && keys.every(k => own.includes(k)) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * The draft a command sends, when the command is the one shape, names its credentials file, and passes exactly
 * `--params '{"userId":…}'` and `--json '{"id":…}'`. A payload carrying its own message, or any other option, gets no
 * draft read.
 */
function draftSendTarget(shape: SendShape | null): Omit<DraftBinding, 'messageId'> | null {
    // A relative or ~ path would resolve against the hook's cwd and home, not the shell's.
    const credentialsFile = shape?.credentialsFile;
    if (!shape?.raw || shape.raw.resource !== 'drafts' || !credentialsFile?.startsWith('/')) return null;
    const words = shape.raw.words;
    const given = new Map<string, string>();
    for (let k = 0; k < words.length; k += 2) {
        const name = words[k].source;
        const value = words[k + 1];
        if ((name !== '--params' && name !== '--json') || given.has(name) || !value || value.variable !== null) return null;
        given.set(name, value.value);
    }
    const userId = jsonObjectWithKeys(given.get('--params'), ['userId'])?.userId;
    const draftId = jsonObjectWithKeys(given.get('--json'), ['id'])?.id;
    if (typeof userId !== 'string' || !GMAIL_USER_ID.test(userId) || typeof draftId !== 'string' || !GMAIL_ID.test(draftId)) return null;
    return { draftId, userId, credentialsFile };
}

/**
 * One read-only Gmail API call through gws with the send's credentials, bounded in time and size; null on any failure.
 * Beside a login in `configDir`, gws runs with an empty config directory of its own, so it answers for the credentials.
 */
function gwsRead(method: string[], params: Record<string, unknown>, credentialsFile: string, gwsBin: string, configDir: string): Record<string, unknown> | null {
    return gwsLoginIn(configDir)?.length === 0
        ? gwsReadWith(method, params, credentialsFile, gwsBin, null)
        : inEmptyDir(own => gwsReadWith(method, params, credentialsFile, gwsBin, own));
}

function gwsReadWith(method: string[], params: Record<string, unknown>, credentialsFile: string, gwsBin: string, own: string | null): Record<string, unknown> | null {
    try {
        const run = spawnSync(gwsBin, ['gmail', ...method, '--params', JSON.stringify(params)], {
            env: { ...process.env, GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsFile, ...(own ? { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: own } : {}) },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: GWS_READ_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: GWS_READ_MAX_BYTES,
        });
        if (run.error || run.status !== 0 || typeof run.stdout !== 'string') return null;
        const value = JSON.parse(run.stdout) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** Read a draft through gws; null on any failure, or a reply for another draft. */
function readDraft(target: Omit<DraftBinding, 'messageId'>, format: 'full' | 'minimal', gwsBin: string, configDir: string): StoredDraft | null {
    const draft = gwsRead(['users', 'drafts', 'get'], { userId: target.userId, id: target.draftId, format }, target.credentialsFile, gwsBin, configDir) as Partial<StoredDraft> | null;
    if (draft?.id !== target.draftId || typeof draft.message?.id !== 'string' || !draft.message.id) return null;
    return draft as StoredDraft;
}

/** A text part in the charset its Content-Type declares (UTF-8 when none); null when that can't be done exactly. */
function decodedPart(part: DraftPart): string | null {
    const data = part.body?.data;
    if (typeof data !== 'string') return null;
    const contentType = (Array.isArray(part.headers) ? part.headers as Array<{ name?: unknown; value?: unknown }> : [])
        .find(h => typeof h?.name === 'string' && h.name.toLowerCase() === 'content-type')?.value;
    const charset = typeof contentType === 'string' ? /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] : undefined;
    try {
        return new TextDecoder(charset ?? 'utf-8', { fatal: true }).decode(Buffer.from(data, 'base64url'));
    } catch {
        return null;
    }
}

type DraftEnvelope = { to?: string; from?: string; subject?: string; cc?: string; bcc?: string };

// Characters a chat client shows as nothing, or that reorder the text around them.
const HIDDEN_OR_BIDI = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E007F}]/u;
// The variation selector and joiner inside an ordinary emoji (❤️, 👩‍💻) are how it renders, not hidden text.
const EMOJI_JOINERS = /(\p{Extended_Pictographic})️?(?:‍(?=\p{Extended_Pictographic}))?/gu;
// What chat Markdown restyles in a one-line field; a "Name <address>" header defused to ‹ is still readable.
const FIELD_MARKUP = /[`*~|]|\{\{emoji:/i;
const DRAFT_MAX_PARTS = 500;
const DRAFT_MAX_DEPTH = 20;

interface DraftView {
    envelope: DraftEnvelope;
    /** The text recipients read: the HTML part as text when there is one, since mail clients show it first. */
    text: string;
    /** The text's length in characters; null when the body is too long to measure. */
    length: number | null;
    html: boolean;
    attachments: string[];
    /** What the card can't show faithfully, listed first on the card so a cut summary can't drop it. */
    warnings: string[];
}

/** What the card shows of a draft. Every MIME leaf is either the shown text, an attachment, or the reason for a warning. */
function draftContent(draft: StoredDraft): DraftView {
    const envelope: DraftEnvelope = {};
    const root = draft.message.payload ?? {};
    for (const h of Array.isArray(root.headers) ? root.headers as Array<{ name?: unknown; value?: unknown }> : []) {
        const name = typeof h?.name === 'string' ? h.name.toLowerCase() : '';
        const value = typeof h?.value === 'string' ? h.value.trim() : '';
        if (value && (name === 'to' || name === 'from' || name === 'subject' || name === 'cc' || name === 'bcc')) {
            envelope[name] = envelope[name] === undefined ? value : `${envelope[name]}, ${value}`;
        }
    }
    type TextLeaf = { mime: string; text: string | null; parent: DraftPart | null; grandparent: DraftPart | null };
    const texts: TextLeaf[] = [];
    const attachments: string[] = [];
    const warnings: string[] = [];
    // Depth-first, in document order: which version of a multipart/alternative a client prefers depends on order.
    const pending: Array<{ part: DraftPart; depth: number; parent: DraftPart | null; grandparent: DraftPart | null }> =
        [{ part: root, depth: 0, parent: null, grandparent: null }];
    let incomplete = false;
    for (let seen = 0; pending.length; seen++) {
        const { part, depth, parent, grandparent } = pending.pop()!;
        if (seen >= DRAFT_MAX_PARTS) {
            incomplete = true;
            break;
        }
        const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
        const children = Array.isArray(part.parts) ? part.parts.filter((c): c is DraftPart => !!c && typeof c === 'object') : [];
        if (children.length) {
            if (depth >= DRAFT_MAX_DEPTH) {
                incomplete = true;
                continue;
            }
            for (const child of [...children].reverse()) pending.push({ part: child, depth: depth + 1, parent: part, grandparent: parent });
            continue;
        }
        const filename = typeof part.filename === 'string' ? part.filename : '';
        if (!filename && (mime === 'text/plain' || mime === 'text/html')) texts.push({ mime, text: decodedPart(part), parent, grandparent });
        else attachments.push(filename || `unnamed ${mime || 'part'}`);
    }
    if (incomplete) {
        warnings.push('⚠️ This draft has more parts than the card reads; some of its content is not described here. Check the draft before approving.');
    }
    const html = texts.find(t => t.mime === 'text/html');
    const shown = html ?? texts.find(t => t.mime === 'text/plain');
    // The one pair a client may show either side of: a plain part, then its HTML version (alone or with inline images in
    // a multipart/related), under one multipart/alternative. The last version is the preferred one (RFC 2046).
    const isType = (part: DraftPart | null, type: string) => String(part?.mimeType ?? '').toLowerCase() === type;
    const [first, second] = texts;
    const onePairOfVersions = texts.length === 2 && first.mime === 'text/plain' && second.mime === 'text/html'
        && isType(first.parent, 'multipart/alternative') && Array.isArray(first.parent?.parts) && first.parent.parts.length === 2
        && (second.parent === first.parent || (isType(second.parent, 'multipart/related') && second.grandparent === first.parent));
    if (texts.length > 1 && !onePairOfVersions) {
        warnings.push(`⚠️ This draft has ${texts.length} text parts and the card shows one. Check the draft before approving.`);
    }
    if (shown && shown.text === null) warnings.push('⚠️ The text of this draft could not be decoded, so it is not shown. Check the draft before approving.');
    const text = shown?.text ? (shown.mime === 'text/html' ? htmlToText(shown.text) : shown.text.trim()) : '';
    // htmlToText reads only the head of a long body, so its length is a floor.
    const length = shown?.mime === 'text/html' && (shown.text?.length ?? 0) > HTML_MAX_CHARS ? null : [...text].length;
    const fields = Object.values(envelope);
    if ([text, ...fields, ...attachments].some(v => HIDDEN_OR_BIDI.test(v.replace(EMOJI_JOINERS, '$1')))) {
        warnings.push('⚠️ This draft holds invisible or direction-changing characters, so recipients may read it differently from this card.');
    }
    if (fields.some(v => FIELD_MARKUP.test(v) || CHAT_MENTION.test(v))) {
        warnings.push('⚠️ A header in this draft holds characters chat formatting may change, so it may not read here exactly as sent.');
    }
    return { envelope, text, length, html: shown?.mime === 'text/html', attachments, warnings };
}

/**
 * Re-read an approved draft just before its send runs: null when it is still the version the card showed, otherwise
 * the refusal to give the agent. A failed read refuses too, since nothing else shows this is the approved version.
 * Gmail has no conditional send, so an edit in the moment between this read and the send is not seen.
 */
export function draftChangedSince(binding: DraftBinding, gwsBin: string = GWS_BIN, configDir: string = defaultGwsConfigDir()): string | null {
    const now = readDraft(binding, 'minimal', gwsBin, configDir);
    if (now === null) {
        return `Email send refused: draft ${binding.draftId} could not be re-read to confirm it is the version that was ` +
            'approved. Ask for approval again with the same command.';
    }
    if (now.message.id === binding.messageId) return null;
    return `Email send refused: draft ${binding.draftId} was edited after its approval card was shown, so the approval ` +
        'does not cover what it holds now. Ask for approval again with the same command; the new card shows the current draft.';
}

// The regex fallback runs only when the parser finds no send; it is quadratic
// on hostile input, and recipients sit near the front of a real command.
const FALLBACK_SCAN_CHARS = 64 * 1024;

const SEND_VERB = /^\+(send|reply|reply-all|forward)$/;

interface GwsGmailCall {
    /** null when the call is not a recognisable send (another verb, or an obfuscated one). */
    verb: 'send' | 'reply' | 'reply-all' | 'forward' | null;
    /** Source text of the word after `gmail`. */
    verbText: string;
    helper: boolean;
    /** Source text of each argument after the verb. */
    texts: string[];
    /** Quote-removed value of each argument, unexpanded. */
    values: string[];
    pos: number;
}

/** Every `gws gmail …` call in the command, sends or not. */
function gwsGmailCalls(view: ShellView): GwsGmailCall[] {
    const calls: GwsGmailCall[] = [];
    for (const c of view.commands) {
        const texts = [c.name, ...c.argTexts];
        const values = texts.map(t => evalWord(t, view, c.pos).value);
        const at = values.indexOf('gws');
        if (at < 0 || values[at + 1] !== 'gmail') continue;
        const rest = values.slice(at + 2);
        const helper = rest[0]?.match(SEND_VERB)?.[1] as GwsGmailCall['verb'] | undefined;
        const raw = rest[0] === 'users' && (rest[1] === 'messages' || rest[1] === 'drafts') && rest[2] === 'send';
        const skip = at + 2 + (helper ? 1 : raw ? 3 : 0);
        calls.push({ verb: helper ?? (raw ? 'send' : null), verbText: texts[at + 2] ?? '', helper: !!helper, texts: texts.slice(skip), values: values.slice(skip), pos: c.pos });
    }
    return calls;
}

/** Source text of every value given for `flag`, in `--flag value` and `--flag=value` forms. */
function argTexts(call: GwsGmailCall, flag: string): string[] {
    const out: string[] = [];
    call.values.forEach((v, i) => {
        if (v === flag && i + 1 < call.texts.length) out.push(call.texts[i + 1]);
        else if (v.startsWith(`${flag}=`)) out.push(call.texts[i].replace(/^[^=]*=/, ''));
    });
    return out;
}

/** Turn the `--body` argument into the text that will be sent, when the command shows it. */
function resolveBody(
    text: string | undefined,
    view: ShellView,
    pos: number,
    cwd: string | undefined,
    evaluated: (text: string) => string,
): { text: string | null; note?: string } {
    if (text === undefined) return { text: null, note: 'No `--body` was given.' };
    const name = soleVariable(text);
    if (name) {
        const value = view.valueAt(name, pos);
        // Unquoted, the shell splits the value into several arguments.
        if (value?.kind === 'text' && !text.startsWith('"') && /\s/.test(value.value)) {
            return { text: null, note: `${code(text)} is unquoted, so the shell splits it into several arguments; the text sent is not what it holds.` };
        }
        if (value?.kind === 'text') return { text: value.value };
        if (value?.kind === 'file') {
            const file = readBodyFile(value.path, cwd);
            return file === null
                ? { text: null, note: `The text is read from ${code(value.path)} when the command runs; that file is not shown here (missing, not an email-type file, or outside the working directories).` }
                : { text: file, note: `Read from ${code(value.path)} when approval was requested.` };
        }
        return { text: null, note: `The text comes from ${code(text)}, which is only set when the command runs.` };
    }
    return { text: evaluated(text) };
}
