import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, LAB_SCOPE_FILE_ENV, changesProduction, describeGate, evaluateBashCommand } from './block-destructive-core';

/**
 * POSTGRES ROLE AND PRIVILEGE CHANGES. Creating, changing or dropping a role, granting or revoking a privilege, changing
 * default privileges or an owner, and creating a SECURITY DEFINER function take approval on every Postgres the guard
 * reads SQL for. A listed dev database and a Lab database waive a change to their own objects, never one to a role or
 * another object the whole cluster holds; the in-container scratch Postgres is exempt.
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
    'CREATE ROLE app_reader LOGIN',
    'create user app_reader',
    'CREATE GROUP app_readers',
    'ALTER ROLE app_reader SUPERUSER',
    'ALTER USER app_reader WITH CONNECTION LIMIT 5',
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

// Statements on roles, which the whole cluster holds: role DDL, role membership, and moving or dropping what a role owns.
const CLUSTER_SQL = new Set(PRIVILEGE_SQL.filter(sql => /^(?:create|alter|drop)\s+(?:role|user|group)\b|^grant\s+app_admin\b|^reassign\s+owned\b|^alter\s+database\b[\s\S]*\bowner\s+to\b/i.test(sql)));

describe('a role or privilege change on a reachable Postgres is never run without approval', () => {
    for (const sql of PRIVILEGE_SQL) {
        test.each([
            ['dev, through its connection string', viaUri(DEV_DB, sql), 'block'],
            ['prod, through its connection string', viaUri(PROD_DB, sql), 'block'],
            // A listed dev database waives changes to its own objects; a role, which the whole cluster holds, keeps its card.
            ['dev, its host written out', viaHost(DEV_DB, sql), CLUSTER_SQL.has(sql) ? 'gate' : 'allow'],
            ['prod, its host written out', viaHost(PROD_DB, sql), 'gate'],
            ['dev, through render psql', viaRender(DEV_DB, sql), CLUSTER_SQL.has(sql) ? 'gate' : 'allow'],
            ['prod, through render psql', viaRender(PROD_DB, sql), 'gate'],
        ])(sql + ': %s', (_where, command, action) => {
            expect(run(command).action).toBe(action as 'block' | 'gate');
        });
    }

    test('inside a DO block', () => {
        expect(run("psql -X -h " + host(PROD_DB) + " -U app -d app -c 'DO $$BEGIN GRANT SELECT ON public.orders TO app_reader; END$$'").action).toBe('gate');
        expect(run("render psql " + DEV_DB + " -c 'DO $$BEGIN CREATE ROLE app_reader; END$$'").action).toBe('gate');
        expect(run("render psql " + DEV_DB + " -c 'DO $$BEGIN GRANT SELECT ON public.orders TO app_reader; END$$'").action).toBe('allow');
    });

    test.each([
        ['a quoted heredoc', "psql -X -h " + host(PROD_DB) + " -U app -d app <<'EOF'\nGRANT SELECT ON public.orders TO app_reader;\nEOF"],
        ['a pipe', 'echo "GRANT SELECT ON public.orders TO app_reader" | psql -X -h ' + host(PROD_DB) + ' -U app -d app'],
        ['one transaction with other statements', "psql -X -h " + host(PROD_DB) + " -U app -d app -1 -c 'BEGIN; CREATE ROLE app_reader; COMMIT'"],
        ['under timeout, piped to tail', "timeout 30 psql -X -h " + host(PROD_DB) + " -U app -d app -c 'GRANT SELECT ON t TO r' 2>&1 | tail -3"],
    ])('from %s', (_how, command) => {
        expect(run(command).action).toBe('gate');
    });

    test.each([
        ['through render psql', viaRender(DEV_DB, 'GRANT app_admin TO app_reader'), 'whole cluster holds'],
        ['its host written out', viaHost(DEV_DB, 'GRANT app_admin TO app_reader'), 'whole cluster holds'],
        ['a statement on another database', viaRender(DEV_DB, 'DROP DATABASE other_db'), 'DROP DATABASE other_db'],
        ['a comment on another database', viaRender(DEV_DB, "COMMENT ON DATABASE other_db IS 'x'"), 'COMMENT ON DATABASE other_db'],
        ['a database named on the next line', viaRender(DEV_DB, 'DROP DATABASE\n  other_db'), 'DROP DATABASE other_db'],
    ])('a listed dev database holds it as dev and says why: %s', (_how, command, why) => {
        const { reason } = run(command);
        expect(changesProduction(command, '/tmp')).toBe(false);
        expect(reason).toContain(DEV_DB);
        expect(reason).toContain(why);
        expect(reason).not.toContain('not proven dev');
    });

    test('the dev hold card names the other database', () => {
        const command = viaRender(DEV_DB, 'DROP DATABASE other_db');
        expect(describeGate(command, run(command).reason!, '/tmp').summary).toContain('If you approve: Runs SQL on the Render dev resource named in the step below, and its SQL acts outside this database (DROP DATABASE other_db)');
    });

    test.each([
        ['ALTER FUNCTION f() SECURITY INVOKER', 'SECURITY INVOKER'],
        ['ALTER TABLE t ENABLE ROW LEVEL SECURITY', 'ENABLE ROW LEVEL SECURITY'],
        ['ALTER TABLE t FORCE ROW LEVEL SECURITY', '(FORCE ROW LEVEL SECURITY'],
        ['ALTER TABLE t NO FORCE ROW LEVEL SECURITY', 'NO FORCE ROW LEVEL SECURITY'],
        ['ALTER TABLE t DISABLE ROW LEVEL SECURITY', 'DISABLE ROW LEVEL SECURITY'],
    ])('the card for %s is titled with its keyword', (sql, title) => {
        const command = viaHost(PROD_DB, sql);
        expect(describeGate(command, run(command).reason!, '/tmp').label).toContain(title);
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
        viaRender(DEV_DB, 'GRANT USAGE ON FOREIGN SERVER reporting TO app_reader'),
        viaRender(DEV_DB, 'GRANT USAGE ON FOREIGN DATA WRAPPER postgres_fdw TO app_reader'),
        viaRender(DEV_DB, "update public.orders set note = 'owner to' where id = 1"),
        viaHost(PROD_DB, 'select rolname from pg_roles'),
    ])('%s', command => {
        expect(run(command).action).toBe('allow');
    });
});

test('a Snowflake GRANT takes the write card, not a Postgres privilege card', () => {
    const { action, reason } = run('snow sql -c acme_dev -q "GRANT SELECT ON ALL TABLES IN SCHEMA dev_db.app TO ROLE r"');
    expect(action).toBe('gate');
    expect(reason).not.toContain('PostgreSQL');
});

test('a readable file is read: a grant in it is carded, a select runs', () => {
    const grants = join(dir, 'grants.sql');
    const reads = join(dir, 'reads.sql');
    writeFileSync(grants, 'GRANT SELECT ON public.orders TO app_reader;\n');
    writeFileSync(reads, 'select count(*) from public.orders;\n');
    expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + grants).action).toBe('gate');
    expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app < ' + grants).action).toBe('gate');
    expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + reads).action).toBe('allow');
});

describe('psql input the guard reads as psql does', () => {
    let fx = '';
    const f = (name: string) => join(fx, name);
    beforeAll(() => {
        fx = mkdtempSync(join(tmpdir(), 'pg-input-'));
        const files: Record<string, string> = {
            'grant.sql': 'GRANT ALL ON t TO public;\n',
            'ok.sql': 'select 1;\n',
            'gexec.sql': "select 'GRANT ALL ON t TO public' \\gexec\n",
            'password.sql': '\\password app\n',
            'include.sql': '\\i :migration\n',
            'label.sql': 'DO $$ <<lbl>> BEGIN GRANT ALL ON t TO public; END lbl $$;\n',
            'role.sql': 'CREATE ROLE app_reader;\n',
            'nested-role.sql': '/* note /* inner */\nCREATE ROLE app_reader;\n*/\nselect 1;\n',
            'copy-hides.sql': "COPY t FROM stdin;\nO'Brien\n\\.\nGRANT ALL ON t TO public;\n",
            'copy-after-emoji.sql': "SELECT 1 AS \u{1F680};\n/* load\n   orders */\n\\copy orders FROM 'orders.csv'\n",
            'copy-after-comment.sql': "/* load\n   orders */\n\\copy orders FROM 'orders.csv'\n",
            'copy-comment.sql': '-- Previous import used COPY staging_orders FROM STDIN;\nDROP TABLE IF EXISTS staging_orders;\nCOPY import_log FROM STDIN;\nimported\n\\.\n',
        };
        for (const [name, text] of Object.entries(files)) writeFileSync(f(name), text);
    });
    afterAll(() => rmSync(fx, { recursive: true, force: true }));
    const H = 'psql -h db.example.com';

    test.each([
        ['-f clustered after -X', () => `${H} -Xf ${f('grant.sql')}`],
        ['a \\copy FROM after a comment that spans lines', () => `${H} -X -d app -f ${f('copy-after-comment.sql')}`],
        ['a \\copy FROM after an emoji and a comment that spans lines', () => `${H} -X -d app -f ${f('copy-after-emoji.sql')}`],
        ['\\gexec, which runs query results as SQL', () => `${H} -f ${f('gexec.sql')}`],
        ['\\password, which alters a role', () => `${H} -f ${f('password.sql')}`],
        ['a GRANT first in a labelled block', () => `${H} -f ${f('label.sql')}`],
        ['a GRANT after COPY data holding an apostrophe', () => `${H} -f ${f('copy-hides.sql')}`],
        ['a DROP after a comment that mentions COPY FROM STDIN', () => `${H} -X -f ${f('copy-comment.sql')}`],
        ['an unreadable EXECUTE on a listed dev database', () => `render psql ${DEV_DB} -c "DO \\$\\$ BEGIN EXECUTE format('GRANT ALL ON %I TO public', 't'); END \\$\\$" -o text`],
    ])('%s gates', (_name, command) => {
        expect(run(command()).action).toBe('gate');
    });

    test.each([
        ['a $( ) psql gets in single quotes, as text', () => `${H} -c '$(not run)'`],
    ])('%s runs', (_name, command) => {
        expect(run(command()).action).toBe('allow');
    });

    // On a listed dev database only a role change keeps its card, so how the file is read decides.
    const DEV = 'psql -X -h ' + host(DEV_DB) + ' -U app -d app';
    test('a role change in a file on a listed dev database gates', () => {
        expect(run(`${DEV} -f ${f('role.sql')}`).action).toBe('gate');
    });
    test('a role change inside a nested comment on a listed dev database runs', () => {
        expect(run(`${DEV} -f ${f('nested-role.sql')}`).action).toBe('allow');
    });
});

