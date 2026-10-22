/**
 * Shell-reading helpers, and the helpers that describe a gated action to its
 * approver. The description helpers never decide allow, gate or block: a wrong
 * answer can only make the description less informative, never change what
 * runs. Output is plain text because each harness shows it in its own approval
 * surface (a native permission prompt, a chat card, a hand-off message).
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { extname, resolve as pathResolve, sep } from 'path';
import { parse } from 'unbash';

// Short enough for the tightest known surface: NanoClaw posts it into a Slack
// block that the adapter cuts at 3000 UTF-16 units, next to its own
// 1400-character command preview. Lengths here are UTF-16 units for that reason.
export const CARD_SUMMARY_MAX_CHARS = 1300;
export const CARD_LABEL_MAX_CHARS = 130;

const FILE_MAX_BYTES = 256 * 1024;
// The HTML-to-text pass is quadratic on hostile input; the description only
// ever shows the first thousand or so characters of the result.
const HTML_MAX_CHARS = 20_000;

export function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    let out = '';
    for (const ch of text) {
        if (out.length + ch.length > max - 1) break;
        out += ch;
    }
    return out.trimEnd() + '…';
}

export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Inline code cannot contain a backtick in chat markdown; swap it so the span stays closed. */
export function code(text: string): string {
    return '`' + text.replace(/`/g, 'ʼ') + '`';
}

// Slack turns `<!channel>`, `<@U…>`, `<#C…>` and `<url|label>` into pings and
// links when a harness posts the text there.
function defuse(text: string): string {
    return text.replace(/<(?=[!@#a-z])/gi, '‹');
}

/** Untrusted text on one line, so it cannot forge further lines of the description. */
export function inline(text: string): string {
    return defuse(oneLine(text));
}

/** Untrusted multi-line text, quoted. */
export function quoteBlock(text: string): string {
    return defuse(text).split('\n').map(line => `> ${line}`).join('\n');
}

/** What a shell variable holds at a point in a command, as far as the text proves. */
export type ShellValue =
    | { kind: 'text'; value: string }
    | { kind: 'file'; path: string }
    | { kind: 'runtime' };

export interface ShellCommand {
    name: string;
    /** Each argument's source text, quotes included. */
    argTexts: string[];
    pos: number;
}

export interface ShellView {
    commands: ShellCommand[];
    valueAt(name: string, pos: number): ShellValue | undefined;
    commandAt(pos: number): ShellCommand | undefined;
}

// Deeper than any real command; past it the walk gives up so a hostile one
// costs milliseconds, not seconds.
const WALK_MAX_DEPTH = 200;

// unbash computes a word's `parts` lazily, so it is not among the node's own keys.
function walk(node: unknown, visit: (n: any, nested: boolean) => void, nested = false, seen = new WeakSet<object>(), depth = 0): void {
    if (!node || typeof node !== 'object' || seen.has(node as object)) return;
    if (depth > WALK_MAX_DEPTH) throw new RangeError('command nests too deeply to describe');
    seen.add(node as object);
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit, nested, seen, depth + 1);
        return;
    }
    const record = node as Record<string, any>;
    visit(record, nested);
    const inner = nested || record.type === 'CommandExpansion' || record.type === 'ProcessSubstitution';
    for (const child of Object.values(record)) walk(child, visit, inner, seen, depth + 1);
    if ('text' in record && !Object.prototype.hasOwnProperty.call(record, 'parts')) walk(record.parts, visit, inner, seen, depth + 1);
}

/** A command line the guard can't parse the way bash will run it; callers treat it as unreadable and hold. */
export class ShellParseError extends Error {}

// unbash reads a heredoc delimiter by its first character, so `E"O"F`, `'E'OF` or `"E\OF"` give it a different
// delimiter from bash's and it reads the commands after the body as more body.
const SHELL_METACHARS = ' \t\n;&|<>()';
const HEREDOC_REWRITES_MAX = 32;

/**
 * The delimiter bash takes from the heredoc word starting at `i`: the word with its quotes removed and nothing
 * expanded, quoted when any part of it is. Null for a word whose expansion or continuation this does not model.
 */
function bashHeredocDelimiter(src: string, i: number): { delimiter: string; quoted: boolean; end: number } | null {
    if (src[i] === '#') return null;
    let delimiter = '';
    let quoted = false;
    let j = i;
    while (j < src.length && !SHELL_METACHARS.includes(src[j])) {
        const c = src[j];
        if (c === "'") {
            const close = src.indexOf("'", j + 1);
            if (close < 0) return null;
            delimiter += src.slice(j + 1, close);
            quoted = true;
            j = close + 1;
        } else if (c === '"') {
            let k = j + 1;
            for (; k < src.length && src[k] !== '"'; k++) {
                if (src[k] === '$' || src[k] === '`') return null;
                if (src[k] === '\\') {
                    const next = src[k + 1];
                    if (next === undefined || next === '\n') return null;
                    if ('"\\$`'.includes(next)) {
                        delimiter += next;
                        k++;
                        continue;
                    }
                }
                delimiter += src[k];
            }
            if (k >= src.length) return null;
            quoted = true;
            j = k + 1;
        } else if (c === '\\') {
            const next = src[j + 1];
            if (next === undefined || next === '\n') return null;
            delimiter += next;
            quoted = true;
            j += 2;
        } else if (c === '`' || (c === '$' && /^[('"{[]/.test(src[j + 1] ?? ''))) {
            return null;
        } else {
            delimiter += c;
            j++;
        }
    }
    return j === i || delimiter.includes('\n') ? null : { delimiter, quoted, end: j };
}

/** Where the heredoc word of redirect `r` starts in `src`, past its operator and any blanks. */
function heredocWordStart(src: string, r: any): number | null {
    const op = src.indexOf('<<', r.pos);
    if (op < 0 || op >= r.end) return null;
    let i = op + (r.operator === '<<-' ? 3 : 2);
    while (src[i] === ' ' || src[i] === '\t') i++;
    return i;
}

/** The heredoc redirects of a script outside its command substitutions, whose offsets index the script's own text. */
function heredocRedirects(node: unknown, out: any[] = [], seen = new WeakSet<object>(), depth = 0): any[] {
    if (!node || typeof node !== 'object' || seen.has(node as object)) return out;
    if (depth > WALK_MAX_DEPTH) throw new ShellParseError('command nests too deeply to read');
    seen.add(node as object);
    const record = node as Record<string, any>;
    if (depth > 0 && (record.type === 'CommandExpansion' || record.type === 'ProcessSubstitution')) return out;
    if ((record.operator === '<<' || record.operator === '<<-') && typeof record.pos === 'number') out.push(record);
    for (const child of Object.values(record)) heredocRedirects(child, out, seen, depth + 1);
    return out;
}

/**
 * Whether unbash left a command's redirects out of the tree: it drops them for a command with no name and no
 * assignment (`<<EOF`, `>f <<EOF`) and for a coproc, so a heredoc there is never checked.
 */
function dropsRedirects(node: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
    if (!node || typeof node !== 'object' || seen.has(node as object)) return false;
    if (depth > WALK_MAX_DEPTH) throw new ShellParseError('command nests too deeply to read');
    seen.add(node as object);
    const r = node as Record<string, any>;
    if (depth > 0 && (r.type === 'CommandExpansion' || r.type === 'ProcessSubstitution')) return false;
    if (r.type === 'Coproc') return true;
    if (r.type === 'Command' && !r.name && !r.prefix?.length && !r.suffix?.length && !r.redirects?.length) return true;
    return Object.values(r).some(child => dropsRedirects(child, seen, depth + 1));
}

/** The first heredoc in `script` (parsed from `src`) whose delimiter unbash read differently from bash, or null. */
function misreadHeredoc(script: unknown, src: string): { start: number; bash: ReturnType<typeof bashHeredocDelimiter> } | null {
    for (const r of heredocRedirects(script).sort((a, b) => a.pos - b.pos)) {
        const start = heredocWordStart(src, r);
        if (start === null) throw new ShellParseError('a heredoc operator the guard cannot locate');
        const bash = bashHeredocDelimiter(src, start);
        if (!bash || bash.delimiter !== String(r.target?.text ?? '') || bash.quoted !== Boolean(r.heredocQuoted) || bash.end !== r.end) {
            return { start, bash };
        }
        if (!bash.quoted && continuationMisread(String(r.content ?? ''), bash.delimiter, r.operator === '<<-')) return { start, bash: null };
    }
    return null;
}

/**
 * Whether bash ends an unquoted heredoc somewhere other than where unbash did. Bash joins a line ending in an unescaped
 * backslash to the next before comparing it with the delimiter; unbash compares physical lines. So a joined line can
 * end the body early, and a body whose last line is continued runs on past unbash's delimiter line.
 */
function continuationMisread(body: string, delimiter: string, stripTabs: boolean): boolean {
    const lines = body.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let joined = false;
        while (endsInContinuation(line)) {
            if (i + 1 >= lines.length) return true;
            line = line.slice(0, -1) + lines[++i];
            joined = true;
        }
        if (joined && (line === delimiter || (stripTabs && line.replace(/^\t+/, '') === delimiter))) return true;
    }
    return false;
}

function endsInContinuation(line: string): boolean {
    let n = 0;
    while (n < line.length && line[line.length - 1 - n] === '\\') n++;
    return n % 2 === 1;
}

/** The delimiter written so unbash reads it as bash does, in exactly `length` characters, or null when it can't be. */
function canonicalDelimiter(delimiter: string, quoted: boolean, length: number): string | null {
    const forms = quoted
        ? [`'${delimiter}'`, ...(delimiter && ![...SHELL_METACHARS, "'", '"'].some(c => delimiter.includes(c)) ? [`\\${delimiter.replace(/\\/g, '\\\\')}`] : [])]
        : [];
    const form = forms.filter(f => f.length <= length && !(f.startsWith("'") && delimiter.includes("'"))).sort((a, b) => a.length - b.length)[0];
    return form === undefined ? null : ' '.repeat(length - form.length) + form;
}

/**
 * Parse a command line as bash reads it. A heredoc delimiter unbash misreads is rewritten in place, at the same
 * length so every offset still indexes the caller's text, and the line parsed again. Throws ShellParseError when
 * the delimiter can't be determined or rewritten (inside a command substitution, unbash parses it lazily from its
 * own text), so the caller holds instead of trusting a parse that hides commands.
 */
export function parseShell(command: string): any {
    if (!command.includes('<<')) return parse(command);
    let src = command;
    for (let round = 0; round <= HEREDOC_REWRITES_MAX; round++) {
        const ast: any = parse(src);
        const misread = misreadHeredoc(ast, src);
        if (!misread) {
            if (dropsRedirects(ast)) throw new ShellParseError('a heredoc on a command the parser drops redirects from');
            checkNestedHeredocs(ast);
            return ast;
        }
        const { start, bash } = misread;
        if (!bash) throw new ShellParseError('a heredoc delimiter the guard cannot read the way bash does');
        const form = canonicalDelimiter(bash.delimiter, bash.quoted, bash.end - start);
        if (form === null) throw new ShellParseError('a heredoc delimiter the guard cannot read the way bash does');
        src = src.slice(0, start) + form + src.slice(bash.end);
    }
    throw new ShellParseError('too many heredocs to read');
}

/** Throws when a heredoc inside a command substitution has a delimiter unbash misread; those can't be rewritten. */
function checkNestedHeredocs(ast: unknown): void {
    try {
        walk(ast, visitSubstitution);
    } catch (e) {
        throw e instanceof RangeError ? new ShellParseError(e.message) : e;
    }
}

function visitSubstitution(n: any): void {
    if (n.type !== 'CommandExpansion' && n.type !== 'ProcessSubstitution') return;
    const text = String(n.text ?? '');
    const backtick = text.startsWith('`');
    const inner = backtick ? text.slice(1, -1) : text.slice(2, -1);
    if (inner.includes('<<') && dropsRedirects(n.script)) {
        throw new ShellParseError('a heredoc on a command the parser drops redirects from');
    }
    if (!heredocRedirects(n.script).length) return;
    // bash removes backslashes inside backticks before parsing, so their offsets don't index the written text.
    if ((backtick && inner.includes('\\')) || misreadHeredoc(n.script, inner)) {
        throw new ShellParseError('a heredoc inside a command substitution whose delimiter the guard cannot read the way bash does');
    }
}

function catFileOf(script: any): string | null {
    const commands: any[] = [];
    walk(script, n => { if (n.type === 'Command') commands.push(n); });
    if (commands.length !== 1) return null;
    const [cmd] = commands;
    const args = (cmd.suffix || []).map((s: any) => String(s.text ?? s.value ?? ''));
    if (cmd.name?.text !== 'cat' || args.length !== 1 || (cmd.prefix || []).length) return null;
    return /^\/[^\s'"$`\\]*$/.test(args[0]) ? args[0] : null;
}

const ANSI_C_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\', a: '\x07', e: '\x1b' };

/** Index just past the `)` that closes the `$(` or `(` starting at `open`. */
function closeParen(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return i + 1;
    }
    return text.length;
}

/**
 * Evaluate a word's source text the way bash would, substituting variables the
 * command provably set. `keepQuotes` keeps quote characters for display of a
 * whole command line. Anything only known at run time is left as written and
 * listed in `unresolved`.
 */
export function evalWord(
    text: string,
    view: ShellView,
    pos: number,
    keepQuotes = false,
    // Take an unquoted value whole instead of leaving it unresolved for word splitting: right for a reader of the
    // words joined back together, such as the text echo or printf emits.
    joinSplit = false,
): { value: string; unresolved: string[] } {
    const unresolved: string[] = [];
    const note = (s: string) => { const c = clip(s, 40); if (!unresolved.includes(c)) unresolved.push(c); };
    let out = '';
    let i = 0;
    let quote: '' | '"' = '';
    const dollar = (): void => {
        const rest = text.slice(i);
        const simple = rest.match(/^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/);
        if (simple) {
            const value = view.valueAt(simple[1] ?? simple[2], pos);
            // Unquoted, the shell splits a value on whitespace into several words.
            if (value?.kind === 'text' && (quote === '"' || joinSplit || !/\s/.test(value.value)) && out.length + value.value.length <= RESOLVE_MAX_CHARS) {
                out += value.value;
            } else { out += simple[0]; note(simple[0]); }
            i += simple[0].length;
            return;
        }
        let end: number;
        if (rest.startsWith('$((') || rest.startsWith('$(')) end = closeParen(text, i + 1);
        else if (rest.startsWith('${')) { const c = text.indexOf('}', i); end = c < 0 ? text.length : c + 1; }
        else if (/^\$[0-9#?$!*@-]/.test(rest)) end = i + 2;
        else { out += '$'; i++; return; }
        out += text.slice(i, end);
        note(text.slice(i, end));
        i = end;
    };
    while (i < text.length) {
        const c = text[i];
        if (quote === '"') {
            if (c === '"') { quote = ''; if (keepQuotes) out += c; i++; }
            else if (c === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) { if (keepQuotes) out += c; out += text[i + 1]; i += 2; }
            else if (c === '$') dollar();
            else if (c === '`') { const e = text.indexOf('`', i + 1); const end = e < 0 ? text.length : e + 1; out += text.slice(i, end); note(text.slice(i, end)); i = end; }
            else { out += c; i++; }
        } else if (c === '$' && text[i + 1] === "'") {
            let j = i + 2;
            let literal = '';
            while (j < text.length && text[j] !== "'") {
                if (text[j] === '\\' && j + 1 < text.length) {
                    const esc = text[j + 1];
                    const hex = esc === 'x' ? text.slice(j + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0] : undefined;
                    if (hex) {
                        literal += String.fromCharCode(parseInt(hex, 16));
                        j += 2 + hex.length;
                        continue;
                    }
                    literal += ANSI_C_ESCAPES[esc] ?? `\\${esc}`;
                    j += 2;
                } else literal += text[j++];
            }
            out += keepQuotes ? text.slice(i, Math.min(text.length, j + 1)) : literal;
            i = j + 1;
        } else if (c === "'") {
            const e = text.indexOf("'", i + 1);
            const end = e < 0 ? text.length : e;
            out += keepQuotes ? text.slice(i, Math.min(text.length, end + 1)) : text.slice(i + 1, end);
            i = end + 1;
        } else if (c === '"' || (c === '$' && text[i + 1] === '"')) {
            if (c === '$') i++;
            quote = '"';
            if (keepQuotes) out += '"';
            i++;
        } else if (c === '\\' && i + 1 < text.length) {
            if (keepQuotes) out += c;
            out += text[i + 1];
            i += 2;
        } else if (c === '$') dollar();
        else if (c === '`') { const e = text.indexOf('`', i + 1); const end = e < 0 ? text.length : e + 1; out += text.slice(i, end); note(text.slice(i, end)); i = end; }
        else { out += c; i++; }
    }
    return { value: out, unresolved };
}

// Only a shell builtin can change the calling shell's variables; an external
// program runs in its own process. So a command keeps variables trusted only if
// it is not a builtin, or is one of these, which never assign.
const BASH_BUILTINS = new Set([
    'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt',
    'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc',
    'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source',
    'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
    '.', ':', '[',
]);
const NON_ASSIGNING_BUILTINS = new Set([
    'cd', 'echo', 'exit', 'false', 'help', 'jobs', 'kill', 'pwd', 'return', 'shift', 'times', 'true', 'type',
    'ulimit', 'umask', ':',
]);
// Nodes that may assign any variable: a function body runs wherever it is
// called, and arithmetic or a coproc can set names the text does not spell out.
const ASSIGNING_NODES = new Set(['Function', 'ArithmeticCommand', 'ArithmeticFor', 'ArithmeticExpansion', 'Coproc', 'TestCommand']);
// Variables the shell sets itself, so an assignment does not decide their value.
const SHELL_MANAGED = /^(?:RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|BASHPID|UID|EUID|PPID|PWD|OLDPWD|HISTCMD|_|IFS|BASH_\w*|BASH)$/;
// Past this, resolving variables is not worth its cost on a hostile command.
const RESOLVE_MAX_CHARS = 64 * 1024;

interface VarEvent {
    /** `*` for a builtin that may change any variable. */
    name: string;
    /** -1 inside a command substitution: it taints the name everywhere. */
    pos: number;
    value: ShellValue;
    /** An assignment inside an `&&` chain only holds for the rest of that chain. */
    scope?: [number, number];
}

const NO_VARIABLES: ShellView = { commands: [], valueAt: () => undefined, commandAt: () => undefined };

/** Remove a word's shell quoting without expanding anything: `"a $X"` → `a $X`. */
export function shellUnquote(text: string): string {
    return evalWord(text, NO_VARIABLES, 0).value;
}

/**
 * Parse `command` into its simple commands and the variables it provably sets.
 * Only a top-level assignment counts, alone or in an `&&` chain (then only for
 * the rest of that chain). One in a subshell, group, branch, loop, pipeline,
 * background job or after `||`, an append, or a loop variable makes the
 * variable `runtime` from there on, and so does any later builtin that is not
 * known to leave variables alone. A function definition anywhere turns
 * resolution off.
 */
export function viewShell(command: string): ShellView {
    const events: VarEvent[] = [];
    const commands: ShellCommand[] = [];
    const empty: ShellView = { commands, valueAt: () => undefined, commandAt: () => undefined };
    let ast: any;
    try {
        ast = parseShell(command);
    } catch {
        return empty;
    }
    try {
        return collect(ast);
    } catch {
        // A pathologically deep command; describe nothing rather than throw.
        commands.length = 0;
        return empty;
    }

    function collect(ast: any): ShellView {
        const tooLong = command.length > RESOLVE_MAX_CHARS;
        const valueAt = (name: string, pos: number): ShellValue | undefined => {
            if (tooLong || pos < 0 || SHELL_MANAGED.test(name)) return { kind: 'runtime' };
            let latest: VarEvent | undefined;
            for (const e of events) {
                if (e.pos < 0 && (e.name === name || e.name === '*')) return { kind: 'runtime' };
                if ((e.name === name || e.name === '*') && e.pos < pos && (!latest || e.pos >= latest.pos)) latest = e;
            }
            if (!latest) return undefined;
            if (latest.name === '*' || (latest.scope && (pos < latest.scope[0] || pos > latest.scope[1]))) return { kind: 'runtime' };
            return latest.value;
        };
        const view: ShellView = {
            commands,
            valueAt,
            commandAt: pos => (pos < 0 ? undefined : commands.find(c => c.pos === pos)),
        };

        const valueOf = (word: any, pos: number): ShellValue => {
            const parts: any[] = word?.parts;
            if (Array.isArray(parts) && parts.length === 1 && parts[0]?.type === 'CommandExpansion') {
                const path = catFileOf(parts[0].script);
                return path ? { kind: 'file', path } : { kind: 'runtime' };
            }
            const r = evalWord(String(word?.text ?? ''), view, pos);
            // A value longer than any command line can only come from self-concatenation (doubling); it is not resolved.
            return r.unresolved.length || r.value.length > RESOLVE_MAX_CHARS ? { kind: 'runtime' } : { kind: 'text', value: r.value };
        };

        const sound = new Map<any, [number, number] | undefined>();
        for (const entry of ast.commands ?? []) {
            if (entry?.background) continue;
            const node = entry?.type === 'Statement' ? entry.command : entry;
            const chained = node?.type === 'AndOr' && (node.operators ?? []).every((op: string) => op === '&&');
            const chain = chained ? node.commands : node?.type === 'Command' ? [node] : [];
            chain.forEach((c: any, i: number) => {
                if (c?.type !== 'Command') return;
                const scope: [number, number] | undefined = chained && i > 0 ? [node.pos, node.end] : undefined;
                if (!c.name) for (const p of c.prefix ?? []) sound.set(p, scope);
                else if (c.name.text === 'export') sound.set(c, scope);
            });
        }

        // A command substitution's nodes carry offsets relative to the substitution,
        // so they get no position: nothing is resolved inside one, and nothing set
        // inside one is trusted outside it.
        const nodes: Array<{ n: any; nested: boolean }> = [];
        let hasFunction = false;
        walk(ast, (n, nested) => {
            if (n.type === 'Function') hasFunction = true;
            if (n.type === 'Assignment' || n.type === 'Command' || n.type === 'For' || n.type === 'Select' || ASSIGNING_NODES.has(n.type)) {
                nodes.push({ n, nested });
            }
        });
        nodes.sort((a, b) => (a.n.pos ?? 0) - (b.n.pos ?? 0));
        const taint = (name: string, pos: number) => events.push({ name, pos, value: { kind: 'runtime' } });
        for (const { n, nested } of nodes) {
            const pos = nested ? -1 : typeof n.pos === 'number' ? n.pos : 0;
            if (ASSIGNING_NODES.has(n.type)) {
                if (!nested) taint('*', pos);
                continue;
            }
            if (n.type === 'For' || n.type === 'Select') {
                const loopVar = n.name?.text;
                if (typeof loopVar === 'string') taint(loopVar, pos);
                continue;
            }
            if (n.type === 'Assignment') {
                if (typeof n.name !== 'string') continue;
                if (nested || !sound.has(n) || n.append) taint(n.name, pos);
                else events.push({ name: n.name, pos, value: valueOf(n.value, pos), scope: sound.get(n) });
                continue;
            }
            if (!n.name) continue;
            const argTexts: string[] = (n.suffix || []).map((x: any) => String(x.text ?? x.value ?? ''));
            const nameText = String(n.name.text ?? n.name.value ?? '');
            const name = String(n.name.value ?? n.name.text ?? '');
            // A command substitution runs in a subshell and cannot change this shell's variables.
            if (!nested && name !== 'export') {
                // Brace expansion and globbing run before lookup: `{eval,…}` and `ev?l` become eval.
                const disguised = !/^[A-Za-z0-9_.\/+:-]+$/.test(nameText);
                const assigns = BASH_BUILTINS.has(name) && !NON_ASSIGNING_BUILTINS.has(name)
                    && !(name === 'printf' && !argTexts.some(t => /^['"]?-[a-zA-Z]*v/.test(t)));
                if (disguised || assigns) taint('*', pos);
            }
            if (name === 'export') {
                for (const text of argTexts) {
                    const m = text.match(/^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/);
                    if (!m) {
                        if (!nested && !/^[A-Za-z_]\w*$/.test(text)) taint('*', pos);
                        continue;
                    }
                    if (nested || !sound.has(n) || m[2]) { taint(m[1], pos); continue; }
                    const r = evalWord(m[3], view, pos);
                    events.push({ name: m[1], pos, value: r.unresolved.length ? { kind: 'runtime' } : { kind: 'text', value: r.value }, scope: sound.get(n) });
                }
            }
            commands.push({ name, argTexts, pos });
        }
        const scan = command.slice(0, RESOLVE_MAX_CHARS);
        // Any expansion beyond a bare `${NAME}` can assign: `${X:=…}`, an arithmetic subscript or offset.
        for (const m of scan.matchAll(/\$\{(?![A-Za-z_]\w*\})|\$\[/g)) taint('*', m.index ?? 0);
        for (const m of scan.matchAll(/\{([A-Za-z_]\w*)\}[<>]/g)) taint(m[1], m.index ?? 0);
        for (const m of scan.matchAll(/\$\(\(|\(\(/g)) taint('*', m.index ?? 0);
        if (hasFunction) taint('*', -1);
        events.sort((a, b) => a.pos - b.pos);
        return view;
    }
}

/** The variable a word names when it is nothing but `$NAME`, `${NAME}` or their double-quoted forms. */
export function soleVariable(text: string): string | null {
    return text.match(/^"?\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))"?$/)?.slice(1).find(Boolean) ?? null;
}

function boundedRead(path: string): string | null {
    let fd: number | undefined;
    try {
        const st = statSync(path);
        if (!st.isFile() || st.size > FILE_MAX_BYTES) return null;
        fd = openSync(path, 'r');
        const buf = Buffer.alloc(FILE_MAX_BYTES + 1);
        const n = readSync(fd, buf, 0, buf.length, 0);
        return n > FILE_MAX_BYTES ? null : buf.subarray(0, n).toString('utf8');
    } catch {
        return null;
    } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    }
}

/** Read a config file the guard looks inside but never shows. */
export function readConfigFile(path: string): string | null {
    return path.startsWith('/') && !/^\/(?:proc|sys|dev)\//.test(path) ? boundedRead(path) : null;
}

const BODY_EXTENSIONS = new Set(['.html', '.htm', '.txt', '.md', '.eml']);
const SECRET_SEGMENT = /^\.|secret|credential|token|passw|private|key|id_rsa|id_ed25519|id_ecdsa|\.pem$|\.p12$/i;

function bodyRoots(cwd: string | undefined): string[] {
    const home = homedir();
    const roots = ['/workspace', '/tmp', tmpdir()];
    const cwdOk = cwd && cwd.startsWith('/') && cwd !== '/' && !home.startsWith(pathResolve(cwd))
        && !pathResolve(cwd).split(sep).some(seg => SECRET_SEGMENT.test(seg));
    if (cwdOk) roots.push(cwd);
    return roots.map(r => { try { return realpathSync(r); } catch { return r; } });
}

/**
 * Read a message body the command cats from a file, so the approver sees what
 * will be sent. Its content is shown before anyone approves, so only an
 * email-shaped file under a working directory qualifies: never a dotfile, a
 * credential-looking path, or anything a symlink points outside those roots.
 */
export function readBodyFile(path: string, cwd?: string): string | null {
    let real: string;
    try {
        real = realpathSync(path);
    } catch {
        return null;
    }
    if (!BODY_EXTENSIONS.has(extname(real).toLowerCase())) return null;
    const root = bodyRoots(cwd).find(r => real.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!root) return null;
    if (real.slice(root.length).split(sep).some(seg => SECRET_SEGMENT.test(seg))) return null;
    return boundedRead(real);
}

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•',
};

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ent: string) => {
        if (ent[0] === '#') {
            const n = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
        }
        return ENTITIES[ent.toLowerCase()] ?? whole;
    });
}

/** Render an HTML email body as the plain text a recipient would read. */
export function htmlToText(html: string): string {
    const text = html.slice(0, HTML_MAX_CHARS)
        .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_w, attrs: string, label: string) => {
            const href = attrs.match(/\bhref=["']([^"']*)["']/i)?.[1] ?? '';
            const inner = label.replace(/<[^>]*>/g, '').trim();
            return href && inner !== href ? `${inner} (${href})` : inner || href;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, '\n\n')
        .replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote)\b[^>]*>/gi, '\n')
        .replace(/<\/(td|th)>/gi, '\t')
        .replace(/<[^>]*>/g, '');
    return decodeEntities(text)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim() + (html.length > HTML_MAX_CHARS ? '\n…' : '');
}

/** Join lines, dropping trailing lines (not cutting mid-line) once over budget. */
export function fitLines(lines: string[], max = CARD_SUMMARY_MAX_CHARS): string {
    const out: string[] = [];
    let used = 0;
    for (const line of lines) {
        const len = line.length + 1;
        if (used + len > max) {
            const room = max - used - 2;
            if (room >= 40) {
                const cut = clip(line, room);
                out.push((cut.match(/`/g) ?? []).length % 2 ? cut + '`' : cut);
            }
            break;
        }
        out.push(line);
        used += len;
    }
    return out.join('\n');
}
