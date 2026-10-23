import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, describeGate, evaluateBashCommand, parseDevScope } from './block-destructive-core';
import { isProtectedEditPath } from './file-protection-core';

/**
 * DEV-SCOPE EXEMPTION. On a listed Snowflake connection, destructive SQL skips
 * approval only when every target is fully qualified inside one of that
 * connection's dev databases. Every way of pointing the command at another
 * account, identity, role or config, or naming a target the guard cannot read
 * exactly, stays gated.
 */

let dir = '';
let scopeFile = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'dev-scope-test-'));
    scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({
        snowflake: [{ connection: 'acme_dev', databases: ['dev_db'] }, { connection: 'acme_prod', databases: ['scratch_db'] }],
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

describe('destructive SQL inside a listed dev database skips approval', () => {
    test.each([
        'snow sql -c acme_dev -q "drop table dev_db.core.orders"',
        'snow sql --connection=acme_dev --format json -q "delete from DEV_DB.s.t where id = 1"',
        'snow sql -c acme_prod -q "drop table scratch_db.tmp.orders"',
        'snow sql -c acme_prod -q "drop schema scratch_db.tmp"',
        'snow sql -c acme_prod -q \'create or replace table "SCRATCH_DB"."TMP"."T" clone prod_db.core.t\'',
        'snow sql -c acme_prod -q "drop table scratch_db.a.b; drop table scratch_db.a.c"',
        'cd /tmp && timeout 300 snow sql -c acme_prod --warehouse dev_wh -q "drop schema if exists scratch_db.tmp cascade" 2>&1 | tail -3',
        // A role can't move a statement out of the database it names.
        'snow sql -c acme_dev --role ACCOUNTADMIN -q "drop table dev_db.a.b"',
        // An unexported variable the client doesn't read can't reach snow.
        'S=dev_db.a; N=$(date +%s); snow sql -c acme_dev -q "drop table dev_db.a.b" && echo "$S $N"',
        'for n in 1 2; do echo $n; done; snow sql -c acme_dev -q "drop table dev_db.a.b"',
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
        ['an unqualified name on a dev connection, which a role could resolve anywhere', 'snow sql -c acme_dev -q "drop table orders"'],
        ['a quoted lower-case database, which Snowflake treats as a different one', 'snow sql -c acme_prod -q \'drop table "scratch_db".a.b\''],
        ['a comma-separated second target', 'snow sql -c acme_prod -q "drop table scratch_db.a.b, prod_db.a.b"'],
        ['a scripting block', 'snow sql -c acme_prod -q "drop table scratch_db.a.b; begin drop table prod_db.a.b; end"'],
        ['snow templating', 'snow sql -c acme_prod -q "drop table scratch_db.a.b; &{x}" -D "x=drop table prod_db.a.b"'],
        ['a user override', 'snow sql -c acme_dev --user admin -q "drop table dev_db.a.b"'],
        ['a key-file override', 'snow sql -c acme_dev --private-key-path /tmp/k -q "drop table dev_db.a.b"'],
        ['a database override', 'snow sql -c acme_dev --database prod_db -q "drop table dev_db.a.b"'],
        ['HOME redirecting the config', 'HOME=/tmp/h snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['XDG_CONFIG_HOME redirecting the config', 'XDG_CONFIG_HOME=/tmp/h snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['sudo running snow, which changes HOME', 'sudo -u admin snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['nice running snow', 'nice -n 5 snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['env running snow', 'env HOME=/tmp/h snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['an export with a quoted name', 'export SNOW"FLAKE_CONNECTIONS_ACME_DEV_ACCOUNT"=prod; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['an export with an escaped name', 'export SNOWFLAKE\\_HOME=/tmp/h; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a sourced env file', 'set -a; . /tmp/vars; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['PATH pointing at another snow', 'PATH=/tmp/bin:$PATH; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['an unexported SNOWFLAKE_ variable, which keeps an earlier export', 'SNOWFLAKE_HOME=/tmp/h; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['HOME set by a loop', 'for HOME in /tmp/h; do snow sql -c acme_dev -q "drop table dev_db.a.b"; done'],
        ['HOME set by a parameter default', 'echo ${HOME:=/tmp/h}; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a variable set by read', 'read -r HOME < /tmp/h; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a variable set by arithmetic', '(( n = 1 )); snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['PATH set by printf -v', `printf -v PATH '%s' /tmp/bin; snow sql -c acme_dev -q "drop table dev_db.a.b"`],
        ['PATH set by wait -p', 'sleep 1 & wait -p PATH; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a DEBUG trap', `trap 'PATH=/tmp/bin' DEBUG; snow sql -c acme_dev -q "drop table dev_db.a.b"`],
        ['Jinja templating', 'snow sql -c acme_dev --enable-templating JINJA -q "drop table dev_db.a.b"'],
        ['a glued --query= with a prod target beside a dev one', 'snow sql -c acme_dev -q "drop table dev_db.a.b" --query="drop table prod_db.a.b"'],
        ['SQL also arriving on stdin', 'snow sql -c acme_dev -q "drop table dev_db.a.b" <<EOF\ndrop table prod_db.a.b;\nEOF'],
        ['a prod SWAP after a dev drop', 'snow sql -c acme_prod -q "drop table scratch_db.a.b; alter table prod_db.a.b swap with prod_db.a.c"'],
        ['dropping the dev database itself', 'snow sql -c acme_prod -q "drop database scratch_db"'],
        ['a shell variable in the SQL', 'T=scratch_db.a.b; snow sql -c acme_prod -q "drop table $T"'],
        ['IDENTIFIER()', `snow sql -c acme_prod -q "drop table identifier('scratch_db.a.b')"`],
        ['EXECUTE IMMEDIATE', `snow sql -c acme_prod -q "execute immediate 'drop table prod_db.a.b'"`],
        ['an account override', 'snow sql -c acme_dev --account prod-account -q "drop table dev_db.a.b"'],
        ['a temporary connection', 'snow sql -c acme_dev -x -q "drop table dev_db.a.b"'],
        ['another config file', 'snow sql -c acme_dev --config-file /tmp/c.toml -q "drop table dev_db.a.b"'],
        ['a SNOWFLAKE_ prefix variable', 'SNOWFLAKE_ACCOUNT=prod snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['an exported SNOWFLAKE_ variable', 'export SNOWFLAKE_CONNECTIONS_ACME_DEV_ACCOUNT=prod; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['two connection flags', 'snow sql -c acme_dev -c acme_other -q "drop table dev_db.a.b"'],
        ['a connection held in a variable', 'C=acme_dev; snow sql -c $C -q "drop table dev_db.a.b"'],
        ['a function named snow defined on the line', 'snow() { command snow sql -c acme_other -q "$5"; }; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test('an inherited SNOWFLAKE_ variable keeps the prompt, since snow reads it', () => {
        process.env.SNOWFLAKE_CONNECTIONS_ACME_DEV_ACCOUNT = 'prod-account';
        try {
            expect(verdict('snow sql -c acme_dev -q "drop table dev_db.a.b"')).toBe('gate');
        } finally {
            delete process.env.SNOWFLAKE_CONNECTIONS_ACME_DEV_ACCOUNT;
        }
    });

    test('with no scope file nothing is exempt', () => {
        process.env[DEV_SCOPE_FILE_ENV] = join(dir, 'missing.json');
        expect(verdict('snow sql -c acme_dev -q "drop table dev_db.a.b"')).toBe('gate');
    });

    test('a malformed scope file exempts nothing', () => {
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, JSON.stringify({ snowflake: [{ connection: 'acme dev; drop' }] }));
        process.env[DEV_SCOPE_FILE_ENV] = bad;
        expect(verdict('snow sql -c acme_dev -q "drop table dev_db.a.b"')).toBe('gate');
    });

    test('an exempt step does not hide a gated one, and the description names the gated one', () => {
        const command = 'snow sql -c acme_dev -q "drop table dev_db.a.b" && snow sql -c acme_prod -q "drop table prod_db.core.orders"';
        const v = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(v.action).toBe('gate');
        expect(describeGate(command, v.reason!, '/tmp').label).toBe('Drop Snowflake table prod_db.core.orders');
    });
});

describe('a name that leaves out its database stays gated, whatever USE came before', () => {
    // A USE is not the only statement that moves the session: CREATE SCHEMA and CREATE DATABASE do too.
    test.each([
        'snow sql -c acme_dev -q "use schema dev_db.scratch; create or replace table orders as select 1"',
        'snow sql -c acme_dev -q "use database dev_db; drop table scratch.orders"',
        'snow sql -c acme_dev -q "use database dev_db; create schema prod_db.scratch_x; drop table s.t"',
        'snow sql -c acme_dev -q "use schema prod_db.core; drop table orders"',
    ])('%s', (command) => {
        expect(verdict(command)).toBe('gate');
    });
});

describe('SQL read from a file', () => {
    const file = (name: string, sql: string) => {
        const path = join(dir, name);
        writeFileSync(path, sql);
        return path;
    };

    test('a file whose every statement targets the dev database skips approval', () => {
        const f = file('dev.sql', 'drop table if exists dev_db.a.b;\ncreate or replace table dev_db.a.b (x int);\n');
        expect(verdict(`snow sql -c acme_dev -f ${f} 2>&1 | grep -i error`)).toBe('allow');
    });

    test('a file the same line writes with a heredoc is read from that heredoc', () => {
        const f = join(dir, 'fresh.sql');
        expect(verdict(`cat > ${f} <<'EOF'\ndrop table dev_db.a.b;\nEOF\nsnow sql -c acme_dev -f ${f}`)).toBe('allow');
        expect(verdict(`cat > ${f} <<'EOF'\ndrop table prod_db.a.b;\nEOF\nsnow sql -c acme_dev -f ${f}`)).toBe('gate');
    });

    test.each([
        ['a prod statement in the file', 'drop table dev_db.a.b;\ndrop table prod_db.a.b;', (f: string) => `snow sql -c acme_dev -f ${f}`],
        ['sed rewriting the file first', 'drop table dev_db.a.b;', (f: string) => `sed -i 's/dev_db/prod_db/' ${f}; snow sql -c acme_dev -f ${f}`],
        ['a program that could write the file first', 'drop table dev_db.a.b;', (f: string) => `python3 /tmp/gen.py; snow sql -c acme_dev -f ${f}`],
        ['grep output redirected over the file', 'drop table dev_db.a.b;', (f: string) => `grep -i drop /tmp/other.sql > ${f}; snow sql -c acme_dev -f ${f}`],
        ['a file path the line does not prove', 'drop table dev_db.a.b;', (_f: string) => 'snow sql -c acme_dev -f "$SQL_FILE"'],
        ['a file in a variable set from a command', 'drop table dev_db.a.b;', (f: string) => `F=$(ls ${f}); snow sql -c acme_dev -f "$F"`],
        ['a dev query beside a file the line may rewrite', 'drop table dev_db.a.b;', (f: string) => `python3 /tmp/gen.py; snow sql -c acme_dev -q "drop table dev_db.a.c" -f ${f}`],
    ])('%s stays gated', (_name, sql, line) => {
        expect(verdict(line(file('case.sql', sql)))).toBe('gate');
    });
});

describe('Snowflake temporary tables', () => {
    test.each([
        'snow sql -c acme_other -q "create or replace temporary table t as select 1"',
        'snow sql -q "create or replace temp table scratch (x int); select * from scratch"',
        'snow sql -c acme_dev -q "create or replace temporary table t as select 1; drop table dev_db.a.b"',
    ])('replacing one needs no approval: %s', (command) => {
        expect(verdict(command)).toBe('allow');
    });

    test.each([
        ['a permanent table', 'snow sql -q "create or replace table t as select 1"'],
        ['a transient table', 'snow sql -q "create or replace transient table t as select 1"'],
        ['a temporary table beside a prod drop', 'snow sql -q "create or replace temporary table t as select 1; drop table prod_db.a.b"'],
        ['another client', `psql -c "create or replace temp table t as select 1"`],
    ])('%s stays gated', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });
});

describe('where Snowflake splits SQL differently from the guard', () => {
    // Snowflake's connector reads `//` as a comment and `\\` as an escape inside quotes.
    test.each([
        ['a temp table hiding a drop behind //', `snow sql -c acme_other -q "create or replace temp table t (a int) // '\n; drop table prod_db.s.t; -- '"`],
        ['a temp table hiding a drop behind an escaped quote', `snow sql -c acme_other -q "create or replace temp table t as select 'a\\'' as c; drop table prod_db.s.t; select ''"`],
        ['a drop behind an escaped quote', `snow sql -c acme_other -q "select 'a\\'' ; drop table prod_db.s.t; select ''"`],
        ['a drop behind //', `snow sql -c acme_other -q "select 1 // '\n; drop table prod_db.s.t -- '"`],
        ['a dev drop beside a hidden prod drop', `snow sql -c acme_dev -q "drop table dev_db.a.b; select 'a\\'' ; drop table prod_db.s.t; select ''"`],
    ])('%s stays gated', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test('Jinja templating gates whatever the SQL looks like, since snow renders it first', () => {
        expect(verdict(`snow sql --enable-templating JINJA -c acme_other -q "{{ 'dr' ~ 'op' }} table prod_db.s.t"`)).toBe('gate');
        expect(verdict('snow sql -c acme_dev --enable-templating NONE -q "drop table dev_db.a.b"')).toBe('allow');
    });
});

describe('the scope file itself', () => {
    test.each([
        ['{"snowflake": []}', true],
        ['{"snowflake": [{"connection": "acme_dev", "databases": ["dev_db"]}]}', true],
        ['{"snowflake": [{"connection": "acme_dev"}]}', false],
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