describe('a Lab session waives grants on its database, not changes to roles, which the whole cluster holds', () => {
    let labDir = '';
    let savedLab: string | undefined;
    let savedProfile: string | undefined;
    beforeAll(() => {
        labDir = mkdtempSync(join(tmpdir(), 'pg-lab-'));
        writeFileSync(join(labDir, 'lab-scope.local.json'), JSON.stringify({ org: 'lab-org', extraRepos: [] }));
        [savedLab, savedProfile] = [process.env[LAB_SCOPE_FILE_ENV], process.env.NANOCLAW_INSTRUCTIONS_PROFILE];
        process.env[LAB_SCOPE_FILE_ENV] = join(labDir, 'lab-scope.local.json');
        process.env.NANOCLAW_INSTRUCTIONS_PROFILE = 'lab';
    });
    afterAll(() => {
        if (savedLab === undefined) delete process.env[LAB_SCOPE_FILE_ENV];
        else process.env[LAB_SCOPE_FILE_ENV] = savedLab;
        if (savedProfile === undefined) delete process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
        else process.env.NANOCLAW_INSTRUCTIONS_PROFILE = savedProfile;
        rmSync(labDir, { recursive: true, force: true });
    });
    test('a grant on a lab database runs', () => {
        expect(run('psql -X -h db.example.com -d lab_app -c "GRANT SELECT ON t TO app_reader"').action).toBe('allow');
    });
    test.each([['CREATE ROLE app LOGIN'], ['ALTER ROLE app SUPERUSER'], ['DROP USER app']])('%s on a lab database gates', (sql) => {
        expect(run(`psql -X -h db.example.com -d lab_app -c "${sql}"`).action).toBe('gate');
    });
});

