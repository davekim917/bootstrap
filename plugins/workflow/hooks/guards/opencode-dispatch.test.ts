import { describe, test, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test';

// ── C2: OpenCode dispatch-coverage at the REAL entrypoint ─────────────────────
// These tests drive NanoclawGuard()['tool.execute.before'] — the actual opencode
// `tool.execute.before` hook — table-driven over every migrated command-guard
// (self-approval, snowflake, email-gate, git-clone) plus destructive and
// file-protection. They assert four things the per-evaluator suites cannot, all
// at the wired entrypoint:
//   1. correct OUTCOME per guard class (block / gate / allow),
//   2. chain ORDERING (self-approval → snowflake → git-clone → destructive →
//      email), observable via "earlier guard's message wins" composites,
//   3. per-gate ACTION (email → request_bash_gate, destructive →
//      request_destructive_gate),
//   4. the guard-ABSENCE direction — with a missing OR malformed core injected,
//      the entrypoint FAILS CLOSED (NanoclawGuard throws via assertCoreExports);
//      it never silently allows.
//
// Group B's opencode-guard.test.ts pins the gateBashOrThrow wrapper contract;
// this file pins the same guards as observed through the real hook object that
// opencode actually invokes (input/output shape included), and adds the
// imported-core fail-closed direction (B's B3 only exercises assertCoreExports
// directly with hand-built objects).

const CORE = './block-destructive-core';
const EMAIL_CORE = './email-gate-core';

// CRITICAL (learned from Group B): `mock.restore()` does NOT undo `mock.module()`
// (Bun docs). A leaked module mock poisons sibling files that `await import(CORE)`
// (conformance, block-destructive, evaluators, email-gate tests). Capture the
// pristine modules ONCE here, before any test mocks them, and restore the
// registry back via `mock.module(path, () => REAL)` in every afterEach.
const REAL_CORE = { ...(await import(CORE)) };
const REAL_EMAIL = { ...(await import(EMAIL_CORE)) };

function restoreModules(): void {
  mock.restore(); // restores spies/fn mocks
  mock.module(CORE, () => REAL_CORE); // un-leak (restore doesn't cover mock.module)
  mock.module(EMAIL_CORE, () => REAL_EMAIL);
}

type BeforeHook = (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: Record<string, unknown> },
) => Promise<void>;

/**
 * Load the real opencode-guard entrypoint with the destructive + email
 * session-DB gates stubbed so `gate` outcomes are deterministic (the test env
 * has no /workspace session DBs). Each stub records the staged gate ACTION so a
 * gate can be proven to route through the correct primitive
 * (request_destructive_gate vs request_bash_gate). Gates return 'approved' so a
 * gated command does NOT throw — distinguishing it from a block (which throws).
 */
async function loadEntrypoint(decision: 'approved' | 'denied' | 'timeout' = 'approved') {
  const stagedActions: string[] = [];
  mock.module(CORE, () => ({
    ...REAL_CORE,
    // The destructive gate path is guarded by `else if (IS_NANOCLAW)`; force it
    // true so a gated destructive verb reaches runNanoclawGate (the test env has
    // no /workspace session DBs, so the real IS_NANOCLAW is false → the
    // non-NanoClaw fallback would throw before staging). Named-import binding, so
    // mock.module redirects it on re-import.
    IS_NANOCLAW: true,
    // No real gate-file under /tmp/.claude-destructive-gate → keep the bypass off
    // so the chain takes the runNanoclawGate branch deterministically.
    consumeGateApproval: (): boolean => false,
    runNanoclawGate: (): 'approved' | 'denied' | 'timeout' => {
      stagedActions.push('request_destructive_gate');
      return decision;
    },
    runEmailGate: (): 'approved' | 'denied' | 'timeout' => {
      stagedActions.push('request_bash_gate');
      return decision;
    },
    // Belt-and-suspenders: never let a real DB poll run.
    pollDeliveredTable: (): 'approved' | 'denied' | 'timeout' => decision,
  }));
  const { NanoclawGuard } = await import('./opencode-guard');
  const hooks = await NanoclawGuard();
  const before = hooks['tool.execute.before'] as BeforeHook;
  const runBash = (command: string) =>
    before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command } });
  const runEdit = (path: string, tool = 'write') =>
    before({ tool, sessionID: 's', callID: 'c' }, { args: { path } });
  return { before, runBash, runEdit, stagedActions };
}

// Representative input per guard class, with its expected outcome at the
// entrypoint. `gate` rows must NOT throw (stub returns approved) but MUST stage.
interface GuardRow {
  name: string;
  command: string;
  outcome: 'block' | 'gate' | 'allow';
  // For block rows, the thrown message must match this.
  throws?: RegExp;
  // For gate rows, the staged action the chain must emit.
  stagedAction?: 'request_destructive_gate' | 'request_bash_gate';
}

