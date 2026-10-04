import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
    evaluateSelfApproval,
    evaluateSnapshotGitMutation,
    evaluateSnowflakeConnector,
} from './block-destructive-core';

// ── A1: pure evaluators (self-approval, snowflake connector) ──
// Ported verbatim from nanoclaw claude.ts:470-484 (SELF_APPROVAL_RE) and
// claude.ts:498-512 (SNOWFLAKE_CONNECTOR_EXEC_RE). Both are pure: no env, no
// I/O, deterministic on the `command` arg.

describe('evaluateSelfApproval', () => {
    test('test_self_approval_blocks_marker', () => {
        for (const cmd of [
            'touch .claude-destructive-gate',
            'echo ok > .claude-destructive-gate',
            'echo /tmp/.claude-destructive-gate/abc',
        ]) {
            const v = evaluateSelfApproval(cmd);
            expect(v.action).toBe('block');
            expect(typeof v.reason).toBe('string');
            expect((v.reason ?? '').length).toBeGreaterThan(0);
        }
    });

    test('test_self_approval_allows_plain', () => {
        for (const cmd of ['ls -la', 'git status', 'echo hello', '']) {
            expect(evaluateSelfApproval(cmd)).toEqual({ action: 'allow' });
        }
    });

    test('pure — deterministic, no reliance on env', () => {
        const prev = process.env.SOME_ENV;
        process.env.SOME_ENV = 'whatever';
        const a = evaluateSelfApproval('touch .claude-destructive-gate');
        delete process.env.SOME_ENV;
        const b = evaluateSelfApproval('touch .claude-destructive-gate');
        if (prev !== undefined) process.env.SOME_ENV = prev;
        expect(a).toEqual(b);
    });
});

describe('evaluateSnowflakeConnector', () => {
    test('test_snowflake_blocks_connector_import', () => {
        for (const cmd of [
            "python -c 'import snowflake.connector'",
            'python3 -c "import snowflake.connector as sc"',
            'python -c "from snowflake.connector import connect"',
            'python -c "import snowflake_connector"',
        ]) {
            const v = evaluateSnowflakeConnector(cmd);
            expect(v.action).toBe('block');
            expect(typeof v.reason).toBe('string');
            expect((v.reason ?? '').length).toBeGreaterThan(0);
        }
    });

    test('test_snowflake_allows_snow_cli', () => {
        for (const cmd of [
            'snow sql -q "select 1"',
            'grep snowflake.connector requirements.txt',
            'pip install snowflake-connector-python',
            'echo snowflake.connector',
            'ls -la',
            '',
        ]) {
            expect(evaluateSnowflakeConnector(cmd)).toEqual({ action: 'allow' });
        }
    });

    test('pure — deterministic, no reliance on env', () => {
        const cmd = "python -c 'import snowflake.connector'";
        expect(evaluateSnowflakeConnector(cmd)).toEqual(evaluateSnowflakeConnector(cmd));
    });
});

// ── A2: D18 signature-safe gate-wrapper refactor ──
// runNanoclawGate / runEmailGate / runGateRequest all stage a session-DB
// approval request via writeGateRequest (which touches bun:sqlite + the
// /workspace session DBs that don't exist in this test env). To observe the
// staged `action` without a real DB, we mock.module the core so writeGateRequest
// is a spy that records the action arg and pollDeliveredTable returns a fixed
// decision. Bun's mock.module redirects intra-module references, so the
// run*Gate wrappers see the mocked writeGateRequest/pollDeliveredTable.
const MODULE = './block-destructive-core';

interface StagedCall {
    label: string;
    summary: string;
    command: string;
    action: string | undefined;
}

async function loadWithSpies(opts: { stageThrows?: boolean } = {}) {
    const real = await import(MODULE);
    const staged: StagedCall[] = [];
    mock.module(MODULE, () => ({
        ...real,
        writeGateRequest: (
            label: string,
            summary: string,
            command: string,
            action?: 'request_destructive_gate' | 'request_bash_gate',
        ): string => {
            staged.push({ label, summary, command, action });
            if (opts.stageThrows) throw new Error('session DBs broken');
            return 'gate-test-id';
        },
        pollDeliveredTable: (): 'approved' | 'denied' | 'timeout' => 'approved',
    }));
    const mod = await import(MODULE);
    return { mod, staged };
}

