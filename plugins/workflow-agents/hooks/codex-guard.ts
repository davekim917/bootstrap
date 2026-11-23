#!/usr/bin/env bun
/**
 * Codex PreToolUse adapter for the shared command and file-safety policy (`guard-policy.ts`).
 *
 * Codex loads this adapter from the plugin's native hooks manifest. Codex rejects a PreToolUse
 * `permissionDecision: "ask"` as unsupported and then runs the command, so an approval-tier command outside
 * NanoClaw is denied with a hand-off to the user.
 */
import { readFileSync } from 'fs';
import { decideToolCall } from './guard-policy';

export const LOCAL_APPROVAL_HANDOFF =
    'This needs human approval, and this Codex session cannot ask for it. Do not retry or work around it: give the user the exact command to run themselves.';

function emitContinue(): never {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
}

function emitDeny(reason: string): never {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

function main(): void {
    let verdict;
    try {
        const eventArg = process.argv[2];
        const raw = readFileSync(0, 'utf-8');
        const input = raw.trim() ? JSON.parse(raw) : {};
        if (input === null) throw new Error('the hook input is null, not an object.');
        const event = eventArg ?? input.hook_event_name;
        if (event && event !== 'PreToolUse') emitContinue();
        verdict = decideToolCall(input, LOCAL_APPROVAL_HANDOFF);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitDeny(message.startsWith('BLOCKED:') || message.startsWith('GATED:') ? message : `BLOCKED: ${message}`);
    }
    if (verdict.action === 'deny') emitDeny(verdict.reason);
    emitContinue();
}

if (import.meta.main) main();
