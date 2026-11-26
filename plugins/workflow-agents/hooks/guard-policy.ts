/**
 * The command and file-safety policy every PreToolUse adapter in this plugin applies, one runtime's tool call at a
 * time. Adapters translate their runtime's hook payload into a `ToolCall` and the returned verdict into its reply.
 * NanoClaw sessions route approval-tier commands to the session-database approval backend. Elsewhere there is no
 * approval channel, so an approval-tier call is denied with the adapter's hand-off text.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
    IS_NANOCLAW,
    approvalText,
    commandLineOf,
    describeGateForApproval,
    evaluateBashCommand,
    evaluateGitCloneDestination,
    evaluateSelfApproval,
    evaluateSnapshotGitMutation,
    evaluateSnowflakeConnector,
    runEmailGate,
    runNanoclawGate,
} from './guards/block-destructive-core';
import { evaluateEmailSend, evaluateEmailToolCall, type AccountBinding, type DraftBinding, type EmailCard } from './guards/email-gate-core';
import { checkEditProtection, EDIT_TOOLS } from './guards/file-protection-core';

export const SHELL_TOOLS = new Set(['exec_command', 'local_shell_call', 'shell', 'Bash']);
const TEAM_AUTO_SENTINEL = '.team-auto-active';
const TEAM_AUTO_SENTINEL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** One tool call in the Claude-shaped vocabulary the shared cores read. */
export interface ToolCall {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    cwd?: string;
    /** The same for every handler of one tool call, so concurrent guards share one approval card. */
    tool_use_id?: string;
}

export type Verdict = { action: 'allow' } | { action: 'deny'; reason: string };

function isUserInputTool(toolName: unknown): boolean {
    if (typeof toolName !== 'string') return false;
    const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return normalized === 'request_user_input' || normalized.endsWith('_request_user_input');
}

/**
 * Find an active /team-auto sentinel from the hook cwd or one of its parents.
 * Walking upward keeps the guard effective when a tool runs from a
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

/** Where the shell command runs: the tool's `workdir`, relative to the hook cwd, else the hook cwd. */
function shellCwd(input: ToolCall): string {
    const hookCwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const workdir = input.tool_input?.workdir;
    return typeof workdir === 'string' && workdir ? resolve(hookCwd, workdir) : hookCwd;
}

function prefixed(reason: string | undefined, fallback: string): string {
    const value = reason ?? fallback;
    return value.startsWith('BLOCKED:') || value.startsWith('GATED:')
        ? value
        : `BLOCKED: ${value}`;
}

const ALLOW: Verdict = { action: 'allow' };

function deny(reason: string | undefined, fallback: string): Verdict {
    return { action: 'deny', reason: prefixed(reason, fallback) };
}

function deniedDetail(decision: 'denied' | 'timeout'): string {
    return decision === 'denied'
        ? 'Cancelled by user. Do not retry; acknowledge the cancellation briefly.'
        : 'Timed out waiting for user approval. Do not retry.';
}

export function emailReason(command: string, cwd?: string): { action: 'allow' } | {
    action: 'gate';
    reason: string;
    summary?: string;
    deny?: string;
    card: EmailCard;
    draft?: DraftBinding;
    account?: AccountBinding;
} {
    const verdict = evaluateEmailSend(command, {
        isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1',
        cwd,
    });
    if (verdict.action === 'allow') return { action: 'allow' };
    return {
        action: 'gate',
        reason: verdict.label ?? verdict.reason ?? 'Outbound email send requires approval.',
        summary: verdict.summary,
        deny: verdict.deny,
        card: { pureSend: verdict.pureSend, fullSummary: verdict.fullSummary, wholeEmail: verdict.wholeEmail },
        draft: verdict.draft,
        account: verdict.account,
    };
}

/**
 * The verdict for one tool call. `handoff` is appended to an approval-tier denial outside NanoClaw, where the
 * runtime has no way to ask. An approval wait blocks here; a thrown error is a denial.
 */
export function decideToolCall(input: ToolCall, handoff: string): Verdict {
    const verdict = decide(input, handoff);
    // A lone surrogate (an HTML entity decoded into a summary can leave one) makes the host's JSON parser reject the
    // whole reply, and a reply it cannot parse is no deny at all.
    return verdict.action === 'deny' ? { action: 'deny', reason: verdict.reason.toWellFormed() } : verdict;
}

