#!/usr/bin/env bun
/**
 * agy (Antigravity CLI) PreToolUse adapter for the shared command and file-safety policy (`guard-policy.ts`).
 *
 * agy reads hook commands from `hooks.json` files and passes `{hookEventName, toolCall: {name, args}, cwd}` on
 * stdin. It runs the tool when a hook exits 0 with empty output, so `agy-guard.sh` turns every failure into a deny.
 *
 * agy also hot-reloads hook configs from `.agents/` (and its aliases `.agent/`, `_agents/`, `_agent/`) and `~/.gemini/`. Writing one can disable this guard
 * mid-session, so this adapter refuses those writes from any tool. Shell coverage is a best-effort read of the
 * command line; the sandbox the worker runs in is what makes those paths immutable.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { decideToolCall, type ToolCall, type Verdict } from './guard-policy';
import { extractCommands, lineRedirectWrites } from './guards/block-destructive-core';
import { evaluateEmailToolCall } from './guards/email-gate-core';
import builtIns from './agy-builtins.json' with { type: 'json' };

export const AGY_APPROVAL_HANDOFF =
    'This needs human approval, and this agy session cannot ask for it. Do not retry or work around it: give the user the exact command to run themselves.';

/** Tools that change nothing outside agy's own session state. */
export const READ_ONLY_TOOLS = new Set([
    'read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name', 'command_status',
    'read_url_content', 'search_web', 'list_resources', 'read_resource', 'list_permissions',
    'wait', 'wait_5_seconds', 'finish', 'ask_permission', 'ask_custom_permission', 'send_message',
    // A step checklist, the subagent list (and kill), a timer whose fire is a new turn whose calls come through here,
    // and the swarm board, under both the declared and the hook-time names.
    'update_steps', 'manage_subagents', 'schedule',
    'post_message', 'swarm_post_message', 'read_board', 'swarm_read_board', 'swarm_wait',
]);

/** agy's own names, runtime and documented, for tools that write a file. */
const WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const EDIT_TOOLS = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
const PATH_KEYS = ['Path', 'TargetFile', 'File', 'FilePath', 'AbsolutePath'];
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent']);
const SWARM_TOOLS = new Set(['swarm', 'swarm_manage']);
/** Swarm actions that start no worker. */
const SWARM_NON_SPAWNING_ACTIONS = new Set(['status', 'models', 'model', 'kill', 'title']);
/** `manage_task` actions that send nothing to a running task. */
const TASK_READ_ACTIONS = new Set(['list', 'status', 'kill']);

/** Shell commands that only read. A command line touching a protected path passes only if every step is one. */
const READ_ONLY_COMMANDS = new Set([
    'cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'wc', 'file',
    'readlink', 'realpath', 'du', 'jq', 'diff', 'sha256sum', 'md5sum', 'test', '[',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'show', 'diff', 'ls-files', 'rev-parse', 'blame']);
