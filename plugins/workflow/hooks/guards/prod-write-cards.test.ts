import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DBT_WRITE, DEV_SCOPE_FILE_ENV, SQL_EGRESS, SQL_WRITE, describeGate, devLoginTestHooks, evaluateBashCommand } from './block-destructive-core';

/**
 * PRODUCTION WRITES AND DATA LEAVING THE ACCOUNT. Off a target proven dev, SQL that writes at all takes a card, not only
 * SQL that deletes. Data sent out of the account takes one on any target, dev included. A target the guard can't name
 * is refused with the fix to write it out. Reads, and writes into a listed dev database, stay card-free.
 */

let dir = '';
let home = '';
const saved: Record<string, string | undefined> = {};
const realConfigLocked = devLoginTestHooks.configLocked;
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

beforeAll(() => {
    for (const k of ['HOME', DEV_SCOPE_FILE_ENV, 'OLDPWD']) saved[k] = process.env[k];
    delete process.env.OLDPWD;
    dir = mkdtempSync(join(tmpdir(), 'prod-write-cards-test-'));
    home = join(dir, 'home');
    mkdirSync(join(home, '.snowflake'), { recursive: true });
    writeFileSync(join(home, '.snowflake', 'connections.toml'), [
        '[acme_dev]', 'account = "ACME-DEV1"', 'user = "AGENT_DEV_USER"', 'authenticator = "SNOWFLAKE_JWT"',
        'private_key_path = "/home/node/.snowflake/keys/dev/rsa_key.p8"', '',
    ].join('\n'));
    writeFileSync(join(home, '.snowflake', 'config.toml'), '');
    mkdirSync(join(home, '.dbt'), { recursive: true });
    writeFileSync(join(home, '.dbt', 'profiles.yml'), [
        'acme:', '  target: dev', '  outputs:',
        '    dev:', '      type: snowflake', '      account: acme-dev1', '      database: dev_db',
        '    prod:', '      type: snowflake', '      account: acme-dev1', '      database: prod_db',
        'acme_prodfirst:', '  target: prod', '  outputs:',
        '    prod:', '      type: snowflake', '      account: acme-dev1', '      database: prod_db',
        'acme_far:', '  target: dev', '  outputs:',
        '    dev:', '      type: snowflake', '      account: far-acct1', '      database: dev_db', '',
    ].join('\n'));
    mkdirSync(join(dir, 'project'));
    mkdirSync(join(dir, 'project', 'models'));
    mkdirSync(join(dir, 'project', 'macros'));
    writeFileSync(join(dir, 'project', 'macros', 'ops.sql'), [
        "{% macro unload_orders() %}{% do run_query(\"copy into @dev_db.raw.out from dev_db.core.orders\") %}{% endmacro %}",
        "{% macro load_orders() %}{% do run_query(\"insert into prod_db.core.orders values (1)\") %}{% endmacro %}",
        "{% macro fill_dev() %}{% do run_query(\"insert into dev_db.core.t select 1\") %}{% endmacro %}",
        "{% macro count_orders() %}{% do run_query(\"select count(*) from dev_db.core.orders\") %}{% endmacro %}", '',
    ].join('\n'));
    mkdirSync(join(dir, 'farproject'));
    writeFileSync(join(dir, 'farproject', 'dbt_project.yml'), "name: far\nprofile: 'acme_far'\n");
    for (const [name, target] of [['retrydev', 'dev'], ['retryprod', 'prod'], ['retrynone', null], ['retrypath', 'dev'], ['retryfr', 'dev']] as const) {
        mkdirSync(join(dir, name, 'target'), { recursive: true });
        writeFileSync(join(dir, name, 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n" + (name === 'retrypath' ? 'target-path: elsewhere\n' : ''));
        if (target) writeFileSync(join(dir, name, 'target', 'run_results.json'), JSON.stringify({ args: { which: 'build', target, ...(name === 'retryfr' ? { full_refresh: true } : {}) } }));
    }
    writeFileSync(join(dir, 'project', 'load.py'), "import psycopg2\nc = psycopg2.connect('dbname=app')\nc.cursor().execute('insert into orders values (1)')\n");
    writeFileSync(join(dir, 'project', 'render-load.sql'), 'insert into orders values (1);\n');
    writeFileSync(join(dir, 'project', 'render-escape.sql'), 'insert into orders values (1);\n\\! ls\n');
    writeFileSync(join(dir, 'project', 'unload.sql'), "copy into 's3://example-bucket/x/' from dev_db.core.orders;\n");
    writeFileSync(join(dir, 'project', 'huge.sql'), 'select 1;\n'.repeat(120_000));
    writeFileSync(join(dir, 'project', 'migration.sql'), 'insert into orders values (1);\n');
    mkdirSync(join(dir, 'blockproj', 'ops'), { recursive: true });
    writeFileSync(join(dir, 'blockproj', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\nmacro-paths:\n  - ops\n");
    writeFileSync(join(dir, 'blockproj', 'ops', 'ops.sql'), [
        "{% macro wrapper() %}{% do unload_helper() %}{% endmacro %}",
        "{% macro unload_helper() %}{% do run_query(\"copy into @dev_db.raw.out from dev_db.core.orders\") %}{% endmacro %}",
        "{% macro block_unload() %}{% do run_query(\"copy into @dev_db.raw.out from dev_db.core.orders\") %}{% endmacro %}", '',
    ].join('\n'));
    mkdirSync(join(dir, 'retrynotarget', 'target'), { recursive: true });
    writeFileSync(join(dir, 'retrynotarget', 'dbt_project.yml'), "name: acme\nprofile: 'acme_prodfirst'\n");
    writeFileSync(join(dir, 'retrynotarget', 'target', 'run_results.json'), JSON.stringify({ args: { which: 'build' } }));
    mkdirSync(join(dir, 'analytics'));
    writeFileSync(join(dir, 'analytics', 'profiles.yml'), 'acme:\n  target: prod\n  outputs:\n    prod:\n      type: snowflake\n      database: prod_db\n');
    mkdirSync(join(dir, 'warehouse', 'target'), { recursive: true });
    writeFileSync(join(dir, 'warehouse', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n");
    writeFileSync(join(dir, 'warehouse', 'profiles.yml'), 'acme:\n  target: dev\n  outputs:\n    dev:\n      type: snowflake\n      database: dev_db\n');
    writeFileSync(join(dir, 'warehouse', 'target', 'run_results.json'), JSON.stringify({ args: { which: 'build', full_refresh: true } }));
    writeFileSync(join(dir, 'project', 'dev-load.sql'), 'insert into dev_db.core.orders values (1);\n');
    writeFileSync(join(dir, 'project', 'prod-load.sql'), 'insert into prod_db.core.orders values (1);\n');
    mkdirSync(join(dir, 'retryprofile', 'target'), { recursive: true });
    writeFileSync(join(dir, 'retryprofile', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n");
    writeFileSync(join(dir, 'retryprofile', 'target', 'run_results.json'), JSON.stringify({ args: { which: 'build', profile: 'acme_prodfirst' } }));
    mkdirSync(join(dir, 'sfproj'));
    writeFileSync(join(dir, 'sfproj', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\ndata_tests:\n  +store_failures: true\n");
    mkdirSync(join(dir, 'farproject', 'macros'), { recursive: true });
    writeFileSync(join(dir, 'farproject', 'macros', 'fill.sql'), "{% macro fill_far() %}{% do run_query(\"insert into acme_only.core.t select 1\") %}{% endmacro %}\n");
    writeFileSync(join(dir, 'project', 'load.js'), "const { Client } = require('pg');\nconst c = new Client();\nc.query('insert into orders values (1)');\n");
    writeFileSync(join(dir, 'project', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n");
    writeFileSync(join(dir, 'project', 'load.sql'), 'insert into orders values (1);\n');
    writeFileSync(join(dir, 'project', 'setup.sql'), '-- setup\nuse role ops_role;\ncreate database if not exists loads;\ncreate schema if not exists loads.raw;\ngrant usage on database loads to role loads_reader;\n');
    mkdirSync(join(dir, 'project', 'local'));
    writeFileSync(join(dir, 'project', 'local', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n");
    writeFileSync(join(dir, 'project', 'local', 'profiles.yml'), 'acme:\n  target: dev\n  outputs:\n    dev:\n      type: snowflake\n      database: dev_db\n');
    const scope = join(dir, 'dev-scope.local.json');
    writeFileSync(scope, JSON.stringify({
        snowflake: [
            { connection: 'acme_dev', databases: ['dev_db'], login: { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) } },
            { connection: 'acme_shared', databases: ['dev_db'] },
        ],
        render: { resources: ['dpg-devdatabase000000001-a'] },
    }));
    process.env.HOME = home;
    process.env[DEV_SCOPE_FILE_ENV] = scope;
    devLoginTestHooks.configLocked = () => true;
});

afterAll(() => {
    devLoginTestHooks.configLocked = realConfigLocked;
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
});

const evaluate = (command: string) => evaluateBashCommand(command.replaceAll('PROJECT', join(dir, 'project')), { cwd: dir });
const escaped = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

const PG = 'psql -h db.example -U app -d app';
const DEV_PG = 'psql -X -h dpg-devdatabase000000001-a.oregon-postgres.render.com -U app -d app';

describe('a write to a target not proven dev takes the card', () => {
    test.each([
        ['Postgres INSERT', PG + ' -c "insert into orders values (1)"'],
        ['Postgres UPDATE with a WHERE', PG + ' -c "update orders set status = \'x\' where id = 1"'],
        ['Postgres ALTER TABLE', PG + ' -c "alter table orders add column note text"'],
        ['Postgres CREATE TABLE', PG + ' -c "create table orders_copy (id int)"'],
        ['Postgres GRANT', PG + ' -c "grant select on orders to reporting"'],
        ['Postgres \\copy FROM a file', PG + ' -c "\\copy orders from \'orders.csv\' csv"'],
        ['Postgres SELECT INTO a new table', PG + ' -c "select * into orders_copy from orders"'],
        ['Postgres EXPLAIN ANALYZE of an INSERT', PG + ' -c "explain analyze insert into orders values (1)"'],
        ['Postgres writing CTE', PG + ' -c "with n as (insert into orders values (1) returning id) select * from n"'],
        ['pg_restore into a database', 'pg_restore -h db.example -U app -d app dump.pgdump'],
        ['Snowflake INSERT on a prod-capable connection', 'snow sql -c acme_prod -q "insert into prod_db.core.orders values (1)"'],
        ['Snowflake COPY INTO a table', 'snow sql -c acme_prod -q "copy into prod_db.core.orders from @prod_db.core.landing"'],
        ['Snowflake CREATE TABLE AS', 'snow sql -c acme_prod -q "create table prod_db.core.t2 as select 1 x"'],
        ['Snowflake CALL', 'snow sql -c acme_prod -q "call prod_db.core.refresh()"'],
        ['Snowflake unqualified INSERT on a listed connection with no login', 'snow sql -c acme_shared -q "insert into orders values (1)"'],
        ['Snowflake write outside the dev database on that connection', 'snow sql -c acme_shared -q "insert into prod_db.core.orders select * from dev_db.s.t"'],
        ['dbt on a prod target', 'cd PROJECT && dbt run --target prod'],
        ['dbt with another profiles file', 'cd PROJECT && dbt build --profiles-dir .'],
        ['dbt with a variable that names a database', "cd PROJECT && dbt build --vars '{target_database: prod_db}'"],
        ['dbt where a profiles.yml in the working directory would be read first', 'cd PROJECT/local && dbt build'],
        ['dbt after a cd and a copy that could put a project in the start directory', 'cd PROJECT; cp -r PROJECT/local/. .; dbt build'],
        ['dbt after a cd and a checkout that could put a project in the start directory', 'cd PROJECT; git checkout main; dbt build'],
        ['a task in the dev database whose body writes prod, on a connection with no login', 'snow sql -c acme_shared -q "create task dev_db.s.t warehouse = w as insert into prod_db.core.orders values (1)"'],
        ['snow stage execute, which runs SQL files the guard cannot read', 'snow stage execute @dev_db.s.code/x.sql'],
        ['psql running SQL held in a -v variable', "psql -h db.example -v q='insert into orders values (1)' <<<':q'"],
    ])('%s', (_name, command) => {
        const result = evaluate(command);
        expect(result.action).toBe('gate');
        expect(result.reason).toMatch(new RegExp(escaped(SQL_WRITE) + '|' + escaped(DBT_WRITE)));
    });
});

describe('data leaving the account takes the card on any target, dev included', () => {
    test.each([
        ['COPY INTO a stage on a dev login', 'snow sql -c acme_dev -q "copy into @dev_db.s.out from prod_db.core.orders"'],
        ['COPY INTO an external URL on a dev login', 'snow sql -c acme_dev -q "copy into \'s3://example-bucket/x/\' from prod_db.core.orders"'],
        ['GET from a stage on a dev login', 'snow sql -c acme_dev -q "get @dev_db.s.out file:///tmp/out/"'],
        ['a share on a dev login', 'snow sql -c acme_dev -q "create share dev_share"'],
        ['adding accounts to a share', 'snow sql -c acme_prod -q "alter share s add accounts = partner_org.partner_acct"'],
        ['a grant to a share in the dev database', 'snow sql -c acme_shared -q "grant select on table dev_db.s.t to share s"'],
        ['a reader account', 'snow sql -c acme_prod -q "create managed account reader admin_name = \'r\', admin_password = $READER_PW, type = reader"'],
        ['a COPY INTO a stage inside EXECUTE IMMEDIATE on a dev login', 'snow sql -c acme_dev -q "execute immediate \'copy into @dev_db.s.out from prod_db.core.orders\'"'],
        ['Postgres COPY TO a server file', PG + ' -c "copy orders to \'/tmp/orders.csv\'"'],
        ['Postgres lo_export', PG + ' -c "select lo_export(42, \'/tmp/blob\')"'],
        ['Postgres COPY TO a file on a listed dev database', DEV_PG + ' -c "copy orders to \'/tmp/orders.csv\'"'],
        ['COPY FILES INTO a stage on a dev login', 'snow sql -c acme_dev -q "copy files into @dev_db.s.out from @prod_db.s.src"'],
        ['snow stage copy downloading a stage', 'snow stage copy @dev_db.s.out ./local/'],
    ])('%s', (_name, command) => {
        const result = evaluate(command);
        expect(result.action).toBe('gate');
        expect(result.reason).toStartWith(SQL_EGRESS);
    });

    test('a reader account with its password written out is refused, so the password never reaches a card', () => {
        expect(evaluate('snow sql -c acme_prod -q "create managed account reader admin_name = \'r\', admin_password = \'x\', type = reader"').reason).toContain('literal credential');
    });

    test('SQL a dev login builds where the guard cannot read it runs as it does on main', () => {
        expect(evaluate('snow sql -c acme_dev -q "execute immediate \'cop\' || \'y into @dev_db.s.out from prod_db.core.orders\'"').action).toBe('allow');
    });
});

describe('a target the guard cannot name is refused with the fix to write it out', () => {
    test.each([
        ['Postgres through a URL in a variable', 'psql "$DATABASE_URL" -c "insert into orders values (1)"', 'write its host out'],
        ['snow on its default connection', 'snow sql -q "insert into prod_db.core.orders values (1)"', 'Write the connection out'],
        ['snow on a connection in a variable', 'C=acme_prod; snow sql -c "$C" -q "insert into prod_db.core.orders values (1)"', 'Write the connection out'],
        ['pg_restore through a URL in a variable', 'pg_restore -d "$DATABASE_URL" dump.pgdump', 'Write the server out'],
    ])('%s', (_name, command, fix) => {
        const result = evaluate(command);
        expect(result.action).toBe('block');
        expect(result.reason).toContain(fix);
    });
});

describe('reads, and writes into a listed dev target, stay card-free', () => {
    test.each([
        ['a prod read', PG + ' -c "select count(*) from orders"'],
        ['a prod read on Snowflake', 'snow sql -c acme_prod -q "select * from prod_db.core.orders limit 10"'],
        ['Postgres COPY TO STDOUT', PG + ' -c "copy (select * from orders) to stdout with csv"'],
        ['psql \\copy to a local file', PG + ' -c "\\copy orders to \'orders.csv\' csv"'],
        ['a temporary table', 'snow sql -c acme_prod -q "create temporary table t (x int)"'],
        ['a dev login writing', 'snow sql -c acme_dev -q "insert into dev_db.s.t values (1)"'],
        ['a dev write that reads prod, on a connection with no login', 'snow sql -c acme_shared -q "insert into dev_db.s.t select * from prod_db.core.orders"'],
        ['a dev table built from prod, on a connection with no login', 'snow sql -c acme_shared -q "create table dev_db.s.t2 as select * from prod_db.core.orders"'],
        ['a write on a listed dev Postgres', DEV_PG + ' -c "insert into orders values (1)"'],
        ['dbt on the default target', 'cd PROJECT && dbt build --select orders'],
        ['dbt on the dev target', 'cd PROJECT && dbt run --target dev'],
        ['dbt after a cd that may fail, from a start directory with no project', 'cd PROJECT; dbt build --select orders'],
        ['pg_restore listing a dump', 'pg_restore -l dump.pgdump'],
        ['a share named in a read', 'snow sql -c acme_prod -q "show grants to share s"'],
        ['an ampersand in a literal on a dev login', "snow sql -c acme_dev -q \"select 'P&L' as x\""],
        ['listing a stage', 'snow stage list-files @dev_db.s.out'],
    ])('%s', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
});

describe('database code run by an interpreter goes through the same readers', () => {
    test.each([
        ['psycopg2 INSERT', 'python3 -c "import psycopg2; psycopg2.connect(\'host=db.example\').cursor().execute(\'insert into orders values (1)\')"'],
        ['snowflake connector DROP', 'python3 -c "from snowflake import connector; connector.connect(connection_name=\'acme_prod\').cursor().execute(\'drop table prod_db.core.orders\')"'],
        ['tsx run through npx, with pg', 'npx tsx -e "import pg from \'pg\'; new pg.Client().query(\'update orders set a = 1 where id = 1\')"'],
        ['node pg UPDATE', 'node -e "const { Client } = require(\'pg\'); new Client().query(\'update orders set a = 1 where id = 2\')"'],
        ['psql launched from python', 'python3 -c "import subprocess; subprocess.run([\'psql\', \'-h\', \'db.example\', \'-c\', \'delete from orders\'])"'],
        ['a command list whose connection comes from the environment', 'python3 -c "import os, subprocess; cmd = [\'psql\', os.environ[\'DATABASE_URL\'], \'-c\', \'delete from orders\']; subprocess.run(cmd)"'],
        ['a psql launch in a template placeholder', "node -e 'const { execSync } = require(\"child_process\"); console.log(`${execSync(\"psql -h db.example -c \\\"delete from orders\\\"\")}`)'"],
        ['a psql launch inside a string the code runs', 'python3 -c "exec(\\"import subprocess; subprocess.run([\'psql\', \'-h\', \'db.example\', \'-c\', \'delete from orders\'])\\")"'],
        ['a written .sql path the code opens, whose file writes', "python3 - <<'EOF'\nimport psycopg2\npsycopg2.connect().cursor().execute(open('PROJECT/load.sql').read())\nEOF"],
    ])('%s takes the card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });

    test.each([
        ['a read through psycopg2', 'python3 -c "import psycopg2; psycopg2.connect(\'host=db.example\').cursor().execute(\'select 1\')"'],
        ['code that names a driver only in a string', 'python3 -c "print(\'import psycopg2\')"'],
        ['code with no database', 'python3 -c "print(\'Update complete\')"'],
        ['a list of program names that starts with snow', 'python3 -c "tools = [\'snow\', \'dbt\', \'render\']; print(len(tools))"'],
        ['SQL a script loads from a file the guard cannot open', "python3 - <<'EOF'\nimport psycopg2\npsycopg2.connect().cursor().execute(open('missing.sql').read())\nEOF"],
        ['SQL the code builds from a variable', 'python3 -c "import sys, psycopg2; psycopg2.connect(\'host=db.example\').cursor().execute(sys.argv[1])"'],
        ['psql launched with SQL from a variable', 'python3 -c "import os, subprocess; subprocess.run([\'psql\', \'-h\', \'db.example\', \'-c\', os.environ[\'Q\']])"'],
    ])('%s stays card-free', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
});

describe('SQL a verified dev login runs where the guard cannot read it runs as it does on main', () => {
    test.each([
        ['the output of a program piped into snow', 'some-program | snow sql -c acme_dev -i'],
        ['a template that config fills', "snow sql -c acme_dev -q 'select <% ctx.env.x %>'"],
        ['a URL snow fetches', 'snow sql -c acme_dev -q "!source https://example.test/x.sql"'],
    ])('%s', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
});

describe('SQL the guard cannot read is not a silent allow', () => {
    test.each([
        ['SQL a command builds', PG + ' -c "$(cat q.sql)"'],
        ['SQL wholly from a variable the line does not set', PG + ' -c "$SQL"'],
        ['a here-string from such a variable', PG + ' <<<"$SQL"'],
        ['the output of a program piped into psql', 'python3 gen.py | ' + PG],
        ['the output of a program piped into snow off dev', 'some-program | snow sql -c acme_prod -i'],
        ['a $ inside a name that hides a statement from the scanner', "snow sql -c acme_prod -q 'select a$$b; insert into prod_db.core.orders values (1)'"],
    ])('%s', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
});

test('a snow connection from a variable is a connection, not SQL: a read runs and a write is refused with the fix', () => {
    expect(evaluate('snow sql -c "$CONN" -q "select 1"').action).toBe('allow');
    const write = evaluate('snow sql -c "$CONN" -q "insert into t values (1)"');
    expect(write.action).toBe('block');
    expect(write.reason).toContain('Write the connection out');
});

test('a script that holds a psql launch only as sample text in a string stays card-free', () => {
    const script = join(dir, 'samples.ts');
    writeFileSync(script, "const rows = [\n  `python3 -c \"import subprocess; subprocess.run(['psql', '-c', 'drop table t'])\"`,\n];\nconsole.log(rows.length);\n");
    expect(evaluate(`bun ${script}`).action).toBe('allow');
});

describe('a standing grant keeps its statement classes card-free on its connection', () => {
    let previous: string | undefined;
    const withGrants = (grants: unknown) => {
        const scope = join(dir, 'dev-scope-grants.local.json');
        writeFileSync(scope, JSON.stringify({
            snowflake: [{ connection: 'acme_dev', databases: ['dev_db'], login: { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) } }],
            standingGrants: grants,
        }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
    };
    beforeAll(() => { previous = process.env[DEV_SCOPE_FILE_ENV]; });
    beforeEach(() => withGrants({ acme_ops: ['CREATE DATABASE', 'CREATE WAREHOUSE', 'ALTER WAREHOUSE', 'CREATE SHARE', 'ALTER SHARE ADD ACCOUNTS', 'CREATE MANAGED ACCOUNT', 'GRANT SELECT TO SHARE', 'GRANT REFERENCE_USAGE TO SHARE'] }));
    afterAll(() => { process.env[DEV_SCOPE_FILE_ENV] = previous; });

    test.each([
        ['a database', 'snow sql -c acme_ops -q "create database if not exists analytics_tools"'],
        ['a warehouse, then resizing it', 'snow sql -c acme_ops -q "create warehouse ops_wh warehouse_size = xsmall; alter warehouse ops_wh set warehouse_size = small"'],
        ['a share, a grant to it and a consumer account', 'snow sql -c acme_ops -q "create share sales_share; grant select on table prod_db.core.orders to share sales_share; alter share sales_share add accounts = partner_org.partner_acct"'],
        ['a reader account', "snow sql -c acme_ops -q \"create managed account reader_one admin_name = 'r1', admin_password = 'Example-pass-1', type = reader\""],
        ['a granted class beside a read', 'snow sql -c acme_ops -q "select 1; create database scratch_tools"'],
        ['a granted class after a literal umask', 'umask 077; snow sql -c acme_ops -q "create database if not exists analytics_tools"'],
    ])('%s runs without a card', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test.each([
        ['a class the connection is not granted', 'snow sql -c acme_ops -q "insert into prod_db.core.orders values (1)"'],
        ['a granted class beside one it is not', 'snow sql -c acme_ops -q "create database scratch_tools; insert into prod_db.core.orders values (1)"'],
        ['a privilege on a share it is not granted', 'snow sql -c acme_ops -q "grant usage on database prod_db to share sales_share"'],
        ['a destructive statement', 'snow sql -c acme_ops -q "drop database scratch_tools"'],
        ['a role switch before a granted class', 'snow sql -c acme_ops -q "use role accountadmin; create database scratch_tools"'],
        ['a granted class on a connection without the grant', 'snow sql -c acme_prod -q "create database scratch_tools"'],
        ['a granted class with a role option', 'snow sql -c acme_ops --role accountadmin -q "create database scratch_tools"'],
        ['a granted class after a hash that repoints snow', 'hash -p /tmp/bin/snow snow; snow sql -c acme_ops -q "create database scratch_tools"'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });

    test('the grant list is empty unless the file names one', () => {
        withGrants({});
        expect(evaluate('snow sql -c acme_ops -q "create database scratch_tools"').action).toBe('gate');
    });

    test('a class the guard does not know voids the whole dev-scope file', () => {
        withGrants({ acme_ops: ['CREATE DATABASE', 'INSERT'] });
        expect(evaluate('snow sql -c acme_ops -q "create database scratch_tools"').action).toBe('gate');
        expect(evaluate('snow sql -c acme_dev -q "drop table dev_db.s.t"').action).toBe('gate');
    });
});

describe('the account-admin standing grant, with the roles a connection may switch to', () => {
    let previous: string | undefined;
    beforeAll(() => {
        previous = process.env[DEV_SCOPE_FILE_ENV];
        const scope = join(dir, 'dev-scope-admin.local.json');
        writeFileSync(scope, JSON.stringify({
            snowflake: [{ connection: 'acme_dev', databases: ['dev_db'], login: { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) } }],
            standingGrants: { acme_ops: ['account-admin'] },
            ownRoles: { acme_ops: ['OPS_ROLE'] },
        }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
    });
    afterAll(() => { process.env[DEV_SCOPE_FILE_ENV] = previous; });

    test.each([
        ['a setup script under its own role', 'snow sql -c acme_ops -q "use role ops_role; create database if not exists loads; create schema if not exists loads.raw; create role if not exists loads_reader; grant usage on database loads to role loads_reader; grant role loads_reader to role ops_role"'],
        ['a warehouse and a notification integration', "snow sql -c acme_ops -q \"create warehouse if not exists loads_wh warehouse_size = xsmall; create notification integration if not exists loads_events enabled = true type = queue\""],
        ['a task whose body reads', 'snow sql -c acme_ops -q "create task loads.raw.ping warehouse = loads_wh schedule = \'60 minute\' as select 1"'],
        ['a share with its grants and a reader account', "snow sql -c acme_ops -q \"create share loads_share; grant usage on database loads to share loads_share; grant select on table loads.raw.t to share loads_share; create managed account loads_reader admin_name = 'r1', admin_password = 'Example-pass-1', type = reader\""],
        ['a revoke from a role', 'snow sql -c acme_ops -q "revoke usage on warehouse loads_wh from role loads_reader"'],
        ['a setup file it reads', 'snow sql -c acme_ops -f PROJECT/setup.sql'],
    ])('%s runs without a card', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test.each([
        ['DML into an existing table', 'snow sql -c acme_ops -q "insert into loads.raw.t values (1)"'],
        ['COPY INTO a table', "snow sql -c acme_ops -q \"copy into loads.raw.t from @loads.raw.stage\""],
        ['an unload', 'snow sql -c acme_ops -q "copy into @loads.raw.stage from loads.raw.t"'],
        ['a task whose body writes', 'snow sql -c acme_ops -q "create task loads.raw.fill warehouse = loads_wh schedule = \'60 minute\' as insert into loads.raw.t values (1)"'],
        ['a switch to a role it is not given', 'snow sql -c acme_ops -q "use role accountadmin; create database loads"'],
        ['a grant to a user', 'snow sql -c acme_ops -q "grant role loads_reader to user someone"'],
        ['a new table, which the class leaves out', 'snow sql -c acme_ops -q "create table loads.raw.t2 (id int)"'],
        ['a storage integration, which the class leaves out', "snow sql -c acme_ops -q \"create storage integration ext type = external_stage storage_provider = 's3' enabled = true storage_allowed_locations = ('s3://example-bucket/')\""],
        ['a destructive statement', 'snow sql -c acme_ops -q "drop role loads_reader"'],
        ['the class on a connection without it', 'snow sql -c acme_prod -q "create database loads"'],
        ['a setup file that also loads a table', 'snow sql -c acme_ops -f PROJECT/load.sql'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });

    test('a setup file that is not there yet is refused with the fix, not exempt', () => {
        expect(evaluate('snow sql -c acme_ops -f PROJECT/not-there.sql').action).toBe('block');
    });

    test('an own role outside the list voids the file', () => {
        const scope = join(dir, 'dev-scope-badrole.local.json');
        writeFileSync(scope, JSON.stringify({ snowflake: [{ connection: 'acme_dev', databases: ['dev_db'] }], standingGrants: { acme_ops: ['account-admin'] }, ownRoles: { acme_ops: ['ops role'] } }));
        const saved = process.env[DEV_SCOPE_FILE_ENV];
        process.env[DEV_SCOPE_FILE_ENV] = scope;
        try {
            expect(evaluate('snow sql -c acme_ops -q "create database loads"').action).toBe('gate');
        } finally {
            process.env[DEV_SCOPE_FILE_ENV] = saved;
        }
    });
});

describe('the card says what the step does', () => {
    test('a write names its statement and that the target is not proven dev', () => {
        const command = 'snow sql -c acme_prod -q "insert into prod_db.core.orders values (1)"';
        const card = describeGate(command, evaluate(command).reason ?? '', dir);
        expect(card.label).toBe('INSERT in Snowflake PROD_DB.CORE.ORDERS');
        expect(card.summary).toContain("on a target the guard can't prove is dev");
    });

    test('data sent out leads the card and says it cannot be called back', () => {
        const command = 'snow sql -c acme_dev -q "copy into \'s3://example-bucket/x/\' from prod_db.core.orders"';
        const card = describeGate(command, evaluate(command).reason ?? '', dir);
        expect(card.label).toBe('Send Snowflake data out of the account (COPY INTO a stage or external location)');
        expect(card.summary).toContain("can't be called back");
    });
});

describe('SQL that writes or sends out, read the way the server reads it', () => {
    test.each([
        ['a MATERIALIZED CTE that inserts', PG + ' -c "with n as materialized (insert into orders values (1) returning id) select * from n"'],
        ['EXPLAIN ANALYZE of a writing CTE', PG + ' -c "explain analyze with n as (insert into orders values (1) returning id) select * from n"'],
        ['COMMIT PREPARED', PG + " -c \"commit prepared 'tx1'\""],
        ['\\lo_import', PG + " -c \"\\\\lo_import '/srv/x.bin'\""],
        ['\\copy into a quoted table name with a space', PG + " -c \"\\\\copy \\\"my orders\\\" from 'orders.csv' csv\""],
        ['enabling a Snowflake task graph', "snow sql -c acme_prod -q \"select system\$task_dependents_enable('prod_db.core.root')\""],
    ])('%s takes the write card', (_name, command) => {
        const verdict = evaluate(command);
        expect(verdict.action).toBe('gate');
        expect(verdict.reason).toContain(SQL_WRITE);
    });

    test('\\lo_unlink keeps a card', () => {
        expect(evaluate(PG + ' -c "\\\\lo_unlink 1234"').action).toBe('gate');
    });

    test.each([
        ['adding a table to a publication', DEV_PG + ' -c "alter publication pub add table orders"'],
        ['a literal unload under --enable-templating on the dev login', "snow sql -c acme_dev --enable-templating JINJA -q \"copy into 's3://example-bucket/x/' from dev_db.core.orders\""],
        ['snow stage copy down to this machine, with its connection option first', 'snow stage copy -c acme_dev @dev_db.raw.s/x ./out'],
        ['snow git copy down to this machine', 'snow git copy --connection acme_dev @dev_db.raw.repo/branches/main/ ./out'],
    ])('%s takes the egress card', (_name, command) => {
        const verdict = evaluate(command);
        expect(verdict.action).toBe('gate');
        expect(verdict.reason).toStartWith(SQL_EGRESS);
    });

    test.each([
        ['a stage path that holds the word', 'snow sql -c acme_dev -q "copy into @dev_db.raw.s/validation_mode/ from dev_db.core.orders"'],
        ['a column named for it in the query', 'snow sql -c acme_dev -q "copy into @dev_db.raw.s from (select 1 as validation_mode from dev_db.core.orders)"'],
    ])('an unload with VALIDATION_MODE only in %s takes the egress card', (_name, command) => {
        expect(evaluate(command).reason).toStartWith(SQL_EGRESS);
    });

    test('snow stage copy with an option the reference does not list keeps a card', () => {
        expect(evaluate('snow stage copy --made-up-option ./a @dev_db.raw.s/').action).toBe('gate');
    });

    test.each([
        ['EXPLAIN (ANALYZE FALSE) of an INSERT', PG + ' -c "explain (analyze false) insert into orders values (1)"'],
        ['a Snowflake load checked with VALIDATION_MODE', 'snow sql -c acme_prod -q "copy into prod_db.core.orders from @prod_db.core.s validation_mode = return_errors"'],
        ['a Snowflake unload checked with VALIDATION_MODE', 'snow sql -c acme_prod -q "copy into @prod_db.core.s from prod_db.core.orders validation_mode = return_rows"'],
    ])('%s only reads', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
});

describe('dbt targets read the way dbt reads them', () => {
    test.each([
        ['a target before the subcommand', 'cd PROJECT && dbt --target prod build'],
        ['an attached -t', 'cd PROJECT && dbt build -tprod'],
        ['a later --target', 'cd PROJECT && dbt build --target dev --target prod'],
        ['an exported DBT_TARGET earlier on the line', 'cd PROJECT && export DBT_TARGET=prod; dbt build'],
        ['a runner that starts dbt', 'cd PROJECT && uv run dbt build --target prod'],
        ['a subdirectory of the project on another target', 'cd PROJECT/models && dbt build --target prod'],
        ['dbt test that stores failures on another target', 'cd PROJECT && dbt test --store-failures --target prod'],
        ['a dev database name on another account', 'cd __DIR__/farproject && dbt build'],
        ['dbt retry of a prod run', 'cd __DIR__/retryprod && dbt retry'],
        ['dbt retry with no saved run to read', 'cd __DIR__/retrynone && dbt retry'],
        ['a macro that writes outside the dev target', 'cd PROJECT && dbt run-operation load_orders'],
        ['a macro that writes outside the dev target, from a project subdirectory', 'cd PROJECT/models && dbt run-operation load_orders'],
        ['a runner option before run', 'cd PROJECT && uv --directory PROJECT run dbt build'],
        ['a runner directory option', 'cd PROJECT && poetry -C PROJECT run dbt build'],
        ['a runner env file', 'cd PROJECT && uv run --env-file prod.env dbt build'],
        ['a runner directory after run', 'cd PROJECT && uv run --directory PROJECT dbt build'],
        ['dbt retry where the project moves its target path', 'cd __DIR__/retrypath && dbt retry'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command.replaceAll('__DIR__', dir)).action).toBe('gate');
    });

    test('dbt retry with DBT_STATE set keeps its card', () => {
        process.env.DBT_STATE = join(dir, 'retrydev', 'target');
        try {
            expect(evaluate('cd ' + join(dir, 'retrydev') + ' && dbt retry').action).toBe('gate');
        } finally {
            delete process.env.DBT_STATE;
        }
    });

    test.each([['PROJECT'], ['PROJECT/models']])('a macro that unloads takes the egress card on the dev target, from %s', (at) => {
        const verdict = evaluate('cd ' + at + ' && dbt run-operation unload_orders');
        expect(verdict.action).toBe('gate');
        expect(verdict.reason).toStartWith(SQL_EGRESS);
    });

    test.each([
        ['a runner that starts dbt on the dev target', 'cd PROJECT && uv run dbt build'],
        ['a subdirectory of the project, whose project dbt finds above it', 'cd PROJECT/models && dbt build'],
        ['dbt test that stores failures in the dev target', 'cd PROJECT && dbt test --store-failures'],
        ['dbt retry of a dev run', 'cd __DIR__/retrydev && dbt retry'],
        ['a macro that only reads', 'cd PROJECT && dbt run-operation count_orders'],
        ['a macro that writes into the dev database', 'cd PROJECT && dbt run-operation fill_dev'],
        ['a macro that writes into the dev database, after a cd that may fail from a start directory with no project', 'cd PROJECT; dbt run-operation fill_dev'],
        ['dbt seed --full-refresh on the dev target, as on main', 'cd PROJECT && dbt seed --full-refresh'],
    ])('%s runs without a card', (_name, command) => {
        expect(evaluate(command.replaceAll('__DIR__', dir)).action).toBe('allow');
    });

    test('an account the dev-scope entry names for dbt counts as dev', () => {
        const previous = process.env[DEV_SCOPE_FILE_ENV];
        const scope = join(dir, 'dev-scope-dbt-accounts.local.json');
        writeFileSync(scope, JSON.stringify({ snowflake: [{ connection: 'acme_dev', databases: ['dev_db'], dbtAccounts: ['FAR-ACCT1'] }] }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
        try {
            expect(evaluate('cd ' + join(dir, 'farproject') + ' && dbt build').action).toBe('allow');
        } finally {
            process.env[DEV_SCOPE_FILE_ENV] = previous;
        }
    });
});

describe('interpreter code reaches the scanner', () => {
    test.each([
        ['a driver imported beside another module', "python3 -c \"import os, psycopg2; psycopg2.connect('dbname=app').cursor().execute('insert into orders values (1)')\""],
        ['a script handed on stdin', 'python3 < PROJECT/load.py'],
        ['a script after a preloaded module', 'node -r dotenv/config PROJECT/load.js'],
        ['a deno script after its bare -r', 'deno run -r PROJECT/load.js'],
        ['a literal EXPLAIN ANALYZE that writes', "python3 -c \"import psycopg2; psycopg2.connect('dbname=app').cursor().execute('explain analyze insert into orders values (1)')\""],
        ['a literal REFRESH MATERIALIZED VIEW', "python3 -c \"import psycopg2; psycopg2.connect('dbname=app').cursor().execute('refresh materialized view order_totals')\""],
        ['a literal INSERT ALL', "python3 -c \"import snowflake.connector as s; s.connect().cursor().execute('insert all into a values (1) into b values (2) select 1')\""],
    ])('%s takes a card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
});

describe('what main ran without a card still does', () => {
    test.each([
        ['a fully qualified task whose body reads, on a listed connection with no login', "snow sql -c acme_shared -q \"create or replace task dev_db.core.ping warehouse = wh schedule = '60 minute' as select 1\""],
        ['suspending a task in the dev database', 'snow sql -c acme_shared -q "alter task dev_db.core.fill suspend"'],
        ['a task changed with SET, as on main', 'snow sql -c acme_shared -q "alter task dev_db.core.fill set warehouse = wh2"'],
        ['dropping a task in the dev database, as on main', 'snow sql -c acme_shared -q "drop task dev_db.core.fill"'],
        ['replacing a task whose body deletes from the dev database', "snow sql -c acme_shared -q \"create or replace task dev_db.core.trim warehouse = wh schedule = '60 minute' as delete from dev_db.core.t where d < current_date\""],
        ['a readable -f file on Render dev', DEV_PG + ' -f PROJECT/render-load.sql'],
        ['a task whose body writes into the dev database', "snow sql -c acme_shared -q \"create or replace task dev_db.core.fill warehouse = wh schedule = '60 minute' as insert into dev_db.core.t select 1\""],
        ['a literal \\copy FROM a file on Render dev', DEV_PG + " -c \"\\\\copy orders from 'orders.csv' csv\""],
        ['a literal dev write after a PGPASSWORD prefix', 'PGPASSWORD=example ' + DEV_PG + ' -c "insert into orders values (1)"'],
    ])('%s runs without a card', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test.each([
        ['an alert, whose action follows THEN', "snow sql -c acme_shared -q \"create or replace alert dev_db.core.a warehouse = wh schedule = '1 minute' if (exists (select 1)) then insert into prod_db.core.t select 1\""],
        ['a task whose body writes outside the dev database', "snow sql -c acme_shared -q \"create or replace task dev_db.core.fill warehouse = wh schedule = '60 minute' as insert into prod_db.core.t select 1\""],
        ['\\copy FROM a program on Render dev', DEV_PG + " -c \"\\\\copy orders from program 'cat orders.csv' csv\""],
        ['\\copy beside a shell escape on Render dev', DEV_PG + " -c \"\\\\copy orders from 'orders.csv' csv\" -c '\\\\! ls'"],
        ['PGHOST beside PGPASSWORD', 'PGPASSWORD=example PGHOST=db.example ' + DEV_PG + ' -c "insert into orders values (1)"'],
        ['PGSERVICE', 'PGSERVICE=prod ' + DEV_PG + ' -c "insert into orders values (1)"'],
        ['resuming a task, which starts what it holds', 'snow sql -c acme_shared -q "alter task dev_db.core.fill resume"'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).not.toBe('allow');
    });

    describe('in a lab session', () => {
        let profile: string | undefined;
        beforeAll(() => { profile = process.env.NANOCLAW_INSTRUCTIONS_PROFILE; process.env.NANOCLAW_INSTRUCTIONS_PROFILE = 'lab'; });
        afterAll(() => {
            if (profile === undefined) delete process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
            else process.env.NANOCLAW_INSTRUCTIONS_PROFILE = profile;
        });
        test('unreadable SQL on a lab database runs as on main', () => {
            expect(evaluate('psql -d lab_app -f "$F"').action).toBe('allow');
        });
        test('a literal unload from a lab database keeps its card', () => {
            expect(evaluate('psql -d lab_app -c "select lo_export(1, \'/srv/out.bin\')"').action).not.toBe('allow');
        });
    });
});

describe('egress through a target that cannot be named is refused with the fix', () => {
    test('an unload on the default snow connection', () => {
        const verdict = evaluate("snow sql -q \"copy into 's3://example-bucket/x/' from prod_db.core.orders\"");
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('snow sql -c <connection>');
    });
    test('an unload through libpq defaults', () => {
        expect(evaluate('psql -c "select lo_export(1, \'/srv/out.bin\')"').action).toBe('block');
    });
    test('a written-out server with a variable archive is resolvable', () => {
        expect(evaluate('pg_restore -h db.example -U app -d app "$DUMP"').action).toBe('gate');
    });
});

describe('the card names every change the step makes', () => {
    // The card body, before the command it quotes, so a fragment of the command can't pass for a description.
    const cardOf = (command: string) => {
        const card = describeGate(command, evaluate(command).reason ?? '', dir);
        return { label: card.label, summary: card.summary.split('\nStep needing approval')[0] };
    };
    test('every unload is named', () => {
        const card = cardOf('snow sql -c acme_prod -q "copy into @prod_db.core.a from prod_db.core.t1; copy into @prod_db.core.b from prod_db.core.t2"');
        expect(card.label).toContain('(+1 more)');
        expect(card.summary).toMatch(/\nAnd: .*prod_db\.core\.t2/i);
    });
    test('a write is named beside a destructive statement', () => {
        const card = cardOf('snow sql -c acme_prod -q "delete from prod_db.core.t; insert into prod_db.core.t2 values (1)"');
        expect(card.summary).toMatch(/\nAnd: Runs INSERT on .PROD_DB\.CORE\.T2./);
    });
    test('kinds past the first three are still named', () => {
        const card = cardOf('snow sql -c acme_prod -q "insert into prod_db.core.a values (1); insert into prod_db.core.b values (1); insert into prod_db.core.c values (1); create view prod_db.core.v as select 1"');
        expect(card.summary).toMatch(/And 1 more: .*VIEW/i);
    });
    test('UPDATE ONLY names the table', () => {
        expect(cardOf(PG + ' -c "update only orders set status = 1 where id = 1"').label).toMatch(/ORDERS/i);
    });
    test('an attached -c names its connection', () => {
        const card = cardOf('snow sql -cacme_prod -q "insert into prod_db.core.orders values (1)"');
        expect(card.summary).toContain('connection \x60acme_prod\x60');
        expect(card.summary).not.toContain('default connection');
    });
    test('Postgres egress says the data left the database', () => {
        expect(cardOf(DEV_PG + ' -c "select lo_export(1, \'/srv/out.bin\')"').summary).toContain('left the database');
    });
    test('pg_restore --clean --create says the archive chooses the database it replaces', () => {
        expect(evaluate('pg_restore -h db.example -U app -d postgres --clean --create dump.pgdump').reason).toContain('the archive chooses which database it replaces');
    });
});

describe('psql input the guard cannot read takes a card', () => {
    test.todo('-Xc "$SQL" with the SQL wholly in an unresolved variable takes a card');
    test.todo('--file=- or -f /dev/stdin fed by a pipe the guard cannot read takes a card');
    test.todo('-v name="$X" interpolated as :name with an unresolved value takes a card');
});

describe('credentials in a SQL file stay off the card', () => {
    test.todo('a CREATE MANAGED ACCOUNT read from a -f file withholds ADMIN_PASSWORD from the card preview and summary');
    test.todo('an unload that carries a storage credential withholds it from the card');
});

describe('account-admin holds administration, never data that moves', () => {
    let previous: string | undefined;
    beforeAll(() => {
        previous = process.env[DEV_SCOPE_FILE_ENV];
        const scope = join(dir, 'dev-scope-admin-review.local.json');
        writeFileSync(scope, JSON.stringify({
            snowflake: [{ connection: 'acme_dev', databases: ['dev_db'] }],
            standingGrants: { acme_ops: ['account-admin'], acme_narrow: ['CREATE DATABASE'] },
            ownRoles: { acme_ops: ['OPS_ROLE'] },
        }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
    });
    afterAll(() => { process.env[DEV_SCOPE_FILE_ENV] = previous; });

    test.each([
        ['a quoted own role', 'snow sql -c acme_ops -q \'use role "OPS_ROLE"; create database loads\''],
        ['suspending a task', 'snow sql -c acme_ops -q "alter task loads.raw.fill suspend"'],
    ])('%s runs without a card', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test.each([
        ['a database clone', 'snow sql -c acme_ops -q "create database loads clone prod_db"'],
        ['a schema clone', 'snow sql -c acme_ops -q "create schema loads.raw clone prod_db.core"'],
        ['a clone under the narrow CREATE DATABASE class', 'snow sql -c acme_narrow -q "create database loads clone prod_db"'],
        ['replication enabled to another account', 'snow sql -c acme_ops -q "alter database loads enable replication to accounts partner_org.partner_acct"'],
        ['a refresh from a primary', 'snow sql -c acme_ops -q "alter database loads refresh"'],
        ['a quoted role that is not the own one', 'snow sql -c acme_ops -q \'use role "ops_role"; create database loads\''],
        ['a task changed to run a write', 'snow sql -c acme_ops -q "alter task loads.raw.fill modify as insert into loads.raw.t values (1)"'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
});

describe('one option table per CLI: snow global options, dbt repeated flags', () => {
    test.each([
        ['snow sql after --config-file', 'snow --config-file /srv/other.toml sql -c acme_prod -q "insert into prod_db.core.orders values (1)"'],
        ['snow sql after --config-file= on the dev login', 'snow --config-file=/srv/other.toml sql -c acme_dev -q "insert into dev_db.core.orders values (1)"'],
        ['snow stage copy after --config-file', 'snow --config-file /srv/other.toml stage copy ./a @prod_db.core.s/'],
        ['snow with an option before its command that the reference does not list', 'snow --made-up sql -c acme_prod -q "insert into prod_db.core.orders values (1)"'],
        ['a repeated --project-dir, whose last names another account', 'dbt build --project-dir PROJECT --project-dir __DIR__/farproject'],
        ['a repeated --state, whose last holds a prod run', 'cd PROJECT && dbt retry --state __DIR__/retrydev/target --state __DIR__/retryprod/target'],
        ['a repeated --profile, whose last is the other account', 'cd PROJECT && dbt build --profile acme --profile acme_far'],
        ['HOME on the dbt step', 'cd PROJECT && HOME=/srv/other dbt build'],
        ['an exported DBT_STORE_FAILURES before dbt test', 'cd PROJECT && export DBT_STORE_FAILURES=true && dbt test --target prod'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command.replaceAll('__DIR__', dir)).action).not.toBe('allow');
    });
});

describe('known egress is never discarded', () => {
    test('a readable unload beside a file too large to read, on the dev login', () => {
        expect(evaluate('snow sql -c acme_dev -f PROJECT/unload.sql -f PROJECT/huge.sql').reason).toStartWith(SQL_EGRESS);
    });
    test('an unload whose stage --env fills', () => {
        const command = "snow sql -c acme_dev --env stage=@dev_db.raw.out -q \"copy into <% ctx.env.stage %> from dev_db.core.orders\"";
        expect(evaluate(command).reason).toStartWith(SQL_EGRESS);
    });
    test('a load that purges its stage keeps its card on a listed connection', () => {
        expect(evaluate('snow sql -c acme_shared -q "copy into dev_db.core.t from @prod_db.core.s purge = true"').action).toBe('gate');
    });
    test('an Iceberg table on an external volume is egress', () => {
        expect(evaluate("snow sql -c acme_dev -q \"create iceberg table dev_db.core.ice external_volume = 'vol' catalog = 'SNOWFLAKE' base_location = 'x' as select * from dev_db.core.orders\"").reason).toStartWith(SQL_EGRESS);
    });
    test('a quoted VALIDATION_MODE only reads', () => {
        expect(evaluate("snow sql -c acme_prod -q \"copy into @prod_db.core.s from prod_db.core.orders validation_mode = 'RETURN_ROWS'\"").action).toBe('allow');
    });
});

describe('dbt macros read the way dbt finds them', () => {
    test.each([
        ['a macro under a block-list macro-paths', 'cd __DIR__/blockproj && dbt run-operation block_unload'],
        ['a helper a macro calls', 'cd __DIR__/blockproj && dbt run-operation wrapper'],
    ])('%s takes the egress card on the dev target', (_name, command) => {
        expect(evaluate(command.replaceAll('__DIR__', dir)).reason).toStartWith(SQL_EGRESS);
    });
});

describe('interpreter options read from each runtime\'s table', () => {
    test.each([
        ['bun run with a file', 'bun run PROJECT/load.js'],
        ['node after a bare --preserve-symlinks-main', 'node --preserve-symlinks-main PROJECT/load.js'],
        ['a Python driver imported after a semicolon', "python3 -c \"import os; import psycopg2; psycopg2.connect('dbname=app').cursor().execute('insert into orders values (1)')\""],
        ['a literal UPDATE ONLY', "python3 -c \"import psycopg2; psycopg2.connect('dbname=app').cursor().execute('update only orders set s = 1 where id = 1')\""],
        ['a literal UPDATE of a quoted table with a space', "python3 -c \"import psycopg2; psycopg2.connect('dbname=app').cursor().execute('update \\\"my orders\\\" set s = 1 where id = 1')\""],
    ])('%s takes a card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
    test('a Python command that prints a migration handed on stdin runs as before', () => {
        expect(evaluate('python3 -c "import sys, psycopg2; print(sys.stdin.read())" < PROJECT/migration.sql').action).toBe('allow');
    });
});

describe('standing grants and roles, as Snowflake stores them', () => {
    let previous: string | undefined;
    beforeAll(() => {
        previous = process.env[DEV_SCOPE_FILE_ENV];
        const scope = join(dir, 'dev-scope-admin-r3.local.json');
        writeFileSync(scope, JSON.stringify({
            snowflake: [{ connection: 'acme_dev', databases: ['dev_db'] }],
            standingGrants: { acme_ops: ['account-admin'], acme_narrow: ['CREATE DATABASE'] },
            ownRoles: { acme_ops: ['OPS_ROLE', 'MixedRole'] },
        }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
    });
    afterAll(() => { process.env[DEV_SCOPE_FILE_ENV] = previous; });
    test.each([
        ['resuming a task, which starts what it holds', 'snow sql -c acme_ops -q "alter task loads.raw.fill resume"'],
        ['a database restored from a backup set', 'snow sql -c acme_ops -q "create database loads from backup set prod_bs identifier \'x\'"'],
        ['a backup restore under the narrow class', 'snow sql -c acme_narrow -q "create database loads from backup set prod_bs identifier \'x\'"'],
        ['an unquoted switch to a mixed-case own role, which Snowflake reads as MIXEDROLE', 'snow sql -c acme_ops -q "use role mixedrole; create database loads"'],
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
    test('a quoted mixed-case own role matches exactly', () => {
        expect(evaluate('snow sql -c acme_ops -q \'use role "MixedRole"; create database loads\'').action).toBe('allow');
    });
});

describe('refusals and cards for the review round', () => {
    test('pg_restore with a variable -d is refused, whatever -h says', () => {
        expect(evaluate('pg_restore -h db.example -d "$DATABASE_URL" dump.pgdump').action).toBe('block');
    });
    test('templated SQL on the default snow connection is refused', () => {
        expect(evaluate('snow sql --enable-templating JINJA -q "select {{ x }}"').action).toBe('block');
    });
    test('a Render dev file with a shell escape keeps its card', () => {
        expect(evaluate(DEV_PG + ' -f PROJECT/render-escape.sql').action).not.toBe('allow');
    });
    const body = (command: string) => describeGate(command, evaluate(command).reason ?? '', dir).summary.split('\nStep needing approval')[0];
    test('pg_restore --clean --create says it replaces the database the archive names', () => {
        expect(body('pg_restore -h db.example -U app -d postgres --clean --create dump.pgdump')).toContain('the archive chooses which database it replaces');
    });
    test('the destructive UPDATE ONLY card names the table', () => {
        expect(describeGate(PG + ' -c "update only orders set s = 1"', evaluate(PG + ' -c "update only orders set s = 1"').reason ?? '', dir).label).toMatch(/table orders/i);
    });
    test('a retry with no readable saved run says so', () => {
        expect(body('cd ' + join(dir, 'retrynone') + ' && dbt retry')).toContain('the saved run');
    });
});

describe('final round', () => {
    test('dbt test on another target cards when the project stores test failures', () => {
        expect(evaluate('cd ' + join(dir, 'sfproj') + ' && dbt test --target prod').action).toBe('gate');
    });
    test('dbt test on the dev target of such a project runs without a card', () => {
        expect(evaluate('cd ' + join(dir, 'sfproj') + ' && dbt test').action).toBe('allow');
    });
    test('a literal COMMENT ON in interpreter code takes a card', () => {
        expect(evaluate("python3 -c \"import psycopg2; psycopg2.connect('dbname=app').cursor().execute('comment on table orders is \\'x\\'')\"").action).toBe('gate');
    });
    test('a file piped into inline code that only reads stdin is data', () => {
        expect(evaluate("cat PROJECT/load.py | python3 -c 'import sys; print(sys.stdin.read())'").action).toBe('allow');
    });
    test('a file piped into python with no code of its own is the program', () => {
        expect(evaluate('cat PROJECT/load.py | python3').action).toBe('gate');
    });
    test.each([
        ['suspending an alert', 'snow sql -c acme_shared -q "alter alert dev_db.core.a suspend"'],
        ['resuming an alert', 'snow sql -c acme_shared -q "alter alert dev_db.core.a resume"'],
        ['pausing a pipe', 'snow sql -c acme_shared -q "alter pipe dev_db.core.p set pipe_execution_paused = true"'],
    ])('%s on a listed connection with no login runs as on main', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
    test('changing what an alert runs keeps its card', () => {
        expect(evaluate('snow sql -c acme_shared -q "alter alert dev_db.core.a modify action insert into prod_db.core.t select 1"').action).toBe('gate');
    });
    test('a macro write into a dev database listed only on another account keeps its card', () => {
        const previous = process.env[DEV_SCOPE_FILE_ENV];
        const scope = join(dir, 'dev-scope-macro-accounts.local.json');
        writeFileSync(scope, JSON.stringify({ snowflake: [
            { connection: 'acme_dev', databases: ['dev_db', 'acme_only'] },
            { connection: 'far_dev', databases: ['dev_db'], dbtAccounts: ['FAR-ACCT1'] },
        ] }));
        process.env[DEV_SCOPE_FILE_ENV] = scope;
        try {
            expect(evaluate('cd ' + join(dir, 'farproject') + ' && dbt build').action).toBe('allow');
            expect(evaluate('cd ' + join(dir, 'farproject') + ' && dbt run-operation fill_far').action).toBe('gate');
        } finally {
            process.env[DEV_SCOPE_FILE_ENV] = previous;
        }
    });
    test('the retry card reads the saved target from the directory the command runs in', () => {
        const at = join(dir, 'retryprod');
        const verdict = evaluateBashCommand('dbt retry', { cwd: at });
        expect(describeGate('dbt retry', verdict.reason ?? '', at).label).toBe('Run dbt retry on target prod');
    });
    test('a load that purges its stage says so on the card', () => {
        const command = 'snow sql -c acme_shared -q "copy into dev_db.core.t from @prod_db.core.s purge = true"';
        expect(describeGate(command, evaluate(command).reason ?? '', dir).label).toMatch(/PURGE/i);
    });
});

describe('review 245d', () => {
    test('dbt test on another target cards, since any test can store its failures', () => {
        const command = 'cd PROJECT && dbt test --target prod';
        const verdict = evaluate(command);
        expect(verdict.action).toBe('gate');
        expect(describeGate(command.replaceAll('PROJECT', join(dir, 'project')), verdict.reason ?? '', dir).summary).toContain('may store the failing rows');
    });
    test('dbt test with --no-store-failures runs without a card', () => {
        expect(evaluate('cd PROJECT && dbt test --target prod --no-store-failures').action).toBe('allow');
    });
    test.each([
        ['a pipe', "printf 'import psycopg2\\npsycopg2.connect(\"dbname=app\").cursor().execute(\"insert into orders values (1)\")\\n' | python3 - warehouse"],
        ['a heredoc', "python3 - warehouse <<'EOF'\nimport psycopg2\npsycopg2.connect('dbname=app').cursor().execute('insert into orders values (1)')\nEOF"],
    ])('python3 - with arguments reads the program from %s', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
    test.each([
        ['a quoted alert', 'snow sql -c acme_shared -q \'alter alert dev_db.core."Daily Alert" suspend\''],
        ['a quoted pipe', 'snow sql -c acme_shared -q \'alter pipe dev_db.core."Load Pipe" set pipe_execution_paused = true\''],
    ])('pausing %s on a listed connection with no login runs as on main', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });
    test('a validation-only load with PURGE purges nothing', () => {
        expect(evaluate('snow sql -c acme_prod -q "copy into prod_db.core.t from @prod_db.core.s purge = true validation_mode = return_errors"').action).toBe('allow');
    });
    test('the retry card follows a relative cd to the project it reruns', () => {
        const command = 'cd retryprod && dbt retry';
        const verdict = evaluateBashCommand(command, { cwd: dir });
        expect(describeGate(command, verdict.reason ?? '', dir).label).toBe('Run dbt retry on target prod');
    });
    test('the retry card shows a saved full refresh', () => {
        const at = join(dir, 'retryfr');
        const verdict = evaluateBashCommand('dbt retry', { cwd: at });
        expect(verdict.action).toBe('gate');
        expect(describeGate('dbt retry', verdict.reason ?? '', at).label).toContain('--full-refresh');
    });
});

describe('review 245e', () => {
    test('the retry card resolves --project-dir from the directory the step runs in, as the gate does', () => {
        const command = 'cd project && dbt retry --project-dir ../retryprod';
        const verdict = evaluateBashCommand(command, { cwd: dir });
        expect(verdict.action).toBe('gate');
        expect(describeGate(command, verdict.reason ?? '', dir).label).toBe('Run dbt retry on target prod');
    });
    test('two ALTER TABLEs on one table that add different columns are two changes', () => {
        const command = 'snow sql -c acme_prod -q "alter table prod_db.core.t add column a int; alter table prod_db.core.t add column b int"';
        expect(describeGate(command, evaluate(command).reason ?? '', dir).label).toContain('(+1 more)');
    });
});

describe('review 245f', () => {
    test('two ALTER TABLEs that add differently quoted columns are two changes', () => {
        const command = 'snow sql -c acme_prod -q \'alter table prod_db.core.t add column "Col A" int; alter table prod_db.core.t add column "Col B" int\'';
        expect(describeGate(command, evaluate(command).reason ?? '', dir).label).toContain('(+1 more)');
    });
    test('the retry card takes the profile default from the project it read the saved run from', () => {
        const command = 'cd project && dbt retry --project-dir ../retrynotarget';
        const verdict = evaluateBashCommand(command, { cwd: dir });
        expect(describeGate(command, verdict.reason ?? '', dir).label).toBe('Run dbt retry on target prod');
    });
});

describe('review 245g', () => {
    test('the card reads profiles.yml from the working directory, apart from --project-dir, as dbt does', () => {
        const command = 'cd analytics && dbt retry --project-dir ../warehouse';
        const verdict = evaluateBashCommand(command, { cwd: dir });
        expect(verdict.action).toBe('gate');
        expect(describeGate(command, verdict.reason ?? '', dir).label).toBe('Rerun the saved dbt build with --full-refresh on target prod');
    });
    test('a profiles.yml in the working directory leaves a dev build unproven, wherever the project is', () => {
        expect(evaluate('cd analytics && dbt build --project-dir PROJECT').action).toBe('gate');
    });
});

describe('fresh review', () => {
    test('a readable -f file into a listed dev database on a connection with no login runs as on main', () => {
        expect(evaluate('snow sql -c acme_shared -f PROJECT/dev-load.sql').action).toBe('allow');
    });
    test('a readable -f file into a database not listed as dev keeps its card', () => {
        expect(evaluate('snow sql -c acme_shared -f PROJECT/prod-load.sql').action).toBe('gate');
    });
    const body = (command: string) => describeGate(command, evaluate(command).reason ?? '', dir).summary.split('\nStep needing approval')[0];
    test('a connection string as the dbname names the server the card shows, over -h', () => {
        const summary = body("psql -X -h dev.example -d 'postgresql://prod.example/app' -c 'insert into orders values (1)'");
        expect(summary).toContain('prod.example');
        expect(summary).not.toContain('dev.example');
    });
    test('pg_restore --create says it restores into the database the archive names', () => {
        expect(body('pg_restore -h db.example -U app -d postgres --create app.dump')).toContain('the archive chooses the database it writes');
    });
    test('the retry card uses the saved profile override', () => {
        const at = join(dir, 'retryprofile');
        const verdict = evaluateBashCommand('dbt retry', { cwd: at });
        expect(describeGate('dbt retry', verdict.reason ?? '', at).label).toBe('Run dbt retry on target prod');
    });
    test.each([
        ['two inserts that differ only in a literal', "snow sql -c acme_prod -q \"insert into prod_db.core.t values ('red'); insert into prod_db.core.t values ('blue')\""],
        ['the same insert twice', 'snow sql -c acme_prod -q "insert into prod_db.core.t values (1); insert into prod_db.core.t values (1)"'],
    ])('%s are two changes on the card', (_name, command) => {
        expect(describeGate(command, evaluate(command).reason ?? '', dir).label).toContain('(+1 more)');
    });
});

describe('replay round', () => {
    const run = (command: string) => evaluateBashCommand(command, { cwd: dir });
    const body = (command: string) => describeGate(command, run(command).reason ?? '', dir).summary.split('\nStep needing approval')[0];
    test('SQL the guard cannot read, with no write it can see, on a server it cannot name takes a card naming that server as unknown', () => {
        const command = 'psql -X "$APP_URL" -c "$(cat q.sql)"';
        expect(run(command).action).toBe('gate');
        expect(body(command)).toContain('on a server \x60$APP_URL\x60 names');
    });
    test('a variable set to a read, then a command named through a variable, takes a card, not a refusal, on a loopback server', () => {
        expect(run('R=$(pwd); Q="select 1"; $R/run.sh; psql -X -h 127.0.0.1 -p 5999 -U app -d app -c "$Q"').action).toBe('gate');
    });
    test('reads echoed around a sleep into psql on a loopback server run as on main', () => {
        expect(run('(echo "select 1"; sleep 1; echo "select 2") | psql -X -h 127.0.0.1 -p 5999 -U app -d app').action).toBe('allow');
    });
    test.each([
        ['a write it found on a server it cannot name', 'psql -X "$APP_URL" -c "update t set a = 1 where id = 2"', 'block'],
        ['a write echoed beside a sleep', '(echo "insert into t values (1)"; sleep 1) | psql -X "$APP_URL"', 'block'],
        ['a write held in a variable set on the line', 'Q="update t set a = 1 where id = 2"; psql -X -h 127.0.0.1 -p 5999 -U app -d app -c "$Q"', 'block'],
        ['a sleep the line defines as a function', 'sleep() { echo "drop table t"; }; (echo "select 1"; sleep 1) | psql -X -h db.example -d app', 'gate'],
        ['a sleep found through a moved PATH', 'PATH=/tmp/bin:$PATH; (echo "select 1"; sleep 1) | psql -X -h db.example -d app', 'gate'],
        ['a restore through a written-out loopback address', 'pg_restore -h 127.0.0.1 -p 5999 -U scratch -d app -L toc.list app.dump', 'gate'],
    ])('control: %s keeps its verdict', (_name, command, action) => {
        expect(run(command).action).toBe(action as 'allow' | 'gate' | 'block');
    });
    test('a restore into a server it cannot name says how to restore into a scratch Postgres', () => {
        const verdict = run('pg_restore -d "$APP_URL" app.dump');
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('scratch-pg url <db>');
        expect(verdict.reason).toContain('runs without approval when scratch-pg\'s cluster is what listens there');
    });
    test('a multi-host URI shows every host libpq can connect to', () => {
        const summary = body("psql -X 'postgresql://primary.example:5432,failover.example:5433/app' -c 'insert into t values (1)'");
        expect(summary).toContain('Connects using: \x60postgresql://primary.example:5432,failover.example:5433/app\x60');
    });
    test('host and dbname in a URI query override the authority and path', () => {
        const summary = body("psql -X 'postgresql://ignored.example/app?host=query.example&dbname=other' -c 'insert into t values (1)'");
        expect(summary).toContain('\x60other\x60 on \x60query.example\x60');
        expect(summary).not.toContain('ignored.example');
    });
    test('a written host beside a dbname held in a variable shows both', () => {
        const summary = body('psql -X -h db.example "$APP_URL" -c "insert into t values (1)"');
        expect(summary).toContain('on \x60db.example\x60, or on a server \x60$APP_URL\x60 names');
    });
});

describe('libpq URI query parameters', () => {
    const body = (command: string) => describeGate(command, evaluateBashCommand(command, { cwd: dir }).reason ?? '', dir).summary.split('\nStep needing approval')[0];
    test('the last host in the query wins, as libpq stores a repeated parameter over the one before', () => {
        const summary = body("psql -X 'postgresql://ignored.example/app?host=first.example&host=last.example' -c 'insert into t values (1)'");
        expect(summary).toContain('on \x60last.example\x60');
        expect(summary).not.toContain('first.example');
    });
    test.each([
        ['a URI with a host list and a hostaddr list holding an empty slot', "psql -X 'postgresql://primary.example,failover.example/app?hostaddr=192.0.2.10,' -c 'insert into t values (1)'", 'postgresql://primary.example,failover.example/app?hostaddr=192.0.2.10,'],
        ['key=value pairs with a host list and a hostaddr list holding an empty slot', "psql -X -d 'host=primary.example,failover.example hostaddr=192.0.2.10, dbname=app' -c 'insert into t values (1)'", '-d host=primary.example,failover.example hostaddr=192.0.2.10, dbname=app'],
        ['a single host with a hostaddr', "psql -X 'postgresql://named.example/app?hostaddr=192.0.2.10' -c 'insert into t values (1)'", 'postgresql://named.example/app?hostaddr=192.0.2.10'],
        ['a host list given with -h', "psql -X -h primary.example,failover.example -p 5432,5433 -d app -c 'insert into t values (1)'", '-h primary.example,failover.example'],
    ])('%s: the card shows the connection parameters as written', (_name, command, written) => {
        const summary = body(command);
        expect(summary).toContain('Connects using: ');
        expect(summary).toContain('\x60' + written + '\x60');
        expect(summary).toContain('connection parameters choose');
        expect(summary).not.toMatch(/on \x60192\.0\.2\.10\x60|authenticating as/);
    });
    test('a single host with no hostaddr keeps the card that names it', () => {
        const summary = body("psql -X -h db.example -d app -c 'insert into t values (1)'");
        expect(summary).toContain('in the PostgreSQL database \x60app\x60 on \x60db.example\x60');
        expect(summary).not.toContain('Connects using');
    });
});

describe('libpq options as psql reads them', () => {
    const body = (command: string) => describeGate(command, evaluateBashCommand(command, { cwd: dir }).reason ?? '', dir).summary.split('\nStep needing approval')[0];
    test('an attached -d counts as the last -d', () => {
        const summary = body('psql -X -h db.example.com -d staging_app -dprod_app -c "insert into orders values (1)"');
        expect(summary).toContain('prod_app');
        expect(summary).not.toContain('staging_app');
    });
    test('a connection string splits on ASCII whitespace only, so a non-ASCII space stays inside a value', () => {
        const summary = body('psql -X "host=db.example.com dbname=prod_app dbname=staging_app" -c "insert into orders values (1)"');
        expect(summary).toContain('\x60prod_app dbname=staging_app\x60');
        expect(summary).not.toContain('\x60staging_app\x60');
    });
});