describe('A2 runGateRequest action parameterization', () => {
    afterEach(() => {
        mock.restore();
    });

    test('test_runNanoclawGate_legacy_3arg_emits_destructive', async () => {
        const { mod, staged } = await loadWithSpies();
        const decision = mod.runNanoclawGate('rm -rf foo', 'because', () => {});
        expect(decision).toBe('approved');
        expect(staged).toHaveLength(1);
        expect(staged[0].action).toBe('request_destructive_gate');
    });

    test('test_runEmailGate_emits_bash_gate', async () => {
        const { mod, staged } = await loadWithSpies();
        const decision = mod.runEmailGate('gws gmail +send', 'email send');
        expect(decision).toBe('approved');
        expect(staged).toHaveLength(1);
        expect(staged[0].action).toBe('request_bash_gate');
    });

    test('test_runEmailGate_threads_summary_to_card (S-QA2)', async () => {
        const { mod, staged } = await loadWithSpies();
        const decision = mod.runEmailGate(
            'gws gmail +send --to a@example.com',
            'Email send to a@example.com',
            undefined,
            '*From:* me\n*To:* a@example.com\n\n*Body:*\n> hi',
        );
        expect(decision).toBe('approved');
        expect(staged).toHaveLength(1);
        // label stays the short label; summary is the distinct structured card body
        expect(staged[0].label).toBe('Email send to a@example.com');
        expect(staged[0].summary).toBe('*From:* me\n*To:* a@example.com\n\n*Body:*\n> hi');
        expect(staged[0].action).toBe('request_bash_gate');
    });

    test('runEmailGate without a summary falls back to reason for both (back-compat)', async () => {
        const { mod, staged } = await loadWithSpies();
        mod.runEmailGate('gws gmail +send', 'email send');
        expect(staged[0].label).toBe('email send');
        expect(staged[0].summary).toBe('email send'); // unchanged legacy behavior
    });

    test('runGateRequest forwards an explicit action', async () => {
        const { mod, staged } = await loadWithSpies();
        mod.runGateRequest('cmd', 'reason', { action: 'request_bash_gate' });
        expect(staged[0].action).toBe('request_bash_gate');
        mod.runGateRequest('cmd2', 'reason2', { action: 'request_destructive_gate' });
        expect(staged[1].action).toBe('request_destructive_gate');
    });

    test('test_onStageError_fires_on_staging_failure', async () => {
        const { mod } = await loadWithSpies({ stageThrows: true });
        let captured: unknown;
        const decision = mod.runNanoclawGate('rm -rf foo', 'because', (err: unknown) => {
            captured = err;
        });
        expect(decision).toBe('denied');
        expect(captured).toBeInstanceOf(Error);
        expect((captured as Error).message).toBe('session DBs broken');
    });

    test('onStageError fires for runEmailGate too', async () => {
        const { mod } = await loadWithSpies({ stageThrows: true });
        let fired = false;
        const decision = mod.runEmailGate('gws gmail +send', 'email', () => {
            fired = true;
        });
        expect(decision).toBe('denied');
        expect(fired).toBe(true);
    });
});

