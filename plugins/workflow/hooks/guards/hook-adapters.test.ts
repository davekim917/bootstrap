import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findFreshSentinel } from './block-askuser-during-auto';

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

async function runHook(
    file: string,
    input: string,
    env: Record<string, string> = {},
): Promise<{ status: number; stderr: string }> {
    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, file)], {
        stdin: new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env },
    });
    const status = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { status, stderr };
}

describe('enforcement adapters fail closed', () => {
    test('file protection blocks malformed hook input', async () => {
        const result = await runHook('file-protection.ts', '{bad-json');
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/failed closed/i);
    });
});

describe('the Claude launcher', () => {
    test.each([
        ['guards/block-destructive.ts', { tool_name: 'Bash', tool_input: { command: 'echo EXAMPLE=1 > .env' } }],
        ['guards/file-protection.ts', { tool_name: 'Write', tool_input: { file_path: '.env', content: 'EXAMPLE=1' } }],
    ])('%s ignores SKIP_FILE_PROTECTION=1 in the project .env', async (hook, input) => {
        const project = mkdtempSync(join(tmpdir(), 'run-hook-dotenv-'));
        temporaryRoots.push(project);
        writeFileSync(join(project, '.env'), 'SKIP_FILE_PROTECTION=1\n');
        const env = { ...process.env };
        delete env.SKIP_FILE_PROTECTION;
        const proc = Bun.spawn([join(import.meta.dir, '..', 'run-hook.sh'), hook], {
            cwd: project,
            stdin: new Blob([JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, ...input })]),
            stdout: 'pipe',
            stderr: 'pipe',
            env,
        });
        expect(await proc.exited).toBe(2);
        expect(await new Response(proc.stderr).text()).toMatch(/file-protection|File protection/);
    });
});

describe('the Claude launcher bun version gate', () => {
    /** A PATH whose bun reports `version` to --version and runs the real bun for everything else. */
    function bunReporting(version: string): Record<string, string | undefined> {
        const bin = mkdtempSync(join(tmpdir(), 'run-hook-bun-'));
        temporaryRoots.push(bin);
        writeFileSync(join(bin, 'version'), version);
        writeFileSync(join(bin, 'bun'), `#!${Bun.which('bash')}\nif [ "$1" = --version ]; then cat ${JSON.stringify(join(bin, 'version'))}; exit 0; fi\nexec ${JSON.stringify(Bun.which('bun'))} "$@"\n`);
        chmodSync(join(bin, 'bun'), 0o755);
        return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    }

    async function launch(version: string): Promise<{ status: number; stderr: string }> {
        const proc = Bun.spawn([join(import.meta.dir, '..', 'run-hook.sh'), 'guards/block-destructive.ts'], {
            stdin: new Blob([JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } })]),
            stdout: 'pipe',
            stderr: 'pipe',
            env: bunReporting(version),
        });
        return { status: await proc.exited, stderr: await new Response(proc.stderr).text() };
    }

    test.each([['1.3.3\n'], ['1.4.2'], ['1.4.2-canary.1\n'], ['1.4.2+abc'], ['2.0.0-beta\n']])('%j runs the hook', async (version) => {
        expect((await launch(version)).status).toBe(0);
    });

    test.each([['1.3.2\n'], ['1.3.2-canary.1'], ['1.4'], ['canary'], ['']])('%j is refused before the hook runs', async (version) => {
        const result = await launch(version);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/Bun 1\.3\.3 or newer/);
    });
});

describe('team-auto sentinel', () => {
    test('detects a fresh sentinel and ignores it only after two hours', () => {
        const root = mkdtempSync(join(tmpdir(), 'team-auto-hook-'));
        temporaryRoots.push(root);
        const featureDir = join(root, 'docs', 'specs', 'auth');
        mkdirSync(featureDir, { recursive: true });
        const sentinel = join(featureDir, '.team-auto-active');
        writeFileSync(sentinel, '');

        expect(findFreshSentinel(root)).toBe(sentinel);

        const stale = new Date(Date.now() - 121 * 60 * 1000);
        utimesSync(sentinel, stale, stale);
        expect(findFreshSentinel(root)).toBeNull();
    });

    test('blocks AskUserQuestion while the sentinel is fresh', async () => {
        const root = mkdtempSync(join(tmpdir(), 'team-auto-hook-'));
        temporaryRoots.push(root);
        const featureDir = join(root, 'docs', 'specs', 'auth');
        mkdirSync(featureDir, { recursive: true });
        const sentinel = join(featureDir, '.team-auto-active');
        writeFileSync(sentinel, '');

        const result = await runHook('block-askuser-during-auto.ts', JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'AskUserQuestion',
            tool_input: { questions: [] },
            cwd: root,
        }));

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('BLOCKED: AskUserQuestion during /team-auto');
        expect(result.stderr).toContain(sentinel);
        expect(result.stderr).toContain('docs/specs/<feature>/run.md');
        expect(result.stderr).not.toContain('auto-pause.md');
        expect(result.stderr).not.toContain('decisions.yaml');
    });

    test('allows unrelated tools, stale sentinels, and the explicit debug bypass', async () => {
        const root = mkdtempSync(join(tmpdir(), 'team-auto-hook-'));
        temporaryRoots.push(root);
        const featureDir = join(root, 'docs', 'specs', 'auth');
        mkdirSync(featureDir, { recursive: true });
        const sentinel = join(featureDir, '.team-auto-active');
        writeFileSync(sentinel, '');

        const baseInput = {
            hook_event_name: 'PreToolUse',
            tool_input: {},
            cwd: root,
        };
        expect((await runHook(
            'block-askuser-during-auto.ts',
            JSON.stringify({ ...baseInput, tool_name: 'Read' }),
        )).status).toBe(0);
        expect((await runHook(
            'block-askuser-during-auto.ts',
            JSON.stringify({ ...baseInput, tool_name: 'AskUserQuestion' }),
            { SKIP_TEAM_AUTO_ASKBLOCK: '1' },
        )).status).toBe(0);

        const stale = new Date(Date.now() - 121 * 60 * 1000);
        utimesSync(sentinel, stale, stale);
        expect((await runHook(
            'block-askuser-during-auto.ts',
            JSON.stringify({ ...baseInput, tool_name: 'AskUserQuestion' }),
        )).status).toBe(0);
    });
});
