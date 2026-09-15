import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_BLOCK_THRESHOLD,
    DEFAULT_WARN_THRESHOLD,
    analyzeTurn,
    evaluateDispatchFirst,
    isCoordinatorModel,
    isLogisticalToolUse,
    isUserTurnBoundary,
    parseTranscript,
    resolveThresholds,
    type DispatchFirstVerdict,
} from './dispatch-first-core';

// ── Transcript fixture builder ───────────────────────────────────────────────
// Mirrors the real Claude Code JSONL shape observed on this host (2.1.270):
// user turns are `type:"user"` with string content or a text block; tool
// results are `type:"user"` with `tool_result` blocks; assistant lines carry
// `message.model` and `tool_use` blocks.

type ToolUse = { name: string; input?: Record<string, unknown>; id?: string };

let seq = 0;
const nextId = () => `toolu_${String(++seq).padStart(4, '0')}`;

function userTurn(text = 'please do the thing'): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function userTextBlockTurn(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}

function toolResult(id: string): string {
    return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
}

function assistant(model: string, uses: ToolUse[], extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'assistant',
        ...extra,
        message: {
            role: 'assistant',
            model,
            content: uses.map((u) => ({ type: 'tool_use', id: u.id ?? nextId(), name: u.name, input: u.input ?? {} })),
        },
    });
}

/** A turn of `n` counted investigation calls (each followed by its tool_result). */
function investigationTurn(model: string, n: number, opts: { dispatchAt?: number } = {}): string[] {
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = nextId();
        const uses: ToolUse[] = [{ name: 'Read', input: { file_path: `/repo/src/file${i}.ts` }, id }];
        if (opts.dispatchAt === i) uses.push({ name: 'Agent', input: { prompt: 'build it' } });
        lines.push(assistant(model, uses), toolResult(id));
    }
    return lines;
}

function transcript(...parts: Array<string | string[]>): string {
    return `${parts.flat().join('\n')}\n`;
}

const SONNET = 'claude-sonnet-5';
const FABLE = 'claude-fable-5-1';

function evaluate(
    text: string | null,
    overrides: Partial<Parameters<typeof evaluateDispatchFirst>[0]> = {},
): DispatchFirstVerdict {
    return evaluateDispatchFirst({
        transcriptText: text,
        toolName: 'Read',
        toolInput: { file_path: '/repo/src/next.ts' },
        env: {},
        ...overrides,
    });
}

// ── Roster ───────────────────────────────────────────────────────────────────

describe('coordinator roster', () => {
    test.each(['claude-sonnet-5', 'claude-sonnet-4-5-20250929', 'gpt-5.6-terra', 'gpt-5.6-terra-xhigh'])(
        '%s is a coordinator',
        (m) => expect(isCoordinatorModel(m)).toBe(true),
    );
    test.each(['claude-fable-5-1', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'gpt-6-astra', 'gpt-6-sol', '', null, undefined])(
        '%s is not a coordinator',
        (m) => expect(isCoordinatorModel(m as string | null | undefined)).toBe(false),
    );
});

// ── Allowlist ────────────────────────────────────────────────────────────────

describe('logistical allowlist', () => {
    test.each([
        'gh pr view 42 --json headRefOid',
        'gh api repos/o/r/pulls/42',
        'mkdir -p docs/specs/x',
        'git fetch origin main',
        'ls -la',
        'pwd',
        'date -u',
        'echo hello',
        '  ls src && echo done',
    ])('Bash not counted: %s', (command) => {
        expect(isLogisticalToolUse('Bash', { command })).toBe(true);
    });

    test.each([
        'cat src/index.ts',
        'git show HEAD:src/app.ts',
        'curl https://svc/healthz',
        'ls && cat src/index.ts',
        'echo x; git log -p',
        'pnpm test',
        // Every segment must be allowlisted; a filter like `head` is not.
        'gh pr view 1 | head',
    ])('Bash counted: %s', (command) => {
        expect(isLogisticalToolUse('Bash', { command })).toBe(false);
    });

    test.each([
        '/repo/docs/specs/feature/plan.md',
        '/repo/docs/specs/feature/run.md',
        '/repo/CLAUDE.md',
        '/home/u/.claude/skills/orchestrate/SKILL.md',
        'plan.md',
    ])('Read not counted: %s', (file_path) => {
        expect(isLogisticalToolUse('Read', { file_path })).toBe(true);
    });

    test.each(['/repo/src/index.ts', '/repo/docs/plan.md.bak', '/repo/README.md', 'myplan.md'])(
        'Read counted: %s',
        (file_path) => expect(isLogisticalToolUse('Read', { file_path })).toBe(false),
    );

    test('Grep, Glob and WebFetch are always counted', () => {
        expect(isLogisticalToolUse('Grep', { pattern: 'x' })).toBe(false);
        expect(isLogisticalToolUse('Glob', { pattern: '**/*.ts' })).toBe(false);
        expect(isLogisticalToolUse('WebFetch', { url: 'https://x' })).toBe(false);
    });
});