/** The directory names agy reads workspace customizations, hooks among them, from; `.agents` is the documented one. */
const WORKSPACE_CUSTOMIZATION_DIRS = ['.agents', '.agent', '_agents', '_agent'];
/** The names besides `.agents` that agy reads only at a workspace root; anywhere else they are ordinary directories. */
const ROOT_ONLY_CUSTOMIZATION_DIRS = WORKSPACE_CUSTOMIZATION_DIRS.filter((name) => name !== '.agents');
const PROTECTED_TEXT = /(?:^|[\s'"=:/~])(?:\.agents|\.gemini)(?:[/\s'"]|$)|\/etc\/antigravity\b/;
const PROTECTED_LOCATIONS = ".agents/, a workspace root's .agent/, _agents/ or _agent/, ~/.gemini/ or /etc/antigravity/";

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

function isProtectedConfig(path: string, rootOnlyDirs: string[]): boolean {
    const segments = path.split(sep);
    return segments.includes('.agents') || segments.includes('.gemini')
        || path === '/etc/antigravity' || path.startsWith('/etc/antigravity/')
        || rootOnlyDirs.some((dir) => path === dir || path.startsWith(dir + sep));
}

/** The nearest directory at or above `start` that holds a `.git` entry, or null. */
function gitTopLevel(start: string): string | null {
    for (let dir = physicalPath(start, sep); ; dir = dirname(dir)) {
        try {
            lstatSync(join(dir, '.git'));
            return dir;
        } catch {
            // No .git here; try the parent.
        }
        if (dirname(dir) === dir) return null;
    }
}

/**
 * The root-only customization directories (`.agent/`, `_agents/`, `_agent/`) of each workspace root and of the git top
 * level of the hook's cwd, as written and as the filesystem resolves them.
 */
function rootOnlyCustomizationDirs(roots: string[], cwd: string): string[] {
    const top = gitTopLevel(cwd);
    const anchors = [...roots, ...(top ? [top] : [])];
    return [...new Set(anchors.flatMap((anchor) => ROOT_ONLY_CUSTOMIZATION_DIRS.flatMap((name) => {
        const dir = join(anchor, name);
        return [dir, physicalPath(dir, sep)];
    })))];
}

/** True when `target`, as written or as the filesystem resolves it from any of `roots`, is a hook-config location. */
export function isProtectedTarget(target: string, roots: string[], rootOnlyDirs: string[] = []): boolean {
    const bases = isAbsolute(target) ? [roots[0] ?? sep] : roots;
    return bases.some((root) => isProtectedConfig(resolve(root, target), rootOnlyDirs) || isProtectedConfig(physicalPath(target, root), rootOnlyDirs));
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

/**
 * Subagent types agy ships with no definition file, as `agy-builtins-capture.ts` read them from the system prompts
 * agy stored. agy refuses a name it does not know, so a name kept from an older capture costs nothing.
 */
export const BUILT_IN_SUBAGENTS: ReadonlySet<string> = new Set(Object.keys(builtIns.subagents));
const BUILT_INS_CAPTURED_AT = builtIns.capturedAgyVersion;

function errorCode(error: unknown): string {
    return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}

/**
 * An agents directory as the filesystem resolves it, or null when it does not exist. ENOENT alone does not mean
 * absent: a link on the path whose target is missing also gives ENOENT, so the deepest component that exists must be
 * a real directory. Any other error throws.
 */
function canonicalAgentsDir(dir: string): string | null {
    try {
        return realpathSync(dir);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new Error(`the directory ${dir} cannot be resolved (${errorCode(error)})`);
    }
    for (let path = dir; ; path = dirname(path)) {
        let info;
        try {
            info = lstatSync(path);
        } catch (error) {
            if (errorCode(error) === 'ENOENT' && dirname(path) !== path) continue;
            throw new Error(`the directory ${dir} cannot be resolved (${errorCode(error)} at ${path})`);
        }
        if (info.isSymbolicLink()) {
            try {
                realpathSync(path);
            } catch (error) {
                throw new Error(`the directory ${dir} cannot be resolved (${path} is a link whose target cannot be resolved: ${errorCode(error)})`);
            }
        }
        return null;
    }
}

/**
 * The files agy reads markdown agents from in one directory: `<dir>/<file>.md` and `<dir>/<subdir>/agent.md`, no
 * deeper. An entry the guard cannot inspect could hold any agent's definition, so every error but an absent
 * `agent.md` throws.
 */
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
        } catch (error) {
            throw new Error(`${path} in the agents directory cannot be checked (${errorCode(error)})`);
        }
        if (isDirectory) {
            const nested = join(path, 'agent.md');
            try {
                lstatSync(nested);
            } catch (error) {
                if (errorCode(error) === 'ENOENT') continue;
                throw new Error(`${nested} cannot be checked (${errorCode(error)})`);
            }
            try {
                statSync(nested);
            } catch (error) {
                throw new Error(`${nested} cannot be checked (${errorCode(error)})`);
            }
            files.push(nested);
        } else if (entry.endsWith('.md')) {
            files.push(path);
        }
    }
    return files;
}

/**
 * A file's frontmatter, or why it cannot be read as one, with the `name` a line of it declares even when the
 * frontmatter does not parse: agy's YAML parser may read a file this one rejects. A file that cannot be read at all
 * throws, since its name, and so the agent it defines, is unknown.
 */
