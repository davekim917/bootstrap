#!/usr/bin/env bun
/**
 * Codex PreToolUse adapter for the shared command and file-safety policy.
 *
 * Codex loads this adapter from the plugin's native hooks manifest. Local
 * sessions return `permissionDecision: "ask"`, which invokes Codex's native
 * approval UI for the exact tool call. NanoClaw sessions retain their
 * session-database approval backend.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
    IS_NANOCLAW,
    evaluateBashCommand,
    evaluateGitCloneDestination,
    evaluateSelfApproval,
    evaluateSnapshotGitMutation,
    evaluateSnowflakeConnector,
    runEmailGate,
    runNanoclawGate,
} from './guards/block-destructive-core';
import { evaluateEmailSend, evaluateEmailToolCall } from './guards/email-gate-core';
import { checkEditProtection, EDIT_TOOLS } from './guards/file-protection-core';

const SHELL_TOOLS = new Set(['exec_command', 'local_shell_call', 'shell', 'Bash']);
const TEAM_AUTO_SENTINEL = '.team-auto-active';
const TEAM_AUTO_SENTINEL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function isUserInputTool(toolName: unknown): boolean {
    if (typeof toolName !== 'string') return false;
    const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return normalized === 'request_user_input' || normalized.endsWith('_request_user_input');
}

/**
 * Find an active /team-auto sentinel from the hook cwd or one of its parents.
 * Walking upward keeps the guard effective when Codex runs a tool from a
 * package subdirectory instead of the repository root.
 */
export function findFreshTeamAutoSentinel(
    startDir: string,
    nowMs = Date.now(),
): string | null {
    let projectDir = resolve(startDir);

    while (true) {
        const specsRoot = join(projectDir, 'docs', 'specs');
        if (existsSync(specsRoot)) {
            try {
                for (const entry of readdirSync(specsRoot)) {
                    const sentinel = join(specsRoot, entry, TEAM_AUTO_SENTINEL);
                    try {
                        const stat = statSync(sentinel);
                        if (stat.isFile() && nowMs - stat.mtimeMs <= TEAM_AUTO_SENTINEL_MAX_AGE_MS) {
                            return sentinel;
                        }
                    } catch {
                        // This feature has no readable sentinel; keep looking.
                    }
                }
            } catch {
                // This candidate is unreadable; try its parent.
            }
        }

        const parent = dirname(projectDir);
        if (parent === projectDir) return null;
        projectDir = parent;
    }
}

function commandFromInput(toolInput: Record<string, unknown> = {}): string {
    const command = toolInput.command ?? toolInput.cmd;
    if (typeof command === 'string') return command;
    if (Array.isArray(command)) return command.join(' ');
    return '';
}

function prefixed(reason: string | undefined, fallback: string): string {
    const value = reason ?? fallback;
    return value.startsWith('BLOCKED:') || value.startsWith('GATED:')
        ? value
        : `BLOCKED: ${value}`;
}

function emitContinue(): never {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
}

