import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

/**
 * SQL FROM FILES. A SQL client's file input is read and scanned like an
 * argument, wherever the file is named: an option, a `<` redirect, a `cat`
 * piped in, or an include inside the SQL. A file too large to check gates.
 */

let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sql-input-test-'));
    writeFileSync(join(dir, 'bad.sql'), 'select 1;\ndrop table users;\n');
    writeFileSync(join(dir, 'ok.sql'), 'select 1;\n');
    writeFileSync(join(dir, 'huge.sql'), 'select 1;\n'.repeat(120_000));
    writeFileSync(join(dir, 'outer.sql'), `\\i ${join(dir, 'inner.sql')}\n`);
    writeFileSync(join(dir, 'inner.sql'), `\\i ${join(dir, 'bad.sql')}\n`);
    mkdirSync(join(dir, 'job'));
    writeFileSync(join(dir, 'job', 'outer.sql'), '\\ir drop.sql\n');
    writeFileSync(join(dir, 'job', 'drop.sql'), 'drop table users;\n');
    writeFileSync(join(dir, 'drop schema.sql'), 'drop schema s;\n');
    writeFileSync(join(dir, 'quoted.sql'), `\\i '${join(dir, 'drop schema.sql')}'\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const verdict = (command: string) => evaluateBashCommand(command, { cwd: dir }).action;

describe('a destructive SQL file is gated however it reaches the client', () => {
    test.each([
        (d: string) => `snow sql -f ${d}/bad.sql`,
        (d: string) => `snow sql --filename=${d}/bad.sql`,
        (d: string) => `psql -f ${d}/bad.sql`,
        (d: string) => `psql < ${d}/bad.sql`,
        (d: string) => `cat ${d}/bad.sql | psql`,
        (d: string) => `snow sql -q "!source ${d}/bad.sql"`,
        (d: string) => `psql -c "\\i ${d}/bad.sql"`,
        () => 'psql -f bad.sql',
        (d: string) => `psql -f ${d}/outer.sql`,
        (d: string) => `psql -f ${d}/job/outer.sql`,
        (d: string) => `psql -f ${d}/quoted.sql`,
    ])('%#', (make) => {
        expect(verdict(make(dir))).toBe('gate');
    });
});

describe('a read-only SQL file is not', () => {
    test.each([
        (d: string) => `snow sql -f ${d}/ok.sql`,
        (d: string) => `psql < ${d}/ok.sql`,
        (d: string) => `cat ${d}/ok.sql | psql`,
    ])('%#', (make) => {
        expect(verdict(make(dir))).toBe('allow');
    });
});

test('a SQL file too large to check gates', () => {
    expect(verdict(`snow sql -f ${dir}/huge.sql`)).toBe('gate');
});

test('a file path the command proves is read: a variable with a known value, or a plain top-level cd', () => {
    expect(verdict(`f=${dir}/bad.sql; psql -f "$f"`)).toBe('gate');
    expect(verdict(`cd ${dir} && snow sql -f bad.sql`)).toBe('gate');
    expect(verdict(`D=${dir}; cd $D; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`f=${dir}/ok.sql; psql -f "$f"`)).toBe('allow');
    expect(verdict(`cd ${dir}; snow sql -f ok.sql`)).toBe('allow');
});

test('a cd the step does not depend on leaves both directories possible, and each is read', () => {
    expect(verdict(`cd /does/not/exist || psql -f bad.sql`)).toBe('gate');
    expect(verdict(`cd /does/not/exist; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`cd /does/not/exist && psql -f bad.sql`)).toBe('allow');
});

test('env -C with a relative directory resolves from where the command starts', () => {
    expect(verdict(`env -C job psql -f drop.sql`)).toBe('gate');
});

test('text piped through tee into a file is what that file holds', () => {
    expect(verdict(`echo 'DROP TABLE users' | tee fresh.sql; psql -f fresh.sql`)).toBe('gate');
});

test('text echoed to the terminal is not fed to a client that is not in its pipeline', () => {
    expect(verdict(`echo 'DROP TABLE users'; psql`)).toBe('allow');
    expect(verdict(`echo 'DROP TABLE users' | psql`)).toBe('gate');
});

test('after a cd the command does not prove, a relative file is not read from the starting directory, where it names a different file', () => {
    expect(verdict(`cd /elsewhere && psql -f bad.sql`)).toBe('allow');
    expect(verdict(`if true; then cd /elsewhere; fi; psql -f bad.sql`)).toBe('allow');
});
