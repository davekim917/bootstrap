// NanoClaw guard plugin for the OpenCode runtime.
//
// Brings the destructive-action gate to OpenCode siblings, at parity with the
// Claude Code `block-destructive` hook. Both share the SAME decision core
// (`block-destructive-core.ts`) so the two runtimes can never drift.
//
// Mechanism (verified against opencode 1.15.7): `tool.execute.before` THROWS to
// abort a tool call before it runs; the Error message surfaces to the agent as
// the tool result. We intercept the `bash` tool, evaluate the command, and
// throw on a hard block or a denied/timed-out approval gate.
//
// OpenCode loads this from the per-spawn config `plugin: [...]` (wired host-side
// in src/providers/opencode.ts). It runs on Bun — same runtime as the core —
// so `bun:sqlite` (the session-DB approval gate) and the `unbash` AST parser work unchanged.
//
// FOLLOW-UP (not yet ported): the Claude container runs a post-commit
// blast-radius advisory (container/nanoclaw-plugin/hooks/post-commit-verify.cjs,
// a PostToolUse hook). Porting it here means invoking that .cjs from a
// `tool.execute.after` git-commit detector with a PostToolUse-shaped input + the
// correct worktree cwd, and surfacing its checklist via the tool output. The
// GitNexus MCP tools and skills are already available to opencode; only this
// advisory is missing.

import {
  evaluateBashCommand,
  runNanoclawGate,
  consumeGateApproval,
  IS_NANOCLAW,
} from './block-destructive-core';
import { checkEditProtection, EDIT_TOOLS } from './file-protection-core';

// Minimal structural types for the opencode plugin contract (avoids a hard dep
// on @opencode-ai/plugin, which isn't installed in this repo). Matches the
// 1.15.7 Hooks shape: tool.execute.before(input,{args}), .after(input,{...}).
type ToolBeforeInput = { tool: string; sessionID: string; callID: string };
type ToolBeforeOutput = { args: Record<string, unknown> };

function bashCommandOf(args: Record<string, unknown> | undefined): string {
  const c = args?.command;
  return typeof c === 'string' ? c : '';
}

/**
 * Evaluate a bash command and throw (aborting the tool call) if it must be
 * blocked or its approval gate is denied/timed-out. Mirrors the Claude hook's
 * main() control flow exactly, reusing the shared core.
 */
export function gateBashOrThrow(command: string): void {
  if (!command) return;

  const verdict = evaluateBashCommand(command);

  if (verdict.action === 'block') {
    throw new Error(verdict.reason ?? 'Blocked by nanoclaw destructive-action gate.');
  }

  if (verdict.action === 'gate') {
    const reason = verdict.reason ?? 'requires approval';

    // Gate-file bypass (parity with the Claude hook; rarely set in-container).
    if (consumeGateApproval(command)) {
      const after = evaluateBashCommand(command, { skipGate: true });
      if (after.action === 'block') throw new Error(after.reason ?? reason);
      return;
    }

    if (IS_NANOCLAW) {
      // session-DB approval gate: blocks until the host's approver decides (or 60-min timeout).
      const decision = runNanoclawGate(command, reason);
      if (decision === 'approved') {
        // Re-check the rm tier that the gate short-circuited (matches the hook).
        const after = evaluateBashCommand(command, { skipGate: true });
        if (after.action === 'block') throw new Error(after.reason ?? reason);
        return;
      }
      const detail =
        decision === 'denied'
          ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
          : 'Timed out waiting for user approval. Do not retry.';
      throw new Error(`BLOCKED: ${reason} — ${detail}`);
    }

    // Non-NanoClaw fallback (no session-DB surface): fail closed.
    throw new Error(`BLOCKED: ${reason} — requires explicit user approval, which is unavailable in this environment.`);
  }
}

export const NanoclawGuard = async () => {
  return {
    'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      // File-protection: block edits to protected paths (.env, lockfiles, .git,
      // terraform), at parity with the Claude file-protection hook. Shared core.
      if (EDIT_TOOLS.has(input.tool)) {
        if (process.env.SKIP_FILE_PROTECTION !== '1') {
          const blocked = checkEditProtection(input.tool, (output.args ?? {}) as Record<string, unknown>);
          if (blocked) {
            throw new Error(
              `BLOCKED: file-protection — '${blocked}' is protected from automated edits. Set SKIP_FILE_PROTECTION=1 to bypass.`,
            );
          }
        }
        return;
      }
      // Destructive-command gate (bash).
      if (input.tool !== 'bash') return;
      gateBashOrThrow(bashCommandOf(output.args));
    },
  };
};
