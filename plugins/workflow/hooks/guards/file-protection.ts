#!/usr/bin/env bun
/**
 * PreToolUse hook: blocks edits to protected files/paths (.git, lockfiles,
 * .env*, terraform). Thin Claude-hook adapter — all decision logic lives in
 * `file-protection-core.ts` (shared with the OpenCode plugin + the codex
 * container chain). This file owns the Claude-hook I/O surface only.
 *
 * Exit code 2 blocks the tool (Claude Code semantics).
 * Fail-open on parse error (exit 0).
 */
import { readFileSync } from 'fs';
import { checkEditProtection } from './file-protection-core';

function main(): void {
    try {
        // Bypass for deliberate operator edits.
        if (process.env.SKIP_FILE_PROTECTION === '1') {
            console.error('[file-protection] Bypassed via SKIP_FILE_PROTECTION');
            process.exit(0);
        }

        const input = JSON.parse(readFileSync(0, 'utf-8')) as {
            tool_name?: string;
            tool_input?: Record<string, unknown>;
        };

        const blocked = checkEditProtection(input.tool_name ?? '', input.tool_input ?? {});
        if (blocked) {
            console.error(`
⚠️ BLOCKED: File protection guard
Path: ${blocked}
Reason: This path is protected from automated edits.
Bypass: export SKIP_FILE_PROTECTION=1 (temporary)
`);
            process.exit(2);
        }

        process.exit(0);
    } catch (error) {
        // Fail open but log for debugging.
        console.error('[file-protection] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