// ── Turn boundary ────────────────────────────────────────────────────────────

describe('turn boundary', () => {
    test('a string-content user line is a boundary', () => {
        expect(isUserTurnBoundary(JSON.parse(userTurn()))).toBe(true);
    });
    test('a text-block user line is a boundary', () => {
        expect(isUserTurnBoundary(JSON.parse(userTextBlockTurn('[Request interrupted by user]')))).toBe(true);
    });
    test('a tool_result user line is NOT a boundary', () => {
        expect(isUserTurnBoundary(JSON.parse(toolResult('toolu_x')))).toBe(false);
    });
    test('assistant and attachment lines are not boundaries', () => {
        expect(isUserTurnBoundary(JSON.parse(assistant(SONNET, [])))).toBe(false);
        expect(isUserTurnBoundary({ type: 'attachment' })).toBe(false);
    });

    test('calls before the most recent user message are not counted', () => {
        const text = transcript(
            userTurn('first ask'),
            investigationTurn(SONNET, 7),
            userTurn('second ask'),
            investigationTurn(SONNET, 2),
        );
        const turn = analyzeTurn(parseTranscript(text));
        expect(turn.investigationCalls).toHaveLength(2);
        expect(turn.model).toBe(SONNET);
        expect(turn.dispatched).toBe(false);
    });

    test('tool_result lines do not reset the count', () => {
        const text = transcript(userTurn(), investigationTurn(SONNET, 5));
        expect(analyzeTurn(parseTranscript(text)).investigationCalls).toHaveLength(5);
    });

    test('an Agent dispatch in a PRIOR turn does not cover this turn', () => {
        const text = transcript(
            userTurn('first'),
            investigationTurn(SONNET, 1, { dispatchAt: 0 }),
            userTurn('second'),
            investigationTurn(SONNET, 4),
        );
        const turn = analyzeTurn(parseTranscript(text));
        expect(turn.dispatched).toBe(false);
        expect(turn.investigationCalls).toHaveLength(4);
    });

    test('sidechain lines are ignored', () => {
        const text = transcript(
            userTurn(),
            assistant(SONNET, [{ name: 'Read', input: { file_path: '/repo/a.ts' } }], { isSidechain: true }),
            assistant(SONNET, [{ name: 'Read', input: { file_path: '/repo/b.ts' } }]),
        );
        expect(analyzeTurn(parseTranscript(text)).investigationCalls).toHaveLength(1);
    });

    test('a torn trailing line is skipped, not fatal', () => {
        const text = transcript(userTurn(), investigationTurn(SONNET, 2)) + '{"type":"assis';
        expect(analyzeTurn(parseTranscript(text)).investigationCalls).toHaveLength(2);
    });

    test('the current tool_use, if already persisted, is not double-counted', () => {
        const text = transcript(
            userTurn(),
            investigationTurn(SONNET, 3),
            assistant(SONNET, [{ name: 'Read', input: { file_path: '/repo/src/next.ts' }, id: 'toolu_current' }]),
        );
        const withId = evaluate(text, { toolUseId: 'toolu_current' });
        expect(withId.count).toBe(4);
        const withoutId = evaluate(text);
        expect(withoutId.count).toBe(5);
    });

    test('model comes from the LATEST assistant line, so a /model switch is honoured', () => {
        const text = transcript(
            userTurn('a'),
            assistant(FABLE, []),
            userTurn('b'),
            assistant(SONNET, []),
        );
        expect(analyzeTurn(parseTranscript(text)).model).toBe(SONNET);
    });

    test('first call of a turn falls back to the previous turn\'s model', () => {
        const text = transcript(userTurn('a'), assistant(SONNET, []), userTurn('b'));
        expect(analyzeTurn(parseTranscript(text)).model).toBe(SONNET);
    });

    test('synthetic model markers are ignored', () => {
        const text = transcript(userTurn(), assistant(SONNET, []), assistant('<synthetic>', []));
        expect(analyzeTurn(parseTranscript(text)).model).toBe(SONNET);
    });
});

