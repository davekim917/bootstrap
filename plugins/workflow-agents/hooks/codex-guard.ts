#!/usr/bin/env bun
/**
 * Codex PreToolUse guard — destructive-command gate at parity with the Claude
 * `block-destructive` hook and the OpenCode `opencode-guard` plugin. Reuses the
 * SAME shared decision core (`./guards/block-destructive-core`) so the three
 * runtimes can never drift. This file owns only the Codex hook I/O surface.
 *
 * WHY WIRED VIA hooks.json, NOT THE PLUGIN HOOK SYSTEM:
 * Codex does NOT fire plugin-provided hooks under `codex exec` (host) or
 * `codex app-server` (container) — verified empirically (a plugin-declared
 * PreToolUse never ran; `eval` executed unblocked under exec; 0 hook artifacts
 * across 47 container sessions). The reliable Codex hook surface is the
 * user-level hooks.json, so this adapter is referenced there:
 *   - host:      ~/.codex/hooks.json   PreToolUse → `bun <repo>/.../codex-guard.ts PreToolUse`
 *   - container: nanoclaw's generated  ~/.codex/hooks.json PreToolUse entry
 * Both run it under bun (imports the .ts core directly; bun:sqlite powers the
 * in-container session-DB approval gate).
 *
 * CODEX HOOK PROTOCOL (Claude-flavored, parsed from STDOUT — see
 * container/agent-runner/src/codex-hooks/{cli,runner}.ts): emit
 *   { hookSpecificOutput: { hookEventName, permissionDecision: 'deny',
 *                           permissionDecisionReason } }   to block, or
 *   { continue: true }                                     to allow.
 * Exit 0 always. The event name arrives as argv[2] (with a stdin fallback).
 * Fail-open (emit continue) on parse error — matches block-destructive.ts.
 */
import { readFileSync } from 'fs';
import {
    IS_NANOCLAW,
    GATE_DIR,
    computeGateHash,
    consumeGateApproval,
    evaluateBashCommand,
    runNanoclawGate,
} from './guards/block-destructive-core';
import { checkEditProtection, EDIT_TOOLS } from './guards/file-protection-core';

// Codex shell-tool aliases (normalized to the core's bash expectations).
const SHELL_TOOLS = new Set(['exec_command', 'local_shell_call', 'shell', 'Bash']);

function commandFromInput(toolInput: Record<string, unknown> = {}): string {
    const c =
        (toolInput as { command?: unknown }).command ?? (toolInput as { cmd?: unknown }).cmd;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.join(' ');
    return '';
}

function prefixBlocked(reason: string | undefined): string {
    const r = reason ?? 'destructive command blocked';
    return r.startsWith('BLOCKED:') || r.startsWith('GATED:') ? r : `BLOCKED: ${r}`;
}

// ── Codex stdout-JSON decision emitters ────────────────────────────────────────
function emitContinue(): never {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
}

function emitDeny(reason: string): never {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: reason,
            },
        }),
    );
    process.exit(0);
}

function main(): void {
    try {
        const eventArg = process.argv[2];
        const raw = readFileSync(0, 'utf-8');
        const input = raw.trim() ? JSON.parse(raw) : {};

        // Only gate shell tools on PreToolUse; everything else passes through.
        const event = eventArg ?? input.hook_event_name;
        if (event && event !== 'PreToolUse') emitContinue();

        // File-protection: block edits to protected paths (.env, lockfiles, .git,
        // terraform), at parity with the Claude file-protection hook. Shared core.
        if (input.tool_name && EDIT_TOOLS.has(input.tool_name)) {
            if (process.env.SKIP_FILE_PROTECTION !== '1') {
                const blocked = checkEditProtection(input.tool_name, input.tool_input ?? {});
                if (blocked) emitDeny(`BLOCKED: file-protection — '${blocked}' is protected from automated edits.`);
            }
            emitContinue();
        }

        if (input.tool_name && !SHELL_TOOLS.has(input.tool_name)) emitContinue();

        const command = commandFromInput(input.tool_input ?? {});
        if (!command) emitContinue();

        const decision = evaluateBashCommand(command);

        if (decision.action === 'allow') emitContinue();
        if (decision.action === 'block') emitDeny(prefixBlocked(decision.reason));

        // ── gate ──
        const reason = decision.reason ?? 'requires approval';

        // Approval bypass: a one-time gate file lets an approved command through.
        if (consumeGateApproval(command)) {
            const post = evaluateBashCommand(command, { skipGate: true });
            if (post.action === 'block') emitDeny(prefixBlocked(post.reason));
            emitContinue();
        }

        if (IS_NANOCLAW) {
            // Container: session-DB approval gate. Blocks until the user decides
            // (or 60-min timeout). runNanoclawGate fail-closes to 'denied'; the
            // onStageError flag distinguishes a broken-DB stage failure.
            let staged = true;
            const verdict = runNanoclawGate(command, reason, () => {
                staged = false;
            });
            if (!staged) {
                emitDeny(`BLOCKED: ${reason} — could not stage approval request (session DBs unavailable).`);
            }
            if (verdict === 'approved') {
                const post = evaluateBashCommand(command, { skipGate: true });
                if (post.action === 'block') emitDeny(prefixBlocked(post.reason));
                emitContinue();
            }
            const detail =
                verdict === 'denied'
                    ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
                    : 'Timed out waiting for user approval. Do not retry.';
            emitDeny(`BLOCKED: ${reason} — ${detail}`);
        }

        // Host / local CLI: one-time gate-file approval (parity with the Claude hook).
        const hash = computeGateHash(command);
        emitDeny(
            `GATED: ${reason}\n\n` +
                `This command requires explicit user approval before execution.\n` +
                `1. Show the user the exact command and explain what it will do\n` +
                `2. Ask for their explicit approval\n` +
                `3. If approved, run: mkdir -p ${GATE_DIR} && echo approved > ${GATE_DIR}/${hash}\n` +
                `4. Then retry the original command unchanged`,
        );
    } catch (error) {
        // Fail-open: a broken hook must not wedge the agent (matches block-destructive.ts).
        process.stderr.write(
            `[codex-guard] hook error (non-blocking): ${error instanceof Error ? error.message : String(error)}\n`,
        );
        emitContinue();
    }
}

main();
