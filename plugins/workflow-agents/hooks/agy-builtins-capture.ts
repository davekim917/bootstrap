#!/usr/bin/env bun
/**
 * Proposes changes to agy-builtins.json, the guard's checked-in list, from what agy itself told its model. agy has no command that lists its built-in
 * subagents, and the set depends on server-side feature flags as well as the version, so the record of truth is the
 * system prompt agy stored for a real conversation: its "Available subagents:" list, in each conversation database's
 * generation records. That list also names the custom agents the session could load, in the same form, so every name
 * a markdown definition provides in the session's workspaces or global config is dropped. It prints the proposed
 * manifest and the names it would add; it never writes the file, which changes only through a reviewed PR. A name
 * already recorded is never dropped, since a capture sees only the subagents its own environment offered.
 *
 *   bun agy-builtins-capture.ts --agy-version <x.y.z> --state <dir> --config <dir> --workspace <dir>...
 *
 * `--state` is the session's `antigravity-cli` dir (under its `.gemini`), `--config` the dir agy read as
 * `~/.gemini/config`, and each `--workspace` one of the session's workspace roots.
 */
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { definedAgentNames } from './agy-guard';

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
        // Generation records hold the prompts agy sent; other tables hold conversation text, where a list can be quoted.
        for (const { data } of db.query('SELECT data FROM gen_metadata').all() as { data: unknown }[]) {
            if (data instanceof Uint8Array) for (const found of subagentNamesIn(data)) names.add(found);
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
    const values = (flag: string) => argv.flatMap((arg, i) => (argv[i - 1] === flag ? [arg] : []));
    const [version] = values('--agy-version');
    const [state] = values('--state');
    const [config] = values('--config');
    const workspaces = values('--workspace');
    if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !state || !config || workspaces.length === 0) {
        console.error('usage: bun agy-builtins-capture.ts --agy-version <x.y.z> --state <dir> --config <dir> --workspace <dir>...');
        return 2;
    }
    const dbs = conversationDbs(state);
    const listed = [...new Set(dbs.flatMap(subagentNamesInDb))].sort();
    if (listed.length === 0) {
        console.error(`no "Available subagents:" list in ${dbs.length} conversation database(s); run one agy turn in that session first`);
        return 1;
    }
    const custom = definedAgentNames(workspaces, config);
    const found = listed.filter((name) => !custom.has(name));
    const dropped = listed.filter((name) => custom.has(name));
    const current = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
    const added = found.filter((name) => !(name in current.subagents));
    process.stdout.write(JSON.stringify(merge(current, found, version), null, 4) + '\n');
    console.error(`built-in: ${found.join(', ') || '(none)'}; new: ${added.join(', ') || '(none)'}; custom, dropped: ${dropped.join(', ') || '(none)'}; from ${dbs.length} conversation database(s). Proposed manifest on stdout; review it in a PR.`);
    return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
