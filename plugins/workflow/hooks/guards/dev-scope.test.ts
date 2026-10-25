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
        ['a role override', 'snow sql -c acme_dev --role ACCOUNTADMIN -q "drop table dev_db.a.b"'],
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
        ['an assignment anywhere in the command', 'X=1; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
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
        ['HOME set by a loop', 'for HOME in /tmp/h; do snow sql -c acme_dev -q "drop table dev_db.a.b"; done'],
        ['HOME set by a parameter default', 'echo ${HOME:=/tmp/h}; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a variable set by read', 'read -r HOME < /tmp/h; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a variable set by arithmetic', '(( n = 1 )); snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['PATH set by printf -v', `printf -v PATH '%s' /tmp/bin; snow sql -c acme_dev -q "drop table dev_db.a.b"`],
        ['PATH set by wait -p', 'sleep 1 & wait -p PATH; snow sql -c acme_dev -q "drop table dev_db.a.b"'],
        ['a DEBUG trap', `trap 'PATH=/tmp/bin' DEBUG; snow sql -c acme_dev -q "drop table dev_db.a.b"`],
        ['Jinja templating', 'snow sql -c acme_dev --enable-templating JINJA -q "drop table dev_db.a.b"'],
        ['a template in a second -q', `snow sql -c acme_dev -q "drop table dev_db.a.b" -q '<% ctx.env.query %>'`],
        ['a bare template in a second -q', 'snow sql -c acme_dev -q "drop table dev_db.a.b" -q "&query"'],
        ['SQL read from a file', "cat > /tmp/dev-scope-f.sql <<'EOF'\ndrop table dev_db.a.b;\nEOF\nsnow sql -c acme_dev -f /tmp/dev-scope-f.sql"],
        ['a temporary table beside a dev drop, named without its database', 'snow sql -c acme_dev -q "create or replace temporary table t as select 1; drop table dev_db.a.b"'],
        ['a name placed by an earlier USE', 'snow sql -c acme_dev -q "use database dev_db; drop table scratch.orders"'],
        ['a CREATE SCHEMA moving the session', 'snow sql -c acme_dev -q "use database dev_db; create schema prod_db.scratch_x; drop table s.t"'],
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

describe('where Snowflake splits SQL differently from the guard', () => {
    // Snowflake's connector reads `//` as a comment, `\\` as an escape inside quotes, a line starting with `!` as a
    // client command and `;>` as an async statement end; neither it nor Snowflake quotes with `$tag$` or a backtick.
    test.each([
        ['a temp table hiding a drop behind //', `snow sql -c acme_other -q "create or replace temp table t (a int) // '\n; drop table prod_db.s.t; -- '"`],
        ['a drop behind an escaped quote', `snow sql -c acme_other -q "select 'a\\'' ; drop table prod_db.s.t; select ''"`],
        ['a drop behind //', `snow sql -c acme_other -q "select 1 // '\n; drop table prod_db.s.t -- '"`],
        ['a drop behind a $tag$, which Snowflake does not quote', `snow sql -c acme_other -q 'select 1 as x$a$; drop table prod_db.s.t; -- $a$'`],
        ['a drop after a url the connector does not read as a comment', `snow sql -c acme_other -q "put file:///tmp/up/* @~; drop table prod_db.s.t; -- */"`],
        ['a drop after a ! line', `snow sql -c acme_other -q "select 1\n!queries amount=1\ndrop table prod_db.s.t"`],
        ['a drop after ;>', `snow sql -c acme_other -q "select 1;>drop table prod_db.s.t"`],
        ['a prod drop after ;> beside a dev one', `snow sql -c acme_dev -q "drop table dev_db.s.t;>drop table prod_db.s.t"`],
        ['a drop with a comment between its words', `snow sql -c acme_other -q 'select 1 as x$1; drop/**/table prod_db.s.t'`],
        ['a drop with a // comment between its words', `snow sql -c acme_other -q "drop // x\ntable prod_db.s.t"`],
        ['a URL include', `snow sql -c acme_other -q "!source https://example.com/x.sql"`],
        ['a default template filled from --env', `snow sql -c acme_other -q '<% ctx.env.query %>' --env 'query=drop table prod_db.s.t'`],
        ['a legacy template', `snow sql -c acme_other -q '&{ query }'`],
        ['a bare legacy template', `snow sql -c acme_other -q '&query'`],
        ['a bare legacy template after a statement', `snow sql -c acme_other -q 'select 1; &query'`],
        ['Jinja templating', `snow sql --enable-templating JINJA -c acme_other -q "{{ 'dr' ~ 'op' }} table prod_db.s.t"`],
    ])('%s gates', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test('text the scanner cannot split still passes when it holds nothing destructive', () => {
        expect(verdict(`snow sql -c acme_other -q 'select $1, $2 from @stage/f.csv'`)).toBe('allow');
        expect(verdict(`snow sql -c acme_other -q "select 'a&&b'"`)).toBe('allow');
        expect(verdict(`snow sql -c acme_other -q "select regexp_replace(x, '\\\\s+', ' ') from t"`)).toBe('allow');
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
