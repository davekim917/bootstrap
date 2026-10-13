import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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

test('after a cd, a relative file is not read from the starting directory, where it names a different file', () => {
    expect(verdict(`cd /elsewhere && psql -f bad.sql`)).toBe('allow');
});
