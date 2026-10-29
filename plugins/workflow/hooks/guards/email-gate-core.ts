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
import { gatedSlackPosts, noteSendParts, resolveCommand, soleCommand, walkCommandNodes } from './block-destructive-core';
import { CARD_SUMMARY_MAX_CHARS, clip, code, evalWord, fitLines, htmlToText, inline, parseShell, quoteBlock, readBodyFile, soleVariable, viewShell, type ShellView } from './gate-card-core';

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
        // A quoted span that is no option's value can be `--` ("--", $'\055\055'), after which gws reads the flag as text.
        if (tokens[j].includes(QUOTED_SPAN_SENTINEL) && !(tokens[j - 1].startsWith('-') && !tokens[j - 1].includes('='))) return false;
        if (!EMAIL_BYPASS_FLAGS.has(tokens[j])) continue;
        const prev = tokens[j - 1];
        const prevConsumesValue = prev.startsWith('-') && !prev.includes('='); // bare -x/--opt eats next word
        if (!prevConsumesValue) return true; // a real, standalone gws option
    }
    return false;
}

// gws gmail options that take no value, so a bypass flag after one is still an option.
const GWS_BOOLEAN_OPTIONS = new Set(['--html', '--dry-run', '--draft', '--help', '-h', '--no-original-attachments']);
// Commands a probe may pipe through or run beside gws: none sends mail, runs
// another command, or changes shell state a later gws call could read.
const PROBE_COMPANIONS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'jq', 'wc', 'uniq', 'cut', 'tr', 'cat', 'echo', 'printf', 'true', ':', 'sleep']);
// Variables a probe may set. Anything that changes how a later command is found
// or started (PATH, BASH_ENV, LD_PRELOAD, IFS, …) or how gws behaves (its own
// GOOGLE_*/GWS_* settings other than the credentials file) is refused.
const PROBE_VARIABLE_DENY = /^(?:PATH|EXECIGNORE|GLOBIGNORE|POSIXLY_CORRECT|CDPATH|IFS|ENV|BASH_ENV|BASH\w*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|LD_\w+|DYLD_\w+|GCONV_PATH|HOSTALIASES|NODE_\w+|HOME|XDG_\w+|TMPDIR|LANG|LC_\w+|GREP_\w+|GWS_\w+|GOOGLE_\w+)$/;
const PROBE_VARIABLE_ALLOW = new Set(['GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE']);

/**
 * gws is the command this node runs, reached through nothing but `command`, `time`, `nice [-n N]`, `timeout DURATION`
 * or `env NAME=VALUE…`, each written plainly. A package runner (npx, bunx, pnpm exec, …) can supply its own gws, sudo
 * looks it up on another PATH, and a quoted or escaped word, or another wrapper option, could move the command
 * position, so any of those means this is not the installed gws.
 */
function gwsReachedDirectly(node: any): boolean {
    const words = [node.name, ...(node.suffix || [])].map((w: any) => ({ text: String(w?.text ?? ''), value: String(w?.value ?? w?.text ?? '') }));
    const at = (i: number) => words[i]?.value ?? '';
    for (let i = 0; i < words.length && words[i].text === words[i].value; ) {
        const word = words[i++].value;
        if (word === 'gws') return true;
        if (word === 'command' || word === 'time') continue;
        if (word === 'nice') {
            if (at(i) === '-n' && /^-?\d+$/.test(at(i + 1))) i += 2;
            else if (/^-\d+$/.test(at(i))) i++;
        } else if (word === 'timeout') {
            if (!/^\d+(?:\.\d+)?[smhd]?$/.test(at(i))) return false;
            i++;
        } else if (word === 'env') {
            while (/^[A-Za-z_]\w*=/.test(at(i))) i++;
        } else {
            return false;
        }
    }
    return false;
}

// Shell constructs a probe never needs. Each can run or repeat a command, or set a variable, outside a plain command list.
const PROBE_COMPOUND_NODES = new Set(['For', 'ArithmeticFor', 'While', 'If', 'Case', 'Function', 'BraceGroup', 'Subshell', 'Select', 'Coproc', 'ArithmeticCommand', 'TestCommand', 'CompoundList']);

function onlyPlainCommands(node: unknown, seen = new WeakSet<object>()): boolean {
    if (!node || typeof node !== 'object' || seen.has(node)) return true;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string' && PROBE_COMPOUND_NODES.has(record.type)) return false;
    for (const child of Object.values(record)) if (!onlyPlainCommands(child, seen)) return false;
    // unbash computes a word's parts (and the scripts inside them) lazily, so they are not own properties.
    return !('text' in record && !Object.prototype.hasOwnProperty.call(record, 'parts')) || onlyPlainCommands(record.parts, seen);
}

