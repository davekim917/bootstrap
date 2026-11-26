import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentReads, guardSources } from './test-support/environment-inventory';

const WRAPPER = join(import.meta.dir, 'codex-guard.sh');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RunOptions = { cwd?: string; env?: Record<string, string | undefined> };

async function run(wrapper: string, stdin: string, options: RunOptions = {}): Promise<{ status: number; stdout: string; ms: number }> {
    const started = performance.now();
    const proc = Bun.spawn(['bash', wrapper, 'PreToolUse'], {
        stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', cwd: options.cwd, env: options.env ?? process.env,
    });
    const status = await proc.exited;
    return { status, stdout: await new Response(proc.stdout).text(), ms: performance.now() - started };
}

function scratch(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

/** The shipped wrapper beside a stand-in guard, with its watchdog shortened to `seconds`. */
function withStandIn(guard: string, seconds = 30): string {
    const root = scratch('codex-guard-wrapper-');
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

const GUARD_VARIABLES = environmentReads(guardSources());

/** The environment without `names`, so a row sees only the value it sets. */
function without(...names: string[]): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of names) delete env[name];
    return env;
}

describe('the environment inventory is read from the sources', () => {
    test('it holds the names a merge, a push, a Postgres probe and file protection read', () => {
        for (const name of ['GH_REPO', 'REPO', 'GIT_DIR', 'GIT_WORK_TREE', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'SKIP_FILE_PROTECTION', 'BOOTSTRAP_MERGE_SCOPE_FILE', 'SNOWFLAKE_ACCOUNT']) {
            expect(GUARD_VARIABLES).toContain(name);
        }
    });

    test('literal, bracket and destructured reads are collected; a computed one fails the scan', () => {
        const source = (text: string) => new Map([['example.ts', text]]);
        expect(environmentReads(source("const a = process.env.ALPHA; const b = Bun.env['BETA'];\nconst { GAMMA, DELTA: d } = process.env;")))
            .toEqual(['ALPHA', 'BETA', 'DELTA', 'GAMMA']);
        expect(() => environmentReads(source('const key = pick(); const v = process.env[key];'))).toThrow(/example\.ts:1 reads the environment/);
        expect(() => environmentReads(source('const all = { ...process.env };'))).toThrow(/cannot place/);
        expect(environmentReads(source("const flag = process['env'].EPSILON;"))).toEqual(['EPSILON']);
        expect(() => environmentReads(source('const { [pick()]: value } = process.env;'))).toThrow(/cannot place/);
        expect(() => environmentReads(source('const { ZETA, ...rest } = process.env;'))).toThrow(/cannot place/);
    });
});

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


describe("the agent's working directory cannot configure the guard", () => {
    const patchEnv = JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: .env\n@@\n-A=1\n+A=2\n*** End Patch' },
    });

    test('a cwd .env with SKIP_FILE_PROTECTION=1 does not relax a protected-file edit', async () => {
        const cwd = scratch('codex-guard-cwd-');
        writeFileSync(join(cwd, '.env'), 'SKIP_FILE_PROTECTION=1\n');
        expect(denyReason((await run(WRAPPER, patchEnv, { cwd, env: without('SKIP_FILE_PROTECTION') })).stdout)).toMatch(/\.env/);
        expect(JSON.parse((await run(WRAPPER, patchEnv, { cwd, env: { ...without(), SKIP_FILE_PROTECTION: '1' } })).stdout)).toEqual({ continue: true });
    });

    test('a cwd bunfig.toml preload does not run', async () => {
        const cwd = scratch('codex-guard-cwd-');
        const marker = join(cwd, 'preloaded');
        writeFileSync(join(cwd, 'preload.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
        writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
        const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command: 'git status' } });
        expect(JSON.parse((await run(WRAPPER, input, { cwd })).stdout)).toEqual({ continue: true });
        expect(existsSync(marker)).toBe(false);
    });

    test.each(GUARD_VARIABLES)('%s: from the inherited environment it reaches the guard; from a cwd .env it does not', async (name) => {
        const cwd = scratch('codex-guard-cwd-');
        writeFileSync(join(cwd, '.env'), `${name}=planted\n`);
        const guard = `process.stdout.write(JSON.stringify({ value: process.env[${JSON.stringify(name)}] ?? 'unset' }));`;
        const wrapper = withStandIn(guard);
        expect(JSON.parse((await run(wrapper, '{}', { cwd, env: { ...without(name), [name]: cwd } })).stdout)).toEqual({ value: cwd });
        expect(JSON.parse((await run(wrapper, '{}', { cwd, env: without(name) })).stdout)).toEqual({ value: 'unset' });
    });

    test('the shipped guard loads its own dependencies from a cwd with no package.json', async () => {
        const cwd = scratch('codex-guard-cwd-');
        expect(readdirSync(cwd)).toEqual([]);
        const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command: 'git status' } });
        expect(JSON.parse((await run(WRAPPER, input, { cwd })).stdout)).toEqual({ continue: true });
    });
});