function emitDecision(permissionDecision: 'deny' | 'ask', reason: string): never {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision,
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

function emitDeny(reason: string | undefined, fallback: string): never {
    emitDecision('deny', prefixed(reason, fallback));
}

function emitAsk(reason: string): never {
    emitDecision('ask', reason);
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
        const eventArg = process.argv[2];
        const raw = readFileSync(0, 'utf-8');
        const input = raw.trim() ? JSON.parse(raw) : {};
        const event = eventArg ?? input.hook_event_name;
        if (event && event !== 'PreToolUse') emitContinue();

        if (
            process.env.SKIP_TEAM_AUTO_ASKBLOCK !== '1'
            && isUserInputTool(input.tool_name)
        ) {
            const sentinel = findFreshTeamAutoSentinel(
                typeof input.cwd === 'string' ? input.cwd : process.cwd(),
            );
            if (sentinel) {
                emitDeny(
                    `request_user_input is disabled while /team-auto is active (${sentinel}). `
                    + 'Remove the sentinel, record one evidenced blocker in '
                    + 'docs/specs/<feature>/run.md, and stop.',
                    'User input is disabled while /team-auto is active.',
                );
            }
        }

        const nativeEmail = evaluateEmailToolCall(
            input.tool_name ?? '',
            input.tool_input ?? {},
            { isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1' },
        );
        if (nativeEmail.action === 'gate') {
            const reason = nativeEmail.label ?? nativeEmail.reason ?? 'Outbound email send requires approval.';
            if (!IS_NANOCLAW) {
                emitAsk(`${reason}${nativeEmail.summary ? `\n\n${nativeEmail.summary}` : ''}`);
            }

            let staged = true;
            const decision = runEmailGate(`tool:${input.tool_name}`, reason, () => {
                staged = false;
            }, nativeEmail.summary);
            if (!staged) {
                emitDeny(`${reason} — could not stage the NanoClaw approval request.`, reason);
            }
            if (decision !== 'approved') {
                emitDeny(`${reason} — ${deniedDetail(decision)}`, reason);
            }
            emitContinue();
        }

        if (input.tool_name && EDIT_TOOLS.has(input.tool_name)) {
            if (process.env.SKIP_FILE_PROTECTION !== '1') {
                const protectedPath = checkEditProtection(input.tool_name, input.tool_input ?? {});
                if (protectedPath) {
                    emitDeny(
                        `file-protection — '${protectedPath}' is protected from automated edits.`,
                        'Protected file edit blocked.',
                    );
                }
            }
            emitContinue();
        }

        if (input.tool_name && !SHELL_TOOLS.has(input.tool_name)) emitContinue();
        const command = commandFromInput(input.tool_input ?? {});
        if (!command) emitContinue();

        const selfApproval = evaluateSelfApproval(command);
        if (selfApproval.action === 'block') {
            emitDeny(selfApproval.reason, 'Self-approval is not allowed.');
        }

        const snowflake = evaluateSnowflakeConnector(command);
        if (snowflake.action === 'block') {
            emitDeny(snowflake.reason, 'Use snow sql instead of the Python Snowflake connector.');
        }

        const clone = evaluateGitCloneDestination(command);
        if (clone.action !== 'allow') {
            emitDeny(clone.reason, 'Git clone into a managed directory is not allowed.');
        }

        const snapshot = evaluateSnapshotGitMutation(command);
        if (snapshot.action !== 'allow') {
            emitDeny(snapshot.reason, 'Git mutations inside read-only repo snapshots are not allowed.');
        }

        const destructive = evaluateBashCommand(command);
        if (destructive.action === 'block') {
            emitDeny(destructive.reason, 'Destructive command blocked.');
        }

        if (destructive.action === 'gate') {
            const reason = destructive.reason ?? 'Destructive command requires approval.';
            const post = evaluateBashCommand(command, { skipGate: true });
            if (post.action === 'block') {
                emitDeny(post.reason, 'Command remains blocked after destructive-gate evaluation.');
            }

            if (!IS_NANOCLAW) {
                const email = emailReason(command);
                const combined = email.action === 'gate'
                    ? `${reason}\n\nAlso requires outbound-email approval: ${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`
                    : reason;
                emitAsk(combined);
            }

            let staged = true;
            const decision = runNanoclawGate(command, reason, () => {
                staged = false;
            });
            if (!staged) {
                emitDeny(`${reason} — could not stage the NanoClaw approval request.`, reason);
            }
            if (decision !== 'approved') {
                emitDeny(`${reason} — ${deniedDetail(decision)}`, reason);
            }
        }

        const email = emailReason(command);
        if (email.action === 'gate') {
            if (!IS_NANOCLAW) {
                emitAsk(`${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`);
            }

            let staged = true;
            const decision = runEmailGate(command, email.reason, () => {
                staged = false;
            }, email.summary);
            if (!staged) {
                emitDeny(`${email.reason} — could not stage the NanoClaw approval request.`, email.reason);
            }
            if (decision !== 'approved') {
                emitDeny(`${email.reason} — ${deniedDetail(decision)}`, email.reason);
            }
        }

        emitContinue();
    } catch (error) {
        emitDeny(
            error instanceof Error ? error.message : String(error),
            'Command guard failed closed.',
        );
    }
}

if (import.meta.main) main();