function probeMaySet(name: string): boolean {
    return /^[A-Za-z_]\w*$/.test(name) && (PROBE_VARIABLE_ALLOW.has(name) || !PROBE_VARIABLE_DENY.test(name));
}

// A probe opens a substitution or subshell a handful of times; past this it is
// not a probe, and parsing it a second time would double the cost of a deep nest.
const PROBE_PARENS_MAX = 64;

// A sed script that only prints or deletes lines: `1,40p`, `/^x/p`, `$d`.
const SED_PRINT_ONLY = /^(?:(?:\d+|\$|\/[^/\n]*\/)(?:,(?:\d+|\$|\/[^/\n]*\/))?)?[pd]$/;
// sed options that only change how lines are matched or whether they print by default.
const SED_QUIET_OPTIONS = /^(?:-[nEr]+|--quiet|--silent|--regexp-extended|--posix)$/;

/**
 * The number of files sed reads when every script it is given (`-e S`, `-eS`, `-neS`, `--expression[=]S`, or the
 * first operand when there is no -e) only prints or deletes lines and no option is anything else (no -i, -f, -s, -z,
 * `--`); null otherwise. The remaining operands are the files it reads.
 */
function sedPrintOnlyFiles(args: string[]): number | null {
    const scripts: string[] = [];
    const operands: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (SED_QUIET_OPTIONS.test(a)) continue;
        const attached = a.match(/^-[nEr]*e(.*)$/s) ?? a.match(/^--expression=(.*)$/s);
        if (attached && attached[1] !== '') scripts.push(attached[1]);
        else if (attached || a === '--expression') {
            if (i + 1 >= args.length) return null;
            scripts.push(args[++i]);
        } else if (a.startsWith('-')) return null;
        else operands.push(a);
    }
    if (scripts.length === 0) scripts.push(...operands.splice(0, 1));
    return scripts.length > 0 && scripts.every(sc => SED_PRINT_ONLY.test(sc)) ? operands.length : null;
}

// Word parts whose value the shell splits or globs, so one word can become
// several arguments (an injected `--`, or a flag where the parser saw a value).
const SPLITTING_PARTS = new Set(['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion', 'ArithmeticExpansion', 'ProcessSubstitution', 'BraceExpansion', 'ExtendedGlob']);

