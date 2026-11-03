import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * OpenCode loads a legacy plugin file by calling every one of its exports as a plugin factory with its own plugin
 * context, and one export that throws drops the file with "failed to load plugin". These tests apply that rule to
 * every OpenCode plugin file in the repo.
 */

const PLUGINS = resolve(import.meta.dir, '../../..');

function opencodePluginFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : opencodePluginFiles(path);
        return /^opencode-(?!.*(?:-core|\.test)\.)[\w-]+\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
    });
}

const files = opencodePluginFiles(PLUGINS);

test('the OpenCode plugin files are found', () => {
    expect(files.map(file => relative(PLUGINS, file))).toContain('workflow/hooks/guards/opencode-guard.ts');
});

describe.each(files.map(file => [relative(PLUGINS, file), file]))('%s', (_name, file) => {
    test('loads the way OpenCode loads it: every export is a factory that returns hooks', async () => {
        const mod = (await import(file)) as Record<string, unknown>;
        expect(Object.keys(mod).length).toBeGreaterThan(0);
        for (const [name, entry] of Object.entries(mod)) {
            expect({ name, type: typeof entry }).toEqual({ name, type: 'function' });
            const hooks = await (entry as (input: unknown) => Promise<unknown>)({ directory: PLUGINS, worktree: PLUGINS });
            expect({ name, hooks: typeof hooks }).toEqual({ name, hooks: 'object' });
        }
    });
});
