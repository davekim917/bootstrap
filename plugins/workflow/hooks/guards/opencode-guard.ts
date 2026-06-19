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

import * as core from './block-destructive-core';
import {
  evaluateBashCommand,
  evaluateGitCloneDestination,
  evaluateSelfApproval,
  evaluateSnowflakeConnector,
  runNanoclawGate,
  runEmailGate,
  consumeGateApproval,
  IS_NANOCLAW,
} from './block-destructive-core';
import { evaluateEmailSend } from './email-gate-core';
import * as emailCore from './email-gate-core';
import { checkEditProtection, EDIT_TOOLS } from './file-protection-core';

// ── Fail-closed core-export validation (B3) ───────────────────────────────────
// "Present ≠ correct." A stale or partially-built core could export an email
// VERDICT evaluator while the underlying gate PRIMITIVE that stages the approval
// request silently went missing (or vice-versa) — the guard would then either
// fail-open on email sends or throw an opaque runtime error deep in a tool call.
// We assert at load time that every evaluator AND every gate primitive this
// adapter consumes is a real function. If any is missing or mis-typed, we refuse
// to construct the guard rather than operate against a malformed core.
//
// Validated set deliberately includes the gate WRAPPERS (runEmailGate,
// runNanoclawGate, runGateRequest, pollDeliveredTable), not just the pure
// evaluators — the cycle-4 gap was a stale email primitive passing because only
// the verdict evaluator was checked.
const REQUIRED_CORE_FNS = [
  'evaluateSelfApproval',
  'evaluateSnowflakeConnector',
  'evaluateGitCloneDestination',
  // gate primitives / wrappers
  'runEmailGate',
  'runNanoclawGate',
  'runGateRequest',
  'pollDeliveredTable',
] as const;

export function assertCoreExports(
  coreMod: Record<string, unknown> = core as unknown as Record<string, unknown>,
  emailMod: Record<string, unknown> = emailCore as unknown as Record<string, unknown>,
): void {
  const missing: string[] = [];
  for (const fn of REQUIRED_CORE_FNS) {
    if (typeof coreMod[fn] !== 'function') missing.push(`block-destructive-core.${fn}`);
  }
  // evaluateEmailSend lives in email-gate-core, not block-destructive-core.
  if (typeof emailMod.evaluateEmailSend !== 'function') {
    missing.push('email-gate-core.evaluateEmailSend');
  }
  if (missing.length > 0) {
    throw new Error(
      `[opencode-guard] fail-closed: malformed guard core — missing/mis-typed export(s): ${missing.join(
        ', ',
      )}. Refusing to operate.`,
    );
  }
}

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
 * main() control flow, reusing the shared core.
 *
 * Chain order (MUST match the Codex runner chain so the dispatch conformance
 * test can assert a single cross-provider order):
 *   1. self-approval  → block  (no writing .claude-destructive-gate yourself)
 *   2. snowflake      → block  (no ad-hoc python snowflake.connector)
 *   3. git-clone      → block  (managed-dir clone; use clone_repo/create_worktree)
 *   4. destructive    → block | gate  (the rm / SQL / cloud-CLI matrix)
 *   5. email          → gate   (outbound gws gmail send → admin approval)
 *
 * No inline regex copies — every verdict comes from the shared core (B1).
 */
export function gateBashOrThrow(command: string): void {
  if (!command) return;

  // 1. Self-approval block (shared core — parity with Claude/Codex). The agent
  //    must not approve its own destructive gate by writing .claude-destructive-gate.
  const selfApproval = evaluateSelfApproval(command);
  if (selfApproval.action === 'block') {
    throw new Error(selfApproval.reason ?? 'Blocked: self-approval is not allowed.');
  }

  // 2. Snowflake-connector block (shared core). Steer ad-hoc python
  //    snowflake.connector use toward `snow sql`.
  const snowflake = evaluateSnowflakeConnector(command);
  if (snowflake.action === 'block') {
    throw new Error(snowflake.reason ?? 'Blocked: use snow sql instead of the Python connector.');
  }

  // 3. git-clone destination guard (shared core). Block `git clone` into a
  //    managed dir; agents must use clone_repo/create_worktree.
  //    Fail-closed: treat any non-`allow` verdict as a block.
  const cloneVerdict = evaluateGitCloneDestination(command);
  if (cloneVerdict?.action !== 'allow') {
    throw new Error(cloneVerdict?.reason ?? 'Blocked: git clone into a managed directory.');
  }

  // 4. Destructive-command gate (shared core — the full rm / SQL / cloud matrix).
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
      // Fall through to the email gate below — an approved destructive verb in
      // the same command line must still be email-gated if it also sends mail.
    } else if (IS_NANOCLAW) {
      // session-DB approval gate: blocks until the host's approver decides (or 60-min timeout).
      const decision = runNanoclawGate(command, reason);
      if (decision === 'approved') {
        // Re-check the rm tier that the gate short-circuited (matches the hook).
        const after = evaluateBashCommand(command, { skipGate: true });
        if (after.action === 'block') throw new Error(after.reason ?? reason);
        // Fall through to the email gate below.
      } else {
        const detail =
          decision === 'denied'
            ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
            : 'Timed out waiting for user approval. Do not retry.';
        throw new Error(`BLOCKED: ${reason} — ${detail}`);
      }
    } else {
      // Non-NanoClaw fallback (no session-DB surface): fail closed.
      throw new Error(
        `BLOCKED: ${reason} — requires explicit user approval, which is unavailable in this environment.`,
      );
    }
  }

  // 5. Email gate (shared verdict from email-gate-core; staged via runEmailGate
  //    → request_bash_gate, NOT request_destructive_gate). The policy
  //    (scheduled-task bypass, --dry-run/--draft/--help bypass, gate otherwise)
  //    is encoded in evaluateEmailSend — we only consume its verdict (no
  //    OpenCode-local email policy). Fail-closed on denied / timeout.
  const emailVerdict = evaluateEmailSend(command, {
    isScheduledTask: process.env.NANOCLAW_IS_SCHEDULED_TASK === '1',
  });
  if (emailVerdict.action === 'gate') {
    const reason = emailVerdict.label ?? emailVerdict.reason ?? 'Email send requires approval';
    // Thread the structured card body (from/to/cc/bcc/body) so OpenCode's
    // approval card matches Claude's in-tree card instead of repeating the short
    // label (S-QA2 parity). runEmailGate stages a request_bash_gate approval and
    // polls for the decision; it fail-closes to 'denied' if it cannot stage.
    const decision = runEmailGate(command, reason, undefined, emailVerdict.summary);
    if (decision === 'approved') return;
    const detail =
      decision === 'denied'
        ? 'Cancelled by user. Do not retry — acknowledge briefly.'
        : 'Timed out waiting for admin approval. Do not retry — ask the user.';
    throw new Error(`BLOCKED: ${reason} — ${detail}`);
  }
}

export const NanoclawGuard = async () => {
  // Fail-closed: refuse to operate against a malformed core (B3). Throws here so
  // the guard never silently fails-open on a missing evaluator or gate primitive.
  assertCoreExports();
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