function wordIsFixed(word: any): boolean {
    const parts = word?.parts;
    if (!Array.isArray(parts)) return typeof word?.value === 'string' && !/[$`*?[{]/.test(word.value);
    return parts.every((p: any) => !SPLITTING_PARTS.has(p?.type) && !(p?.type === 'Literal' && /[*?[{]/.test(p.value ?? '')));
}

/**
 * True when the word is the same text however the shell runs: plain characters and single- or double-quoted text, with
 * no expansion, and outside quotes no escape, glob or brace. ANSI-C `$'\055e'` and locale `$"…"` quoting are refused,
 * since the parser keeps their escapes while bash turns them into other characters (`$'\055e'` is `-e`).
 */
function wordIsLiteral(word: any): boolean {
    const plain = (text: unknown) => typeof text === 'string' && !/[$`\\*?[{]/.test(text);
    const quoted = (text: unknown) => typeof text === 'string' && !/[$`]/.test(text);
    const parts = word?.parts;
    if (!Array.isArray(parts)) return word?.text === word?.value && plain(word?.text);
    return parts.every((p: any) => p?.type === 'SingleQuoted'
        || (p?.type === 'Literal' && plain(p.text))
        || (p?.type === 'DoubleQuoted' && (p.parts || []).every((q: any) => q?.type === 'Literal' && quoted(q.text))));
}

/** Short options a companion takes: `flags` stand alone or cluster, `valued` take the rest of the word or the next one. */
interface CompanionOptions {
    flags: string;
    valued: string;
    /** Long options and how many following words each takes when not written `--name=value`. */
    long?: Record<string, number>;
    /** Accepts `-NUM`, as head, tail and grep do. */
    numeric?: boolean;
}

const GREP_OPTIONS: CompanionOptions = {
    flags: 'EFGPiyvwxcLlnhHoqsrRabTUzZ',
    valued: 'eABCm',
    numeric: true,
    long: {
        '--extended-regexp': 0, '--fixed-strings': 0, '--basic-regexp': 0, '--perl-regexp': 0, '--ignore-case': 0,
        '--invert-match': 0, '--word-regexp': 0, '--line-regexp': 0, '--count': 0, '--files-with-matches': 0,
        '--files-without-match': 0, '--line-number': 0, '--no-filename': 0, '--with-filename': 0, '--only-matching': 0,
        '--quiet': 0, '--silent': 0, '--no-messages': 0, '--recursive': 0, '--dereference-recursive': 0, '--text': 0,
        '--color': 0, '--colour': 0, '--regexp': 1, '--max-count': 1, '--after-context': 1, '--before-context': 1,
        '--context': 1, '--include': 1, '--exclude': 1, '--exclude-dir': 1,
    },
};
const HEAD_TAIL_OPTIONS: CompanionOptions = {
    flags: 'qvz',
    valued: 'nc',
    numeric: true,
    long: { '--quiet': 0, '--silent': 0, '--verbose': 0, '--zero-terminated': 0, '--lines': 1, '--bytes': 1 },
};

/**
 * Every option each companion may be given. None of these reads a script or pattern file, runs a program, or writes
 * anywhere, so anything else (grep -f, jq --from-file, printf -v, cd -@, …) is not a probe.
 */
const COMPANION_OPTIONS: Record<string, CompanionOptions> = {
    grep: GREP_OPTIONS,
    egrep: GREP_OPTIONS,
    fgrep: GREP_OPTIONS,
    head: HEAD_TAIL_OPTIONS,
    tail: HEAD_TAIL_OPTIONS,
    cat: { flags: 'AbeEnsStTuv', valued: '' },
    wc: { flags: 'clmwL', valued: '' },
    uniq: { flags: 'cdDiuz', valued: 'fsw' },
    cut: { flags: 'sz', valued: 'bcdf', long: { '--complement': 0, '--only-delimited': 0, '--bytes': 1, '--characters': 1, '--delimiter': 1, '--fields': 1 } },
    tr: { flags: 'cdsCt', valued: '' },
    jq: {
        flags: 'rcnsejaRCMS',
        valued: '',
        long: {
            '--raw-output': 0, '--compact-output': 0, '--null-input': 0, '--slurp': 0, '--exit-status': 0, '--join-output': 0,
            '--ascii-output': 0, '--raw-input': 0, '--color-output': 0, '--monochrome-output': 0, '--sort-keys': 0,
            '--tab': 0, '--indent': 1, '--arg': 2, '--argjson': 2,
        },
    },
    echo: { flags: 'neE', valued: '' },
    cd: { flags: 'LP', valued: '' },
};

function optionsAllowed(name: string, args: string[]): boolean {
    const spec = COMPANION_OPTIONS[name] ?? { flags: '', valued: '' };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') return true;
        if (!a.startsWith('-') || a === '-') continue;
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const takes = spec.long?.[eq === -1 ? a : a.slice(0, eq)];
            if (takes === undefined || (eq !== -1 && takes !== 1)) return false;
            if (eq === -1) i += takes;
            continue;
        }
        if (spec.numeric && /^-\d+$/.test(a)) continue;
        for (let j = 1; j < a.length; j++) {
            if (spec.flags.includes(a[j])) continue;
            if (!spec.valued.includes(a[j])) return false;
            if (j === a.length - 1) i++;
            break;
        }
    }
    return true;
}

// Redirect operators that only read, or that point one descriptor at another (`2>&1`, `>&-`).
const READ_REDIRECTS = new Set(['<', '<<', '<<-', '<<<']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);

/** Every redirect only reads, duplicates a descriptor, or writes to /dev/null: a probe writes no file a later command could run. */
function redirectsWriteNothing(node: any): boolean {
    return (node.redirects || []).every((r: any) => {
        const target = String(r?.target?.text ?? '');
        if (READ_REDIRECTS.has(r?.operator)) return true;
        if (r?.operator === '>&' || r?.operator === '<&') return /^(?:\d+|-)$/.test(target);
        return WRITE_REDIRECTS.has(r?.operator) && target === '/dev/null';
    });
}

// Expansions that run code from a variable's value: `${v@P}` prompt expansion, an array subscript or `${!v}` indirection
// (both evaluate a subscript the value names), and arithmetic (`$((v))`, `$[v]`), which does the same.
const VALUE_EVALUATING_EXPANSION = /\$\{(?![A-Za-z_]\w*\})|\$\(\(|\$\[/;

// `gws gmail users <resource> list|get`: reads mail, never sends it.
const GWS_GMAIL_READ_RE = /^gmail users (?:messages|threads|labels|drafts|history|settings(?: \w+)?) (?:list|get)$/;
// `set` options a probe may use; none changes what a later command runs.
const PROBE_SET_OPTIONS = /^(?:[-+][euxvo]+|pipefail|errexit|nounset|xtrace|verbose)$/;

/** A gws gmail call that only reads: its leading positional words name a list or get method. */
function gwsCallOnlyReads(node: any, args: string[]): boolean {
    if (!(node.suffix || []).every(wordIsFixed)) return false;
    const end = args.findIndex(a => a.startsWith('-'));
    return GWS_GMAIL_READ_RE.test(args.slice(0, end === -1 ? args.length : end).join(' '));
}

/** The real --help, -h, --dry-run or --draft option a gws call holds before any `--`, or null. */
function gwsProbeFlag(node: any, args: string[]): string | null {
    const suffix = node.suffix || [];
    if (!suffix.every(wordIsFixed)) return null;
    const offset = suffix.length - args.length;
    if (offset < 0) return null;
    const takesValue = (arg: string) => arg.startsWith('-') && !arg.includes('=') && !GWS_BOOLEAN_OPTIONS.has(arg);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') return null;
        // A quoted or expanded word may be `--` when the shell runs it ("$B" with B=--, $'\055\055'), unless it is an option's value.
        if (!wordIsLiteral(suffix[i + offset]) && !takesValue(args[i - 1] ?? '')) return null;
        if (!EMAIL_BYPASS_FLAGS.has(args[i])) continue;
        if (!takesValue(args[i - 1] ?? '')) return args[i];
    }
    return null;
}

const GWS_HELP_FLAGS = new Set(['--help', '-h']);

/**
 * True when a command sends no mail: every command bash would run in it
 * (conditions, pipelines, substitutions and function bodies included) is a gws
 * call holding a real --help, -h, --dry-run or --draft option, a gws gmail read,
 * or a read-only filter such as head, grep, jq or a print-only sed. Plain
 * variable assignments are allowed; their substitutions are commands checked
 * the same way. With no gws call at all, the send text is only inside the
 * arguments of those filters, never a command bash runs. A sed that reads files
 * may sit only beside gws help, and `cd` only where no gws runs, since a relative
 * PATH entry would make it pick another gws. Anything else (an unknown command,
 * a name built at run time, a word the shell could split into extra options, a
 * parse error) is not a probe.
 */
export function probeOnlyCommand(command: string): boolean {
    if ((command.match(/\(/g) ?? []).length > PROBE_PARENS_MAX) return false;
    // A `{VAR}>file` redirect assigns VAR (PATH included) outside any assignment word; a probe never needs one.
    if (/\{[A-Za-z_]\w*\}\s*[<>]/.test(command)) return false;
    if (VALUE_EVALUATING_EXPANSION.test(command)) return false;
    let script: any;
    try {
        script = parseShell(command);
    } catch {
        return false;
    }
    if (script?.errors?.length || !onlyPlainCommands(script)) return false;
    // unbash stops at a stray `)` or `}` without reporting an error, leaving the rest of the line unread.
    if (!/^[\s;&]*(?:#[^\n]*)?\s*$/.test(command.slice(script?.commands?.at(-1)?.end ?? 0))) return false;
    let gwsCalls = 0;
    let gwsCallsBesideHelp = 0;
    let changesDirectory = false;
    let readsFiles = false;
    for (const node of walkCommandNodes(script)) {
        if (node.__resolved) return false;
        if (!(node.prefix || []).every((p: any) => typeof p?.name === 'string' && probeMaySet(p.name))) return false;
        if (!redirectsWriteNothing(node)) return false;
        if (!node.name) continue;
        if (!wordIsFixed(node.name)) return false;
        const cmd = resolveCommand(node);
        if (!cmd) return false;
        // Anything but gws runs as a plain bare word: a path or a wrapper could run a different program than the name says.
        if (cmd.name !== 'gws' && (String(node.name.text ?? '') !== cmd.name || cmd.name.includes('/'))) return false;
        if (!(cmd.env ?? []).every(a => probeMaySet(a.split('=')[0]))) return false;
        // A word whose value is only known when the shell runs can be an option the checks below never saw: with
        // OPTS=-ee, `sed -n -e p "$OPTS"` runs its input as commands.
        if (cmd.name !== 'gws' && !(node.suffix || []).every(wordIsLiteral)) return false;
        if (cmd.name === 'gws') {
            if (!gwsReachedDirectly(node)) return false;
            const flag = gwsProbeFlag(node, cmd.args);
            if (!flag && !gwsCallOnlyReads(node, cmd.args)) return false;
            if (!flag || !GWS_HELP_FLAGS.has(flag)) gwsCallsBesideHelp++;
            gwsCalls++;
        } else if (cmd.name === 'set') {
            if (!cmd.args.every(a => PROBE_SET_OPTIONS.test(a))) return false;
        } else if (cmd.name === 'export') {
            if (!cmd.args.every(a => probeMaySet(a.split('=')[0]))) return false;
        } else if (cmd.name === 'sed') {
            const files = sedPrintOnlyFiles(cmd.args);
            if (files === null) return false;
            if (files > 0) readsFiles = true;
        } else if (cmd.name === 'cd') {
            if (!optionsAllowed(cmd.name, cmd.args)) return false;
            changesDirectory = true;
        } else if (!PROBE_COMPANIONS.has(cmd.name) || !optionsAllowed(cmd.name, cmd.args)) {
            return false;
        }
    }
    if (changesDirectory && gwsCalls > 0) return false;
    if (readsFiles && gwsCallsBesideHelp > 0) return false;
    // Each gws call must be spelled as the bare word `gws`: the parser resolves
    // `/any/dir/gws` by basename, and a binary at another path need not honour --dry-run.
    // With no gws call it refuses any bare `gws` word, so `echo gws gmail +send` still gates.
    const gwsInText = (command.match(/(?:^|[\s;&|(`{!])gws(?=\s)/g) ?? []).length;
    return gwsInText === gwsCalls && GWS_EMAIL_SEND_RE.test(command);
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
}

