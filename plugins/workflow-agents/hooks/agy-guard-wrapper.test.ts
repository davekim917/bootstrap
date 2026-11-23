import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = join(import.meta.dir, 'agy-guard.sh');
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
    const root = mkdtempSync(join(tmpdir(), 'agy-guard-wrapper-'));
    roots.push(root);
    const source = readFileSync(WRAPPER, 'utf8');
    const shortened = source.replace(/^WATCHDOG_SECONDS=\d+$/m, `WATCHDOG_SECONDS=${seconds}`);
    expect(shortened).not.toBe(source);
    writeFileSync(join(root, 'agy-guard.sh'), shortened);
    writeFileSync(join(root, 'agy-guard.ts'), guard);
    return join(root, 'agy-guard.sh');
}

function denyReason(stdout: string): string {
    const reply = JSON.parse(stdout);
    expect(reply.decision).toBe('deny');
    return reply.reason;
}

describe('a guard that does not finish with a decision is a deny, since agy runs the tool on empty output', () => {
    test.each([
        ['exits 0 with no output', 'process.exit(0);', /exit 0/],
        ['exits non-zero', 'process.exit(1);', /exit 1/],
        ['throws before printing', "throw new Error('boom');", /exit 1/],
        ['prints something that is not a decision', "process.stdout.write('{\"continue\":true}');", /exit 0/],
    ])('%s', async (_name, guard, status) => {
        const result = await run(withStandIn(guard), '{}');
        expect(result.status).toBe(0);
        expect(denyReason(result.stdout)).toMatch(status);
    });

    test('runs past the watchdog', async () => {
        const result = await run(withStandIn('await Bun.sleep(60_000);', 2), '{}');
        expect(result.status).toBe(0);
        expect(denyReason(result.stdout)).toMatch(/exit 137/);
        expect(result.ms).toBeLessThan(10_000);
    });
});

describe("the guard's own decision passes through", () => {
    test('with the hook input on its stdin', async () => {
        const echo = "const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ decision: 'allow', input }));";
        const result = await run(withStandIn(echo), '{"toolCall":{"name":"read_file"}}');
        expect(JSON.parse(result.stdout)).toEqual({ decision: 'allow', input: '{"toolCall":{"name":"read_file"}}' });
    });

    test('the shipped guard denies a destructive command itself, not through the wrapper', async () => {
        const input = JSON.stringify({ hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'snow sql -q "DROP TABLE example_db.core.orders"' } } });
        const reason = denyReason((await run(WRAPPER, input)).stdout);
        expect(reason).toMatch(/Destructive Snowflake SQL/);
        expect(reason).not.toMatch(/did not finish/);
    });
});