// ── Thresholds from env ──────────────────────────────────────────────────────

describe('thresholds', () => {
    test('defaults', () => {
        const t = resolveThresholds({});
        expect(t).toMatchObject({ warn: DEFAULT_WARN_THRESHOLD, block: DEFAULT_BLOCK_THRESHOLD, disabled: false, ignoredEnv: [] });
    });
    test('env overrides', () => {
        const t = resolveThresholds({ BOOTSTRAP_DISPATCH_FIRST_WARN: '5', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '12' });
        expect(t).toMatchObject({ warn: 5, block: 12 });
    });
    test.each(['off', 'OFF', '0', 'false'])('%s disables', (v) => {
        expect(resolveThresholds({ BOOTSTRAP_DISPATCH_FIRST: v }).disabled).toBe(true);
    });
    test.each(['on', '1', 'true', ''])('%s does not disable', (v) => {
        expect(resolveThresholds({ BOOTSTRAP_DISPATCH_FIRST: v }).disabled).toBe(false);
    });
    test('an unusable value keeps the default and is reported, never silently loosened', () => {
        const t = resolveThresholds({ BOOTSTRAP_DISPATCH_FIRST_WARN: 'lots', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '-1' });
        expect(t.warn).toBe(DEFAULT_WARN_THRESHOLD);
        expect(t.block).toBe(DEFAULT_BLOCK_THRESHOLD);
        expect(t.ignoredEnv).toHaveLength(2);
    });
    test('block below warn is raised to warn', () => {
        const t = resolveThresholds({ BOOTSTRAP_DISPATCH_FIRST_WARN: '6', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '2' });
        expect(t.block).toBe(6);
        expect(t.ignoredEnv).toHaveLength(1);
    });
});

// ── Verdicts (the brief's fixture matrix) ────────────────────────────────────

