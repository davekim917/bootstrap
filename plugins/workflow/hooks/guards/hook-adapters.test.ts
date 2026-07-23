import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findFreshSentinel } from './block-askuser-during-auto';
import { isCanonicalPath, relativeArtifactPath } from './workflow-artifact-path';

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

    test('workflow build gate blocks malformed hook input', async () => {
        const result = await runHook('workflow-gate-enforcement.ts', '{bad-json');
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/malformed hook input/i);
    });
});

describe('workflow artifact path handling', () => {
    const cwd = '/workspace/repo';

    test('accepts canonical relative and absolute artifact paths', () => {
        expect(isCanonicalPath('docs/specs/auth/design.md', cwd)).toBe(true);
        expect(isCanonicalPath('/workspace/repo/docs/specs/auth/design.md', cwd)).toBe(true);
        expect(isCanonicalPath('docs/project-scope.md', cwd)).toBe(true);
    });

    test('rejects lookalike and escaping paths', () => {
        expect(isCanonicalPath('docs/specs-archive/auth/design.md', cwd)).toBe(false);
        expect(isCanonicalPath('../other/docs/specs/auth/design.md', cwd)).toBe(false);
        expect(relativeArtifactPath('../other/design.md', cwd)).toBe('../other/design.md');
    });
});

describe('team-auto sentinel', () => {
    test('detects a fresh sentinel and ignores it after the stale threshold', () => {
        const root = mkdtempSync(join(tmpdir(), 'team-auto-hook-'));
        temporaryRoots.push(root);
        const featureDir = join(root, 'docs', 'specs', 'auth');
        mkdirSync(featureDir, { recursive: true });
        const sentinel = join(featureDir, '.team-auto-active');
        writeFileSync(sentinel, '');

        expect(findFreshSentinel(root)).toBe(sentinel);

        const stale = new Date(Date.now() - 31 * 60 * 1000);
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

        const stale = new Date(Date.now() - 31 * 60 * 1000);
        utimesSync(sentinel, stale, stale);
        expect((await runHook(
            'block-askuser-during-auto.ts',
            JSON.stringify({ ...baseInput, tool_name: 'AskUserQuestion' }),
        )).status).toBe(0);
    });
});
