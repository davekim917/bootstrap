import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Reads of the environment whose name is not written at the read itself, keyed by the exact expression, each with the
 * names it can read, found in the sources. A read that is neither a literal name nor one of these fails the scan, so
 * a new read has to be placed here before the wrapper rows below cover it.
 */
const INDIRECT_READS: Record<string, (sources: Map<string, string>) => string[]> = {
    // deploymentFilePath(FILE, FILE_ENV): each constant passed as its second argument.
    'process.env[envVar]': (sources) => {
        const named = callArguments(sources, /deploymentFilePath\(\s*\w+\s*,\s*(\w+)\s*\)/g, true);
        if ([...joined(sources).matchAll(/(?<!function )\bdeploymentFilePath\(/g)].length !== named.length) {
            throw new Error('deploymentFilePath is called with a variable name that is not a constant');
        }
        return named;
    },
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
    function bunReporting(version: string): Record<string, string | undefined> {
        const bin = scratch('codex-guard-bun-');
        writeFileSync(join(bin, 'version'), version);
        writeFileSync(join(bin, 'bun'), `#!/bin/bash\nif [ "$1" = --version ]; then cat ${JSON.stringify(join(bin, 'version'))}; exit 0; fi\nexec ${JSON.stringify(REAL_BUN)} "$@"\n`);
        chmodSync(join(bin, 'bun'), 0o755);
        return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
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

    test.each([['1.3.3\n'], ['1.3.10\n'], ['1.10.0\n'], ['2.0.0\n'], ['1.4.2']])('%j runs the guard', async (version) => {
        expect(JSON.parse((await run(withStandIn(allowed), '{}', { env: bunReporting(version) })).stdout)).toEqual({ continue: true });
    });
});
