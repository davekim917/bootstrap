#!/usr/bin/env bun
/**
 * Claude PreToolUse adapter for the dispatch-first coordinator guard.
 *
 * Decision logic lives in `dispatch-first-core.ts` (runtime-neutral, unit
 * tested). This file owns only Claude's hook I/O:
 *   - warn: exit 0 with `hookSpecificOutput.additionalContext` and NO
 *     `permissionDecision`, so the message reaches the model and the normal
 *     permission flow still applies (hooks doc, "Decision control": "The hook
 *     can return additionalContext without a permissionDecision; when it does,
 *     the normal permission flow applies"). An `allow` decision would silently
 *     skip the user's permission prompt for the gated Bash call — not ours to do.
 *   - block: exit 2 with a `BLOCKED:` line on stderr (shown to the model).
 *
 * Fails OPEN by design — see the core's header. Builders must never be blocked,
 * and a torn transcript or unexpected payload must not become a fleet-wide
 * outage of every coordinator's Read tool.
 */
import { readFileSync } from 'fs';
import type { ToolUseInput } from '../lib/types';
import {
    evaluateDispatchFirst,
    formatDecisionLog,
    loadTranscript,
} from './dispatch-first-core';

function main(): void {
    try {
        const input: ToolUseInput = JSON.parse(readFileSync(0, 'utf-8'));
        const verdict = evaluateDispatchFirst({
            transcriptText: loadTranscript(input.transcript_path),
            toolName: input.tool_name ?? '',
            toolInput: (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {},
            toolUseId: typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined,
            inSubagent: typeof input.agent_id === 'string' && input.agent_id !== '',
            env: process.env,
        });

        if (verdict.action === 'block') {
            console.error(formatDecisionLog(verdict));
            console.error(verdict.reason);
            process.exit(2);
        }

        if (verdict.action === 'warn') {
            console.error(formatDecisionLog(verdict));
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    additionalContext: verdict.reason,
                },
            }));
            process.exit(0);
        }

        if (verdict.thresholds.ignoredEnv.length > 0) {
            console.error(formatDecisionLog(verdict));
        }
        process.exit(0);
    } catch (error) {
        console.error(
            '[dispatch-first] skipped (fail-open):',
            error instanceof Error ? error.message : String(error),
        );
        process.exit(0);
    }
}

main();
