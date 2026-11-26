#!/usr/bin/env bun
/**
 * Refreshes agy-builtins.json from what agy itself told its model. agy has no command that lists its built-in
 * subagents, and the set depends on server-side feature flags as well as the version, so the record of truth is the
 * system prompt agy stored for a real conversation: its "Available subagents:" list, kept in each conversation
 * database under the agy home. A name found is added with this version as its evidence; a name already recorded is
 * never dropped, since a capture sees only the subagents its own environment offered.
 *
 *   bun agy-builtins-capture.ts --agy-version <version> [--write] <agy state dir>...
 *
 * An agy state dir is the `antigravity-cli` dir under a session's `.gemini`, or any dir above it.
 */
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export const MANIFEST_PATH = join(import.meta.dir, 'agy-builtins.json');

export type Manifest = { capturedAgyVersion: string; subagents: Record<string, string[]> };

const LIST = /Available subagents:\r?\n((?:- [A-Za-z0-9][A-Za-z0-9_.-]*: [^\n]*\r?\n?)+)/g;
const ENTRY = /^- ([A-Za-z0-9][A-Za-z0-9_.-]*): /gm;

/** Every subagent name in an "Available subagents:" list anywhere in `bytes`. */
export function subagentNamesIn(bytes: Uint8Array): string[] {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const names = new Set<string>();
    for (const list of text.matchAll(LIST)) {
        for (const entry of list[1].matchAll(ENTRY)) names.add(entry[1]);
    }
    return [...names].sort();
}

/**
 * Every subagent name listed in any value of a conversation database. Values are read through SQLite, since a stored
 * prompt larger than a page is split across overflow pages on disk.
 */
export function subagentNamesInDb(path: string): string[] {
    const db = new Database(path, { readonly: true });
    try {
        const names = new Set<string>();
        const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
        for (const { name } of tables) {
            for (const row of db.query(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as Record<string, unknown>[]) {
                for (const value of Object.values(row)) {
                    const bytes = value instanceof Uint8Array ? value : typeof value === 'string' ? new TextEncoder().encode(value) : null;
                    if (bytes) for (const found of subagentNamesIn(bytes)) names.add(found);
                }
            }
        }
        return [...names].sort();
    } finally {
        db.close();
    }
}

/** Every conversation database at or below `dir`. */
function conversationDbs(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const info = statSync(path, { throwIfNoEntry: false });
        if (info?.isDirectory()) conversationDbs(path, out);
        else if (info?.isFile() && entry.endsWith('.db') && dir.endsWith('conversations')) out.push(path);
    }
    return out;
}

/** The manifest with `found` merged in under `version`. */
export function merge(manifest: Manifest, found: string[], version: string): Manifest {
    const evidence = `agy ${version}: listed under 'Available subagents' in a stored system prompt`;
    const subagents: Record<string, string[]> = {};
    for (const [name, notes] of Object.entries(manifest.subagents)) subagents[name] = [...notes];
    for (const name of found) {
        const notes = subagents[name] ?? [];
        if (!notes.includes(evidence)) notes.unshift(evidence);
        subagents[name] = notes;
    }
    const sorted = Object.fromEntries(Object.entries(subagents).sort(([a], [b]) => a.localeCompare(b)));
    return { capturedAgyVersion: version, subagents: sorted };
}

function main(argv: string[]): number {
    const at = argv.indexOf('--agy-version');
    const version = at >= 0 ? argv[at + 1] : undefined;
    const write = argv.includes('--write');
    const dirs = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--agy-version');
    if (!version || !/^\d+\.\d+\.\d+$/.test(version) || dirs.length === 0) {
        console.error('usage: bun agy-builtins-capture.ts --agy-version <x.y.z> [--write] <agy state dir>...');
        return 2;
    }
    const dbs = dirs.flatMap((dir) => conversationDbs(dir));
    const found = [...new Set(dbs.flatMap(subagentNamesInDb))].sort();
    if (found.length === 0) {
        console.error(`no "Available subagents:" list in ${dbs.length} conversation database(s); run one agy turn under that home first`);
        return 1;
    }
    const current = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
    const next = merge(current, found, version);
    const text = JSON.stringify(next, null, 4) + '\n';
    if (write) writeFileSync(MANIFEST_PATH, text);
    else process.stdout.write(text);
    console.error(`found ${found.join(', ')} in ${dbs.length} conversation database(s)${write ? `; wrote ${MANIFEST_PATH}` : ''}`);
    return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
