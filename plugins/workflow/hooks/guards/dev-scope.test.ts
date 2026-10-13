import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, describeGate, evaluateBashCommand, parseDevScope } from './block-destructive-core';
import { isProtectedEditPath } from './file-protection-core';

/**
 * DEV-SCOPE EXEMPTION. A Snowflake connection listed as dev skips approval; a
 * connection limited to dev databases skips it only for statements whose every
 * target is fully qualified inside them. Every way of pointing the command
 * elsewhere, or naming a target the guard cannot read exactly, stays gated.
 */

let dir = '';
let scopeFile = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'dev-scope-test-'));
    scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({
        snowflake: [{ connection: 'acme_dev' }, { connection: 'acme_prod', databases: ['scratch_db'] }],
    }));
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
});

afterEach(() => {
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
});

afterAll(() => {
    if (saved === undefined) delete process.env[DEV_SCOPE_FILE_ENV];
    else process.env[DEV_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

describe('a listed dev connection skips approval', () => {
    test.each([
        'snow sql -c acme_dev -q "drop table analytics.core.orders"',
        'snow sql --connection=acme_dev -q "delete from any_db.s.t"',
        'snow sql -c acme_prod -q "drop table scratch_db.tmp.orders"',
        'snow sql -c acme_prod -q "drop schema scratch_db.tmp"',
        'snow sql -c acme_prod -q \'create or replace table "SCRATCH_DB"."TMP"."T" clone prod_db.core.t\'',
        'snow sql -c acme_prod -q "drop table scratch_db.a.b; drop table scratch_db.a.c"',
    ])('%s', (command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('everything else stays gated', () => {
    test.each([
        ['the default connection', 'snow sql -q "drop table scratch_db.tmp.orders"'],
        ['an unlisted connection', 'snow sql -c acme_other -q "drop table a.b.c"'],
        ['a prod table on a database-limited connection', 'snow sql -c acme_prod -q "drop table prod_db.core.orders"'],
        ['one prod statement among dev ones', 'snow sql -c acme_prod -q "drop table scratch_db.a.b; drop table prod_db.a.b"'],
        ['a two-part table name', 'snow sql -c acme_prod -q "drop table scratch_db.orders"'],
        ['an unqualified table name', 'snow sql -c acme_prod -q "delete from orders"'],
        ['dropping the dev database itself', 'snow sql -c acme_prod -q "drop database scratch_db"'],
        ['a shell variable in the SQL', 'T=scratch_db.a.b; snow sql -c acme_prod -q "drop table $T"'],
        ['IDENTIFIER()', `snow sql -c acme_prod -q "drop table identifier('scratch_db.a.b')"`],
        ['EXECUTE IMMEDIATE', `snow sql -c acme_prod -q "execute immediate 'drop table prod_db.a.b'"`],
        ['an account override', 'snow sql -c acme_dev --account prod-account -q "drop table a.b.c"'],
        ['a temporary connection', 'snow sql -c acme_dev -x -q "drop table a.b.c"'],
        ['another config file', 'snow sql -c acme_dev --config-file /tmp/c.toml -q "drop table a.b.c"'],
        ['a SNOWFLAKE_ prefix variable', 'SNOWFLAKE_ACCOUNT=prod snow sql -c acme_dev -q "drop table a.b.c"'],
        ['an exported SNOWFLAKE_ variable', 'export SNOWFLAKE_CONNECTIONS_ACME_DEV_ACCOUNT=prod; snow sql -c acme_dev -q "drop table a.b.c"'],
        ['two connection flags', 'snow sql -c acme_dev -c acme_other -q "drop table a.b.c"'],
        ['a connection held in a variable', 'C=acme_dev; snow sql -c $C -q "drop table a.b.c"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test('with no scope file nothing is exempt', () => {
        process.env[DEV_SCOPE_FILE_ENV] = join(dir, 'missing.json');
        expect(verdict('snow sql -c acme_dev -q "drop table a.b.c"')).toBe('gate');
    });

    test('a malformed scope file exempts nothing', () => {
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, JSON.stringify({ snowflake: [{ connection: 'acme dev; drop' }] }));
        process.env[DEV_SCOPE_FILE_ENV] = bad;
        expect(verdict('snow sql -c acme_dev -q "drop table a.b.c"')).toBe('gate');
    });

    test('an exempt step does not hide a gated one, and the description names the gated one', () => {
        const command = 'snow sql -c acme_dev -q "drop table a.b.c" && snow sql -c acme_prod -q "drop table prod_db.core.orders"';
        const v = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(v.action).toBe('gate');
        expect(describeGate(command, v.reason!, '/tmp').label).toBe('Drop Snowflake table prod_db.core.orders');
    });
});

describe('the scope file itself', () => {
    test.each([
        ['{"snowflake": []}', true],
        ['{"snowflake": [{"connection": "acme_dev"}]}', true],
        ['{"snowflake": [{"connection": "acme_prod", "databases": []}]}', false],
        ['{"snowflake": [{"connection": "acme_prod", "databases": ["bad name"]}]}', false],
        ['{"other": []}', false],
        ['not json', false],
    ])('%s parses: %p', (text, ok) => {
        expect(parseDevScope(text) !== null).toBe(ok);
    });

    test('agents cannot edit it', () => {
        expect(isProtectedEditPath('/workspace/plugins/bootstrap/dev-scope.local.json')).toBe(true);
    });
});