function decide(input: ToolCall, handoff: string): Verdict {
    const needsHumanApproval = (reason: string): Verdict => ({ action: 'deny', reason: `${reason}\n\n${handoff}` });
    try {
        const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;

        if (
            process.env.SKIP_TEAM_AUTO_ASKBLOCK !== '1'
            && isUserInputTool(input.tool_name)
        ) {
            const sentinel = findFreshTeamAutoSentinel(
                typeof input.cwd === 'string' ? input.cwd : process.cwd(),
            );
            if (sentinel) {
                return deny(
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
                return needsHumanApproval(`${reason}${nativeEmail.summary ? `\n\n${nativeEmail.summary}` : ''}`);
            }

            let staged = true;
            const decision = runEmailGate(`tool:${input.tool_name}`, reason, () => {
                staged = false;
            }, nativeEmail.summary, toolUseId, { wholeEmail: nativeEmail.wholeEmail });
            if (!staged) {
                return deny(`${reason} — could not stage the NanoClaw approval request.`, reason);
            }
            if (decision !== 'approved') {
                return deny(`${reason} — ${deniedDetail(decision)}`, reason);
            }
            return ALLOW;
        }

        if (input.tool_name && EDIT_TOOLS.has(input.tool_name)) {
            if (process.env.SKIP_FILE_PROTECTION !== '1') {
                const protectedPath = checkEditProtection(
                    input.tool_name,
                    input.tool_input ?? {},
                    typeof input.cwd === 'string' ? input.cwd : undefined,
                );
                if (protectedPath) {
                    return deny(
                        `file-protection — '${protectedPath}' is protected from automated edits.`,
                        'Protected file edit blocked.',
                    );
                }
            }
            return ALLOW;
        }

        if (input.tool_name && !SHELL_TOOLS.has(input.tool_name)) return ALLOW;
        const command = commandLineOf(input.tool_input?.command ?? input.tool_input?.cmd);
        if (!command) return ALLOW;

        const selfApproval = evaluateSelfApproval(command);
        if (selfApproval.action === 'block') {
            return deny(selfApproval.reason, 'Self-approval is not allowed.');
        }

        const snowflake = evaluateSnowflakeConnector(command);
        if (snowflake.action === 'block') {
            return deny(snowflake.reason, 'Use snow sql instead of the Python Snowflake connector.');
        }

        const clone = evaluateGitCloneDestination(command);
        if (clone.action !== 'allow') {
            return deny(clone.reason, 'Git clone into a managed directory is not allowed.');
        }

        const snapshot = evaluateSnapshotGitMutation(command);
        if (snapshot.action !== 'allow') {
            return deny(snapshot.reason, 'Git mutations inside read-only repo snapshots are not allowed.');
        }

        const cwd = shellCwd(input);

        const destructive = evaluateBashCommand(command, { cwd });
        if (destructive.action === 'block') {
            return deny(destructive.reason, 'Destructive command blocked.');
        }

        // An email send sharing its command is refused after any hard block and before any gate asks, so no approval is spent on it.
        const email = emailReason(command, cwd);
        if (email.action === 'gate' && email.deny) {
            return deny(email.deny, email.reason);
        }

        if (destructive.action === 'gate') {
            const reason = destructive.reason ?? 'Destructive command requires approval.';
            const post = evaluateBashCommand(command, { skipGate: true, cwd });
            if (post.action === 'block') {
                return deny(post.reason, 'Command remains blocked after destructive-gate evaluation.');
            }

            if (!IS_NANOCLAW) {
                const described = approvalText(describeGateForApproval(command, reason, cwd));
                const combined = email.action === 'gate'
                    ? `${described}\n\nAlso requires outbound-email approval: ${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`
                    : described;
                return needsHumanApproval(combined);
            }

            let staged = true;
            const decision = runNanoclawGate(command, reason, () => {
                staged = false;
            }, toolUseId, cwd);
            if (!staged) {
                return deny(`${reason} — could not stage the NanoClaw approval request.`, reason);
            }
            if (decision !== 'approved') {
                return deny(`${reason} — ${deniedDetail(decision)}`, reason);
            }
        }

        if (email.action === 'gate') {
            if (!IS_NANOCLAW) {
                return needsHumanApproval(`${email.reason}${email.summary ? `\n\n${email.summary}` : ''}`);
            }

            let staged = true;
            let changed: string | undefined;
            const binding = email.draft;
            const decision = runEmailGate(command, email.reason, () => {
                staged = false;
            }, email.summary, toolUseId, email.card,
            binding || email.account ? { binding, account: email.account, onChanged: (refusal) => { changed = refusal; } } : undefined);
            if (changed !== undefined) {
                return deny(changed, email.reason);
            }
            if (!staged) {
                return deny(`${email.reason} — could not stage the NanoClaw approval request.`, email.reason);
            }
            if (decision !== 'approved') {
                return deny(`${email.reason} — ${deniedDetail(decision)}`, email.reason);
            }
        }

        return ALLOW;
    } catch (error) {
        return deny(
            error instanceof Error ? error.message : String(error),
            'Command guard failed closed.',
        );
    }
}