/** Verdict for the email gate. On `gate`, `label` + `summary`
 *  describe the send for the approver. */
export interface EmailGateVerdict {
    action: 'allow' | 'gate';
    label?: string;
    summary?: string;
    reason?: string;
    /** Everything the send delivers, when the command is that one send stated literally; see `request_send_gate`. */
    sendParts?: string[];
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
        const used = lines.join('\n').length + header.length + 8;
        lines.push('', header, quoteBlock(clip((isHtml ? htmlToText(body) : body.slice(0, 20_000).trim()) || '(empty)', Math.max(200, CARD_SUMMARY_MAX_CHARS - used))));
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
 *   2. Every command bash runs is gws help, dry-run, draft or read, or a read-only
 *      filter whose quoted arguments merely hold the send text (probeOnlyCommand) → allow.
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
// The only sends a person's own "send" can stand in for: ones that deliver exactly the text they read and nothing
// else. A reply quotes the original and may inherit its recipients; a forward carries it.
const SEND_WORD_SHAPES = new Set(['slack chat.postMessage', 'slack chat.update', 'email send']);

function approvableSendParts(shape: string, parts: string[] | undefined): string[] | undefined {
    return SEND_WORD_SHAPES.has(shape) ? parts : undefined;
}

export function evaluateEmailSend(command: string, env: EnvSnapshot): EmailGateVerdict {
    const slack = command ? gatedSlackPosts(command) : [];
    if (slack.length > 0) {
        const text = slack[0].text;
        const sendParts = approvableSendParts(`slack ${slack[0].method}`, slack.length === 1 && text !== null && soleCommand(command) ? [text] : undefined);
        noteSendParts(command, sendParts ?? null);
        return {
            action: 'gate',
            ...(sendParts ? { sendParts } : {}),
            label: `Slack post in your name (${slack[0].method})`,
            summary: text === null
                ? "The agent wants to post to Slack as you. The guard couldn't read the exact text; check the full command before approving."
                : `The agent wants to post this to Slack as you:\n\n${quoteBlock(clip(text, CARD_SUMMARY_MAX_CHARS))}`,
        };
    }
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
    if (probeOnlyCommand(command) || bypassFlagIsRealArgvToken(command)) return { action: 'allow' };

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
    const flagTo = matchFlag('--to');
    const envelope = !flagTo ? envelopeFromJsonRaw(command) : {};
    const subject = matchFlag('--subject') ?? envelope.subject ?? '';
    const cc = matchFlag('--cc') ?? envelope.cc;
    const bcc = matchFlag('--bcc') ?? envelope.bcc;
    const removed = matchFlag('--remove');
    const messageId = matchFlag('--message-id');
    const alias = matchFlag('--from');
    const attachments = send ? [...argTexts(send, '-a'), ...argTexts(send, '--attach')].map(evaluated) : [];
    const isHtml = send ? send.values.includes('--html') : /\s--html(?:\s|$)/.test(scanned);
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

    // gws resolves reply recipients from the original message, honouring its
    // Reply-To header; `--to` adds recipients (`gws gmail +reply-all --help`).
    const threadRecipients = action === 'reply' ? 'the original sender (or its Reply-To address)'
        : action === 'reply-all' ? 'the original sender (or its Reply-To address) and everyone on To/Cc'
        : null;
    const to = inline(threadRecipients
        ? (flagTo ? `${threadRecipients}, plus ${flagTo}` : threadRecipients)
        : flagTo ?? envelope.to ?? 'unknown recipient');
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
        : (subject ? `Email ${action} to ${to}: "${inline(subject)}"` : `Email ${action} to ${to}`)
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
        lines.push(`⚠️ This send carries ${code(probeFlag)}, which on its own sends nothing. The gate still asks because the command also pipes or chains other steps it can't rule out; check the full command.`, '');
    }
    lines.push(`From: ${inline(fromAccount)}${alias ? ` (as ${inline(alias)})` : ''}`, `To: ${to}`);
    if (cc) lines.push(`Cc: ${inline(cc)}`);
    if (bcc) lines.push(`Bcc: ${inline(bcc)}`);
    if (removed) lines.push(`Removed from the reply: ${inline(removed)}`);
    if (subject) lines.push(`Subject: ${inline(subject)}`);
    else if (threadRecipients) lines.push('Subject: Re: the original subject');
    if (messageId && threadRecipients) lines.push(`In reply to: Gmail message ${code(inline(messageId))}, quoted under the reply`);
    if (attachments.length) lines.push(`Attachments: ${attachments.map(a => code(inline(a))).join(', ')}`);

