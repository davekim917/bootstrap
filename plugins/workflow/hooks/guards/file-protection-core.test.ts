import { describe, it, expect } from 'bun:test';
import {
    isProtectedEditPath,
    editPathsFromToolInput,
    checkEditProtection,
} from './file-protection-core';

describe('isProtectedEditPath', () => {
    it('blocks protected segments', () => {
        for (const p of [
            '.env',
            'app/.env.local',
            'package-lock.json',
            'pnpm-lock.yaml',
            'yarn.lock',
            '.git/config',
            'repo/.git/HEAD',
            '.public-boundary-allowlist.json',
            'repo/.public-boundary-baseline.json',
        ]) {
            expect(isProtectedEditPath(p)).toBe(true);
        }
    });

    it('blocks terraform glob paths', () => {
        expect(isProtectedEditPath('terraform/main.tf')).toBe(true);
        expect(isProtectedEditPath('infra/terraform/prod.tf')).toBe(true);
        expect(isProtectedEditPath('/workspace/repo/terraform/main.tf')).toBe(true);
        expect(isProtectedEditPath('/workspace/repo/infra/terraform/prod.tf')).toBe(true);
        expect(isProtectedEditPath('C:\\repo\\terraform\\main.tf')).toBe(true);
        expect(isProtectedEditPath('C:\\repo\\infra\\terraform\\prod.tf')).toBe(true);
    });

    it('protects .git itself, which is a file in a linked worktree', () => {
        expect(isProtectedEditPath('.git')).toBe(true);
        expect(isProtectedEditPath('/workspace/repo/.git')).toBe(true);
        expect(isProtectedEditPath('.github/workflows/ci.yml')).toBe(false);
    });

    it('allows template/allowlisted files even though they look protected', () => {
        for (const p of ['.env.example', '.env.sample', '.env.template', '.gitignore', '.dockerignore']) {
            expect(isProtectedEditPath(p)).toBe(false);
        }
    });

    it('allows ordinary source files', () => {
        for (const p of ['src/index.ts', 'README.md', 'lib/foo/bar.js', '']) {
            expect(isProtectedEditPath(p)).toBe(false);
        }
    });
});

describe('editPathsFromToolInput', () => {
    it('reads Claude file_path + edits[]', () => {
        expect(editPathsFromToolInput({ file_path: '.env' })).toEqual(['.env']);
        expect(editPathsFromToolInput({ edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }] })).toEqual(['a.ts', 'b.ts']);
    });

    it('reads OpenCode path', () => {
        expect(editPathsFromToolInput({ path: 'src/x.ts' })).toEqual(['src/x.ts']);
    });

    it('reads codex apply_patch envelope', () => {
        const patch = '*** Begin Patch\n*** Update File: .env\n@@\n-FOO\n+BAR\n*** End Patch';
        expect(editPathsFromToolInput({ patch })).toEqual(['.env']);
    });

    it('dedupes', () => {
        expect(editPathsFromToolInput({ file_path: 'a.ts', path: 'a.ts' })).toEqual(['a.ts']);
    });
});

describe('checkEditProtection', () => {
    it('flags a protected path on an edit tool (any runtime name)', () => {
        expect(checkEditProtection('Write', { file_path: '.env' })).toBe('.env');
        expect(checkEditProtection('edit', { path: 'package-lock.json' })).toBe('package-lock.json');
        expect(checkEditProtection('apply_patch', { patch: '*** Update File: terraform/main.tf\n' })).toBe('terraform/main.tf');
    });

    it('allows safe edits', () => {
        expect(checkEditProtection('Write', { file_path: 'src/index.ts' })).toBeNull();
    });

    it.each([
        ['OpenCode apply_patch (patchText)', { patchText: '*** Begin Patch\n*** Update File: .env\n@@\n-A\n+B\n*** End Patch' }, '.env'],
        ['Codex apply_patch hook input (command)', { command: '*** Begin Patch\n*** Delete File: pnpm-lock.yaml\n*** End Patch' }, 'pnpm-lock.yaml'],
        ['a move onto a protected path', { patchText: '*** Begin Patch\n*** Update File: notes.txt\n*** Move to: .env\n@@\n-a\n+b\n*** End Patch' }, '.env'],
        ['CRLF line endings', { patchText: '*** Begin Patch\r\n*** Add File: .env\r\n+X=1\r\n*** End Patch\r\n' }, '.env'],
        ['no space after the header colon', { patchText: '*** Begin Patch\n*** Add File:.env\n+X=1\n*** End Patch' }, '.env'],
        ['one protected file among several', { patchText: '*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** Update File: app/package-lock.json\n@@\n-a\n+b\n*** End Patch' }, 'app/package-lock.json'],
    ])('flags a patch through %s', (_name, input, expected) => {
        expect(checkEditProtection('apply_patch', input)).toBe(expected);
    });

    it.each([
        ['a bare CR inside the path', { patchText: '*** Begin Patch\n*** Add File: scratch\r/../.env\n+X=1\n*** End Patch' }, undefined, 'scratch\r/../.env'],
        ['a relative path inside terraform/', { patchText: '*** Begin Patch\n*** Add File: main.tf\n+x\n*** End Patch' }, '/repo/terraform', 'main.tf'],
        ['an indented header right after Begin Patch', { patchText: '*** Begin Patch\n *** Add File: .env\n+X=1\n*** End Patch' }, undefined, '.env'],
        ['an indented header after an Add hunk', { patchText: '*** Begin Patch\n*** Add File: notes.txt\n+x\n\t*** Delete File: yarn.lock\n*** End Patch' }, undefined, 'yarn.lock'],
        ['deleting a linked worktree\'s .git file', { patchText: '*** Begin Patch\n*** Delete File: .git\n*** End Patch' }, undefined, '.git'],
        ['a template name under .git/', { patchText: '*** Begin Patch\n*** Add File: .git/.env.example\n+x\n*** End Patch' }, undefined, '.git/.env.example'],
    ])('flags a patch through %s', (_name, input, cwd, expected) => {
        expect(checkEditProtection('apply_patch', input, cwd)).toBe(expected);
    });

    it.each([
        ['a context line that reads like a header', '*** Begin Patch\n*** Update File: docs/patch-format.md\n@@\n *** Delete File: .env\n-old\n+new\n*** End Patch'],
        ['a path that leaves terraform/ again', '*** Begin Patch\n*** Add File: terraform/../notes.txt\n+x\n*** End Patch'],
    ])('allows %s', (_name, patchText) => {
        expect(checkEditProtection('apply_patch', { patchText }, '/repo')).toBeNull();
    });

    it('allows a patch that touches only ordinary files', () => {
        expect(checkEditProtection('apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-a\n+b\n*** End Patch' })).toBeNull();
    });

    it('blocks an edit tool whose input names no target it can read', () => {
        for (const [tool, input] of [
            ['apply_patch', { patchText: 'not a patch' }],
            ['apply_patch', { patch_text: '*** Begin Patch\n*** Add File: .env\n+X\n*** End Patch' }],
            ['write', { content: 'X=1' }],
            ['Edit', {}],
        ] as const) {
            const blocked = checkEditProtection(tool, input as Record<string, unknown>);
            expect(typeof blocked).toBe('string');
            expect(blocked).not.toBe('');
        }
    });

    it('ignores non-edit tools', () => {
        expect(checkEditProtection('Bash', { command: 'rm .env' })).toBeNull();
        expect(checkEditProtection('WebFetch', { url: 'x' })).toBeNull();
    });
});