function readAgentFile(file: string): { frontmatter: Record<string, unknown> } | { error: string; declaredName?: string } {
    let text: string;
    try {
        text = readFileSync(file, 'utf-8');
    } catch (error) {
        throw new Error(`${file} in the agents directory cannot be read (${errorCode(error)})`);
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
 * The agents directories one customization root holds, as the filesystem resolves them: `<root>/agents/` and each
 * `<root>/plugins/<plugin>/agents/`. Every lookup error throws, as in `agentFilesIn`.
 */
function agentsDirsUnder(customizationRoot: string): string[] {
    const dirs: string[] = [];
    const direct = canonicalAgentsDir(join(customizationRoot, 'agents'));
    if (direct !== null) dirs.push(direct);
    const plugins = canonicalAgentsDir(join(customizationRoot, 'plugins'));
    if (plugins === null) return dirs;
    let entries: string[];
    try {
        entries = readdirSync(plugins);
    } catch (error) {
        throw new Error(`the plugins directory ${plugins} cannot be listed (${errorCode(error)})`);
    }
    for (const entry of entries) {
        const path = join(plugins, entry);
        let isDirectory: boolean;
        try {
            isDirectory = statSync(path).isDirectory();
        } catch (error) {
            throw new Error(`${path} in the plugins directory cannot be checked (${errorCode(error)})`);
        }
        if (!isDirectory) continue;
        const pluginAgents = canonicalAgentsDir(join(path, 'agents'));
        if (pluginAgents !== null) dirs.push(pluginAgents);
    }
    return dirs;
}

/**
 * Why invoking `typeName` would run a subagent without this guard, or null. agy loads markdown agents from the
 * workspace before `~/.gemini/config/`: in each workspace from `<root>/agents/` under every customization directory
 * name agy reads, and in both scopes from each plugin's `agents/`. It matches the frontmatter `name` exactly; the file
 * name and any deeper directory play no part. agy's order among the workspace directories is undocumented, so every
 * workspace match is checked, and the global scope only when the workspace has none. A readable file whose
 * frontmatter does not parse is no candidate, unless a `name` line still names `typeName`. A custom name with no
 * definition, any lookup error before a scope resolves the name (built-ins included, as a custom file may override
 * one), or a definition that resolves outside its directory is refused, since the guard cannot check what agy would
 * run.
 */
function subagentRefusal(typeName: string, roots: string[], home: string): string | null {
    const scopes = agentScopes(roots, home);
    const skipped: string[] = [];
    let selected: Candidate[] = [];
    try {
        for (const scope of scopes) {
            for (const dir of scope.flatMap(agentsDirsUnder)) {
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
        return `no agent definition named '${typeName}' that agy would load (searched agents/ and plugins/*/agents/ under ${searched}${skipped.length ? `; skipped: ${skipped.join('; ')}` : ''}), and it is not one of agy's built-in subagents (${[...BUILT_IN_SUBAGENTS].join(', ')}; captured from agy ${BUILT_INS_CAPTURED_AT}), so the guard cannot check it. Invoke one of those or a markdown agent defined there. If this agy offers a built-in missing from that list, refresh agy-builtins.json with agy-builtins-capture.ts.`;
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

/** `word` as one single-quoted shell word. */
function shellWord(word: string): string {
    return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The customization roots agy loads markdown agents from, in its order: every workspace's, then the global one. */
function agentScopes(roots: string[], home: string): string[][] {
    return [
        roots.flatMap((root) => WORKSPACE_CUSTOMIZATION_DIRS.map((name) => join(root, name))),
        [join(home, '.gemini', 'config')],
    ];
}

/**
 * Every agent name a markdown definition provides under the given workspaces and global config dir (the dir agy
 * reads as `~/.gemini/config`), parsed or only declared. A lookup error throws.
 */
export function definedAgentNames(workspaces: string[], globalConfig: string): Set<string> {
    const names = new Set<string>();
    const roots = [...workspaces.flatMap((root) => WORKSPACE_CUSTOMIZATION_DIRS.map((name) => join(root, name))), globalConfig];
    for (const dir of roots.flatMap(agentsDirsUnder)) {
        for (const file of agentFilesIn(dir)) {
            const read = readAgentFile(file);
            const name = 'frontmatter' in read ? read.frontmatter.name : read.declaredName;
            if (typeof name === 'string' && name) names.add(name);
        }
    }
    return names;
}

/**
 * Why a workflow script could start an agent that runs without this guard, or null. A script picks its agents' types
 * in Python the guard cannot read, and agy runs a workflow agent of a type that turns inheritance off without the
 * user's hooks, so a script passes only while no definition agy could load, in any scope, does that. A file with no
 * readable name defines no agent agy can start; one with a name the guard cannot parse, or that resolves outside its
 * directory, is refused, as for invoke_subagent.
 */
function workflowAgentRefusal(roots: string[], home: string): string | null {
    try {
        for (const dir of agentScopes(roots, home).flat().flatMap(agentsDirsUnder)) {
            for (const file of agentFilesIn(dir)) {
                const read = readAgentFile(file);
                if (!('frontmatter' in read)) {
                    if (read.declaredName === undefined) continue;
                    return `${file} defines agent '${read.declaredName}' but cannot be read as an agent definition (${read.error}), so the guard cannot tell whether a workflow agent of that type keeps this guard's hooks. Fix or remove that file.`;
                }
                let real: string;
                try {
                    real = realpathSync(file);
                } catch (lookup) {
                    return `${file} cannot be resolved (${errorCode(lookup)}), so the guard cannot tell which agent definition a workflow could start.`;
                }
                if (!real.startsWith(dir + sep)) {
                    return `${file} resolves outside its agents directory (${real}), so the guard cannot tell which agent definition a workflow could start.`;
                }
                const off = inheritanceOff(read.frontmatter);
                if (off) {
                    return `agent '${String(read.frontmatter.name)}' (${file}) sets ${off}, and a workflow script can start an agent of any type without the guard seeing which, so run_workflow is refused while that definition exists. Use invoke_subagent, which is checked per type.`;
                }
            }
        }
    } catch (error) {
        return `${error instanceof Error ? error.message : String(error)}, so the guard cannot tell whether a workflow agent would keep this guard's hooks.`;
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

/** True when a word or redirect target of the command line names a hook-config location through a symlink. */
function aliasesProtectedPath(command: string, roots: string[], rootOnlyDirs: string[]): boolean {
    const steps = stepsOf(command);
    let redirects: string[] | null;
    try {
        redirects = lineRedirectWrites(command).map((write) => write.target);
    } catch {
        redirects = null;
    }
    // A line the parser cannot read is refused by the policy behind this check.
    if (steps === null || redirects === null) return false;
    return [...steps.flatMap((step) => step.args), ...redirects].some((word) =>
        word !== '' && !word.startsWith('-') && isProtectedTarget(word, roots, rootOnlyDirs));
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
function decideShell(command: unknown, runsIn: string | undefined, roots: string[], rootOnlyDirs: string[], base: ToolCall): Verdict {
    if (typeof command !== 'string' || !command.trim()) return denied('no command line to check.');
    const inProtected = runsIn !== undefined && isProtectedTarget(runsIn, roots, rootOnlyDirs);
    const anchors = runsIn !== undefined ? [physicalPath(runsIn, roots[0])] : roots;
    if ((PROTECTED_TEXT.test(command) || inProtected || aliasesProtectedPath(command, anchors, rootOnlyDirs)) && !readsOnly(command)) {
        return denied(`this command touches ${PROTECTED_LOCATIONS}, where hook configs live. Agents may not change them.`);
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
    const rootOnlyDirs = rootOnlyCustomizationDirs(roots, typeof rawCwd === 'string' && rawCwd ? rawCwd : cwd);
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
        return decideShell(args.CommandLine, runsIn, roots, rootOnlyDirs, base);
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
            if (isProtectedTarget(target, roots, rootOnlyDirs)) {
                return denied(`'${target}' is a hook-config location (${PROTECTED_LOCATIONS}). Agents may not change it.`);
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

    if (name === 'generate_image') {
        // agy picks the directory (its own artifacts dir for the conversation); only the file name comes from the model.
        const imageName = args.ImageName;
        if (imageName !== undefined && (typeof imageName !== 'string' || /[\\/]/.test(imageName) || imageName.includes('..'))) {
            return denied("generate_image's ImageName must be a plain file name: agy saves the image in its own artifacts directory, and a path in the name could land it elsewhere.");
        }
        return { action: 'allow' };
    }

    if (name === 'run_workflow') {
        const script = args.Script;
        const scriptPath = args.ScriptPath;
        const inline = typeof script === 'string' && script.trim() !== '';
        const onDisk = typeof scriptPath === 'string' && scriptPath !== '';
        if (inline === onDisk) return denied('run_workflow must set exactly one of Script and ScriptPath, so the guard can check what it runs.');
        const agents = workflowAgentRefusal(roots, home);
        if (agents) return denied(agents);
        // agy runs the script as its own python3 process, whose writes, commands and network calls reach no hook, so
        // it is judged as the command line that would run it, as run_command judges `python3 -c`.
        const words = ['python3', ...(inline ? ['-c', script as string] : [scriptPath as string])];
        if (args.Args !== undefined) words.push(JSON.stringify(args.Args) ?? '');
        const runsIn = typeof args.Cwd === 'string' && args.Cwd ? args.Cwd : undefined;
        return decideShell(words.map(shellWord).join(' '), runsIn, roots, rootOnlyDirs, base);
    }

    if (SWARM_TOOLS.has(name)) {
        const action = typeof args.action === 'string' ? args.action : '';
        if (SWARM_NON_SPAWNING_ACTIONS.has(action)) return { action: 'allow' };
        if (action === 'add') {
            const workspace = args.workspace;
            if (workspace === undefined || workspace === '' || workspace === 'inherit') return { action: 'allow' };
            return denied(`a swarm worker may only work in this session's workspace (workspace "inherit"); '${String(workspace)}' is a new checkout, which loads its own hook config.`);
        }
        return denied(`swarm action '${action || '(none)'}' is not one this guard can check.`);
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