    const bodyText = send ? argTexts(send, '--body')[0] : matchFlag('--body');
    const body = send || bodyText === undefined
        ? resolveBody(bodyText, view, send?.pos ?? Infinity, env.cwd, evaluated)
        : { text: bodyText };
    lines.push('');
    if (body.text !== null) {
        const text = isHtml ? htmlToText(body.text) : body.text.trim();
        const header = `Message${isHtml ? ' (HTML, shown as text)' : ''}:`;
        const used = lines.join('\n').length + header.length + 120;
        lines.push(header, quoteBlock(clip(text || '(empty)', Math.max(200, CARD_SUMMARY_MAX_CHARS - used))));
        if (body.note) lines.push(body.note);
    } else if (isRawApi) {
        lines.push('Message: not shown. This send passes a raw MIME message, so the text is only visible inside the encoded payload. Decline and ask the agent to show the draft if you need to read it first.');
    } else {
        lines.push(`Message: not shown. ${body.note ?? 'The command builds the text when it runs.'} Decline and ask the agent to show the draft if you need to read it first.`);
    }
    if (unresolved.size) {
        const list = [...unresolved];
        lines.push(`⚠️ ${list.map(code).join(', ')} ${list.length === 1 ? 'is' : 'are'} only known when the command runs, so the value${list.length === 1 ? '' : 's'} above may differ.`);
    }
    // What a person must have seen for their own "send" to stand in for the card: a single literal send only.
    const literalParts = [flagTo, cc, bcc, subject || undefined].filter((v): v is string => v !== undefined && v !== '');
    const readable = gwsWords === 1 && !generatedWord && !probeFlag && !isHtml && !isRawApi && unresolved.size === 0
        && attachments.length === 0
        && body.text !== null && body.text.trim() !== '' && literalParts.every(v => !/[$`]/.test(v));
    // Each envelope part carries its role, so the host can match it to the same field of the draft the person saw.
    const roleParts = ([['to', flagTo], ['cc', cc], ['bcc', bcc]] as const)
        .flatMap(([role, value]) => value ? value.split(/\s*,\s*/).filter(Boolean).map(addr => `${role}:${addr}`) : [])
        .concat(subject ? [`subject:${subject}`] : []);
    const sendParts = approvableSendParts(`email ${action}`, readable && view.commands.length === 1 ? [body.text!.trim(), ...roleParts] : undefined);
    noteSendParts(command, sendParts ?? null);
    return { action: 'gate', label, summary: fitLines(lines, CARD_SUMMARY_MAX_CHARS), ...(sendParts ? { sendParts } : {}) };
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
