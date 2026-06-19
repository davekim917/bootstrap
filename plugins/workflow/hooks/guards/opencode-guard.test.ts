import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { gateBashOrThrow, assertCoreExports } from './opencode-guard';

// Regression guard for the OpenCode plugin's bash gate wrapper. The full
// decision matrix is covered by block-destructive.test.ts (shared core); these
// lock the wrapper's throw/allow contract that opencode's tool.execute.before
// relies on, plus the cross-provider chain order, the email gate wiring, and the
// fail-closed core-export validation. The destructive session-DB approval-gate
// path (runNanoclawGate) needs the session DBs and is exercised by the
// in-container integration test, not here.

describe('opencode-guard gateBashOrThrow — destructive/git-clone (existing contract)', () => {
  test('throws on a hard-blocked command (eval)', () => {
    expect(() => gateBashOrThrow("eval 'echo hi'")).toThrow(/eval is not allowed/);
  });

  test('throws on a hard-blocked deletion (find -delete)', () => {
    expect(() => gateBashOrThrow('find . -delete')).toThrow(/find -delete/);
  });

  test('throws on rm of a non-ephemeral path (trash redirect)', () => {
    expect(() => gateBashOrThrow('rm important.txt')).toThrow(/trash/);
  });

  test('allows a safe command (no throw)', () => {
    expect(() => gateBashOrThrow('ls -la')).not.toThrow();
  });

  test('allows rm of an ephemeral path (no throw)', () => {
    expect(() => gateBashOrThrow('rm -rf node_modules')).not.toThrow();
  });

  test('empty command is a no-op', () => {
    expect(() => gateBashOrThrow('')).not.toThrow();
  });

  test('throws on git clone into a managed dir (parity with Claude/Codex)', () => {
    expect(() => gateBashOrThrow('git clone https://github.com/a/b /workspace/agent/repos/b')).toThrow(
      /blocked|clone_repo|create_worktree/,
    );
  });

  test('allows git clone into /tmp (no throw)', () => {
    expect(() => gateBashOrThrow('git clone https://github.com/a/b /tmp/scratch')).not.toThrow();
  });
});

// ── B1: self-approval + snowflake wired into the bash chain ──
describe('B1 self-approval + snowflake + chain order', () => {
  test('test_oc_blocks_self_approval', () => {
    // Writing the .claude-destructive-gate marker yourself is a block.
    expect(() => gateBashOrThrow('touch .claude-destructive-gate')).toThrow(/self-approval/i);
    expect(() => gateBashOrThrow('echo ok > .claude-destructive-gate')).toThrow(/self-approval/i);
  });

  test('test_oc_blocks_snowflake_connector', () => {
    expect(() => gateBashOrThrow("python -c 'import snowflake.connector'")).toThrow(
      /snowflake\.connector|snow sql/i,
    );
    expect(() => gateBashOrThrow('python3 -c "from snowflake.connector import connect"')).toThrow(
      /snowflake\.connector|snow sql/i,
    );
  });

  test('test_oc_allows_plain_bash', () => {
    for (const cmd of ['ls -la', 'git status', 'echo hello', 'cat file.txt']) {
      expect(() => gateBashOrThrow(cmd)).not.toThrow();
    }
  });

  test('test_oc_chain_order', () => {
    // The chain is self-approval → snowflake → git-clone → destructive → email.
    // Each assertion crafts a command that trips an EARLIER guard AND a later
    // one; the earlier guard's message must win, proving ordering.

    // self-approval BEFORE snowflake: a python snowflake.connector line that
    // also touches the gate marker → self-approval fires first.
    expect(() =>
      gateBashOrThrow("touch .claude-destructive-gate && python -c 'import snowflake.connector'"),
    ).toThrow(/self-approval/i);

    // snowflake BEFORE git-clone: a snowflake.connector line that also clones
    // into a managed dir → snowflake fires first.
    expect(() =>
      gateBashOrThrow(
        "python -c 'import snowflake.connector' && git clone https://github.com/a/b /workspace/agent/x",
      ),
    ).toThrow(/snowflake\.connector|snow sql/i);

    // git-clone BEFORE destructive: a managed-dir clone that also runs an rm of
    // a protected path → git-clone fires first.
    expect(() =>
      gateBashOrThrow('git clone https://github.com/a/b /workspace/agent/x && rm important.txt'),
    ).toThrow(/clone_repo|create_worktree|managed/i);

    // destructive BEFORE email: a hard-blocked eval combined with an email send
    // → destructive (eval) fires first, never reaching the email gate.
    expect(() => gateBashOrThrow("eval 'x' && gws gmail +send --to a@b.com")).toThrow(
      /eval is not allowed/,
    );
  });
});

