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
        '    dev:', '      type: snowflake', '      database: dev_db',
        '    prod:', '      type: snowflake', '      database: prod_db', '',
    ].join('\n'));
    mkdirSync(join(dir, 'project'));
    writeFileSync(join(dir, 'project', 'dbt_project.yml'), "name: acme\nprofile: 'acme'\n");
    writeFileSync(join(dir, 'project', 'load.sql'), 'insert into orders values (1);\n');
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
        ['a reader account', 'snow sql -c acme_prod -q "create managed account reader admin_name = \'r\', admin_password = \'x\', type = reader"'],
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
    ])('%s keeps its card', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
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
