#!/usr/bin/env bun
/**
 * Reads a guard's reply on stdin and prints it back only when it is one JSON value of the runtime's decision schema
 * (`codex` or `agy`); exits 1 otherwise. A host forwards a malformed reply to its own parser, which may record the
 * error and run the tool, so the wrappers turn anything this refuses into a deny.
 */
import { readFileSync } from 'fs';

function exactKeys(value: object, keys: string[]): boolean {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidReply(runtime: string, reply: unknown): boolean {
    if (!isObject(reply)) return false;
    if (runtime === 'agy') {
        if (reply.decision === 'allow') return exactKeys(reply, ['decision']);
        return reply.decision === 'deny' && typeof reply.reason === 'string' && exactKeys(reply, ['decision', 'reason']);
    }
    if (runtime === 'codex') {
        if (reply.continue === true) return exactKeys(reply, ['continue']);
        const out = reply.hookSpecificOutput;
        return exactKeys(reply, ['hookSpecificOutput']) && isObject(out)
            && exactKeys(out, ['hookEventName', 'permissionDecision', 'permissionDecisionReason'])
            && out.hookEventName === 'PreToolUse' && out.permissionDecision === 'deny'
            && typeof out.permissionDecisionReason === 'string';
    }
    return false;
}

if (import.meta.main) {
    try {
        const reply = JSON.parse(readFileSync(0, 'utf-8'));
        if (isValidReply(process.argv[2] ?? '', reply)) {
            process.stdout.write(JSON.stringify(reply));
            process.exit(0);
        }
    } catch {
        // Not JSON: refused below.
    }
    process.exit(1);
}