// ── B2: email gate wired via runEmailGate (request_bash_gate) ──
// The email VERDICT comes from the real email-gate-core (no OpenCode-local
// policy). Only the gate I/O (runEmailGate / pollDeliveredTable) is stubbed so
// the test never touches the /workspace session DBs. Bun's mock.module
// redirects intra-module references, so opencode-guard's runEmailGate import is
// the stub after a fresh re-import.
const CORE = './block-destructive-core';

// CRITICAL: `mock.restore()` does NOT undo `mock.module()` (Bun docs). A leaked
// module mock poisons OTHER test files that `await import(CORE)` (e.g. Group A's
// evaluators test captures the "real" core via import). So we capture the
// pristine module ONCE here, before any test mocks it, and restore the registry
// back to it in every afterEach via `mock.module(CORE, () => REAL_CORE)`.
const REAL_CORE = { ...(await import(CORE)) };

function restoreCore(): void {
  mock.restore(); // restores spies/fn mocks
  mock.module(CORE, () => REAL_CORE); // un-leak the module mock (restore doesn't)
}

interface EmailStage {
  command: string;
  reason: string;
}

async function loadGuardWithEmailStub(decision: 'approved' | 'denied' | 'timeout') {
  const stages: EmailStage[] = [];
  // Records every staged gate-request action so the email path can be proven to
  // emit request_bash_gate (via runEmailGate) and NOT request_destructive_gate.
  const stagedActions: string[] = [];
  mock.module(CORE, () => ({
    ...REAL_CORE,
    runEmailGate: (command: string, reason: string): 'approved' | 'denied' | 'timeout' => {
      stages.push({ command, reason });
      stagedActions.push('request_bash_gate');
      return decision;
    },
    // If the destructive path were (wrongly) taken for an email send, this fires.
    runNanoclawGate: (): 'approved' | 'denied' | 'timeout' => {
      stagedActions.push('request_destructive_gate');
      return decision;
    },
    // Guard against the test accidentally hitting a real DB poll.
    pollDeliveredTable: (): 'approved' | 'denied' | 'timeout' => decision,
  }));
  const guard = await import('./opencode-guard');
  return { guard, stages, stagedActions };
}

