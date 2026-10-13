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

test('-f - reads the pipe', () => {
    expect(verdict(`printf 'DROP TABLE users;' | psql -f -`)).toBe('gate');
});

test('a file written under one name and run through a variable holding it is the same file', () => {
    expect(verdict(`echo 'DROP TABLE users' > fresh2.sql; f=fresh2.sql; psql -f "$f"`)).toBe('gate');
});

test('a cd inside a command substitution does not move the shell the client runs in', () => {
    expect(verdict(`echo "$(cd /tmp)"; psql -f bad.sql`)).toBe('gate');
});

test('a file cat feeds through tee is what tee writes', () => {
    expect(verdict(`cat bad.sql | tee fresh3.sql; psql -f fresh3.sql`)).toBe('gate');
});

test('printf output is scanned operand by operand, as it formats them', () => {
    expect(verdict(`printf '%s' 'DROP TABLE users;' | psql`)).toBe('gate');
});

test('a pipeline inside an if feeds its client like a top-level one', () => {
    expect(verdict(`if echo 'DROP TABLE users' | psql; then :; fi`)).toBe('gate');
});

test('env -C with a variable directory reads the file from that directory', () => {
    expect(evaluateBashCommand(`D=${dir}; env -C "$D" psql -f bad.sql`, { cwd: '/' }).action).toBe('gate');
});

test('a write after the SQL client does not count as the file it read', () => {
    expect(verdict(`psql -f safe.sql; echo 'DROP TABLE users' > safe.sql`)).toBe('allow');
});

test('echo -e newlines are rendered before scanning', () => {
    expect(verdict(`echo -e "SELECT 1;\\nDROP TABLE users;" | psql`)).toBe('gate');
    expect(verdict(`echo -e 'BEGIN;\\nDROP TABLE users;\\nCOMMIT;' | psql`)).toBe('gate');
});

test('a pipeline inside a loop keeps its own input when the loop is itself a pipe stage', () => {
    expect(verdict(`psql -Atc "select tablename from pg_tables" | grep tmp_ | while read t; do echo "DROP TABLE $t;" | psql; done`)).toBe('gate');
});

test('many cds and writes before a SQL file resolve in bounded time', () => {
    const command = 'D=/;N=f;' + 'cd $D;echo>$N;'.repeat(4400) + 'psql ' + Array.from({ length: 16 }, (_, i) => `-f g${i}`).join(' ');
    const started = Date.now();
    verdict(command);
    expect(Date.now() - started).toBeLessThan(3000);
});

test('a cd inside a branch leaves the starting directory a candidate', () => {
    expect(verdict(`if false; then cd /tmp; fi; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`if true; then cd /elsewhere; fi; psql -f bad.sql`)).toBe('gate');
});

test('printf output is rendered from its format', () => {
    expect(verdict(`printf 'DROP %s users;' TABLE | psql`)).toBe('gate');
});

test('a file cat feeds through tee also reaches the next stage', () => {
    expect(verdict(`cat bad.sql | tee copy.sql | psql`)).toBe('gate');
});

test('a relative write after a cd matches the absolute path the client reads', () => {
    expect(verdict(`cd ${dir} && echo 'DROP TABLE users' > fresh4.sql && psql -f ${dir}/fresh4.sql`)).toBe('gate');
});

test('text echoed to the terminal is not fed to a client that is not in its pipeline', () => {
    expect(verdict(`echo 'DROP TABLE users'; psql`)).toBe('allow');
    expect(verdict(`echo 'DROP TABLE users' | psql`)).toBe('gate');
});

test('after a cd the command implies, a relative file is not read from the starting directory, where it names a different file', () => {
    expect(verdict(`cd /elsewhere && psql -f bad.sql`)).toBe('allow');
});
