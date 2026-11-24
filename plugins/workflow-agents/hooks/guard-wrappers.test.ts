import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Reads of the environment whose name is not written at the read itself, keyed by the exact expression, each with the
 * names it can read, found in the sources. A read that is neither a literal name nor one of these fails the scan, so
 * a new read has to be placed here before the wrapper tests below cover it.
 */
const INDIRECT_READS: Record<string, (sources: Map<string, string>) => string[]> = {
    // deploymentFilePath(FILE, FILE_ENV): each constant passed as its second argument.
    'process.env[envVar]': (sources) => callArguments(sources, /deploymentFilePath\(\s*\w+\s*,\s*(\w+)\s*\)/g, true),
    // assignedValue('NAME', …), and a literal list mapped through it.
    'process.env[name]': (sources) => {
        const named = callArguments(sources, /assignedValue\(\s*'(\w+)'/g, false);
        const listed = [...joined(sources).matchAll(/\[([^\]]*)\]\.some\(\s*name\s*=>\s*assignedValue\(name\b/g)]
            .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((n) => n[1]));
        const calls = [...joined(sources).matchAll(/(?<!function )\bassignedValue\(/g)].length;
        if (calls !== named.length + [...joined(sources).matchAll(/(?<!function )\bassignedValue\(name\b/g)].length) {
            throw new Error('assignedValue is called with a name that is not a literal');
        }
        return [...named, ...listed];
    },
    // The local Postgres probe's host.env, read only for the names in LIBPQ_REDIRECT_ENV.
    'env: process.env,': libpqRedirects,
    'LIBPQ_REDIRECT_ENV.some(k => LIVE_LOCAL_PG_HOST.env[k]': libpqRedirects,
    'LIBPQ_REDIRECT_ENV.some(k => host.env[k]': libpqRedirects,
    // Any SNOWFLAKE_ name, in any case.
    "Object.keys(process.env).some(k => k.toUpperCase().startsWith('SNOWFLAKE_'))": () => ['SNOWFLAKE_ACCOUNT', 'snowflake_account'],
    // Any name at all: whether a variable a command assigns is already set. One stands for every name.
    '!(name in process.env)': () => ['EXAMPLE_ASSIGNED_NAME'],
    // The whole environment, handed to the gws child. One stands for every name.
    '{ ...process.env, GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE': () => ['HTTPS_PROXY'],
};

function joined(sources: Map<string, string>): string {
    return [...sources.values()].join('\n');
}

function libpqRedirects(sources: Map<string, string>): string[] {
    const list = /const LIBPQ_REDIRECT_ENV = \[([^\]]*)\]/.exec(joined(sources))?.[1];
    if (list === undefined) throw new Error('LIBPQ_REDIRECT_ENV is not a literal list');
    return [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

/** The literal (or, with `resolve`, the string constant) each call passes. */
function callArguments(sources: Map<string, string>, call: RegExp, resolve: boolean): string[] {
    const text = joined(sources);
    return [...text.matchAll(call)].map((m) => {
        if (!resolve) return m[1];
        const value = new RegExp(`const ${m[1]}\\s*=\\s*'(\\w+)'`).exec(text)?.[1];
        if (!value) throw new Error(`${m[1]} is not a string constant`);
        return value;
    });
}

/** Every variable name the sources read from the environment, or an error naming a read the scan cannot place. */
function environmentReads(sources: Map<string, string>): string[] {
    const names = new Set<string>();
    const read = /\b(?:process\.env|Bun\.env|import\.meta\.env)\b|\bprocess\[\s*['"]env['"]\s*\]|\.env\[|\.env\.(?=[A-Z])|\b(homedir|tmpdir)\(\)/g;
    for (const [path, text] of sources) {
        text.split('\n').forEach((line, index) => {
            if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
            for (const match of line.matchAll(read)) {
                // os.homedir() reads HOME; os.tmpdir() reads TMPDIR, then TMP, then TEMP.
                if (match[1] === 'homedir') { names.add('HOME'); continue; }
                if (match[1] === 'tmpdir') { ['TMPDIR', 'TMP', 'TEMP'].forEach((n) => names.add(n)); continue; }
                const after = line.slice(match.index! + match[0].length);
                const before = line.slice(0, match.index!);
                const literal = match[0].endsWith('.') ? /^([A-Za-z_]\w*)/.exec(after)
                    : match[0].endsWith('[') ? /^\s*(['"])(\w+)\1\s*\]/.exec(after)?.slice(1)
                    : (/^\.([A-Za-z_]\w*)/.exec(after) ?? /^\[\s*(['"])(\w+)\1\s*\]/.exec(after)?.slice(1));
                if (literal) { names.add(literal.at(-1)!); continue; }
                const destructured = /\{([^{}]*)\}\s*=\s*$/.exec(before);
                if (destructured && !match[0].startsWith('.')) {
                    for (const part of destructured[1].split(',')) {
                        if (!part.trim()) continue;
                        // NAME, NAME: alias or NAME = default; a computed key or a rest element reads names not written here.
                        const name = /^\s*([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?(?:=.*)?$/.exec(part)?.[1];
                        if (!name) throw new Error(`${path}:${index + 1} destructures the environment in a way the scan cannot place: ${line.trim()}`);
                        names.add(name);
                    }
                    continue;
                }
                const indirect = Object.keys(INDIRECT_READS).find((expression) => line.includes(expression));
                if (!indirect) throw new Error(`${path}:${index + 1} reads the environment in a way the scan cannot place: ${line.trim()}`);
                for (const name of INDIRECT_READS[indirect](sources)) names.add(name);
            }
        });
    }
    return [...names].sort();
}

/** Every module the wrappers load: the adapters, the reply check, the policy and the vendored cores. */
function guardSources(): Map<string, string> {
    const sources = new Map<string, string>();
    for (const dir of [import.meta.dir, join(import.meta.dir, 'guards')]) {
        for (const name of readdirSync(dir).sort()) {
            if (name.endsWith('.ts') && !name.endsWith('.test.ts')) sources.set(join(dir, name), readFileSync(join(dir, name), 'utf8'));
        }
    }
    return sources;
}

const GUARD_VARIABLES = environmentReads(guardSources());

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
function withStandIn(rt: Runtime, guard: string, seconds = 30, checker?: string): string {
    const root = scratch(`${rt.runtime}-guard-wrapper-`);
    const source = readFileSync(rt.wrapper, 'utf8');
    const shortened = source.replace(/^WATCHDOG_SECONDS=\d+$/m, `WATCHDOG_SECONDS=${seconds}`);
    expect(shortened).not.toBe(source);
    writeFileSync(join(root, rt.wrapper.split('/').pop()!), shortened);
    writeFileSync(join(root, rt.guardFile), guard);
    writeFileSync(join(root, 'guard-reply.ts'), checker ?? readFileSync(join(import.meta.dir, 'guard-reply.ts')));
    return join(root, rt.wrapper.split('/').pop()!);
}

/** timeout's status after it sends KILL differs by coreutils build: 137 with 9.4 on the host, 124 on the CI runner. */
const WATCHDOG_DENY = /did not finish.*\(exit (?:124|137)\)/;

const print = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;

/** An environment whose bun reports `version` (after `stall` seconds) and otherwise runs the real bun. */
function fakeBun(version: string, stall = 0): Record<string, string | undefined> {
    const bin = scratch('fake-bun-');
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = --version ]; then sleep ${stall}; printf '%s\\n' "$FAKE_BUN_VERSION"; exit 0; fi\nexec "$REAL_BUN" "$@"\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_BUN: process.execPath, FAKE_BUN_VERSION: version };
}

describe.each(RUNTIMES)('$runtime wrapper: anything but a well-formed decision is a deny', (rt) => {
    test.each([
        ['exits non-zero', 'process.exit(1);', /exit 1/],
        ['throws before printing', "throw new Error('boom');", /exit 1/],
        ['exits 0 with no output', 'process.exit(0);', /exit 0/],
        ['prints something that is not a decision', print(rt.notADecision), /exit 0/],
        ['prints a reply cut short', print('{'), /exit 0/],
        ['prints a decision with an unescaped quote', print('{"decision":"deny","reason":"a"b"}'), /exit 0/],
        ['prints a JSON array', print('[]'), /exit 0/],
        ['prints a reply with a NUL byte inside a word', print(rt.runtime === 'codex' ? '{"continue":tr\x00ue}' : '{"decision":"al\x00low"}'), /exit 0/],
    ])('%s', async (_name, guard, status) => {
        const result = await run(withStandIn(rt, guard), '{}');
        expect(result.status).toBe(0);
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(status);
    });

    test('runs past the watchdog', async () => {
        const result = await run(withStandIn(rt, 'await Bun.sleep(60_000);', 2), '{}');
        expect(result.status).toBe(0);
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(WATCHDOG_DENY);
        expect(result.ms).toBeLessThan(10_000);
    });

    test('runs on a bun too old to ignore the .env', async () => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed))), '{}', { env: fakeBun('1.3.2') });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(/older than 1\.3\.3/);
    });

    test.each(['bun 1.3.2', '1.3.3-canary', '', 'garbage', '1.2.99', '1.3.3"'])('runs on a bun reporting %j', async (version) => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed))), '{}', { env: fakeBun(version) });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(/older than 1\.3\.3 or reports a version this guard cannot read/);
    });

    test.each(['1.3.3', '1.10.0', '2.0.0'])('runs the guard on a bun reporting %s', async (version) => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed))), '{}', { env: fakeBun(version) });
        expect(JSON.parse(result.stdout)).toEqual(rt.allowed);
    });

    // Each stall outlasts the 2-second watchdog by far; the deny must arrive on the watchdog's clock.
    test('stalls in the reply check', async () => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed)), 2, 'await Bun.sleep(20_000);'), '{}');
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(WATCHDOG_DENY);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('stalls in the bun version probe', async () => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed)), 2), '{}', { env: fakeBun('1.4.2', 20) });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(WATCHDOG_DENY);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('stalls in the bun version probe with errexit switched on through SHELLOPTS', async () => {
        const result = await run(withStandIn(rt, print(JSON.stringify(rt.allowed)), 2), '{}', { env: { ...fakeBun('1.4.2', 20), SHELLOPTS: 'errexit' } });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(WATCHDOG_DENY);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);

    test('runs past the watchdog with SECONDS set in its environment', async () => {
        const result = await run(withStandIn(rt, 'await Bun.sleep(20_000);', 2), '{}', { env: { ...process.env, SECONDS: '-100' } });
        expect(rt.reasonOf(JSON.parse(result.stdout))).toMatch(WATCHDOG_DENY);
        expect(result.ms).toBeLessThan(10_000);
    }, 30_000);
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

describe('codex wrapper end to end: GH_REPO picks the merged repository from the environment, never from a cwd .env', () => {
    test('inherited, it refuses a merge the checkout alone would allow; planted in the .env, it changes nothing', async () => {
        const rt = RUNTIMES[0];
        const dir = scratch('gh-repo-wrapper-');
        const scope = join(dir, 'merge-scope.local.json');
        writeFileSync(scope, JSON.stringify({ noMerge: { 'Acme/core': ['master'] } }));
        const cwd = join(dir, 'work');
        mkdirSync(cwd);
        const git = (...args: string[]) => expect(spawnSync('git', ['-C', cwd, ...args], { env: { PATH: process.env.PATH, HOME: dir } }).status).toBe(0);
        git('init', '-q');
        git('remote', 'add', 'origin', 'https://github.com/example/ours.git');
        const input = JSON.stringify(rt.payload('gh pr merge 12 --squash'));
        const env: Record<string, string | undefined> = { ...process.env, BOOTSTRAP_MERGE_SCOPE_FILE: scope };
        delete env.GH_REPO;
        const baseline = (await run(rt.wrapper, input, { cwd, env })).stdout;
        expect(JSON.parse(baseline)).toEqual(rt.allowed);
        const inherited = await run(rt.wrapper, input, { cwd, env: { ...env, GH_REPO: 'Acme/core' } });
        expect(rt.reasonOf(JSON.parse(inherited.stdout))).toMatch(/acme\/core, which belongs to another team/);
        writeFileSync(join(cwd, '.env'), 'GH_REPO=Acme/core\n');
        expect((await run(rt.wrapper, input, { cwd, env })).stdout).toBe(baseline);
    });
});
