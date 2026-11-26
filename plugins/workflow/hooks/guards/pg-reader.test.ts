import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, changesProduction, evaluateBashCommand, parseDevScope } from './block-destructive-core';

/**
 * READ-ONLY DEV LOGIN. A database that refuses writes from a login needs no card for any SQL run as it, in one exact
 * shape. A line aimed at that database in any other shape is refused with the reader command to run instead; the
 * owner login stays reachable for writes through `render psql <id> --confirm`, which asks for approval as before.
 */

const DEV_DB = 'dpg-devdatabase000000001-a';
const PROD_DB = 'dpg-proddatabase00000001-a';
const HOST = `${DEV_DB}.virginia-postgres.render.com`;
const READER = `psql -X -h ${HOST} -U app_reader -d app_dev`;

let dir = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'pg-reader-test-'));
    const scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({
        snowflake: [],
        render: { resources: [DEV_DB], readers: [{ resource: DEV_DB, host: HOST, user: 'app_reader', database: 'app_dev' }] },
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
const rewriteIn = (reason: string): string => reason.match(/read → run: (.*?) \(on its own line/)![1];

describe('psql as the read-only login runs with no card, for any SQL', () => {
    test.each([
        [`${READER} -c 'select 1'`],
        [`${READER} -c 'delete from app.accounts'`],
        [`${READER} -c 'drop table app.accounts'`],
        [`timeout 60 ${READER} -c 'select now()'`],
        [`${READER} -c 'select 1' | head -5`],
        [`timeout 60 ${READER} -A -t -c 'select 1' 2>&1 | tail -n 20`],
        [`${READER} --csv -c 'select 1' -c 'select 2'`],
    ])('%s', command => {
        expect(run(command).action).toBe('allow');
    });
});

describe('any other shape aimed at the read-only database gets the reader command instead of a card', () => {
    test.each([
        ['a conninfo dbname', `psql -X -h ${HOST} -U app_reader -d "host=${HOST} user=owner dbname=app_dev" -c 'drop table a'`],
        ['a URI dbname', `psql -X -h ${HOST} -U app_reader -d postgresql://owner:pw@${HOST}/app_dev -c 'drop table a'`],
        ['a service', `psql -X -h ${HOST} -U app_reader -d service=app -c 'drop table a'`],
        ['a positional dbname', `psql -X -h ${HOST} -U app_reader app_dev -c 'drop table a'`],
        ['another login', `psql -X -h ${HOST} -U owner -d app_dev -c 'drop table a'`],
        ['an environment prefix', `PGOPTIONS=-cx=1 ${READER} -c 'drop table a'`],
        ['a pipe into another program', `${READER} -c 'drop table a' | cat`],
        ['a step chained before it', `true && ${READER} -c 'drop table a'`],
        ['an output file', `${READER} -o /tmp/out -c 'drop table a'`],
        ['another port', `psql -X -h ${HOST} -p 6432 -U app_reader -d app_dev -c 'drop table a'`],
    ])('%s', (_label, command) => {
        const { action, reason } = run(command);
        expect(action).toBe('block');
        expect(reason).toContain('read → run: psql -X -h');
        expect(reason).toContain(`write → add --confirm: render psql ${DEV_DB} --confirm`);
    });

    test.each([
        [`cd /tmp/rv; timeout 60 render psql ${DEV_DB} --command "select now()" -o json 2>&1 | head -20`, `${READER} -c 'select now()'`],
        [`PGOPTIONS='-c default_transaction_read_only=on' timeout 60 render psql ${DEV_DB} -o text -- -At -f /tmp/rv/t.sql`, `${READER} -c '<sql>'`],
        [`render psql ${DEV_DB}`, `${READER} -c '<sql>'`],
        [`timeout 60 render psql ${DEV_DB} --command "select 'it''s'" -o json | cat`, `${READER} -c 'select '\\''it'\\'''\\''s'\\'''`],
    ])('%s rewrites to the reader command', (command, rewrite) => {
        const { action, reason } = run(command);
        expect(action).toBe('block');
        expect(rewriteIn(reason!)).toBe(rewrite);
    });

    test.each([
        ['no -X', `psql -h ${HOST} -U app_reader -d app_dev -c 'drop table a'`],
        ['a meta-command', `${READER} -c '\\! rm -rf x'`],
    ])('%s is refused with its own fix, not carded', (_label, command) => {
        expect(run(command).action).toBe('block');
    });

    test('the rewritten command runs with no card', () => {
        const { reason } = run(`cd /tmp/rv; timeout 60 render psql ${DEV_DB} --command "select now()" -o json 2>&1 | head -20`);
        expect(run(rewriteIn(reason!)).action).toBe('allow');
    });
});

describe('what keeps its card', () => {
    test('the explicit write path asks for approval as before', () => {
        const command = `render psql ${DEV_DB} --confirm -o text -- -f /tmp/migrate.sql`;
        expect(run(command).action).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a database with no read-only login is unchanged', () => {
        expect(run(`timeout 60 render psql ${PROD_DB} --command "select 1" -o json | head`).action).toBe('gate');
    });

    test('a libpq variable in the environment that could repoint the connection takes the reader shape away', () => {
        process.env.PGHOSTADDR = '203.0.113.9';
        expect(run(`${READER} -c 'drop table a'`).action).not.toBe('allow');
    });
});

describe('the reader list in dev-scope.local.json', () => {
    const scope = (readers: unknown) => JSON.stringify({ snowflake: [], render: { resources: [DEV_DB], readers } });
    test('parses a reader on a listed resource and host', () => {
        expect(parseDevScope(scope([{ resource: DEV_DB, host: HOST, user: 'app_reader', database: 'app_dev' }]))?.render?.readers).toHaveLength(1);
    });
    test.each([
        ['an unlisted resource', [{ resource: PROD_DB, host: `${PROD_DB}.virginia-postgres.render.com`, user: 'r', database: 'd' }]],
        ['a host that is not the resource', [{ resource: DEV_DB, host: 'db.example.com', user: 'r', database: 'd' }]],
        ['a user that is not an identifier', [{ resource: DEV_DB, host: HOST, user: 'r;x', database: 'd' }]],
        ['a missing database', [{ resource: DEV_DB, host: HOST, user: 'r' }]],
    ])('rejects the whole file for %s', (_label, readers) => {
        expect(parseDevScope(scope(readers))).toBeNull();
    });
});
