import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_PATH, merge, subagentNamesIn, subagentNamesInDb, type Manifest } from './agy-builtins-capture';

const enc = (text: string) => new TextEncoder().encode(text);

describe('the capture reads built-in names from the prompt agy stored', () => {
    test('names come from every "Available subagents:" list, with stored binary around it', () => {
        const stored = new Uint8Array([
            0x0a, 0xff, 0x00,
            ...enc('Do NOT use send_message to communicate with the user.\n\nAvailable subagents:\n'
                + '- self: Subagent that inherits the parent agent\'s full configuration.\n'
                + '- research: Research subagent with read-only tools.\n'
                + '- image-generator: Generates or edits images from a brief.\n'),
            0x12, 0x00,
            ...enc('Available subagents:\n- browser: Drives a browser.\n'),
            0xfe,
            ...enc('Some prose that mentions - writer: as a list item but not under the heading.\n'),
        ]);
        expect(subagentNamesIn(stored)).toEqual(['browser', 'image-generator', 'research', 'self']);
    });

    test('a list stored in a value larger than a database page is read whole', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-capture-'));
        try {
            const path = join(dir, 'conversation.db');
            const db = new Database(path);
            db.run('PRAGMA page_size = 1024');
            db.run('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)');
            const prompt = 'x'.repeat(5000) + '\nAvailable subagents:\n' + ['self', 'research', 'image-generator'].map((n) => `- ${n}: ${'d'.repeat(900)}\n`).join('');
            db.query('INSERT INTO gen_metadata (idx, data) VALUES (1, ?)').run(new TextEncoder().encode(prompt));
            db.close();
            expect(subagentNamesInDb(path)).toEqual(['image-generator', 'research', 'self']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a database with no such list yields nothing', () => {
        expect(subagentNamesIn(enc('- self: not under the heading\n'))).toEqual([]);
    });
});

describe('the capture run keeps custom agents, which agy lists the same way, out of the built-ins', () => {
    test('a name a workspace definition provides is dropped; a list quoted in conversation text is not read', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agy-capture-'));
        try {
            const state = join(dir, 'state');
            const workspace = join(dir, 'ws');
            const config = join(dir, 'config');
            mkdirSync(join(state, 'conversations'), { recursive: true });
            mkdirSync(join(workspace, '.agents', 'agents'), { recursive: true });
            mkdirSync(config);
            writeFileSync(join(workspace, '.agents', 'agents', 'writer.md'), '---\nname: writer\ndescription: Writes.\n---\nWrite.\n');
            const db = new Database(join(state, 'conversations', 'c.db'));
            db.run('CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob)');
            db.run('CREATE TABLE steps (idx integer PRIMARY KEY, step_payload blob)');
            db.query('INSERT INTO gen_metadata (idx, data) VALUES (1, ?)').run(enc('Available subagents:\n- self: Inherits.\n- image-generator: Draws.\n- writer: Writes.\n'));
            db.query('INSERT INTO steps (idx, step_payload) VALUES (1, ?)').run(enc('Available subagents:\n- quoted: From a tool output.\n'));
            db.close();
            const run = Bun.spawnSync(['bun', join(import.meta.dir, 'agy-builtins-capture.ts'), '--agy-version', '9.9.9', '--state', state, '--config', config, '--workspace', workspace]);
            expect(run.exitCode).toBe(0);
            const printed = JSON.parse(run.stdout.toString()) as Manifest;
            expect(printed.capturedAgyVersion).toBe('9.9.9');
            expect(printed.subagents['image-generator'][0]).toBe("agy 9.9.9: listed under 'Available subagents' in a stored system prompt");
            expect(printed.subagents.writer).toBeUndefined();
            expect(printed.subagents.quoted).toBeUndefined();
            expect(run.stderr.toString()).toContain('custom, dropped: writer');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('a capture adds names and never drops one', () => {
    const before: Manifest = {
        capturedAgyVersion: '1.5.16',
        subagents: { browser: ['agy 1.5.1 changelog'], self: ["agy 1.5.16: listed under 'Available subagents' in a stored system prompt"] },
    };

    test('a new name gains evidence for the new version; an unseen one is kept', () => {
        expect(merge(before, ['self', 'image-generator'], '1.5.17')).toEqual({
            capturedAgyVersion: '1.5.17',
            subagents: {
                browser: ['agy 1.5.1 changelog'],
                'image-generator': ["agy 1.5.17: listed under 'Available subagents' in a stored system prompt"],
                self: [
                    "agy 1.5.17: listed under 'Available subagents' in a stored system prompt",
                    "agy 1.5.16: listed under 'Available subagents' in a stored system prompt",
                ],
            },
        });
    });

    test('a repeat capture of the same version changes nothing', () => {
        expect(merge(before, ['self'], '1.5.16')).toEqual(before);
    });

    test('the checked-in manifest is what the guard can load: a version and evidence for every name', () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
        expect(manifest.capturedAgyVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(Object.keys(manifest.subagents).length).toBeGreaterThan(0);
        for (const notes of Object.values(manifest.subagents)) expect(notes.length).toBeGreaterThan(0);
    });
});
