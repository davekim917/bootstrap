import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, changesProduction, describeGate, evaluateBashCommand } from './block-destructive-core';

/**
 * POSTGRES ROLE AND PRIVILEGE CHANGES. Creating, changing or dropping a role, granting or revoking a privilege, changing
 * default privileges or an owner, and creating a SECURITY DEFINER function take approval on every Postgres the guard
 * reads SQL for: a listed dev database included, the in-container scratch Postgres excepted. A psql file that isn't
 * there before the line runs is refused with the way to make it readable, and one the guard may not read is carded.
 */

const DEV_DB = 'dpg-devdatabase000000001-a';
const PROD_DB = 'dpg-proddatabase00000001-a';
const host = (id: string) => id + '.example-postgres.render.com';

let dir = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'pg-privilege-test-'));
    const scope = join(dir, 'dev-scope.local.json');
    writeFileSync(scope, JSON.stringify({ snowflake: [], render: { resources: [DEV_DB] } }));
    process.env[DEV_SCOPE_FILE_ENV] = scope;
});

afterAll(() => {
    if (saved === undefined) delete process.env[DEV_SCOPE_FILE_ENV];
    else process.env[DEV_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const run = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' });

// How agents reach a Render database: the connection string from the API, a written-out host, or render psql.
const viaUri = (id: string, sql: string) =>
    'URI=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/postgres/' + id + '/connection-info" | jq -r .externalConnectionString); psql "$URI" -X -c "' + sql + '"';
const viaHost = (id: string, sql: string) => 'psql -X -h ' + host(id) + ' -U app -d app -c "' + sql + '"';
const viaRender = (id: string, sql: string) => 'render psql ' + id + ' -c "' + sql + '"';

const PRIVILEGE_SQL = [
    "CREATE ROLE app_reader LOGIN PASSWORD 'x'",
    "create user app_reader with password 'x'",
    'CREATE GROUP app_readers',
    'ALTER ROLE app_reader SUPERUSER',
    "ALTER USER app_reader WITH PASSWORD 'y'",
    'ALTER GROUP app_readers ADD USER app_reader',
    'DROP ROLE app_reader',
    'DROP USER IF EXISTS app_reader',
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_reader',
    'GRANT app_admin TO app_reader',
    'REVOKE ALL ON SCHEMA public FROM PUBLIC',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_reader',
    'ALTER TABLE public.orders OWNER TO app_reader',
    'ALTER SCHEMA public OWNER TO app_reader',
    'ALTER DATABASE app OWNER TO app_reader',
    'REASSIGN OWNED BY app_a TO app_b',
    "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1'",
    'ALTER FUNCTION public.f() SECURITY DEFINER',
    'select 1; grant select on public.orders to app_reader',
    '/* setup */ grant usage on schema public to app_reader',
];

describe('a role or privilege change on a reachable Postgres is never run without approval', () => {
    for (const sql of PRIVILEGE_SQL) {
        test.each([
            ['dev, through its connection string', viaUri(DEV_DB, sql), 'block'],
            ['prod, through its connection string', viaUri(PROD_DB, sql), 'block'],
            ['dev, its host written out', viaHost(DEV_DB, sql), 'gate'],
            ['prod, its host written out', viaHost(PROD_DB, sql), 'gate'],
            ['dev, through render psql', viaRender(DEV_DB, sql), 'gate'],
            ['prod, through render psql', viaRender(PROD_DB, sql), 'gate'],
        ])(sql + ': %s', (_where, command, action) => {
            expect(run(command).action).toBe(action as 'block' | 'gate');
        });
    }

    test('inside a DO block', () => {
        expect(run("psql -X -h " + host(PROD_DB) + " -U app -d app -c 'DO $$BEGIN GRANT SELECT ON public.orders TO app_reader; END$$'").action).toBe('gate');
        expect(run("render psql " + DEV_DB + " -c 'DO $$BEGIN GRANT SELECT ON public.orders TO app_reader; END$$'").action).toBe('gate');
    });

    test('a listed dev database holds it as dev and says why', () => {
        const command = viaRender(DEV_DB, 'GRANT SELECT ON public.orders TO app_reader');
        const { reason } = run(command);
        expect(changesProduction(command, '/tmp')).toBe(false);
        expect(reason).toContain(DEV_DB);
        expect(reason).toContain('roles or privileges');
    });

    test('the card names the privilege change', () => {
        const command = viaHost(PROD_DB, 'GRANT SELECT ON public.orders TO app_reader');
        const card = describeGate(command, run(command).reason!, '/tmp');
        expect(card.label).toContain('GRANT');
    });
});

describe('what ran without a card still does', () => {
    test.each([
        viaRender(DEV_DB, 'select grantee, privilege_type from information_schema.role_table_grants'),
        viaRender(DEV_DB, "select 'grant select on t to r' as note"),
        viaRender(DEV_DB, 'create table public.scratch (id int)'),
        viaRender(DEV_DB, "update public.orders set note = 'owner to' where id = 1"),
        viaHost(PROD_DB, 'select rolname from pg_roles'),
        'snow sql -c acme_dev -q "GRANT SELECT ON ALL TABLES IN SCHEMA dev_db.app TO ROLE r"',
    ])('%s', command => {
        expect(run(command).action).toBe('allow');
    });
});

describe('a psql file the guard cannot read before the line runs', () => {
    test.each([
        ['a file not there yet, host written out', () => 'psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + join(dir, 'missing.sql')],
        ['a file not there yet, through the connection string', () => 'URI=$(curl -s "https://api.render.com/v1/postgres/' + PROD_DB + '/connection-info" | jq -r .externalConnectionString); psql "$URI" -f ' + join(dir, 'missing.sql')],
        ['a file written by a program the guard does not model', () => 'curl -s -o ' + join(dir, 'fetched.sql') + ' https://example.com/m.sql && psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + join(dir, 'fetched.sql')],
        ['--file= on a dev host', () => 'psql -X -h ' + host(DEV_DB) + ' -U app -d app --file=' + join(dir, 'missing.sql')],
    ])('%s is refused', (_what, command) => {
        expect(run(command()).action).toBe('block');
    });

    test('the refusal says how to make it readable', () => {
        const { reason } = run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + join(dir, 'missing.sql'));
        expect(reason).toContain('Write the file in one call');
    });

    test('a file the guard is not allowed to read is carded', () => {
        const locked = join(dir, 'locked.sql');
        writeFileSync(locked, 'select 1;\n');
        chmodSync(locked, 0o000);
        try {
            expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + locked).action).toBe('gate');
        } finally {
            chmodSync(locked, 0o600);
        }
    });

    test('a readable file is read: a grant in it is carded, a select runs', () => {
        const grants = join(dir, 'grants.sql');
        const reads = join(dir, 'reads.sql');
        writeFileSync(grants, 'GRANT SELECT ON public.orders TO app_reader;\n');
        writeFileSync(reads, 'select count(*) from public.orders;\n');
        expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + grants).action).toBe('gate');
        expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + reads).action).toBe('allow');
    });
});
