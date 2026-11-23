/**
 * Shared decision logic for the file-protection guard. PURE: no I/O, no stdin,
 * no process.exit, no self-execution at import time.
 *
 * This is the SINGLE SOURCE OF TRUTH for "which edit targets are protected".
 * Each runtime ships a thin adapter that owns its own I/O surface and reuses
 * this core, so they can never drift:
 *   - Claude:   file-protection.ts          (Edit|MultiEdit|Write PreToolUse hook, exit 2)
 *   - OpenCode: opencode-guard.ts           (tool.execute.before on edit/write → throw)
 *   - Codex:    codex-hooks/runner.ts        (Edit/apply_patch PreToolUse → deny decision)
 *
 * An edit tool whose input yields no target path is blocked: a renamed argument
 * must not turn into an unguarded write.
 *
 * Vendored into workflow-agents by scripts/vendor-guards.mjs (--check gated).
 */

import { posix } from 'path';

// Explicitly allowed files (template files that look like protected ones).
// Checked BEFORE the protected patterns.
export const ALLOWED_FILES = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.gitignore',
    '.dockerignore',
];

// Protected path segments — block if the path contains any of these.
export const PROTECTED_SEGMENTS = [
    '.git/',
    '.git\\', // Windows-style
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
    // These files relax a gate: the public-boundary allowlist exempts values from
    // the leak scan, its baseline sets how many flagged lines each file may hold,
    // a lab scope names the org whose LAB-* repos skip destructive-command
    // approval in lab sessions, and a dev scope names the Snowflake connections
    // that skip it everywhere. Their owner edits them.
    '.public-boundary-allowlist.json',
    '.public-boundary-baseline.json',
    'lab-scope.local.json',
    'dev-scope.local.json',
];

// Protected glob patterns (IaC state/config). Match path segments rather than
// only repo-relative paths so absolute and Windows-style tool inputs cannot
// bypass the guard.
export const PROTECTED_GLOBS = [/(?:^|\/)infra\/terraform\//, /(?:^|\/)terraform\//];

/** Edit-tool names across runtimes (Claude / OpenCode / Codex). */
export const EDIT_TOOLS = new Set([
    'Edit',
    'MultiEdit',
    'Write', // Claude
    'edit',
    'write',
    'write_file',
    'create_file', // OpenCode / generic
    'apply_patch', // Codex
]);

// .git is a directory in a clone and a file in a linked worktree; either way
// nothing under it is a template, so it is checked before the allowlist.
const GIT_METADATA = /(?:^|\/)\.git(?:\/|$)/;

/**
 * `path` as the writer resolves it: against `cwd` when relative, with `.`
 * and `..` collapsed. Symlinks are not followed.
 */
export function normalizeEditPath(path: string, cwd?: string): string {
    const p = path.replace(/\\/g, '/');
    const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
    return posix.normalize(cwd && !absolute ? `${cwd.replace(/\\/g, '/')}/${p}` : p);
}

/**
 * Returns true if an edit to `path` should be blocked. `cwd` places a
 * relative path for the directory rules (.git, terraform) only: the name rules
 * match substrings, so a working directory such as `.envs/` must not block
 * every file under it.
 */
export function isProtectedEditPath(path: string, cwd?: string): boolean {
    if (!path) return false;

    const normalizedPath = normalizeEditPath(path);
    const resolvedPath = cwd ? normalizeEditPath(path, cwd) : normalizedPath;
    if (GIT_METADATA.test(resolvedPath)) return true;

    // Allowlist first (template files that look like protected files).
    for (const allowed of ALLOWED_FILES) {
        if (normalizedPath.endsWith(allowed)) return false;
    }
    // Segment-contains.
    for (const segment of PROTECTED_SEGMENTS) {
        if (normalizedPath.includes(segment.replace(/\\/g, '/'))) return true;
    }
    // Glob patterns.
    for (const pattern of PROTECTED_GLOBS) {
        if (pattern.test(resolvedPath)) return true;
    }
    return false;
}

// Both runtimes split on \n alone, read headers only at column 0 (a line
// starting with a space is hunk context), and trim the path's ends, so a \r
// inside a path stays in it. OpenCode accepts no space after the colon. "Move
// to" names the file an update is written to.
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to):([\s\S]*)$/;

/** Extract file paths from the `apply_patch` envelope format (Codex and OpenCode). */
export function filePathsFromPatch(text: unknown): string[] {
    if (typeof text !== 'string') return [];
    const paths: string[] = [];
    for (const line of text.split('\n')) {
        const path = line.match(PATCH_HEADER)?.[1].trim();
        if (path) paths.push(path);
    }
    return paths;
}

/**
 * Where each runtime puts an apply_patch envelope: OpenCode `patchText`, the
 * Codex PreToolUse hook `command`, older/generic shapes `patch`/`diff`/`input`.
 */
const PATCH_KEYS = ['patch', 'patchText', 'diff', 'input', 'command'] as const;

/** Returned by checkEditProtection when an edit tool's input names no target it can read. */
export const UNREADABLE_EDIT_TARGET = '(edit target not found in tool input)';

/**
 * Pull every edit target from a tool_input across runtimes:
 *   - Claude:   { file_path } | { edits: [{ file_path }] }
 *   - OpenCode: { filePath } | { patchText } (apply_patch envelope)
 *   - Codex:    { command } (apply_patch hook input), { patch | diff | input }, { paths }, { files }
 */
export function editPathsFromToolInput(toolInput: Record<string, unknown> = {}): string[] {
    const paths: string[] = [];

    // file_path (Claude), path (generic), filePath (OpenCode edit/write tools).
    for (const key of ['file_path', 'path', 'filePath'] as const) {
        const v = toolInput[key];
        if (typeof v === 'string') paths.push(v);
    }
    for (const key of ['paths', 'files'] as const) {
        const v = toolInput[key];
        if (Array.isArray(v)) {
            for (const item of v) if (typeof item === 'string') paths.push(item);
        }
    }
    if (Array.isArray(toolInput.edits)) {
        for (const edit of toolInput.edits as Array<Record<string, unknown>>) {
            if (edit && typeof edit.file_path === 'string') paths.push(edit.file_path);
            if (edit && typeof edit.path === 'string') paths.push(edit.path);
        }
    }
    for (const key of PATCH_KEYS) paths.push(...filePathsFromPatch(toolInput[key]));

    return [...new Set(paths.filter(Boolean))];
}

/**
 * Evaluate an edit tool call. Returns the first protected path (the block
 * reason), UNREADABLE_EDIT_TARGET when the input names no target, or null when
 * allowed. Callers own the block I/O.
 */
export function checkEditProtection(
    toolName: string,
    toolInput: Record<string, unknown> = {},
    cwd?: string,
): string | null {
    if (!EDIT_TOOLS.has(toolName)) return null;
    const paths = editPathsFromToolInput(toolInput);
    if (paths.length === 0) return UNREADABLE_EDIT_TARGET;
    return firstProtectedPath(paths, cwd);
}

export function firstProtectedPath(paths: string[], cwd?: string): string | null {
    for (const p of paths) {
        if (isProtectedEditPath(p, cwd)) return p;
    }
    return null;
}
