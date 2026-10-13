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

/**
 * Shell builtins can mutate a variable without producing an Assignment AST
 * node. Fail closed for the common mutation forms and for sourced scripts,
 * whose effects cannot be known statically.
 */
export function hasPotentialVariableMutation(fragment: string, variable: string): boolean {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        new RegExp(`\\b(?:export|declare|typeset|local|readonly)\\b[^\\n;]*\\b${escaped}\\s*=`),
        new RegExp(`\\b(?:unset|read|readarray|mapfile)\\b[^\\n;]*\\b${escaped}\\b`),
        new RegExp(`\\bprintf\\b[^\\n;]*\\s-v\\s+${escaped}\\b`),
        new RegExp(`\\bfor\\s+${escaped}\\b`),
        new RegExp(`\\$\\{${escaped}(?::?=)`),
        /(?:^|[;&|]\s*|\n\s*)(?:source|\.)\s+/m,
    ].some(rx => rx.test(fragment));
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

function catFileOf(script: any): string | null {
    const commands: any[] = [];
    walk(script, n => { if (n.type === 'Command') commands.push(n); });
    if (commands.length !== 1) return null;
    const [cmd] = commands;
    const args = (cmd.suffix || []).map((s: any) => String(s.text ?? s.value ?? ''));
    if (cmd.name?.text !== 'cat' || args.length !== 1 || (cmd.prefix || []).length) return null;
    return /^\/[^\s'"$`\\]*$/.test(args[0]) ? args[0] : null;
}

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
            if (value?.kind === 'text') out += value.value;
            else { out += simple[0]; note(simple[0]); }
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
        } else if (c === "'" || (c === '$' && text[i + 1] === "'")) {
            const start = c === '$' ? i + 1 : i;
            const e = text.indexOf("'", start + 1);
            const end = e < 0 ? text.length : e;
            out += keepQuotes ? text.slice(i, Math.min(text.length, end + 1)) : text.slice(start + 1, end);
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

/**
 * Parse `command` into its simple commands and the variables it provably sets.
 * Only top-level assignments count, alone or in a chain joined by `&&`; one in
 * a subshell, group, branch, loop, function or after `||`, an append, or a
 * later builtin that may change it makes the variable `runtime` from there on.
 */
export function viewShell(command: string): ShellView {
    const events: Array<{ name: string; pos: number; end: number; value: ShellValue }> = [];
    const commands: ShellCommand[] = [];
    const empty: ShellView = { commands, valueAt: () => undefined, commandAt: () => undefined };
    let ast: any;
    try {
        ast = parse(command);
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

        const valueAt = (name: string, pos: number): ShellValue | undefined => {
            if (pos < 0 || events.some(e => e.name === name && e.pos < 0)) return { kind: 'runtime' };
            let latest: (typeof events)[number] | undefined;
            for (const e of events) if (e.name === name && e.pos < pos && (!latest || e.pos >= latest.pos)) latest = e;
            if (!latest) return undefined;
            if (latest.value.kind !== 'runtime' && hasPotentialVariableMutation(command.slice(latest.end, pos), name)) {
                return { kind: 'runtime' };
            }
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
            return r.unresolved.length ? { kind: 'runtime' } : { kind: 'text', value: r.value };
        };

        const sound = new Set<any>();
        for (const entry of ast.commands ?? []) {
            const node = entry?.type === 'Statement' ? entry.command : entry;
            const chain = node?.type === 'AndOr' && (node.operators ?? []).every((op: string) => op === '&&')
                ? node.commands
                : node?.type === 'Command' ? [node] : [];
            for (const c of chain) {
                if (c?.type !== 'Command') continue;
                if (!c.name) for (const p of c.prefix ?? []) sound.add(p);
                else if (c.name.text === 'export') sound.add(c);
            }
        }

        // A command substitution's nodes carry offsets relative to the substitution,
        // so they get no position: nothing is resolved inside one, and nothing set
        // inside one is trusted outside it.
        const nodes: Array<{ n: any; nested: boolean }> = [];
        walk(ast, (n, nested) => { if (n.type === 'Assignment' || n.type === 'Command') nodes.push({ n, nested }); });
        nodes.sort((a, b) => (a.n.pos ?? 0) - (b.n.pos ?? 0));
        for (const { n, nested } of nodes) {
            if (nested) {
                if (n.type === 'Assignment' && typeof n.name === 'string') events.push({ name: n.name, pos: -1, end: -1, value: { kind: 'runtime' } });
                if (n.type === 'Command' && n.name) {
                    commands.push({ name: String(n.name.value ?? n.name.text ?? ''), argTexts: (n.suffix || []).map((x: any) => String(x.text ?? x.value ?? '')), pos: -1 });
                }
                continue;
            }
            const pos = typeof n.pos === 'number' ? n.pos : 0;
            const end = typeof n.end === 'number' ? n.end : pos;
            if (n.type === 'Assignment') {
                if (typeof n.name !== 'string') continue;
                const trusted = sound.has(n) && !n.append;
                events.push({ name: n.name, pos, end, value: trusted ? valueOf(n.value, pos) : { kind: 'runtime' } });
                continue;
            }
            if (!n.name) continue;
            const argTexts = (n.suffix || []).map((s: any) => String(s.text ?? s.value ?? ''));
            const name = String(n.name.value ?? n.name.text ?? '');
            if (name === 'export') {
                for (const text of argTexts) {
                    const m = text.match(/^([A-Za-z_]\w*)=([\s\S]*)$/);
                    if (!m) continue;
                    const r = evalWord(m[2], view, pos);
                    const value: ShellValue = sound.has(n) && !r.unresolved.length ? { kind: 'text', value: r.value } : { kind: 'runtime' };
                    events.push({ name: m[1], pos, end, value });
                }
            }
            commands.push({ name, argTexts, pos });
        }
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
const SECRET_SEGMENT = /^\.|secret|credential|token|passw|private|\bkey\b|\.key$|\.pem$/i;

function bodyRoots(cwd: string | undefined): string[] {
    const home = homedir();
    const roots = ['/workspace', '/tmp', tmpdir()];
    if (cwd && cwd.startsWith('/') && cwd !== '/' && pathResolve(cwd) !== home) roots.push(cwd);
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
