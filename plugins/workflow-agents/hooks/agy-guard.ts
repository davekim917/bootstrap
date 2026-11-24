#!/usr/bin/env bun
/**
 * agy (Antigravity CLI) PreToolUse adapter for the shared command and file-safety policy (`guard-policy.ts`).
 *
 * agy reads hook commands from `hooks.json` files and passes `{hookEventName, toolCall: {name, args}, cwd}` on
 * stdin. It runs the tool when a hook exits 0 with empty output, so `agy-guard.sh` turns every failure into a deny.
 *
 * agy also hot-reloads hook configs from `.agents/` and `~/.gemini/`. Writing one can disable this guard
 * mid-session, so this adapter refuses those writes from any tool. Shell coverage is a best-effort read of the
 * command line; the sandbox the worker runs in is what makes those paths immutable.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { decideToolCall, type ToolCall, type Verdict } from './guard-policy';
import { extractCommands, walkCommandNodes } from './guards/block-destructive-core';
import { parseShell } from './guards/gate-card-core';
import { evaluateEmailToolCall } from './guards/email-gate-core';

export const AGY_APPROVAL_HANDOFF =
    'This needs human approval, and this agy session cannot ask for it. Do not retry or work around it: give the user the exact command to run themselves.';

/** Tools that change nothing outside agy's own session state. */
export const READ_ONLY_TOOLS = new Set([
    'read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name', 'command_status',
    'read_url_content', 'search_web', 'list_resources', 'read_resource', 'list_permissions',
    'wait', 'wait_5_seconds', 'finish', 'ask_permission', 'ask_custom_permission', 'send_message',
]);

/** agy's own names, runtime and documented, for tools that write a file. */
const WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const EDIT_TOOLS = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
const PATH_KEYS = ['Path', 'TargetFile', 'File', 'FilePath', 'AbsolutePath'];
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent']);
/** `manage_task` actions that send nothing to a running task. */
const TASK_READ_ACTIONS = new Set(['list', 'status', 'kill']);

/** Shell commands that only read. A command line touching a protected path passes only if every step is one. */
const READ_ONLY_COMMANDS = new Set([
    'cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'wc', 'file',
    'readlink', 'realpath', 'du', 'jq', 'diff', 'sha256sum', 'md5sum', 'test', '[',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'show', 'diff', 'ls-files', 'rev-parse', 'blame']);
const PROTECTED_TEXT = /(?:^|[\s'"=:/~])(?:\.agents|\.gemini)(?:[/\s'"]|$)|\/etc\/antigravity\b/;

type Args = Record<string, unknown>;

function denied(reason: string): Verdict {
    const text = reason.toWellFormed();
    return { action: 'deny', reason: text.startsWith('BLOCKED:') ? text : `BLOCKED: ${text}` };
}

/**
 * Where `target` lands on disk, read the way the kernel walks it: each existing component through its symlinks
 * before the next `..` applies, so `alias/../x` with `alias` pointing into `.agents` lands in `.agents`.
 * Components past the deepest existing one are appended as written.
 */
function physicalPath(target: string, cwd: string, depth = 0): string {
    let current = isAbsolute(target) ? sep : physicalPath(cwd, sep, depth + 1);
    for (const part of target.split(sep)) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            current = dirname(current);
            continue;
        }
        const next = current === sep ? sep + part : current + sep + part;
        let stat;
        try {
            stat = lstatSync(next);
        } catch {
            current = next;
            continue;
        }
        if (stat.isSymbolicLink()) {
            try {
                current = realpathSync(next);
            } catch {
                // A dangling link: follow its text, since the file it names may be created next.
                current = depth < 40 ? physicalPath(readlinkSync(next), current, depth + 1) : next;
            }
        } else {
            current = next;
        }
    }
    return current;
}

function isProtectedConfig(path: string): boolean {
    const segments = path.split(sep);
    return segments.includes('.agents') || segments.includes('.gemini')
        || path === '/etc/antigravity' || path.startsWith('/etc/antigravity/');
}

/** True when `target`, as written or as the filesystem resolves it from any of `roots`, is a hook-config location. */
export function isProtectedTarget(target: string, roots: string[]): boolean {
    const bases = isAbsolute(target) ? [roots[0] ?? sep] : roots;
    return bases.some((root) => isProtectedConfig(resolve(root, target)) || isProtectedConfig(physicalPath(target, root)));
}

/** Every `Workspace` value anywhere in a subagent call, since agy takes one per spec in a `Subagents` list too. */
function workspacesIn(value: unknown, out: unknown[] = []): unknown[] {
    if (Array.isArray(value)) {
        for (const item of value) workspacesIn(item, out);
    } else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            if (key === 'Workspace') out.push(inner);
            else workspacesIn(inner, out);
        }
    }
    return out;
}

