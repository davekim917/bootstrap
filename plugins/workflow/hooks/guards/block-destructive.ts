#!/usr/bin/env bun
/**
 * Claude PreToolUse adapter for the shared command-safety policy.
 *
 * Policy is runtime-neutral and lives in the shared evaluator cores. This file
 * owns only Claude's approval/blocking transport:
 *   - local Claude Code: `permissionDecision: "ask"` invokes the native user
 *     approval UI for the exact pending shell or native email tool call;
 *   - NanoClaw: the existing session-DB approval round trip is retained.
 *
 * The legacy local gate-file flow was intentionally removed. Having the model
 * write its own approval marker made the self-approval guard impossible to
 * enforce. Native hook approval is user-originated and does not require a
 * retry or an agent-writable bypass file.
 */
import { readFileSync } from 'fs';
import type { ToolUseInput } from '../lib/types';
import {
    IS_NANOCLAW,
    evaluateBashCommand,
    evaluateGitCloneDestination,
    evaluateSelfApproval,
    evaluateSnowflakeConnector,
    runEmailGate,
    runNanoclawGate,
} from './block-destructive-core';
import { evaluateEmailSend, evaluateEmailToolCall } from './email-gate-core';

interface GuardToolInput extends ToolUseInput {
    tool_input: {
        command?: string;
        [key: string]: unknown;
    };
}

function prefixed(reason: string | undefined, fallback: string): string {
    const value = reason ?? fallback;
    return value.startsWith('BLOCKED:') || value.startsWith('GATED:')
        ? value
        : `BLOCKED: ${value}`;
}

function block(reason: string | undefined, fallback: string): never {
    console.error(prefixed(reason, fallback));
    process.exit(2);
}

function ask(reason: string): never {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

function deniedDetail(decision: 'denied' | 'timeout'): string {
    return decision === 'denied'
        ? 'Cancelled by user. Do not retry; acknowledge the cancellation briefly.'
        : 'Timed out waiting for user approval. Do not retry.';
}

function emailReason(command: string): { action: 'allow' } | {
    action: 'gate';
    reason: string;
    summary?: string;
} {
    const verdict = evaluateEmailSend(command, {
        isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1',
    });
    if (verdict.action === 'allow') return { action: 'allow' };
    return {
        action: 'gate',
        reason: verdict.label ?? verdict.reason ?? 'Outbound email send requires approval.',
        summary: verdict.summary,
    };
}

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: GuardToolInput = JSON.parse(rawInput);
        const nativeEmail = evaluateEmailToolCall(
            input.tool_name ?? '',
            input.tool_input ?? {},
            { isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1' },
        );
        if (nativeEmail.action === 'gate') {
            const reason = nativeEmail.label ?? nativeEmail.reason ?? 'Outbound email send requires approval.';
            if (!IS_NANOCLAW) {
                ask(`${reason}${nativeEmail.summary ? `\n\n${nativeEmail.summary}` : ''}`);
            }
            const decision = runEmailGate(
                `tool:${input.tool_name}`,
                reason,
                undefined,
                nativeEmail.summary,
            );
            if (decision !== 'approved') {
                block(`${reason} — ${deniedDetail(decision)}`, reason);
            }
            process.exit(0);
        }

        const command = input.tool_input?.command || '';
        if (!command) process.exit(0);

        // Runtime-independent evaluator order. Keep this in sync with the
        // OpenCode and Codex adapters and the adapter conformance tests.
        const selfApproval = evaluateSelfApproval(command);
        if (selfApproval.action === 'block') {
            block(selfApproval.reason, 'Self-approval is not allowed.');
        }

        const snowflake = evaluateSnowflakeConnector(command);
        if (snowflake.action === 'block') {
            block(snowflake.reason, 'Use snow sql instead of the Python Snowflake connector.');
        }

        const clone = evaluateGitCloneDestination(command);
        if (clone.action !== 'allow') {
            block(clone.reason, 'Git clone into a managed directory is not allowed.');
        }

        // Claude's hook payload carries the tool call's working directory; the
        // lab-scope predicate uses it to resolve a bare `git push origin` to the
        // repo it would actually reach. The core falls back to process.cwd().
        const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

        const destructive = evaluateBashCommand(command, { cwd });
        if (destructive.action === 'block') {
            block(destructive.reason, 'Destructive command blocked.');
        }

        if (destructive.action === 'gate') {
            const reason = destructive.reason ?? 'Destructive command requires approval.';
            const post = evaluateBashCommand(command, { skipGate: true, cwd });
            if (post.action === 'block') {
                block(post.reason, 'Command remains blocked after destructive-gate evaluation.');
            }

            if (!IS_NANOCLAW) {
                // A local native approval authorizes this exact full command.
                // Include a second email reason when one command crosses both
                // policy gates so the user sees the complete effect once.
                const email = emailReason(command);
                const combined = email.action === 'gate'
                    ? `${reason}\n\nAlso requires outbound-email approval: ${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`
                    : reason;
                ask(combined);
            }

            const decision = runNanoclawGate(command, reason, (error) => {
                const message = error instanceof Error ? error.message : String(error);
                block(message, `${reason} — could not stage the NanoClaw approval request.`);
            });
            if (decision !== 'approved') {
                block(`${reason} — ${deniedDetail(decision)}`, reason);
            }
        }

        const email = emailReason(command);
        if (email.action === 'gate') {
            if (!IS_NANOCLAW) {
                ask(`${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`);
            }

            const decision = runEmailGate(command, email.reason, undefined, email.summary);
            if (decision !== 'approved') {
                block(`${email.reason} — ${deniedDetail(decision)}`, email.reason);
            }
        }

        process.exit(0);
    } catch (error) {
        // This is an enforcement hook. A malformed payload or broken evaluator
        // must not silently turn the safety boundary off.
        block(
            error instanceof Error ? error.message : String(error),
            'Command guard failed closed.',
        );
    }
}

main();