describe('verdicts', () => {
    test('coordinator, 3 prior calls, no Agent → 4th call warns (allowed with message)', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 3)));
        expect(v.action).toBe('warn');
        expect(v.count).toBe(4);
        expect(v.reason).toMatch(/^GATED: dispatch-first — 4 investigation calls/);
        expect(v.reason).toContain('run.md');
    });

    test('coordinator, 2 prior calls → 3rd call allowed silently', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 2)));
        expect(v.action).toBe('allow');
        expect(v.count).toBe(3);
        expect(v.reason).toBeUndefined();
    });

    test('coordinator, 8 prior calls → 9th call blocks', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 8)));
        expect(v.action).toBe('block');
        expect(v.count).toBe(9);
        expect(v.reason).toMatch(/^BLOCKED: dispatch-first — 9 investigation calls/);
    });

    test('coordinator, 7 prior calls → 8th call still only warns', () => {
        expect(evaluate(transcript(userTurn(), investigationTurn(SONNET, 7))).action).toBe('warn');
    });

    test('Terra coordinator is gated too', () => {
        expect(evaluate(transcript(userTurn(), investigationTurn('gpt-5.6-terra', 8))).action).toBe('block');
    });

    test.each([FABLE, 'claude-opus-5', 'gpt-6-astra', 'gpt-6-sol', 'claude-haiku-4-5-20251001'])(
        'builder %s with 8 prior calls → no-op',
        (model) => {
            const v = evaluate(transcript(userTurn(), investigationTurn(model, 8)));
            expect(v.action).toBe('allow');
            expect(v.skipped).toContain('builder model');
        },
    );

    test('coordinator with an Agent dispatch this turn → no-op even at 8 prior calls', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 8, { dispatchAt: 2 })));
        expect(v.action).toBe('allow');
        expect(v.skipped).toBe('dispatched this turn');
    });

    test('a SendMessage to the retained worker counts as dispatch', () => {
        const text = transcript(
            userTurn(),
            assistant(SONNET, [{ name: 'SendMessage', input: { to: 'worker', message: 'fix the test' } }]),
            investigationTurn(SONNET, 8),
        );
        expect(evaluate(text).action).toBe('allow');
    });

    test('a logistical current call is not counted or gated even past the block line', () => {
        const text = transcript(userTurn(), investigationTurn(SONNET, 8));
        const v = evaluate(text, { toolName: 'Bash', toolInput: { command: 'gh pr view 7 --json headRefOid' } });
        expect(v.action).toBe('allow');
        expect(v.skipped).toBe('logistical call');
        expect(v.count).toBe(0);
    });

    test('prior logistical calls are not counted', () => {
        const text = transcript(
            userTurn(),
            assistant(SONNET, [{ name: 'Bash', input: { command: 'gh pr view 7' } }]),
            assistant(SONNET, [{ name: 'Bash', input: { command: 'mkdir -p docs/specs/x' } }]),
            assistant(SONNET, [{ name: 'Read', input: { file_path: '/repo/docs/specs/x/plan.md' } }]),
            investigationTurn(SONNET, 2),
        );
        const v = evaluate(text);
        expect(v.action).toBe('allow');
        expect(v.count).toBe(3);
    });

    test('a non-investigation tool is never gated', () => {
        const text = transcript(userTurn(), investigationTurn(SONNET, 8));
        const v = evaluate(text, { toolName: 'Edit', toolInput: { file_path: '/repo/x.ts' } });
        expect(v.action).toBe('allow');
        expect(v.skipped).toContain('not counted');
    });

    test('env thresholds move the lines', () => {
        const text = transcript(userTurn(), investigationTurn(SONNET, 3));
        const loose = evaluate(text, { env: { BOOTSTRAP_DISPATCH_FIRST_WARN: '10', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '20' } });
        expect(loose.action).toBe('allow');
        const tight = evaluate(text, { env: { BOOTSTRAP_DISPATCH_FIRST_WARN: '1', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '3' } });
        expect(tight.action).toBe('block');
    });

    test('BOOTSTRAP_DISPATCH_FIRST=off disables entirely', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 20)), { env: { BOOTSTRAP_DISPATCH_FIRST: 'off' } });
        expect(v.action).toBe('allow');
        expect(v.skipped).toContain('off');
    });

    test('subagent context is never gated', () => {
        const v = evaluate(transcript(userTurn(), investigationTurn(SONNET, 20)), { inSubagent: true });
        expect(v.action).toBe('allow');
        expect(v.skipped).toBe('subagent context');
    });

    test('unreadable, empty or model-less transcripts stand down (fail-open, deliberate)', () => {
        expect(evaluate(null).skipped).toBe('transcript unreadable');
        expect(evaluate('').skipped).toBe('transcript empty');
        expect(evaluate(transcript(userTurn())).skipped).toBe('model undeterminable');
        for (const t of [null, '', transcript(userTurn())]) expect(evaluate(t).action).toBe('allow');
    });

    test('the verdict carries every counted call for the diagnostic log', () => {
        const text = transcript(
            userTurn(),
            assistant(SONNET, [{ name: 'Bash', input: { command: 'git show HEAD:src/app.ts' } }]),
            assistant(SONNET, [{ name: 'Grep', input: { pattern: 'healthz' } }]),
            assistant(SONNET, [{ name: 'WebFetch', input: { url: 'https://svc/healthz' } }]),
        );
        const v = evaluate(text);
        expect(v.calls.map((c) => c.tool)).toEqual(['Bash', 'Grep', 'WebFetch', 'Read']);
        expect(v.calls[0].summary).toBe('git show HEAD:src/app.ts');
        expect(v.calls[3].summary).toBe('/repo/src/next.ts');
    });
});