const BASH_ROWS: GuardRow[] = [
  {
    name: 'self-approval',
    command: 'touch .claude-destructive-gate',
    outcome: 'block',
    throws: /self-approval/i,
  },
  {
    name: 'snowflake',
    command: "python -c 'import snowflake.connector'",
    outcome: 'block',
    throws: /snowflake\.connector|snow sql/i,
  },
  {
    name: 'git-clone (managed dir)',
    command: 'git clone https://github.com/a/b /workspace/agent/repos/b',
    outcome: 'block',
    throws: /clone_repo|create_worktree|managed/i,
  },
  {
    name: 'destructive (hard block — eval)',
    command: "eval 'echo hi'",
    outcome: 'block',
    throws: /eval is not allowed/i,
  },
  {
    name: 'destructive (gate — terraform destroy)',
    command: 'terraform destroy -auto-approve',
    outcome: 'gate',
    stagedAction: 'request_destructive_gate',
  },
  {
    name: 'email (gate — gws send)',
    command: 'gws gmail +send --to a@b.com --subject hi',
    outcome: 'gate',
    stagedAction: 'request_bash_gate',
  },
  { name: 'safe bash (allow)', command: 'ls -la', outcome: 'allow' },
];

describe('test_oc_dispatch_each_guard', () => {
  const prevScheduled = process.env.NANOCLAW_IS_SCHEDULED_TASK;
  beforeEach(() => {
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK; // interactive context
  });
  afterEach(() => {
    restoreModules();
    if (prevScheduled === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = prevScheduled;
  });

  for (const row of BASH_ROWS) {
    test(`${row.name} → ${row.outcome} at the real entrypoint`, async () => {
      const { runBash, stagedActions } = await loadEntrypoint('approved');
      if (row.outcome === 'block') {
        await expect(runBash(row.command)).rejects.toThrow(row.throws!);
        // A hard block must throw BEFORE any gate is staged.
        expect(stagedActions).toHaveLength(0);
      } else if (row.outcome === 'gate') {
        // Stub returns approved → the gated command resolves without throwing,
        // but it must have staged exactly its gate action.
        await runBash(row.command);
        expect(stagedActions).toEqual([row.stagedAction!]);
      } else {
        await runBash(row.command);
        expect(stagedActions).toHaveLength(0);
      }
    });
  }

  test('file-protection blocks a protected edit at the entrypoint', async () => {
    const { runEdit, stagedActions } = await loadEntrypoint('approved');
    await expect(runEdit('.env')).rejects.toThrow(/file-protection/i);
    expect(stagedActions).toHaveLength(0);
    // A safe edit passes cleanly.
    await runEdit('src/index.ts');
  });
});

describe('test_oc_dispatch_action_per_gate', () => {
  const prevScheduled = process.env.NANOCLAW_IS_SCHEDULED_TASK;
  beforeEach(() => {
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
  });
  afterEach(() => {
    restoreModules();
    if (prevScheduled === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = prevScheduled;
  });

  test('email send → request_bash_gate (NOT request_destructive_gate)', async () => {
    const { runBash, stagedActions } = await loadEntrypoint('approved');
    await runBash('gws gmail +send --to a@b.com --subject hi');
    expect(stagedActions).toEqual(['request_bash_gate']);
  });

  test('destructive gate → request_destructive_gate (NOT request_bash_gate)', async () => {
    const { runBash, stagedActions } = await loadEntrypoint('approved');
    await runBash('terraform destroy -auto-approve');
    expect(stagedActions).toEqual(['request_destructive_gate']);
  });

  test('an approved destructive verb that also sends email stages BOTH, in order', async () => {
    // After the destructive gate is approved, the chain falls through to the
    // email gate (per gateBashOrThrow step 5's fall-through). Both actions must
    // stage, destructive first, then email.
    const { runBash, stagedActions } = await loadEntrypoint('approved');
    await runBash('terraform destroy -auto-approve && gws gmail +send --to a@b.com');
    expect(stagedActions).toEqual(['request_destructive_gate', 'request_bash_gate']);
  });
});

describe('test_oc_dispatch_chain_order', () => {
  const prevScheduled = process.env.NANOCLAW_IS_SCHEDULED_TASK;
  beforeEach(() => {
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
  });
  afterEach(() => {
    restoreModules();
    if (prevScheduled === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = prevScheduled;
  });

  test('chain order is self-approval → snowflake → git-clone → destructive → email', async () => {
    const { runBash } = await loadEntrypoint('approved');

    // self-approval BEFORE snowflake.
    await expect(
      runBash("touch .claude-destructive-gate && python -c 'import snowflake.connector'"),
    ).rejects.toThrow(/self-approval/i);

    // snowflake BEFORE git-clone.
    await expect(
      runBash(
        "python -c 'import snowflake.connector' && git clone https://github.com/a/b /workspace/agent/x",
      ),
    ).rejects.toThrow(/snowflake\.connector|snow sql/i);

    // git-clone BEFORE destructive.
    await expect(
      runBash('git clone https://github.com/a/b /workspace/agent/x && rm important.txt'),
    ).rejects.toThrow(/clone_repo|create_worktree|managed/i);

    // destructive BEFORE email (hard-block eval wins over the email send → the
    // email gate is never reached).
    await expect(runBash("eval 'x' && gws gmail +send --to a@b.com")).rejects.toThrow(
      /eval is not allowed/i,
    );
  });

  test('destructive gate fires before email even when both are present (gate, not block)', async () => {
    // A gated (not hard-blocked) destructive verb + an email send: the
    // destructive gate stages first; only after approval does email stage.
    const { runBash, stagedActions } = await loadEntrypoint('approved');
    await runBash('terraform destroy -auto-approve && gws gmail +send --to a@b.com');
    expect(stagedActions[0]).toBe('request_destructive_gate');
    expect(stagedActions[1]).toBe('request_bash_gate');
  });
});

// ── Guard-ABSENCE direction: the entrypoint must FAIL CLOSED on a broken core.
//
// IMPORTANT Bun limitation (verified empirically, not assumed): `mock.module()`
// redirects NAMED imports on re-import, but does NOT redirect a live
// `import * as core` NAMESPACE binding. opencode-guard's assertCoreExports()
// reads its DEFAULT args from the `core` / `emailCore` NAMESPACE imports, so
// mock.module-ing the core cannot reach the entrypoint's default-arg validation.
//
// To exercise the REAL entrypoint against a BROKEN core faithfully, we
// `spyOn(og, 'assertCoreExports')` and redirect ONLY its default core argument
// to a broken object, delegating to the REAL validator. The entrypoint's own
// internal call site is what the spy intercepts (proven: spyOn sees the bare
// internal call), and the REAL validation logic runs against the broken core.
// This proves both halves of the contract: (1) NanoclawGuard() invokes the
// validator, and (2) the validator rejects a broken core → the entrypoint
// rejects. No fabricated capability; the throw text is the real fail-closed msg.
async function expectEntrypointFailsClosed(
  brokenCore?: Record<string, unknown>,
  brokenEmail?: Record<string, unknown>,
  pattern = /fail-closed/i,
): Promise<void> {
  const og = await import('./opencode-guard');
  const realValidator = og.assertCoreExports;
  const spy = spyOn(og, 'assertCoreExports').mockImplementation(() =>
    realValidator(brokenCore ?? (REAL_CORE as Record<string, unknown>), brokenEmail ?? (REAL_EMAIL as Record<string, unknown>)),
  );
  try {
    await expect(og.NanoclawGuard()).rejects.toThrow(pattern);
    // The entrypoint actually ran the validator (not a short-circuit).
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  } finally {
    spy.mockRestore();
  }
}

describe('test_oc_dispatch_fail_closed_on_absent_core', () => {
  afterEach(() => {
    restoreModules();
  });

  test('a missing pure evaluator (evaluateSelfApproval) makes the entrypoint refuse to construct', async () => {
    const broken = { ...REAL_CORE } as Record<string, unknown>;
    delete broken.evaluateSelfApproval;
    await expectEntrypointFailsClosed(broken, undefined, /evaluateSelfApproval/);
  });

  test('a missing gate PRIMITIVE (runEmailGate) fails closed (the cycle-4 gap)', async () => {
    // Verdict evaluators present, the gate primitive missing — a stale core that
    // would fail-open on email sends if the entrypoint didn't validate primitives.
    const broken = { ...REAL_CORE } as Record<string, unknown>;
    delete broken.runEmailGate;
    await expectEntrypointFailsClosed(broken, undefined, /runEmailGate/);
  });

  test('a missing email-core evaluator (evaluateEmailSend) fails closed', async () => {
    const brokenEmail = { ...REAL_EMAIL } as Record<string, unknown>;
    delete brokenEmail.evaluateEmailSend;
    await expectEntrypointFailsClosed(undefined, brokenEmail, /evaluateEmailSend/);
  });

  test('a complete core lets the entrypoint construct (control — no false-positive fail-closed)', async () => {
    // Sanity: with both cores intact, the entrypoint constructs the hook object.
    const og = await import('./opencode-guard');
    const hooks = await og.NanoclawGuard();
    expect(typeof hooks['tool.execute.before']).toBe('function');
  });
});

describe('test_oc_dispatch_fail_closed_on_malformed_core', () => {
  afterEach(() => {
    restoreModules();
  });

  test('a mis-typed required export (present but not a function) fails closed', async () => {
    // "Present ≠ correct": runEmailGate exists but is a string. The entrypoint
    // must refuse to construct rather than throw an opaque error mid-tool-call.
    const malformed = { ...REAL_CORE, runEmailGate: 'not a function' } as Record<string, unknown>;
    await expectEntrypointFailsClosed(malformed, undefined, /runEmailGate/);
  });

  test('a mis-typed pure evaluator (evaluateGitCloneDestination) fails closed', async () => {
    const malformed = { ...REAL_CORE, evaluateGitCloneDestination: 42 } as Record<string, unknown>;
    await expectEntrypointFailsClosed(malformed, undefined, /evaluateGitCloneDestination/);
  });

  test('a malformed email evaluator (present but not a function) fails closed', async () => {
    const malformedEmail = { ...REAL_EMAIL, evaluateEmailSend: { nope: true } } as Record<string, unknown>;
    await expectEntrypointFailsClosed(undefined, malformedEmail, /evaluateEmailSend/);
  });
});