describe('psql input the guard reads takes a card for a privilege change it holds', () => {
    let fx = '';
    const f = (name: string) => join(fx, name);
    beforeAll(() => {
        fx = mkdtempSync(join(tmpdir(), 'pg-forms-'));
        writeFileSync(f('mention.sql'), '-- \\gexec and \\password are covered in the runbook\nselect 1;\n');
    });
    afterAll(() => rmSync(fx, { recursive: true, force: true }));
    const H = 'psql -h db.example.com';

    test.each([
        ['a GRANT a quoted heredoc writes, which is read and carded for what it is', () => `cat > ${f('w5.sql')} <<'EOF'\nGRANT ALL ON t TO public;\nEOF\n${H} -f ${f('w5.sql')}`],
        ['a GRANT piped from a literal echo', () => `echo 'GRANT ALL ON t TO public' | ${H}`],
    ])('%s gates', (_name, command) => {
        expect(run(command()).action).toBe('gate');
    });

    test.each([
        ['a comment that mentions \\gexec and \\password', () => `${H} -f ${f('mention.sql')}`],
    ])('%s runs', (_name, command) => {
        expect(run(command()).action).toBe('allow');
    });

    test('DROP OWNED on a listed dev database keeps its card', () => {
        expect(run(`render psql ${DEV_DB} -c "DROP OWNED BY app_a"`).action).toBe('gate');
    });

    test.each([
        ['DROP DATABASE', `render psql ${DEV_DB} -c "DROP DATABASE other_db"`],
        ['a database rename', `render psql ${DEV_DB} -c "ALTER DATABASE other_db RENAME TO old_db"`],
        ['a meta-command after SQL on the line', `render psql ${DEV_DB} -c "SELECT 1; \\\\connect other_db"`],
    ])('%s on a listed dev database keeps its card', (_name, command) => {
        expect(run(command).action).toBe('gate');
    });
});

