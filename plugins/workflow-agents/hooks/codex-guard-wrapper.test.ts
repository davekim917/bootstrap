import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = join(import.meta.dir, 'codex-guard.sh');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(wrapper: string, stdin: string): Promise<{ status: number; stdout: string; ms: number }> {
    const started = performance.now();
    const proc = Bun.spawn(['bash', wrapper, 'PreToolUse'], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
    const status = await proc.exited;
    return { status, stdout: await new Response(proc.stdout).text(), ms: performance.now() - started };
}

/** The shipped wrapper beside a stand-in guard, with its watchdog shortened to `seconds`. */
function withStandIn(guard: string, seconds = 30): string {
    const root = mkdtempSync(join(tmpdir(), 'codex-guard-wrapper-'));
    roots.push(root);
    const source = readFileSync(WRAPPER, 'utf8');
    const shortened = source.replace(/^WATCHDOG_SECONDS=\d+$/m, `WATCHDOG_SECONDS=${seconds}`);
    expect(shortened).not.toBe(source);
    writeFileSync(join(root, 'codex-guard.sh'), shortened);
    writeFileSync(join(root, 'codex-guard.ts'), guard);
    return join(root, 'codex-guard.sh');
}

function denyReason(stdout: string): string {
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    return output.hookSpecificOutput.permissionDecisionReason;
}

describe('a guard that does not finish with a decision is a deny', () => {
    test.each([
        ['exits non-zero', 'process.exit(1);', /exit 1/],
        ['throws before printing', "throw new Error('boom');", /exit 1/],
        ['exits 0 with no output', 'process.exit(0);', /exit 0/],
    ])('%s', async (_name, guard, status) => {
        const result = await run(withStandIn(guard), '{}');
        expect(result.status).toBe(0);
        expect(denyReason(result.stdout)).toMatch(status);
    });

    test('runs past the watchdog', async () => {
        const result = await run(withStandIn('await Bun.sleep(60_000);', 2), '{}');
        expect(result.status).toBe(0);
        expect(denyReason(result.stdout)).toMatch(/did not finish \(exit 137\)/);
        expect(result.ms).toBeLessThan(10_000);
    });
});

describe("the guard's own decision passes through", () => {
    test('with the hook input on its stdin', async () => {
        const echo = "const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ continue: true, input }));";
        const result = await run(withStandIn(echo), '{"tool_name":"exec_command"}');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ continue: true, input: '{"tool_name":"exec_command"}' });
    });

    test.each([
        ['git status', { continue: true }],
    ])('the shipped guard: %s', async (command, expected) => {
        const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command } });
        expect(JSON.parse((await run(WRAPPER, input)).stdout)).toEqual(expected);
    });

    test('the shipped guard: a destructive command is denied by the guard, not the wrapper', async () => {
        const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command: 'snow sql -q "DROP TABLE example_db.core.orders"' } });
        const reason = denyReason((await run(WRAPPER, input)).stdout);
        expect(reason).toMatch(/Destructive Snowflake SQL/);
        expect(reason).not.toMatch(/did not finish/);
    });
});