describe('evaluateSnapshotGitMutation', () => {
    const WT = '/workspace/worktrees/app-repo@feature';
    const SNAP = '/workspace/workgroup/app-repo';

    test('blocks a mutation whose target is a repo snapshot', () => {
        for (const cmd of [
            `git -C ${SNAP} checkout -b feature`,
            `git -C ${SNAP} commit -m x`,
            `cd ${SNAP} && git checkout main`,
            `cd ${SNAP}; git stash`,
            `cd /workspace/workgroup && cd app-repo && git reset --hard`,
            `git --git-dir=${SNAP}/.git --work-tree=${SNAP} reset --hard`,
            `git --work-tree ${SNAP} restore .`,
            `GIT_DIR=${SNAP}/.git git commit -m x`,
            `R=${SNAP}; git -C "$R" checkout x`,
            `git -C ${WT} worktree add ${SNAP}/../app-repo/sub`,
            `git -C /workspace/workgroup/.repos/app-repo.git update-ref refs/heads/x HEAD`,
            `git -C /workspace/workgroup/.rescues/app-repo branch -D x`,
            `git -c user.name=x -C ${SNAP} cherry-pick abc123`,
            'git --git-dir=app-repo/.git -C /workspace/workgroup commit -m x',
            'git -C /workspace/workgroup --work-tree app-repo restore .',
            `env -C ${SNAP} git commit -m x`,
            `env --chdir=${SNAP} git commit -m x`,
            `cd ${SNAP}; (cd ${WT}); git commit -m x`,
            `cd ${SNAP}; cd ${WT} | true; git commit -m x`,
            `R=${SNAP}; R=${WT} env; git -C "$R" commit -m x`,
            `R=${SNAP}; (R=${WT}); git -C "$R" commit -m x`,
            `if true; then cd ${SNAP} && git checkout main; fi`,
            `echo "$(cd ${SNAP} && git commit -m x)"`,
            `cd ${SNAP} || cd ${WT}; git commit -m x`,
            `cd ${SNAP}; pushd ${WT}; popd; git commit -m x`,
            `cd ${SNAP}; cd ${WT}; cd -; git commit -m x`,
            `if true; then cd ${SNAP}; else cd ${WT}; fi; git commit -m x`,
            `case x in a) cd ${SNAP};; *) cd ${WT};; esac; git commit -m x`,
            `while false; do git -C ${SNAP} commit -m x; done`,
            `env -C /workspace/workgroup env -C app-repo git commit -m x`,
            `export GIT_DIR=${SNAP}/.git; git commit -m x`,
            `declare -x GIT_WORK_TREE=${SNAP}; git restore .`,
        ]) {
            expect(evaluateSnapshotGitMutation(cmd).action).toBe('block');
        }
    });

    test('a snapshot path passed as a file argument names no target', () => {
        expect(evaluateSnapshotGitMutation(
            `git --no-optional-locks -C ${WT} apply --check /workspace/workgroup/artifacts/demo/change.patch`,
        )).toEqual({ action: 'allow' });
        expect(evaluateSnapshotGitMutation(
            `git -C ${WT} apply ${SNAP}/patches/change.patch`,
        )).toEqual({ action: 'allow' });
    });

    test('git text inside a heredoc or string body names no target', () => {
        for (const cmd of [
            `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git', '-C', '${SNAP}', 'checkout', 'x'])\nprint("git -C ${SNAP} apply x")\nPY`,
            `echo "git -C ${SNAP} commit -m x"`,
            `cat > /workspace/workgroup/artifacts/demo/receipt.txt <<'EOF'\ncd ${SNAP} && git checkout main\nEOF`,
        ]) {
            expect(evaluateSnapshotGitMutation(cmd)).toEqual({ action: 'allow' });
        }
    });

    test('shared non-repo dirs, worktrees and read-only verbs are not snapshots', () => {
        for (const cmd of [
            'git -C /workspace/workgroup/.worktrees/shared commit -m x',
            'git -C /workspace/workgroup/memory commit -m x',
            'git -C /workspace/workgroup/artifacts/demo apply x.patch',
            'git -C /workspace/workgroup/claims/demo commit -m x',
            `git -C ${WT} commit -m x`,
            `git -C ${SNAP} log --oneline`,
            `git -C ${SNAP} diff HEAD~1`,
            `cd ${SNAP} && git status && cd ${WT} && git commit -m x`,
            `(cd ${SNAP} && git log); git commit -m x`,
            `env -C ${WT} git commit -m x`,
            `R=${WT}; git -C "$R" commit -m x`,
            `cd ${SNAP} && git log; cd ${WT}; git commit -m x`,
            `pushd ${SNAP}; popd; cd ${WT} && git commit -m x`,
            `if true; then cd ${WT}; else cd ${WT}/sub; fi; git commit -m x`,
            `GIT_DIR=${SNAP}/.git; git commit -m x`,
            `export GIT_DIR=${WT}/.git; git commit -m x`,
            'git checkout main',
            '',
        ]) {
            expect(evaluateSnapshotGitMutation(cmd)).toEqual({ action: 'allow' });
        }
    });
});
