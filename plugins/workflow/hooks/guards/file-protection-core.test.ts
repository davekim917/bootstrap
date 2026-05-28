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
        ]) {
            expect(isProtectedEditPath(p)).toBe(true);
        }
    });

    it('blocks terraform glob paths', () => {
        expect(isProtectedEditPath('terraform/main.tf')).toBe(true);
        expect(isProtectedEditPath('infra/terraform/prod.tf')).toBe(true);
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

    it('ignores non-edit tools', () => {
        expect(checkEditProtection('Bash', { command: 'rm .env' })).toBeNull();
        expect(checkEditProtection('WebFetch', { url: 'x' })).toBeNull();
    });
});