/** Every `TypeName` value anywhere in a subagent call, single or in a `Subagents` list. */
function typeNamesIn(value: unknown, out: unknown[] = []): unknown[] {
    if (Array.isArray(value)) {
        for (const item of value) typeNamesIn(item, out);
    } else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            if (key === 'TypeName') out.push(inner);
            else typeNamesIn(inner, out);
        }
    }
    return out;
}

/**
 * An agent that does not inherit the user's customizations runs without the hooks in `~/.gemini/config/hooks.json`,
 * this guard among them. Each key is read without regard to case or separators, and only the value that keeps
 * inheritance on passes.
 */
const INHERITANCE_FIELDS = new Map<string, { label: string; keepsInheritance: unknown }>([
    ['inheritcustomizations', { label: 'inheritCustomizations', keepsInheritance: true }],
    ['inheritscopes', { label: 'inheritScopes', keepsInheritance: 'all' }],
]);

/** The first field in `value`, at any depth, that turns inheritance off, as `key: value`; null when none does. */
function inheritanceOff(value: unknown): string | null {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = inheritanceOff(item);
            if (found) return found;
        }
    } else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            const field = INHERITANCE_FIELDS.get(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
            if (field && inner !== field.keepsInheritance) return `${field.label}: ${JSON.stringify(inner) ?? String(inner)}`;
            const found = inheritanceOff(inner);
            if (found) return found;
        }
    }
    return null;
}

/** Subagent types agy ships with no definition file. */
const BUILT_IN_SUBAGENTS = new Set(['self', 'research', 'browser']);

function errorCode(error: unknown): string {
    return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}

/** An agents directory as the filesystem resolves it, or null when it does not exist. Any other error throws. */
function canonicalAgentsDir(dir: string): string | null {
    try {
        return realpathSync(dir);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw new Error(`the agents directory ${dir} cannot be resolved (${errorCode(error)})`);
    }
}

/** The files agy reads markdown agents from in one directory: `<dir>/<file>.md` and `<dir>/<subdir>/agent.md`, no deeper. */
function agentFilesIn(dir: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch (error) {
        throw new Error(`the agents directory ${dir} cannot be listed (${errorCode(error)})`);
    }
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry);
        let isDirectory: boolean;
        try {
            isDirectory = statSync(path).isDirectory();
        } catch {
            continue;
        }
        if (isDirectory) {
            if (existsSync(join(path, 'agent.md'))) files.push(join(path, 'agent.md'));
        } else if (entry.endsWith('.md')) {
            files.push(path);
        }
    }
    return files;
}

/**
 * A file's frontmatter, or why it cannot be read as one, with the `name` a line of it declares even when the
 * frontmatter does not parse: agy's YAML parser may read a file this one rejects.
 */