describe('B2 email gate', () => {
  const prevScheduled = process.env.NANOCLAW_IS_SCHEDULED_TASK;
  beforeEach(() => {
    // Interactive (non-scheduled) context so the email gate is exercised.
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
  });
  afterEach(() => {
    restoreCore();
    if (prevScheduled === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = prevScheduled;
  });

  test('test_oc_email_gates_with_bash_gate_action', async () => {
    const { guard, stages, stagedActions } = await loadGuardWithEmailStub('approved');
    guard.gateBashOrThrow('gws gmail +send --to a@b.com --subject hi');
    // The email send routed through runEmailGate (which stages request_bash_gate),
    // NOT the destructive runNanoclawGate path (request_destructive_gate).
    expect(stages).toHaveLength(1);
    expect(stages[0].command).toContain('gws gmail +send');
    expect(stagedActions).toEqual(['request_bash_gate']);
    // Card content comes from the shared evaluateEmailSend verdict (label).
    expect(stages[0].reason).toContain('a@b.com');
  });

  test('test_oc_email_denied_throws', async () => {
    const { guard } = await loadGuardWithEmailStub('denied');
    expect(() => guard.gateBashOrThrow('gws gmail +send --to a@b.com')).toThrow(/BLOCKED/);
  });

  test('test_oc_email_timeout_throws', async () => {
    const { guard } = await loadGuardWithEmailStub('timeout');
    expect(() => guard.gateBashOrThrow('gws gmail +send --to a@b.com')).toThrow(/BLOCKED/);
  });

  test('test_oc_email_approved_proceeds', async () => {
    const { guard } = await loadGuardWithEmailStub('approved');
    expect(() => guard.gateBashOrThrow('gws gmail +send --to a@b.com')).not.toThrow();
  });

  test('test_oc_non_email_no_gate', async () => {
    const { guard, stages } = await loadGuardWithEmailStub('approved');
    // A plain, safe command never reaches runEmailGate.
    guard.gateBashOrThrow('ls -la');
    expect(stages).toHaveLength(0);
  });

  test('scheduled tasks bypass the email gate (faithful to shared policy)', async () => {
    process.env.NANOCLAW_IS_SCHEDULED_TASK = '1';
    const { guard, stages } = await loadGuardWithEmailStub('denied');
    // Even with a denying gate, a scheduled task must not gate (evaluateEmailSend
    // returns allow), so it does not throw and never stages.
    expect(() => guard.gateBashOrThrow('gws gmail +send --to a@b.com')).not.toThrow();
    expect(stages).toHaveLength(0);
  });
});

// ── B3: fail-closed core-export validation ──
describe('B3 export validation (present ≠ correct)', () => {
  const completeCore = (): Record<string, unknown> => ({
    evaluateSelfApproval: () => ({ action: 'allow' }),
    evaluateSnowflakeConnector: () => ({ action: 'allow' }),
    evaluateGitCloneDestination: () => ({ action: 'allow' }),
    runEmailGate: () => 'approved',
    runNanoclawGate: () => 'approved',
    runGateRequest: () => 'approved',
    pollDeliveredTable: () => 'approved',
  });
  const completeEmail = (): Record<string, unknown> => ({
    evaluateEmailSend: () => ({ action: 'allow' }),
  });

  test('test_oc_export_validation_throws_on_missing_evaluator', () => {
    const broken = completeCore();
    delete broken.evaluateSelfApproval; // a pure evaluator goes missing
    expect(() => assertCoreExports(broken, completeEmail())).toThrow(/evaluateSelfApproval/);

    // evaluateEmailSend living in email-gate-core is also covered.
    expect(() => assertCoreExports(completeCore(), {})).toThrow(/evaluateEmailSend/);
  });

  test('test_oc_export_validation_throws_on_missing_gate_wrapper', () => {
    // The cycle-4 gap: verdict evaluator present, gate PRIMITIVE missing.
    for (const wrapper of ['runEmailGate', 'runNanoclawGate', 'runGateRequest', 'pollDeliveredTable']) {
      const broken = completeCore();
      delete broken[wrapper];
      expect(() => assertCoreExports(broken, completeEmail())).toThrow(new RegExp(wrapper));
    }
  });

  test('mis-typed export (present but not a function) throws', () => {
    const broken = completeCore();
    broken.runEmailGate = 'not a function' as unknown;
    expect(() => assertCoreExports(broken, completeEmail())).toThrow(/runEmailGate/);
  });

  test('test_oc_export_validation_passes_on_complete_core', () => {
    expect(() => assertCoreExports(completeCore(), completeEmail())).not.toThrow();
  });

  test('the REAL imported core passes validation (no default-arg drift)', () => {
    // Calling with no args validates the actually-imported modules.
    expect(() => assertCoreExports()).not.toThrow();
  });
});

// ── B4: full-chain composition at the real entrypoint ──
// Drives NanoclawGuard()['tool.execute.before'] with one representative case per
// guard class to prove each fires at the real opencode hook entrypoint (no
// wiring regression). The destructive session-DB gate and email gate are stubbed
// so the assertions stay deterministic; what matters is that the entrypoint
// routes each class to its guard.
describe('B4 full-chain composition', () => {
  const prevScheduled = process.env.NANOCLAW_IS_SCHEDULED_TASK;
  afterEach(() => {
    restoreCore();
    if (prevScheduled === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = prevScheduled;
  });

  test('test_oc_full_chain_composition', async () => {
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const emailStages: string[] = [];
    mock.module(CORE, () => ({
      ...REAL_CORE,
      runEmailGate: (command: string): 'approved' => {
        emailStages.push(command);
        return 'approved';
      },
      runNanoclawGate: (): 'approved' => 'approved',
      pollDeliveredTable: (): 'approved' => 'approved',
    }));
    const { NanoclawGuard } = await import('./opencode-guard');
    const hooks = await NanoclawGuard();
    const before = hooks['tool.execute.before'];

    const runBash = (command: string) =>
      before(
        { tool: 'bash', sessionID: 's', callID: 'c' },
        { args: { command } },
      );
    const runEdit = (path: string) =>
      before(
        { tool: 'write', sessionID: 's', callID: 'c' },
        { args: { path } },
      );

    // 1. self-approval
    await expect(runBash('touch .claude-destructive-gate')).rejects.toThrow(/self-approval/i);
    // 2. snowflake
    await expect(runBash("python -c 'import snowflake.connector'")).rejects.toThrow(
      /snowflake\.connector|snow sql/i,
    );
    // 3. git-clone
    await expect(runBash('git clone https://github.com/a/b /workspace/agent/x')).rejects.toThrow(
      /clone_repo|create_worktree|managed/i,
    );
    // 4. destructive (hard block)
    await expect(runBash("eval 'echo hi'")).rejects.toThrow(/eval is not allowed/);
    // 5. email — gates via the stubbed runEmailGate (approved → no throw, but staged)
    await runBash('gws gmail +send --to a@b.com');
    expect(emailStages).toHaveLength(1);
    expect(emailStages[0]).toContain('gws gmail +send');
    // 6. file-protection — an edit to a protected path is blocked at the entrypoint
    await expect(runEdit('.env')).rejects.toThrow(/file-protection/);

    // A safe bash command and a safe edit both pass cleanly.
    await runBash('ls -la');
    await runEdit('src/index.ts');
  });
});
