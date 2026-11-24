import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The two wrappers differ only in their guard file and the reply shape their host reads. */
const RUNTIMES = [
    {
        runtime: 'codex',
        guardFile: 'codex-guard.ts',
        wrapper: join(import.meta.dir, 'codex-guard.sh'),
        reply: (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
        reasonOf: (output: any): string => {
            expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
            expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
            return output.hookSpecificOutput.permissionDecisionReason;
        },
        allowed: { continue: true },
        payload: (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command } }),
        notADecision: '{"continue":true,"extra":1}',
    },
    {
        runtime: 'agy',
        guardFile: 'agy-guard.ts',
        wrapper: join(import.meta.dir, 'agy-guard.sh'),
        reply: (reason: string) => ({ decision: 'deny', reason }),
        reasonOf: (output: any): string => {
            expect(output.decision).toBe('deny');
            return output.reason;
        },
        allowed: { decision: 'allow' },
        payload: (command: string) => ({ hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: command } } }),
        notADecision: '{"continue":true}',
    },
] as const;
type Runtime = (typeof RUNTIMES)[number];

/** Every variable the guard code reads from its environment. */
const GUARD_VARIABLES = [
    'SKIP_FILE_PROTECTION', 'SKIP_TEAM_AUTO_ASKBLOCK', 'NANOCLAW_IS_SCHEDULED_TASK', 'NANOCLAW_WORKGROUP_ID',
    'NANOCLAW_INSTRUCTIONS_PROFILE', 'BOOTSTRAP_MERGE_SCOPE_FILE', 'BOOTSTRAP_DEV_SCOPE_FILE', 'BOOTSTRAP_LAB_SCOPE_FILE',
    'BOOTSTRAP_RESPONSE_SECRETS_FILE', 'DBT_PROJECT_DIR', 'DBT_PROFILES_DIR', 'TMPDIR', 'HOME',
];

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

async function run(
    wrapper: string,
    stdin: string,
    options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ status: number; stdout: string; ms: number }> {
    const started = performance.now();
    const proc = Bun.spawn(['bash', wrapper, 'PreToolUse'], {
        stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', cwd: options.cwd, env: options.env ?? process.env,
    });
    const status = await proc.exited;
    return { status, stdout: await new Response(proc.stdout).text(), ms: performance.now() - started };
}

/** The shipped wrapper and reply check beside a stand-in guard, with the watchdog shortened to `seconds`. */
function withStandIn(rt: Runtime, guard: string, seconds = 30): string {
    const root = scratch(`${rt.runtime}-guard-wrapper-`);
    const source = readFileSync(rt.wrapper, 'utf8');
    const shortened = source.replace(/^WATCHDOG_SECONDS=\d+$/m, `WATCHDOG_SECONDS=${seconds}`);
    expect(shortened).not.toBe(source);
    writeFileSync(join(root, rt.wrapper.split('/').pop()!), shortened);
    writeFileSync(join(root, rt.guardFile), guard);
    writeFileSync(join(root, 'guard-reply.ts'), readFileSync(join(import.meta.dir, 'guard-reply.ts')));
    return join(root, rt.wrapper.split('/').pop()!);
}

const print = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;

describe.each(RUNTIMES)('$runtime wrapper: anything but a well-formed decision is a deny', (rt) => {
    test.each([
        ['exits non-zero', 'process.exit(1);', /exit 1/],
        ['throws before printing', "throw new Error('boom');", /exit 1/],
        ['exits 0 with no output', 'process.exit(0);', /exit 0/],
        ['prints something that is not a decision', print(rt.notADecision), /exit 0/],
        ['prints a reply cut short', print('{'), /exit 0/],
        ['prints a decision with an unescaped quote', print('{"decision":"deny","reason":"a"b"}'), /exit 0/],
        ['prints a JSON array', print('[]'), /exit 0/],
    ])('%s', async (_name, guard, status) => {
        const result = await run(withStandIn(rt, guard), '{}');
        expect(result.status).toBe(0);
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(status);
    });

    test('runs past the watchdog', async () => {
        const result = await run(withStandIn(rt, 'await Bun.sleep(60_000);', 2), '{}');
        expect(result.status).toBe(0);
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(/did not finish.*\(exit 137\)/);
        expect(result.ms).toBeLessThan(10_000);
    });

    test('runs on a bun too old to ignore the .env', async () => {
        const bin = scratch('old-bun-');
        writeFileSync(join(bin, 'bun'), '#!/bin/sh\n[ "$1" = --version ] && { echo 1.3.2; exit 0; }\nexec "$REAL_BUN" "$@"\n');
        chmodSync(join(bin, 'bun'), 0o755);
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_BUN: process.execPath };
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed))), '{}', { env });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(/older than 1\.3\.3/);
    });
});