function readAgentFile(file: string): { frontmatter: Record<string, unknown> } | { error: string; declaredName?: string } {
    let text: string;
    try {
        text = readFileSync(file, 'utf-8');
    } catch (error) {
        return { error: errorCode(error) };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return { error: 'no YAML frontmatter' };
    const declaredName = /^name[ \t]*:[ \t]*(.*?)[ \t]*$/m.exec(match[1])?.[1].replace(/^(['"])(.*)\1$/, '$2');
    let frontmatter: unknown;
    try {
        frontmatter = Bun.YAML.parse(match[1]);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), declaredName };
    }
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return { error: 'frontmatter is not a mapping', declaredName };
    return { frontmatter: frontmatter as Record<string, unknown> };
}

type Candidate = { file: string; dir: string; frontmatter?: Record<string, unknown>; error?: string };

/**
 * Why invoking `typeName` would run a subagent without this guard, or null. agy loads markdown agents from each
 * workspace's `.agents/agents/` before `~/.gemini/config/agents/`, matching the frontmatter `name` exactly; the file
 * name and any deeper directory play no part. The guard checks only the definitions the first of those scopes holds
 * under that name. A file it cannot read or parse elsewhere is no candidate, unless a `name` line still names
 * `typeName`. A custom name with no definition, a lookup error, or a definition that resolves outside its directory
 * is refused, since the guard cannot check what agy would run.
 */
function subagentRefusal(typeName: string, roots: string[], home: string): string | null {
    const scopes = [roots.map((root) => join(root, '.agents', 'agents')), [join(home, '.gemini', 'config', 'agents')]];
    const skipped: string[] = [];
    let selected: Candidate[] = [];
    try {
        for (const scope of scopes) {
            for (const configured of scope) {
                const dir = canonicalAgentsDir(configured);
                if (dir === null) continue;
                for (const file of agentFilesIn(dir)) {
                    const read = readAgentFile(file);
                    if ('frontmatter' in read) {
                        if (read.frontmatter.name === typeName) selected.push({ file, dir, frontmatter: read.frontmatter });
                    } else if (read.declaredName === typeName) {
                        selected.push({ file, dir, error: read.error });
                    } else {
                        skipped.push(`${file} cannot be read as an agent definition (${read.error})`);
                    }
                }
            }
            if (selected.length) break;
        }
    } catch (error) {
        return `${error instanceof Error ? error.message : String(error)}, so the guard cannot tell which definition agy would run for '${typeName}'.`;
    }
    if (!selected.length) {
        if (BUILT_IN_SUBAGENTS.has(typeName)) return null;
        const searched = scopes.flat().join(', ');
        return `no agent definition named '${typeName}' that agy would load (searched ${searched}${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}), so the guard cannot check it. Invoke a built-in subagent (${[...BUILT_IN_SUBAGENTS].join(', ')}) or a markdown agent defined there.`;
    }
    for (const { file, dir, frontmatter, error } of selected) {
        if (error !== undefined || !frontmatter) {
            return `${file} defines agent '${typeName}' but cannot be read as an agent definition (${error}), so the guard cannot tell whether it keeps this guard's hooks. Fix or remove that file.`;
        }
        let real: string;
        try {
            real = realpathSync(file);
        } catch (lookup) {
            return `${file}, which defines agent '${typeName}', cannot be resolved (${errorCode(lookup)}).`;
        }
        if (!real.startsWith(dir + sep)) {
            return `${file}, which defines agent '${typeName}', resolves outside its agents directory (${real}), so the guard cannot tell whether agy reads the same file.`;
        }
        const off = inheritanceOff(frontmatter);
        if (off) {
            return `agent '${typeName}' (${file}) sets ${off}, so it would run without the user's hooks, this guard among them. Agents may only invoke subagents that inherit customizations.`;
        }
    }
    return null;
}

function stepsOf(command: string) {
    try {
        return extractCommands(command);
    } catch {
        return null;
    }
}

function readsOnly(command: string): boolean {
    // Any redirect may write, whatever its file descriptor.
    if (command.includes('>')) return false;
    const steps = stepsOf(command);
    return steps !== null && steps.length > 0 && steps.every((step) =>
        !step.stdoutFiles?.length
        && (READ_ONLY_COMMANDS.has(step.name)
            || (step.name === 'git' && READ_ONLY_GIT.has(step.args[0] ?? '') && !step.args.some((arg) => arg.startsWith('--output')))));
}

const WRITING_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

/**
 * The statements and compound commands of the script, whose own redirects (`(…) 2> f`, `{ …; } > f`, `done 2> f`)
 * apply to everything inside them. The shared walker yields only simple commands; this follows the same structural
 * fields it does, and leaves words and substitutions to it.
 */
function compoundNodes(node: unknown, out: Array<{ redirects?: unknown }> = []): Array<{ redirects?: unknown }> {
    if (Array.isArray(node)) {
        for (const item of node) compoundNodes(item, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    const value = node as Record<string, unknown> & { type?: unknown; items?: unknown; redirects?: unknown };
    if (value.type === 'Command') return out;
    out.push(value);
    for (const key of ['commands', 'command', 'body', 'clause', 'then', 'else']) compoundNodes(value[key], out);
    if (Array.isArray(value.items)) for (const item of value.items) compoundNodes((item as { body?: unknown })?.body, out);
    return out;
}

/**
 * Every file a simple command's redirect may write, on any file descriptor, found by the walker `extractCommands`
 * uses, so commands inside `$(…)`, backticks and process substitutions count too.
 */
function redirectTargets(command: string): string[] | null {
    let commands: Array<{ redirects?: unknown }>;
    try {
        const script = parseShell(command);
        commands = [...walkCommandNodes(script), ...compoundNodes(script)];
    } catch {
        return null;
    }
    return commands.flatMap((node) => (Array.isArray(node.redirects) ? node.redirects : []).flatMap((redirect: unknown) => {
        const { operator, target } = (redirect ?? {}) as { operator?: string; target?: { value?: unknown; text?: unknown } };
        const value = String(target?.value ?? target?.text ?? '');
        // `>&2` and `>&-` duplicate or close a descriptor; any other `>&` target is a file.
        return operator && WRITING_REDIRECTS.has(operator) && !(operator === '>&' && /^(?:\d+|-)$/.test(value)) ? [value] : [];
    }));
}

/** True when a word or redirect target of the command line names a hook-config location through a symlink. */
function aliasesProtectedPath(command: string, roots: string[]): boolean {
    const steps = stepsOf(command);
    const redirects = redirectTargets(command);
    // A line the parser cannot read is refused by the policy behind this check.
    if (steps === null || redirects === null) return false;
    return [...steps.flatMap((step) => step.args), ...redirects].some((word) =>
        word !== '' && !word.startsWith('-') && isProtectedTarget(word, roots));
}

function targetsOf(args: Args): string[] {
    return PATH_KEYS.map((key) => args[key]).filter((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * `sendEmail` read as `send_Email`: the shared matchers fold case and punctuation themselves but split words only at
 * punctuation.
 */
function splitCamelCase(name: string): string {
    return splitAtLowerUpper(name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'));
}

/**
 * The words of a name split at punctuation, case changes and acronym ends (`GMailAPISend` → G, Mail, API, Send),
 * plus each adjacent pair joined, since a vendor word can itself be split by its capitals (G + Mail → GMail).
 */
function nameTokens(name: string): string[] {
    const words = name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
    return [...words, ...words.slice(1).map((word, i) => words[i] + word)].map((word) => word.toLowerCase());
}

/** `MyGMail` read as `My_GMail`: a split that leaves a capitalised run whole. */
function splitAtLowerUpper(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/** A shell command line, judged as `run_command` judges it. */
function decideShell(command: unknown, runsIn: string | undefined, roots: string[], base: ToolCall): Verdict {
    if (typeof command !== 'string' || !command.trim()) return denied('no command line to check.');
    const inProtected = runsIn !== undefined && isProtectedTarget(runsIn, roots);
    const anchors = runsIn !== undefined ? [physicalPath(runsIn, roots[0])] : roots;
    if ((PROTECTED_TEXT.test(command) || inProtected || aliasesProtectedPath(command, anchors)) && !readsOnly(command)) {
        return denied('this command touches .agents/, ~/.gemini/ or /etc/antigravity/, where hook configs live. Agents may not change them.');
    }
    const workdir = runsIn !== undefined ? { workdir: runsIn } : {};
    return decideToolCall({ ...base, tool_name: 'Bash', tool_input: { command, ...workdir } }, AGY_APPROVAL_HANDOFF);
}

/** The verdict for one agy hook payload. `home` is where `~/.gemini` lives, the hook's own HOME unless given. */
export function decideAgyCall(payload: unknown, { home = process.env.HOME || homedir() }: { home?: string } = {}): Verdict {
    if (!payload || typeof payload !== 'object') return denied('the hook input is not a JSON object.');
    const { hookEventName, toolCall, cwd: rawCwd, workspacePaths } = payload as {
        hookEventName?: unknown;
        toolCall?: unknown;
        cwd?: unknown;
        workspacePaths?: unknown;
    };
    // Only a named event other than PreToolUse is outside this guard; a null or missing one is checked in full.
    if (typeof hookEventName === 'string' && hookEventName !== 'PreToolUse') return { action: 'allow' };
    const call = (toolCall ?? {}) as { name?: unknown; args?: unknown; id?: unknown };
    if (typeof call.name !== 'string' || !call.name) return denied('the hook input names no tool, so the guard cannot check this call.');
    const name = call.name;
    const args: Args = call.args && typeof call.args === 'object' ? call.args as Args : {};
    // Hooks may run from a plugin's own directory, so the session's workspaces, not the hook cwd, anchor relative paths.
    const workspaces = Array.isArray(workspacePaths)
        ? workspacePaths.filter((p): p is string => typeof p === 'string' && isAbsolute(p))
        : [];
    const roots = workspaces.length ? workspaces : [typeof rawCwd === 'string' && rawCwd ? rawCwd : process.cwd()];
    const cwd = roots[0];
    const base: ToolCall = { cwd, ...(typeof call.id === 'string' ? { tool_use_id: call.id } : {}) };

    if (name === 'ask_question') {
        for (const root of roots) {
            const verdict = decideToolCall({ ...base, cwd: root, tool_name: 'request_user_input', tool_input: args }, AGY_APPROVAL_HANDOFF);
            if (verdict.action === 'deny') return verdict;
        }
        return { action: 'allow' };
    }
    if (READ_ONLY_TOOLS.has(name)) return { action: 'allow' };

    if (name === 'run_command') {
        // Any value but an explicit false may be read as a request to leave the sandbox.
        if (args.BypassSandbox !== undefined && args.BypassSandbox !== false) {
            return denied('commands may not run outside the sandbox (BypassSandbox).');
        }
        const runsIn = typeof args.Cwd === 'string' && args.Cwd ? args.Cwd : undefined;
        return decideShell(args.CommandLine, runsIn, roots, base);
    }

    if (name === 'manage_task') {
        const action = typeof args.Action === 'string' ? args.Action : '';
        if (TASK_READ_ACTIONS.has(action) && (args.Input === undefined || args.Input === '')) return { action: 'allow' };
        if (action === 'send_input') {
            return denied("manage_task send_input is not allowed: this guard cannot know which directory the running task's shell is in, so it cannot check the input as a command, and a build never needs to type into a running task. Run the command with run_command instead.");
        }
        return denied(`manage_task action '${action || '(none)'}' is not one this guard can check.`);
    }

    if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
        const targets = targetsOf(args);
        if (targets.length === 0) return denied(`${name} names no file, so the guard cannot check it.`);
        for (const target of targets) {
            if (isProtectedTarget(target, roots)) {
                return denied(`'${target}' is a hook-config location (.agents/, ~/.gemini/ or /etc/antigravity/). Agents may not change it.`);
            }
        }
        const [first, ...rest] = targets;
        return decideToolCall({
            ...base,
            tool_name: WRITE_TOOLS.has(name) ? 'Write' : 'Edit',
            tool_input: { file_path: first, ...(rest.length ? { edits: rest.map((file_path) => ({ file_path })) } : {}) },
        }, AGY_APPROVAL_HANDOFF);
    }

    if (name === 'call_mcp_tool') {
        const server = args.ServerName;
        const tool = args.ToolName;
        if (typeof server !== 'string' || !server || typeof tool !== 'string' || !tool) {
            return denied('call_mcp_tool names no server or tool, so the guard cannot check it.');
        }
        const input = args.Arguments && typeof args.Arguments === 'object' ? args.Arguments as Args : {};
        // Splitting adds a word the email matcher reads (`sendEmail`) but can also break one (`GMail` becomes `G_Mail`),
        // so the call is judged under whichever spelling the matcher catches. One policy call, since a gate may wait.
        const spellings = (name: string) => [name, splitCamelCase(name), splitAtLowerUpper(name)];
        const names = [...new Set(spellings(server).flatMap((s) =>
            [splitCamelCase(tool), ...spellings(tool)].map((t) => `mcp__${s}__${t}`)))];
        // Last, every word of both names at once, so `GMailAPISend` still offers the matcher both `gmail` and `send`.
        names.push(`mcp__${nameTokens(server).join('_')}__${nameTokens(tool).join('_')}`);
        const toolName = names.find((n) => evaluateEmailToolCall(n, input, { isScheduledTask: false }).action === 'gate') ?? names[0];
        return decideToolCall({ ...base, tool_name: toolName, tool_input: input }, AGY_APPROVAL_HANDOFF);
    }

    if (SUBAGENT_TOOLS.has(name)) {
        const allowed = new Set(roots.map((root) => physicalPath(root, sep)));
        for (const workspace of workspacesIn(args)) {
            if (workspace === undefined || workspace === '') continue;
            if (typeof workspace !== 'string') return denied(`${name} has an unreadable Workspace.`);
            if (!allowed.has(physicalPath(workspace, cwd))) {
                return denied(`a subagent may only work in this session's workspace (${[...allowed].join(', ')}); a workspace elsewhere loads its own hook config.`);
            }
        }
        if (name === 'define_subagent') {
            const off = inheritanceOff(args);
            if (off) return denied(`define_subagent sets ${off}; a subagent that does not inherit customizations runs without the user's hooks, this guard among them.`);
            return { action: 'allow' };
        }
        const typeNames = typeNamesIn(args);
        if (typeNames.some((typeName) => typeof typeName !== 'string')) return denied(`${name} has an unreadable TypeName.`);
        for (const typeName of typeNames.filter((value): value is string => value !== '')) {
            const refusal = subagentRefusal(typeName, roots, home);
            if (refusal) return denied(refusal);
        }
        return { action: 'allow' };
    }

    return denied(`agy tool '${name}' is not on this guard's allowlist.`);
}

function main(): void {
    let reply: Verdict;
    try {
        const raw = readFileSync(0, 'utf-8');
        reply = decideAgyCall(raw.trim() ? JSON.parse(raw) : null);
    } catch (error) {
        reply = denied(`the guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.stdout.write(JSON.stringify(reply.action === 'deny' ? { decision: 'deny', reason: reply.reason.toWellFormed() } : { decision: 'allow' }));
    process.exit(0);
}

if (import.meta.main) main();
