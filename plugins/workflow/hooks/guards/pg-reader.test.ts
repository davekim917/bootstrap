import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, changesProduction, evaluateBashCommand, parseDevScope } from './block-destructive-core';

/**
 * READ-ONLY DEV LOGIN. A database that refuses writes from a login needs no card for any SQL run as it, in one exact
 * shape run by absolute path. A gated step aimed at that database is refused instead: a read with the reader command
 * to run, a write with the owner path, `render psql <id> --confirm`, which asks for approval as before.
 */

const DEV_DB = 'dpg-devdatabase000000001-a';
const PROD_DB = 'dpg-proddatabase00000001-a';
const HOST = `${DEV_DB}.virginia-postgres.render.com`;
const PSQL = '/usr/local/bin/psql';
const READER = `${PSQL} -X -P pager=off -h ${HOST} -U app_reader -d app_dev`;

let dir = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'pg-reader-test-'));
    const scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({
        snowflake: [],
        render: { resources: [DEV_DB], readers: [{ resource: DEV_DB, host: HOST, user: 'app_reader', databases: ['app_dev', 'app_test'] }] },
    }));
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
});

afterEach(() => {
    delete process.env.PGHOSTADDR;
});

afterAll(() => {
    if (saved === undefined) delete process.env[DEV_SCOPE_FILE_ENV];
    else process.env[DEV_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const run = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' });
const retryIn = (reason: string): string => reason.match(/read → run: (.*?) \(on its own line/)![1];

describe('psql as the read-only login, by absolute path, runs with no card, for any SQL', () => {
    test.each([
        [`${READER} -c 'select 1'`],
        [`${READER} -c 'delete from app.accounts'`],
        [`${PSQL} -X -P pager=off -h ${HOST} -U app_reader -d app_test -c 'drop table app.accounts'`],
        [`/usr/bin/timeout 60 ${READER} -c 'select now()'`],
        [`${READER} -c 'select 1' | /usr/bin/head -5`],
        [`/usr/bin/timeout 60 ${READER} -A -t -c 'select 1' 2>&1 | /usr/bin/tail -n 20`],
        [`${READER} --csv -p 5432 -c 'select 1' -c 'select 2'`],
    ])('%s', command => {
        expect(run(command).action).toBe('allow');
    });
});

describe('anything outside the exact shape is not card-free', () => {
    test.each([
        ['psql by name', `psql -X -P pager=off -h ${HOST} -U app_reader -d app_dev -c 'drop table a'`],
        ['a function named psql defined first', `psql() { sh -c 'echo x'; }; psql -X -P pager=off -h ${HOST} -U app_reader -d app_dev -c 'drop table a'`],
        ['an alias named psql defined first', `alias psql='sh -c echo'; psql -X -P pager=off -h ${HOST} -U app_reader -d app_dev -c 'drop table a'`],
        ['timeout by name', `timeout 60 ${READER} -c 'drop table a'`],
        ['head by name', `${READER} -c 'drop table a' | head -5`],
        ['head with no count', `${READER} -c 'drop table a' | /usr/bin/head`],
        ['the pager left on', `${PSQL} -X -h ${HOST} -U app_reader -d app_dev -c 'drop table a'`],
        ['a database not configured', `${PSQL} -X -P pager=off -h ${HOST} -U app_reader -d postgres -c 'drop table a'`],
        ['another port', `${PSQL} -X -P pager=off -h ${HOST} -p 6432 -U app_reader -d app_dev -c 'drop table a'`],
        ['a trailing &', `${READER} -c 'drop table a' &`],
        ['an environment prefix', `PGOPTIONS=-cx=1 ${READER} -c 'drop table a'`],
        ['a step chained before it', `true && ${READER} -c 'drop table a'`],
    ])('%s', (_label, command) => {
        expect(run(command).action).not.toBe('allow');
    });

    test('a reader-shaped command run by a SQL client escape does not clear the client gate', () => {
        const inner = `${READER} -c 'drop table a'`;
        expect(run(`psql -h db.example.com -c "\\! ${inner}"`).action).not.toBe('allow');
    });

    test('a libpq variable in the environment that could repoint the connection takes the shape away', () => {
        process.env.PGHOSTADDR = '203.0.113.9';
        expect(run(`${READER} -c 'drop table a'`).action).not.toBe('allow');
    });
});

describe('a gated step aimed at the read-only database gets a hint instead of a card', () => {
    test.each([
        [`cd /tmp/rv; timeout 60 render psql ${DEV_DB} --command "select now()" -o json 2>&1 | head -20`, `${READER} -c 'select now()'`],
        [`timeout 60 render psql ${DEV_DB} --command="select 1" -o json | cat`, `${READER} -c 'select 1'`],
        [`timeout 60 render psql ${DEV_DB} --command "select 'x'" -o json | cat`, `${READER} -c "select 'x'"`],
    ])('a read: %s', (command, retry) => {
        const { action, reason } = run(command);
        expect(action).toBe('block');
        expect(retryIn(reason!)).toBe(retry);
        expect(run(retry).action).toBe('allow');
        expect(reason).toContain(`write → add --confirm: render psql ${DEV_DB} --confirm`);
    });

    test.each([
        [`timeout 60 render psql ${DEV_DB} --command "drop table a" -o json | cat`],
        [`timeout 60 render psql ${DEV_DB} --command "insert into a values (1)" -o json | cat`],
        [`timeout 60 psql -X -h ${HOST} -U owner -d app_dev -c 'delete from a'`],
    ])('a write gets only the write line: %s', command => {
        const { action, reason } = run(command);
        expect(action).toBe('block');
        expect(reason).not.toContain('read → run');
        expect(reason).toContain('this step writes');
        expect(reason).toContain(`render psql ${DEV_DB} --confirm`);
    });

    test.each([
        [`PGOPTIONS='-c default_transaction_read_only=on' timeout 60 render psql ${DEV_DB} -o text -- -At -f /tmp/rv/t.sql`],
        [`render psql ${DEV_DB}`],
    ])('SQL the guard can see none of gets the template and the write line: %s', command => {
        const { action, reason } = run(command);
        expect(action).toBe('block');
        expect(reason).not.toContain('read → run');
        expect(reason).toContain(`-d <app_dev|app_test> -c '<sql>'`);
    });
});

describe('what keeps its card', () => {
    test.each([
        [`render psql ${DEV_DB} --confirm -o text -- -f /tmp/migrate.sql`],
        [`render psql ${DEV_DB} --confirm=true -o text -- -f /tmp/migrate.sql`],
    ])('the explicit write path asks for approval as before: %s', command => {
        expect(run(command).action).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a step aimed at the reader never suppresses another step\'s card', () => {
        expect(run(`docker volume rm data; timeout 60 render psql ${DEV_DB} --command "select 1" -o json | cat`).action).toBe('gate');
    });

    test('a database with no read-only login is unchanged', () => {
        expect(run(`timeout 60 render psql ${PROD_DB} --command "select 1" -o json | head`).action).toBe('gate');
    });

    test('a hostname that only appears in SQL is not a target', () => {
        expect(run(`timeout 60 psql -X -h db.example.com -U owner -d app -c "delete from hosts where name = '${HOST}'"`).action).toBe('gate');
    });
});

describe('the reader list in dev-scope.local.json', () => {
    const scope = (readers: unknown) => JSON.stringify({
        snowflake: [{ connection: 'example', databases: ['EXAMPLE_DEV'] }],
        render: { resources: [DEV_DB], readers },
    });
    test('parses a reader on a listed resource and host', () => {
        expect(parseDevScope(scope([{ resource: DEV_DB, host: HOST, user: 'app_reader', databases: ['app_dev'] }]))?.render?.readers).toHaveLength(1);
    });
    test.each([
        ['an unlisted resource', { resource: PROD_DB, host: `${PROD_DB}.virginia-postgres.render.com`, user: 'r', databases: ['d'] }],
        ['a host that is not the resource', { resource: DEV_DB, host: 'db.example.com', user: 'r', databases: ['d'] }],
        ['a user that is not an identifier', { resource: DEV_DB, host: HOST, user: 'r;x', databases: ['d'] }],
        ['no databases', { resource: DEV_DB, host: HOST, user: 'r', databases: [] }],
    ])('drops only an entry with %s, keeping the rest of the file', (_label, bad) => {
        const parsed = parseDevScope(scope([bad, { resource: DEV_DB, host: HOST, user: 'app_reader', databases: ['app_dev'] }]));
        expect(parsed?.render?.readers?.map(r => r.user)).toEqual(['app_reader']);
        expect(parsed?.render?.resources).toEqual([DEV_DB]);
        expect(parsed?.snowflake).toHaveLength(1);
    });
});