describe('role, policy and security changes take a card', () => {
    const H = 'psql -h db.example.com';

    test.each([
        ['createuser', () => 'createuser -h db.example.com app_reader'],
        ['dropuser', () => 'dropuser -h db.example.com app_reader'],
        ['ALTER POLICY', () => `${H} -c "ALTER POLICY p ON t USING (true)"`],
        ['DISABLE ROW LEVEL SECURITY', () => `${H} -c "ALTER TABLE t DISABLE ROW LEVEL SECURITY"`],
        ['NO FORCE ROW LEVEL SECURITY', () => `${H} -c "ALTER TABLE t NO FORCE ROW LEVEL SECURITY"`],
        ['CREATE POLICY', () => `${H} -c "CREATE POLICY p ON t USING (true)"`],
        ['PostgreSQL DROP POLICY', () => `${H} -c "DROP POLICY tenant_isolation ON orders"`],
        ['a view made security_invoker', () => `${H} -X -d app -c 'BEGIN; ALTER VIEW reporting.orders SET (security_invoker = true); ROLLBACK'`],
        ['a view without security_barrier', () => `${H} -X -d app -c 'ALTER VIEW reporting.orders RESET (security_barrier)'`],
        ['a view made security_invoker through ALTER TABLE', () => `${H} -X -d app -c 'ALTER TABLE reporting.orders SET (security_invoker = true)'`],
        ['a function made SECURITY INVOKER', () => `${H} -X -d app -c 'ALTER FUNCTION app.refresh() SECURITY INVOKER'`],
        ['FORCE ROW LEVEL SECURITY', () => `${H} -X -d app -c 'ALTER TABLE orders FORCE ROW LEVEL SECURITY'`],
        ['ENABLE ROW LEVEL SECURITY', () => `${H} -X -d app -c 'ALTER TABLE orders ENABLE ROW LEVEL SECURITY'`],
    ])('%s takes a card', (_name, command) => {
        expect(run(command()).action).toBe('gate');
    });

    test('a \\connect on a listed dev database keeps its card', () => {
        expect(run(`render psql ${DEV_DB} -c "\\connect other" -c "GRANT SELECT ON t TO r"`).action).toBe('gate');
    });
});

