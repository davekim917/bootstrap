#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks destructive bash commands
 *
 * Thin Claude Code entry point. All decision logic + the session-DB approval
 * gate lives in `block-destructive-core.ts` (shared with the opencode plugin). This
 * file owns the Claude-hook I/O surface only: read stdin, run the shared
 * evaluator, emit stderr, and exit with Claude Code's block semantics.
 *
 * Uses unbash AST parser for accurate command boundary detection — eliminates
 * false positives from heredoc content, quoted strings, and comments. Falls
 * back to regex splitting if the parser fails (fail-open design).
 *
 * Three-tier rm protection:
 *   1. Always allow: rm targeting ephemeral dirs (tmp, node_modules, build caches) — checked first
 *   2. Always block: rm targeting /, ~, $HOME, or protected home directories
 *   3. Redirect: all other rm → instructs Claude to use `trash` instead (recoverable)
 *
 * Also always blocks: unlink, shred, truncate, eval, shell -c wrappers,
 *                     find -exec rm, find -delete, xargs rm
 *
 * Infrastructure gates (require user approval, then allow on retry):
 *   Databases: Snowflake, PostgreSQL, MySQL, DuckDB, MongoDB, SQLite, Redis
 *   Cloud: AWS, GCP/gcloud, Azure, DigitalOcean
 *   IaC: Terraform, Pulumi, CDK
 *   Containers: Docker, kubectl, Helm
 *   Platforms: Render, Railway, Fly.io, Heroku, Vercel, Netlify, Supabase
 *   Services: GitHub CLI, Cloudflare/wrangler, Firebase
 *   Data: dbt --full-refresh
 *   System: dd with if=
 *
 * Exit code 2 blocks the tool (Claude Code semantics)
 * Message written to stderr is shown to Claude as the reason for the block
 *
 * Gate mechanism: Infrastructure patterns use a one-time approval file in
 * /tmp/.claude-destructive-gate/<hash>. On first attempt, the hook blocks and
 * instructs Claude to get user approval. If approved, Claude creates the file,
 * retries, and the hook consumes (deletes) it to allow the command through.
 *
 * Fail-open on parse errors (exit 0) — tradeoff: a broken hook silently allows all commands.
 * This is intentional to avoid blocking legitimate work due to hook bugs.
 *
 * Known limitations:
 *   - Interpreter-based deletion (python -c os.remove, perl -e unlink) is not detected
 *   - mv, cp /dev/null, and redirect-based truncation (> file) are not in scope
 */
import { readFileSync } from 'fs';
import type { ToolUseInput } from '../lib/types';
import {
    IS_NANOCLAW,
    GATE_DIR,
    computeGateHash,
    consumeGateApproval,
    evaluateBashCommand,
    runNanoclawGate,
} from './block-destructive-core';

// ── Types ────────────────────────────────────────────────────────────────────

interface BashToolInput extends ToolUseInput {
    tool_input: {
        command?: string;
    };
}

// ── Gate blocking ───────────────────────────────────────────────────────────

function gateBlock(command: string, reason: string): void {
    // NanoClaw mode: session-DB approval gate. Block here until user approves via chat.
    if (IS_NANOCLAW) {
        const decision = runNanoclawGate(command, reason, (err) => {
            // If we can't even stage the request, the session DBs are in a
            // broken state. Deny the command rather than silently allowing —
            // the destructive gate is fail-closed.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`BLOCKED: ${reason} — could not stage approval request (${msg.slice(0, 200)}).`);
            process.exit(2);
        });

        if (decision === 'approved') {
            process.exit(0); // allow
        }

        const detail = decision === 'denied'
            ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
            : 'Timed out waiting for user approval. Do not retry.';
        console.error(`BLOCKED: ${reason} — ${detail}`);
        process.exit(2);
    }

    // Local CC mode: exit with gate file instructions
    const hash = computeGateHash(command);
    console.error(
        `GATED: ${reason}\n\n` +
        `This command requires explicit user approval before execution.\n` +
        `1. Show the user the exact command and explain what it will do\n` +
        `2. Ask for their explicit approval\n` +
        `3. If approved, run: mkdir -p ${GATE_DIR} && echo approved > ${GATE_DIR}/${hash}\n` +
        `4. Then retry the original command unchanged`
    );
    process.exit(2);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: BashToolInput = JSON.parse(rawInput);
        const command = input.tool_input?.command || '';

        const decision = evaluateBashCommand(command);

        if (decision.action === 'block') {
            // Hard-block reasons are bare (need the BLOCKED: prefix); rm reasons
            // already carry their full BLOCKED: text. Prefix only when absent.
            const reason = decision.reason ?? '';
            console.error(
                reason.startsWith('BLOCKED:') || reason.startsWith('GATED:')
                    ? reason
                    : `BLOCKED: ${reason}`
            );
            process.exit(2);
        }

        if (decision.action === 'gate') {
            // Approval bypass: a one-time gate file lets an approved command
            // through unchanged. Checked here (not in the evaluator) so the
            // shared logic stays free of the CC-specific approval surface.
            if (!consumeGateApproval(command)) {
                gateBlock(command, decision.reason ?? '');
            }
            // Approved → the original main() still ran the rm tier after the
            // gate loop, so a destructive rm on the same line stays blocked.
            // Re-evaluate with the gate tier skipped to reproduce that.
            const post = evaluateBashCommand(command, { skipGate: true });
            if (post.action === 'block') {
                const reason = post.reason ?? '';
                console.error(
                    reason.startsWith('BLOCKED:') || reason.startsWith('GATED:')
                        ? reason
                        : `BLOCKED: ${reason}`
                );
                process.exit(2);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('[block-destructive] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
