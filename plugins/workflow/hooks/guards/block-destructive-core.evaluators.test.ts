import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
    evaluateSelfApproval,
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
            'gws gmail +send --to a@b.com',
            'Email send to a@b.com',
            undefined,
            '*From:* me\n*To:* a@b.com\n\n*Body:*\n> hi',
        );
        expect(decision).toBe('approved');
        expect(staged).toHaveLength(1);
        // label stays the short label; summary is the distinct structured card body
        expect(staged[0].label).toBe('Email send to a@b.com');
        expect(staged[0].summary).toBe('*From:* me\n*To:* a@b.com\n\n*Body:*\n> hi');
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
