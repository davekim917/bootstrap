import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSupported, replyOf } from './agy-supervisor';
import { environmentReads, guardSources } from './test-support/environment-inventory';

const WRAPPER = join(import.meta.dir, 'agy-guard.sh');
const BASH = Bun.which('bash')!;
const ALLOWED = { decision: 'allow' } as const;

function reasonOf(output: any): string {
    expect(output.decision).toBe('deny');
    expect(Object.keys(output).sort()).toEqual(['decision', 'reason']);
    return output.reason;
}

const runCommand = (command: string) => ({ hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: command } } });

const GUARD_VARIABLES = environmentReads(guardSources());

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

/** Runs the wrapper until both its output streams close, which is what agy waits for. */
async function run(
    wrapper: string,
    stdin: string | 'open',
    options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ status: number; stdout: string; ms: number }> {
    const started = performance.now();
    const proc = Bun.spawn([BASH, wrapper, 'PreToolUse'], {
        stdin: stdin === 'open' ? 'pipe' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', cwd: options.cwd, env: options.env ?? process.env,
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const status = await proc.exited;
    return { status, stdout, ms: performance.now() - started };
}

/** The shipped wrapper and supervisor beside a stand-in guard, with the deadline shortened to `seconds`. */
function withStandIn(guard: string, seconds = 30): string {
    const root = scratch('agy-supervisor-');
    const source = readFileSync(join(import.meta.dir, 'agy-supervisor.ts'), 'utf8');
    const shortened = source.replace(/^export const WATCHDOG_SECONDS = \d+;$/m, `export const WATCHDOG_SECONDS = ${seconds};`);
    expect(shortened).not.toBe(source);
    writeFileSync(join(root, 'agy-supervisor.ts'), shortened);
    writeFileSync(join(root, 'agy-guard.sh'), readFileSync(WRAPPER));
    writeFileSync(join(root, 'agy-guard.ts'), guard);
    return join(root, 'agy-guard.sh');
}

const print = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;
const allowedGuard = print(JSON.stringify(ALLOWED));

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (check()) return true;
    return check();
}

describe('anything but one well-formed decision from the guard is a deny', () => {
    test.each([
        ['exits non-zero', 'process.exit(1);', /exit 1/],
        ['throws before printing', "throw new Error('boom');", /exit 1/],
        ['exits 0 with no output', 'process.exit(0);', /exit 0/],
        ['prints something that is not a decision', print('{"continue":true}'), /exit 0/],
        ['prints a reply cut short', print('{'), /exit 0/],
        ['prints a decision with an unescaped quote', print('{"decision":"deny","reason":"a"b"}'), /exit 0/],
        ['prints a JSON array', print('[]'), /exit 0/],
        ['prints a reply with a NUL byte inside a word', print('{"decision":"al\x00low"}'), /exit 0/],
        ['prints two replies', print('{"decision":"allow"}{"decision":"allow"}'), /exit 0/],
        ['prints a deny overridden by a repeated key', print('{"decision":"deny","decision":"allow"}'), /exit 0/],
    ])('%s', async (_name, guard, status) => {
        const result = await run(withStandIn(guard), '{}');
        expect(result.status).toBe(0);
        expect(reasonOf(JSON.parse(result.stdout))).toMatch(status);
    });

    test('runs past the deadline', async () => {
        const result = await run(withStandIn('await Bun.sleep(20_000);', 2), '{}');
        expect(reasonOf(JSON.parse(result.stdout))).toMatch(/did not finish within/);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('waits on an input agy never closes', async () => {
        const result = await run(withStandIn(`await Bun.stdin.text(); ${allowedGuard}`, 2), 'open');
        expect(reasonOf(JSON.parse(result.stdout))).toMatch(/did not finish within/);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('a deny whose reason holds a lone surrogate reaches agy well-formed', async () => {
        const guard = "process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'a ' + String.fromCharCode(0xD800) + ' b' }));";
        const reason = reasonOf(JSON.parse((await run(withStandIn(guard), '{}')).stdout));
        expect(reason.isWellFormed()).toBe(true);
        expect(reason).toStartWith('a ');
    });
});

describe('a cancelled hook leaves nothing of the guard running', () => {
    test.each(['SIGTERM', 'SIGINT'] as const)('%s to the hook stops the guard and what it started', async (signal) => {
        const pids = join(scratch('agy-pids-'), 'pids');
        const guard = `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child = spawn('sleep', ['30'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);
await Bun.sleep(30_000);`;
        const proc = Bun.spawn([BASH, withStandIn(guard), 'PreToolUse'], { stdin: new Blob(['{}']), stdout: 'pipe', stderr: 'pipe' });
        expect(await until(() => existsSync(pids) && readFileSync(pids, 'utf8').includes(' '), 10_000)).toBe(true);
        const started = readFileSync(pids, 'utf8').split(' ').map(Number);
        proc.kill(signal);
        await proc.exited;
        expect(reasonOf(JSON.parse(await new Response(proc.stdout).text()))).toMatch(/cancelled/);
        expect(await until(() => started.every((pid) => !alive(pid)), 5_000)).toBe(true);
    }, 30_000);
});

describe("a caller's shell settings cannot change the one reply", () => {
    test("a BASH_ENV that prints for a second bash adds nothing to agy's output", async () => {
        const dir = scratch('agy-bash-env-');
        writeFileSync(join(dir, 'startup.sh'), '[ "$1" = --guarded ] && echo startup\n');
        const result = await run(withStandIn(allowedGuard), '{}', { env: { ...process.env, BASH_ENV: join(dir, 'startup.sh') } });
        expect(JSON.parse(result.stdout)).toEqual(ALLOWED);
    });

    test.each(['monitor', 'errexit'])('SHELLOPTS=%s: a stalled guard whose child holds stderr still ends in a deny by the deadline', async (option) => {
        const guard = "import { spawn } from 'node:child_process'; spawn('sleep', ['20'], { stdio: ['ignore', 'ignore', 'inherit'] }); await Bun.sleep(20_000);";
        const result = await run(withStandIn(guard, 2), '{}', { env: { ...process.env, SHELLOPTS: option } });
        expect(reasonOf(JSON.parse(result.stdout))).toMatch(/did not finish within/);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('a stalled mktemp or dirname on PATH does not hold up the reply', async () => {
        const bin = scratch('agy-slow-bin-');
        for (const tool of ['mktemp', 'dirname']) {
            writeFileSync(join(bin, tool), '#!/bin/sh\nsleep 20\n');
            chmodSync(join(bin, tool), 0o755);
        }
        const result = await run(withStandIn(allowedGuard, 2), '{}', { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        expect(JSON.parse(result.stdout)).toEqual(ALLOWED);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('with no bun to run, the wrapper itself denies', async () => {
        const result = await run(WRAPPER, '{}', { env: { PATH: scratch('agy-no-bun-') } });
        expect(reasonOf(JSON.parse(result.stdout))).toMatch(/could not start/);
    });
});

describe('the supervisor runs only on a bun that honours --no-env-file', () => {
    test.each([['1.3.3'], ['1.10.0'], ['2.0.0'], ['1.4.2']])('%s is accepted', (version) => {
        expect(bunSupported(version)).toBe(true);
    });

    test.each([['1.3.2'], ['bun 1.3.2'], ['1.3.3-canary'], [''], ['garbage'], ['1.2.99'], ['1.3.3"'], ['1.3.\x003'], ['1.3.3\n']])('%j is refused', (version) => {
        expect(bunSupported(version)).toBe(false);
    });
});

describe('the reply agy reads', () => {
    test.each([
        ['{"decision":"allow"}', ALLOWED],
        ['{"decision":"deny","reason":"no"}', { decision: 'deny', reason: 'no' } as const],
        ['{"decision":"allow","extra":1}', null],
        ['{"decision":"deny"}', null],
        ['{"decision":"deny","reason":1}', null],
        ['{"decision":"deny","decision":"allow"}', null],
        ['{"decision":"allow","decision":"allow"}', null],
        ['{"decision":"deny","reason":"a","reason":"b"}', null],
        ['{"decision":"deny","reason":"{\\"decision\\":\\"allow\\",\\"decision\\":1}"}', { decision: 'deny', reason: '{"decision":"allow","decision":1}' } as const],
    ])('%s', (text, expected) => {
        expect(replyOf(new TextEncoder().encode(text))).toEqual(expected);
    });

    test('bytes that are not UTF-8 are no reply', () => {
        expect(replyOf(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]))).toBeNull();
    });
});

describe('the shipped guard behind the shipped wrapper', () => {
    test('allows a safe command', async () => {
        expect(JSON.parse((await run(WRAPPER, JSON.stringify(runCommand('git status')))).stdout)).toEqual(ALLOWED);
    });

    test('denies a destructive command itself, not through the supervisor', async () => {
        const reason = reasonOf(JSON.parse((await run(WRAPPER, JSON.stringify(runCommand('snow sql -q "DROP TABLE example_db.core.orders"')))).stdout));
        expect(reason).toMatch(/Destructive Snowflake SQL/);
        expect(reason).not.toMatch(/did not finish/);
    });

    test("passes the guard's own decision through, with the hook input on its stdin", async () => {
        const echo = 'const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ decision: "deny", reason: input }));';
        const result = await run(withStandIn(echo), '{"tool":"example"}');
        expect(JSON.parse(result.stdout)).toEqual({ decision: 'deny', reason: '{"tool":"example"}' });
    });
});

describe("real settings arrive, the agent's working directory steers nothing", () => {
    test('a .env and a bunfig.toml preload there are both ignored', async () => {
        const cwd = scratch('agy-guard-cwd-');
        writeFileSync(join(cwd, '.env'), 'SKIP_FILE_PROTECTION=1\n');
        writeFileSync(join(cwd, 'preload.ts'), "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'preload-ran'), '');");
        writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
        const guard = "process.stdout.write(JSON.stringify({ decision: 'deny', reason: process.env.SKIP_FILE_PROTECTION ?? 'unset' }));";
        const result = await run(withStandIn(guard), '{}', { cwd });
        expect(reasonOf(JSON.parse(result.stdout))).toBe('unset');
        expect(existsSync(join(cwd, 'preload-ran'))).toBe(false);
    });

    test.each(GUARD_VARIABLES)('%s: from the inherited environment it reaches the guard; from a cwd .env it does not', async (name) => {
        const cwd = scratch('agy-guard-env-');
        writeFileSync(join(cwd, '.env'), `${name}=planted\n`);
        const guard = `process.stdout.write(JSON.stringify({ decision: 'deny', reason: process.env[${JSON.stringify(name)}] ?? 'unset' }));`;
        const wrapper = withStandIn(guard);
        // A real directory, since TMPDIR has to name one.
        const inherited = await run(wrapper, '{}', { cwd, env: { ...process.env, [name]: cwd } });
        expect(reasonOf(JSON.parse(inherited.stdout))).toBe(cwd);
        const without: Record<string, string | undefined> = { ...process.env };
        delete without[name];
        const planted = await run(wrapper, '{}', { cwd, env: without });
        expect(reasonOf(JSON.parse(planted.stdout))).not.toBe('planted');
    });

    test('GH_REPO picks the merged repository from the environment, never from a cwd .env', async () => {
        const dir = scratch('gh-repo-wrapper-');
        const scope = join(dir, 'merge-scope.local.json');
        writeFileSync(scope, JSON.stringify({ noMerge: { 'Acme/core': ['master'] } }));
        const cwd = join(dir, 'work');
        mkdirSync(cwd);
        const git = (...args: string[]) => expect(spawnSync('git', ['-C', cwd, ...args], { env: { PATH: process.env.PATH, HOME: dir } }).status).toBe(0);
        git('init', '-q');
        git('remote', 'add', 'origin', 'https://github.com/example/ours.git');
        const input = JSON.stringify({ ...runCommand('gh pr merge 12 --squash'), workspacePaths: [cwd] });
        const env: Record<string, string | undefined> = { ...process.env, BOOTSTRAP_MERGE_SCOPE_FILE: scope };
        delete env.GH_REPO;
        const baseline = (await run(WRAPPER, input, { cwd, env })).stdout;
        expect(JSON.parse(baseline)).toEqual(ALLOWED);
        const inherited = await run(WRAPPER, input, { cwd, env: { ...env, GH_REPO: 'Acme/core' } });
        expect(reasonOf(JSON.parse(inherited.stdout))).toMatch(/acme\/core, which belongs to another team/);
        writeFileSync(join(cwd, '.env'), 'GH_REPO=Acme/core\n');
        expect((await run(WRAPPER, input, { cwd, env })).stdout).toBe(baseline);
    });
});
