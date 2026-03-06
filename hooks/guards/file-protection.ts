#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks edits to protected files/paths
 * Exit code 2 blocks the tool (Claude Code semantics)
 */
import { readFileSync } from 'fs';
import type { ToolUseInput } from '../lib/types';

interface FileToolInput extends ToolUseInput {
    tool_name: string;
    tool_input: {
        file_path?: string;
        edits?: Array<{ file_path?: string }>;
    };
}

// Explicitly allowed files (checked before protected patterns)
const ALLOWED_FILES = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.gitignore',
    '.dockerignore',
];

// Protected path segments - block if path contains any of these
const PROTECTED_SEGMENTS = [
    '.git/',
    '.git\\', // Windows-style
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
];

// Protected glob patterns
const PROTECTED_GLOBS = [
    /^infra\/terraform\//,
    /^terraform\//,
];

function isProtected(path: string): boolean {
    if (!path) return false;

    // Check allowlist first (template files that look like protected files)
    for (const allowed of ALLOWED_FILES) {
        if (path.endsWith(allowed)) {
            return false;
        }
    }

    // Check segment contains
    for (const segment of PROTECTED_SEGMENTS) {
        if (path.includes(segment)) {
            return true;
        }
    }

    // Check glob patterns
    for (const pattern of PROTECTED_GLOBS) {
        if (pattern.test(path)) {
            return true;
        }
    }

    return false;
}

function getFilePaths(input: FileToolInput): string[] {
    const toolInput = input.tool_input || {};

    // Support MultiEdit
    if (Array.isArray(toolInput.edits)) {
        return toolInput.edits
            .map(e => e?.file_path)
            .filter((p): p is string => typeof p === 'string');
    }

    // Support Edit/Write
    return toolInput.file_path ? [toolInput.file_path] : [];
}

function main(): void {
    try {
        // Allow bypass via environment variable
        if (process.env.SKIP_FILE_PROTECTION === '1') {
            console.error('[file-protection] Bypassed via SKIP_FILE_PROTECTION');
            process.exit(0);
        }

        const rawInput = readFileSync(0, 'utf-8');
        const input: FileToolInput = JSON.parse(rawInput);

        // Only check Edit, MultiEdit, Write
        if (!['Edit', 'MultiEdit', 'Write'].includes(input.tool_name)) {
            process.exit(0);
        }

        const paths = getFilePaths(input);

        for (const path of paths) {
            if (isProtected(path)) {
                console.error(`
⚠️ BLOCKED: File protection guard
Path: ${path}
Reason: This path is protected from automated edits.
Bypass: export SKIP_FILE_PROTECTION=1 (temporary)
`);
                process.exit(2);
            }
        }

        process.exit(0);
    } catch (error) {
        // Fail open but log the error for debugging
        console.error('[file-protection] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