describe('a Lab database waives database objects, not roles the whole cluster holds', () => {
    let labDir = '';
    let savedLab: string | undefined;
    let savedProfile: string | undefined;
    let fx = '';
    beforeAll(() => {
        labDir = mkdtempSync(join(tmpdir(), 'pg-lab-2-'));
        fx = mkdtempSync(join(tmpdir(), 'pg-lab-files-'));
        writeFileSync(join(fx, 'password.sql'), '\\password app\n');
        writeFileSync(join(fx, 'gexec.sql'), "select 'GRANT app_admin TO app' \\gexec\n");
        writeFileSync(join(fx, 'connect-inline.sql'), 'SELECT 1; \\connect app\nDROP TABLE orders;\n');
        writeFileSync(join(fx, 'connect.sql'), '\\connect other_db\nGRANT SELECT ON t TO r;\n');
        writeFileSync(join(fx, 'var-role.sql'), ':role_sql;\n');
        writeFileSync(join(labDir, 'lab-scope.local.json'), JSON.stringify({ org: 'lab-org', extraRepos: [] }));
        [savedLab, savedProfile] = [process.env[LAB_SCOPE_FILE_ENV], process.env.NANOCLAW_INSTRUCTIONS_PROFILE];
        process.env[LAB_SCOPE_FILE_ENV] = join(labDir, 'lab-scope.local.json');
        process.env.NANOCLAW_INSTRUCTIONS_PROFILE = 'lab';
    });
    afterAll(() => {
        if (savedLab === undefined) delete process.env[LAB_SCOPE_FILE_ENV];
        else process.env[LAB_SCOPE_FILE_ENV] = savedLab;
        if (savedProfile === undefined) delete process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
        else process.env.NANOCLAW_INSTRUCTIONS_PROFILE = savedProfile;
        rmSync(labDir, { recursive: true, force: true });
        rmSync(fx, { recursive: true, force: true });
    });
    const LAB = 'psql -X -h db.example.com -d lab_app';
    test.each([
        ['role membership', `${LAB} -c "GRANT app_admin TO app_reader"`],
        ['revoking role membership', `${LAB} -c "REVOKE app_admin FROM app_reader"`],
        ['REASSIGN OWNED', `${LAB} -c "REASSIGN OWNED BY app_a TO app_b"`],
        ['DROP OWNED', `${LAB} -c "DROP OWNED BY app_a"`],
        ['\\password', () => `${LAB} -f ${join(fx, 'password.sql')}`],
        ['\\gexec', () => `${LAB} -f ${join(fx, 'gexec.sql')}`],
        ['an EXECUTE the scanner cannot read', `${LAB} -c "DO \\$\\$ BEGIN EXECUTE format('CREATE ROLE %I', 'x'); END \\$\\$"`],
        ['a \\connect to another database', () => `${LAB} -f ${join(fx, 'connect.sql')}`],
        ['a grant on a tablespace', `${LAB} -c "GRANT CREATE ON TABLESPACE ts TO r"`],
        ['ownership of another database', `${LAB} -c "ALTER DATABASE other_db OWNER TO r"`],
        ['a Lab-named user selecting another database', `psql -X -h db.example.com -U lab_app_admin -d prod_app -c "GRANT SELECT ON t TO r"`],
        ['a Lab-named user with no database named', `psql -X -h db.example.com -U lab_app_admin -c "GRANT SELECT ON t TO r"`],
        ['a Lab-named user in a conninfo string', `psql -X "host=db.example.com user=lab_app_admin dbname=prod_app" -c "GRANT SELECT ON t TO r"`],
        ['a Lab-named user in a URI', `psql -X "postgresql://lab_app_admin@db.example.com/prod_app" -c "GRANT SELECT ON t TO r"`],
        ['a Lab-named host', `psql -X -h lab-db.example.com -d prod_app -c "GRANT SELECT ON t TO r"`],
        ['a URI that names no database, only a Lab user', `psql -X "postgresql://lab_app@192.0.2.30" -c "GRANT SELECT ON t TO r"`],
        ['a conninfo that names no database, only a Lab user', `psql -X "host=db.example.com user=lab_app" -c "GRANT SELECT ON t TO r"`],
        ['a later attached -d that overrides a Lab database', `psql -X -h db.example.com -d lab_app -dprod_app -c "GRANT SELECT ON t TO r"`],
        ['a conninfo whose Lab-looking text sits past a non-ASCII space', `psql -X "host=db.example.com dbname=prod_app\u{a0}dbname=lab_app" -c "GRANT SELECT ON t TO r"`],
        // A foreign server's user mapping sends the session's queries off the database: egress, which no waiver covers.
        ['CREATE USER MAPPING', `${LAB} -c "CREATE USER MAPPING FOR app SERVER s"`],
        // main never read a plain operand as a Lab database.
        ['a positional database name', `psql -X -P pager=off -h db.example.com lab_app -c "DROP TABLE t"`],
        // An expansion in a URI can carry its own @ and /, and so another host and database.
        ['a URI whose password is a variable', 'psql -X "postgresql://lab_app_admin:$PW@192.0.2.30/lab_app" -c "DROP TABLE t"'],
        ['DROP DATABASE beside -P and a positional database name', `psql -X -P pager=off -h db.example.com lab_app -c "DROP DATABASE prod_app"`],
        ['DROP DATABASE naming another lab_ database', `${LAB} -c "DROP DATABASE IF EXISTS lab_archive"`],
        ['DROP DATABASE after a comment', `${LAB} -c "/* cleanup */ DROP DATABASE prod_app"`],
        ['a Lab database without -X, where a psqlrc could connect elsewhere', `psql -h db.example.com -d lab_app -c "DROP TABLE staging_orders"`],
        ['a MySQL table qualified by another database', `mysql -h db.example.com --database=lab_app -e 'TRUNCATE TABLE app.orders'`],
        ['a MySQL table qualified by a quoted database', `mysql -h db.example.com --database=lab_app -e 'DELETE FROM \`app\`.orders'`],
        ['a MySQL table qualified by another database in a list', `mysql -h db.example.com --database=lab_app -e 'DROP TABLE orders, app.orders'`],
        ['a MySQL USE of another database', `mysql -h db.example.com --database=lab_app -e 'USE app; TRUNCATE TABLE orders'`],
        ['a MySQL TRUNCATE short form qualified by another database', `mysql -h db.example.com --database=lab_app -e 'TRUNCATE app.orders'`],
        ['a MySQL column qualified by its table', `mysql -h db.example.com --database=lab_app -e 'DELETE FROM orders WHERE orders.id = 1'`],
        ['a MySQL client command', `mysql -h db.example.com --database=lab_app -e 'TRUNCATE TABLE orders; \\u app'`],
        ['a psql \\connect after SQL on the same line', () => `${LAB} -f ${join(fx, 'connect-inline.sql')}`],
        ['a database rename', `${LAB} -c "ALTER DATABASE prod_app RENAME TO old_app"`],
        ['a MySQL operand that overrides -D', `mysql -h db.example.com --database=lab_app inventory -e 'DELETE FROM orders WHERE FALSE'`],
        ['a tablespace rename', `${LAB} -c 'BEGIN; ALTER TABLESPACE archive RENAME TO archive_review; ROLLBACK'`],
        ['a tablespace rename inside a DO block', `${LAB} -c "DO \\$\\$ BEGIN ALTER TABLESPACE archive RENAME TO archive_review; END \\$\\$"`],
        ['a MySQL schema name ending in a digit', `mysql -h db.example.com --database=lab_app -e 'DELETE FROM inventory2.orders WHERE id = 1'`],
        ['a MySQL CREATE TABLESPACE', `mysql -h db.example.com --database=lab_app -e "CREATE TABLESPACE ts1 ADD DATAFILE 'ts1.ibd'; TRUNCATE TABLE orders"`],
        ['a database statement in a function body', `${LAB} -c "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS \\$fn\\$ BEGIN EXECUTE 'x'; ALTER DATABASE prod_app RENAME TO old_app; END \\$fn\\$; DROP TABLE t"`],
        ['an ALTER DATABASE beside a grant', `${LAB} -c "GRANT SELECT ON t TO r; ALTER DATABASE prod_app SET search_path = x"`],
        ['a comment on another database', `${LAB} -c "COMMENT ON DATABASE prod_app IS 'retired'"`],
        ['role DDL in a -v value the script runs', () => `${LAB} -v role_sql='CREATE ROLE app_reader' -f ${join(fx, 'var-role.sql')}`],
        ['a MySQL Lab database named with -D', `mysql -h db.example.com -D lab_app -e 'TRUNCATE TABLE orders'`],
        ['a MySQL Lab database named as an operand', `mysql -h db.example.com -D inventory lab_app -e 'TRUNCATE TABLE orders'`],
    ])('%s on a lab database gates', (_name, command) => {
        expect(run(typeof command === 'function' ? command() : command).action).toBe('gate');
    });
    test.each([
        ['a grant on an object', `${LAB} -c "GRANT SELECT ON t TO app_reader"`],
        ['a quoted Lab dbname in a conninfo', `psql -X "host=db.example.com dbname='lab_app'" -c "GRANT SELECT ON t TO r"`],
        ['a psql -P setting beside a Lab database', `psql -X -P pager=off -h db.example.com -d lab_app -c "GRANT SELECT ON t TO r"`],
        ['a Lab URI with channel_binding', `psql -X "postgresql://app@192.0.2.30/lab_app?channel_binding=require" -c "GRANT SELECT ON t TO r"`],
        ['a Lab database in a URI', `psql -X "postgresql://app@db.example.com/lab_app" -c "GRANT SELECT ON t TO r"`],
        ['a grant on an object, chosen by the database and not the user', `psql -X -h db.example.com -U app -d lab_app -c "GRANT SELECT ON t TO r"`],
        ['DROP SCHEMA in the connected database', `${LAB} -c "DROP SCHEMA old_area CASCADE"`],
        ['a MySQL table qualified by the selected database', `mysql -h db.example.com --database=lab_app -e 'TRUNCATE TABLE lab_app.orders'`],
        ['a column named tablespace', `${LAB} -c 'SELECT 1 AS tablespace; DROP TABLE t'`],
        ['a MySQL table in the default database', `mysql -h db.example.com --database=lab_app -e 'TRUNCATE TABLE orders'`],
        ['pg_restore without --create', 'pg_restore -d lab_app /tmp/app.dump'],
    ])('%s on a lab database runs', (_name, command) => {
        expect(run(command).action).toBe('allow');
    });
    // --create restores into the database the archive names, which the line doesn't show.
    test.each([
        'pg_restore --create -d lab_app /tmp/app.dump',
        'pg_restore -Cd lab_app /tmp/app.dump',
        `pg_restore --create -d "dbname='lab_app'" /tmp/app.dump`,
    ])('%s takes no Lab waiver', command => {
        expect(run(command).action).toBe('block');
    });
});

test('the DROP OWNED card says it deletes what the role owns', () => {
    const card = describeGate('psql -X -h db.example.com -d app -c "DROP OWNED BY retired_app CASCADE"', 'Destructive PostgreSQL SQL detected (DROP OWNED)', '/tmp');
    expect(card.summary).toContain('Deletes every object the named roles own');
    expect(card.summary).toContain("can't be recovered without a backup");
    expect(card.summary).not.toContain('Changes who can sign in');
});
