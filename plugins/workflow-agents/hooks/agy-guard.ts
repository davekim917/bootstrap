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
import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, isAbsolute, resolve, sep } from 'path';
import { decideToolCall, type ToolCall, type Verdict } from './guard-policy';
import { extractCommands } from './guards/block-destructive-core';

export const AGY_APPROVAL_HANDOFF =
    'This needs human approval, and this agy session cannot ask for it. Do not retry or work around it: give the user the exact command to run themselves.';

/** Tools that change nothing outside agy's own session state. */
export const READ_ONLY_TOOLS = new Set([
    'read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name', 'command_status',
    'read_url_content', 'search_web', 'list_resources', 'read_resource', 'list_permissions',
    'wait', 'wait_5_seconds', 'finish', 'ask_question', 'ask_permission', 'ask_custom_permission',
    'manage_task', 'send_message',
]);

/** agy's own names, runtime and documented, for tools that write a file. */
const WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const EDIT_TOOLS = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
const PATH_KEYS = ['Path', 'TargetFile', 'File', 'FilePath', 'AbsolutePath'];
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent']);

/** Shell commands that only read. A command line touching a protected path passes only if every step is one. */
const READ_ONLY_COMMANDS = new Set([
    'cat', 'ls', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'wc', 'file',
    'readlink', 'realpath', 'du', 'tree', 'jq', 'diff', 'sha256sum', 'md5sum', 'test', '[',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'show', 'diff', 'ls-files', 'rev-parse', 'blame']);
const PROTECTED_TEXT = /(?:^|[\s'"=:/~])(?:\.agents|\.gemini)(?:[/\s'"]|$)|\/etc\/antigravity\b/;

type Args = Record<string, unknown>;

function denied(reason: string): Verdict {
    return { action: 'deny', reason: reason.startsWith('BLOCKED:') ? reason : `BLOCKED: ${reason}` };
}

/** The deepest existing ancestor resolved through symlinks, with the rest of the path appended. */
function resolvedThroughLinks(abs: string): string {
    let existing = abs;
    const rest: string[] = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing) return abs;
        rest.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        existing = parent;
    }
    return [realpathSync(existing), ...rest].join(sep);
}

function isProtectedConfig(path: string): boolean {
    const segments = path.split(sep);
    return segments.includes('.agents') || segments.includes('.gemini')
        || path === '/etc/antigravity' || path.startsWith('/etc/antigravity/');
}

/** The protected hook-config path an edit target names, as written or through a symlink, else null. */
export function protectedConfigTarget(target: string, cwd: string): string | null {
    const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
    if (isProtectedConfig(abs)) return target;
    return isProtectedConfig(resolvedThroughLinks(abs)) ? target : null;
}

function readsOnly(command: string): boolean {
    let steps;
    try {
        steps = extractCommands(command);
    } catch {
        return false;
    }
    return steps.length > 0 && steps.every((step) =>
        !step.stdoutFiles?.length
        && (READ_ONLY_COMMANDS.has(step.name) || (step.name === 'git' && READ_ONLY_GIT.has(step.args[0] ?? ''))));
}

function targetsOf(args: Args): string[] {
    return PATH_KEYS.map((key) => args[key]).filter((value): value is string => typeof value === 'string' && value !== '');
}

/** The verdict for one agy hook payload. */
export function decideAgyCall(payload: unknown): Verdict {
    if (!payload || typeof payload !== 'object') return denied('the hook input is not a JSON object.');
    const { hookEventName, toolCall, cwd: rawCwd } = payload as { hookEventName?: unknown; toolCall?: unknown; cwd?: unknown };
    if (hookEventName !== undefined && hookEventName !== 'PreToolUse') return { action: 'allow' };
    const call = (toolCall ?? {}) as { name?: unknown; args?: unknown; id?: unknown };
    if (typeof call.name !== 'string' || !call.name) return denied('the hook input names no tool, so the guard cannot check this call.');
    const name = call.name;
    const args: Args = call.args && typeof call.args === 'object' ? call.args as Args : {};
    const cwd = typeof rawCwd === 'string' && rawCwd ? rawCwd : process.cwd();
    const base: ToolCall = { cwd, ...(typeof call.id === 'string' ? { tool_use_id: call.id } : {}) };

    if (READ_ONLY_TOOLS.has(name)) return { action: 'allow' };

    if (name === 'run_command') {
        if (args.BypassSandbox === true) return denied('commands may not run outside the sandbox (BypassSandbox).');
        const command = args.CommandLine;
        if (typeof command !== 'string' || !command.trim()) return denied('run_command has no CommandLine to check.');
        if (PROTECTED_TEXT.test(command) && !readsOnly(command)) {
            return denied('this command touches .agents/, ~/.gemini/ or /etc/antigravity/, where hook configs live. Agents may not change them.');
        }
        const workdir = typeof args.Cwd === 'string' && args.Cwd ? { workdir: args.Cwd } : {};
        return decideToolCall({ ...base, tool_name: 'Bash', tool_input: { command, ...workdir } }, AGY_APPROVAL_HANDOFF);
    }

    if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
        const targets = targetsOf(args);
        if (targets.length === 0) return denied(`${name} names no file, so the guard cannot check it.`);
        for (const target of targets) {
            const hit = protectedConfigTarget(target, cwd);
            if (hit) return denied(`'${hit}' is a hook-config location (.agents/, ~/.gemini/ or /etc/antigravity/). Agents may not change it.`);
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
        return decideToolCall({ ...base, tool_name: `mcp__${server}__${tool}`, tool_input: input }, AGY_APPROVAL_HANDOFF);
    }

    if (SUBAGENT_TOOLS.has(name)) {
        const workspace = args.Workspace;
        if (workspace === undefined || workspace === '') return { action: 'allow' };
        if (typeof workspace !== 'string') return denied(`${name} has an unreadable Workspace.`);
        const root = resolvedThroughLinks(resolve(cwd));
        const asked = resolvedThroughLinks(isAbsolute(workspace) ? resolve(workspace) : resolve(cwd, workspace));
        return asked === root
            ? { action: 'allow' }
            : denied(`a subagent may only work in this session's workspace (${root}); a workspace elsewhere loads its own hook config.`);
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
    process.stdout.write(JSON.stringify(reply.action === 'deny' ? { decision: 'deny', reason: reply.reason } : { decision: 'allow' }));
    process.exit(0);
}

if (import.meta.main) main();