describe.each(RUNTIMES)("$runtime wrapper: the guard's own decision passes through", (rt) => {
    test('with the hook input on its stdin', async () => {
        const echo = `const input = await Bun.stdin.text(); process.stdout.write(JSON.stringify((${rt.reply.toString()})(input)));`;
        const result = await run(withStandIn(rt, echo), '{"tool":"example"}');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(rt.reply('{"tool":"example"}'));
    });

    test('the shipped guard allows a safe command', async () => {
        expect(JSON.parse((await run(rt.wrapper, JSON.stringify(rt.payload('git status')))).stdout)).toEqual(rt.allowed);
    });

    test('the shipped guard denies a destructive command itself, not through the wrapper', async () => {
        const result = await run(rt.wrapper, JSON.stringify(rt.payload('snow sql -q "DROP TABLE example_db.core.orders"')));
        const reason = rt.reasonOf(JSON.parse(result.stdout));
        expect(reason).toMatch(/Destructive Snowflake SQL/);
        expect(reason).not.toMatch(/did not finish/);
    });
});

describe.each(RUNTIMES)("$runtime wrapper: real settings arrive, the agent's working directory steers nothing", (rt) => {
    test('a .env and a bunfig.toml preload there are both ignored', async () => {
        const cwd = scratch(`${rt.runtime}-guard-cwd-`);
        writeFileSync(join(cwd, '.env'), 'SKIP_FILE_PROTECTION=1\n');
        writeFileSync(join(cwd, 'preload.ts'), "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'preload-ran'), '');");
        writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
        const guard = `process.stdout.write(JSON.stringify((${rt.reply.toString()})(process.env.SKIP_FILE_PROTECTION ?? 'unset')));`;
        const result = await run(withStandIn(rt, guard), '{}', { cwd });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toBe('unset');
        expect(existsSync(join(cwd, 'preload-ran'))).toBe(false);
    });

    test.each(GUARD_VARIABLES)('%s: from the inherited environment it reaches the guard; from a cwd .env it does not', async (name) => {
        const cwd = scratch(`${rt.runtime}-guard-env-`);
        writeFileSync(join(cwd, '.env'), `${name}=planted\n`);
        const guard = `process.stdout.write(JSON.stringify((${rt.reply.toString()})(process.env[${JSON.stringify(name)}] ?? 'unset')));`;
        const wrapper = withStandIn(rt, guard);
        // A real directory, since the wrapper itself needs TMPDIR to name one.
        const inherited = await run(wrapper, '{}', { cwd, env: { ...process.env, [name]: cwd } });
        expect(rt.reasonOf(JSON.parse(inherited.stdout))).toBe(cwd);
        const without: Record<string, string | undefined> = { ...process.env };
        delete without[name];
        const planted = await run(wrapper, '{}', { cwd, env: without });
        expect(rt.reasonOf(JSON.parse(planted.stdout))).not.toBe('planted');
    });
});

describe('codex wrapper end to end: a merge scope reaches the guard from the environment, never from a cwd .env', () => {
    test('inherited, it refuses the merge; planted in the .env, it changes nothing', async () => {
        const rt = RUNTIMES[0];
        const dir = scratch('merge-scope-wrapper-');
        const scope = join(dir, 'merge-scope.local.json');
        writeFileSync(scope, JSON.stringify({ noMerge: { 'Acme/core': ['master'] } }));
        const cwd = join(dir, 'work');
        mkdirSync(cwd);
        const input = JSON.stringify(rt.payload('gh pr merge 12 -R Acme/core --squash'));
        const env: Record<string, string | undefined> = { ...process.env };
        delete env.BOOTSTRAP_MERGE_SCOPE_FILE;
        const baseline = (await run(rt.wrapper, input, { cwd, env })).stdout;
        expect(baseline).not.toMatch(/belongs to another team/);
        const inherited = await run(rt.wrapper, input, { cwd, env: { ...env, BOOTSTRAP_MERGE_SCOPE_FILE: scope } });
        expect(rt.reasonOf(JSON.parse(inherited.stdout))).toMatch(/acme\/core, which belongs to another team/);
        writeFileSync(join(cwd, '.env'), `BOOTSTRAP_MERGE_SCOPE_FILE=${scope}\n`);
        expect((await run(rt.wrapper, input, { cwd, env })).stdout).toBe(baseline);
    });
});