describe('a bun that cannot honour --no-env-file is refused', () => {
    const REAL_BUN = Bun.which('bun')!;

    /** The PATH a bun reporting `version` to --version comes first on; every other call runs the real bun. */
    function bunReporting(version: string, exitCode = 0, path = process.env.PATH): Record<string, string | undefined> {
        const bin = scratch('codex-guard-bun-');
        writeFileSync(join(bin, 'version'), version);
        writeFileSync(join(bin, 'bun'), `#!${Bun.which('bash')}\nif [ "$1" = --version ]; then ${Bun.which('cat')} ${JSON.stringify(join(bin, 'version'))}; exit ${exitCode}; fi\nexec ${JSON.stringify(REAL_BUN)} "$@"\n`);
        chmodSync(join(bin, 'bun'), 0o755);
        return { ...process.env, PATH: `${bin}:${path}` };
    }

    /** A PATH holding only what the wrapper itself runs, so a tool it does not need is missing. */
    function minimalPath(): string {
        const bin = scratch('codex-guard-path-');
        for (const tool of ['bash', 'dirname', 'mktemp', 'rm', 'sleep']) symlinkSync(Bun.which(tool)!, join(bin, tool));
        return bin;
    }

    const allowed = "process.stdout.write(JSON.stringify({ continue: true }));";

    test.each([
        ['1.3.2\n'], ['1.2.99\n'], ['0.9.9\n'], ['bun 1.3.2\n'], ['1.3.3-canary.1\n'], ['1.3.3"\n'], ['\n'], ['garbage\n'],
        ['1.3\x003\n'], ['1.3.3\n1.3.3\n'], ['v1.4.2\n'], ['1.4\n'],
    ])('%j is denied before the guard runs', async (version) => {
        const result = await run(withStandIn(allowed), '{}', { env: bunReporting(version) });
        expect(result.status).toBe(0);
        expect(denyReason(result.stdout)).toMatch(/needs Bun 1\.3\.3 or newer/);
    });

    test('a probe that prints a valid version and exits non-zero is denied', async () => {
        const result = await run(withStandIn(allowed), '{}', { env: bunReporting('1.4.2\n', 7) });
        expect(denyReason(result.stdout)).toMatch(/needs Bun 1\.3\.3 or newer/);
    });

    test('with SHELLOPTS=errexit:pipefail inherited, a failed probe still prints the deny and a good one runs the guard', async () => {
        const failed = await run(withStandIn(allowed), '{}', { env: { ...bunReporting('1.4.2\n', 7), SHELLOPTS: 'errexit:pipefail' } });
        expect(failed.status).toBe(0);
        expect(denyReason(failed.stdout)).toMatch(/needs Bun 1\.3\.3 or newer/);
        const good = await run(withStandIn(allowed), '{}', { env: { ...bunReporting('1.4.2\n'), SHELLOPTS: 'errexit:pipefail' } });
        expect(JSON.parse(good.stdout)).toEqual({ continue: true });
    });

    test('a PATH with only the tools the wrapper runs, no tr or cat, still forwards the guard decision', async () => {
        const env = bunReporting('1.4.2\n', 0, minimalPath());
        expect(JSON.parse((await run(withStandIn(allowed), '{}', { env })).stdout)).toEqual({ continue: true });
    });

    test.each([['1.3.3\n'], ['1.3.10\n'], ['1.10.0\n'], ['2.0.0\n'], ['1.4.2']])('%j runs the guard', async (version) => {
        expect(JSON.parse((await run(withStandIn(allowed), '{}', { env: bunReporting(version) })).stdout)).toEqual({ continue: true });
    });
});
