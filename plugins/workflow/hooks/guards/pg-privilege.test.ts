import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, LAB_SCOPE_FILE_ENV, changesProduction, describeGate, evaluateBashCommand } from './block-destructive-core';

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

// Statements on roles, which the whole cluster holds: role DDL, role membership, and moving or dropping what a role owns.
const CLUSTER_SQL = new Set(PRIVILEGE_SQL.filter(sql => /^(?:create|alter|drop)\s+(?:role|user|group)\b|^grant\s+app_admin\b|^reassign\s+owned\b|^alter\s+database\b[\s\S]*\bowner\s+to\b/i.test(sql)));

describe('a role or privilege change on a reachable Postgres is never run without approval', () => {
    for (const sql of PRIVILEGE_SQL) {
        test.each([
            ['dev, through its connection string', viaUri(DEV_DB, sql), 'block'],
            ['prod, through its connection string', viaUri(PROD_DB, sql), 'block'],
            ['dev, its host written out', viaHost(DEV_DB, sql), 'gate'],
            ['prod, its host written out', viaHost(PROD_DB, sql), 'gate'],
            // A listed dev database waives changes to its own objects; a role, which the whole cluster holds, keeps its card.
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

    test('a listed dev database holds it as dev and says why', () => {
        const command = viaRender(DEV_DB, 'GRANT app_admin TO app_reader');
        const { reason } = run(command);
        expect(changesProduction(command, '/tmp')).toBe(false);
        expect(reason).toContain(DEV_DB);
        expect(reason).toContain('whole cluster holds');
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
        ['--file= on a dev host', () => 'psql -X -h ' + host(DEV_DB) + ' -U app -d app --file=' + join(dir, 'missing.sql')],
    ])('%s is refused', (_what, command) => {
        expect(run(command()).action).toBe('block');
    });

    // curl writes the file on the line, so it is there when psql opens it: unread, which cards rather than refuses.
    test('a file a program the guard does not trace writes on the line takes a card', () => {
        expect(run('curl -s -o ' + join(dir, 'fetched.sql') + ' https://example.com/m.sql && psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + join(dir, 'fetched.sql')).action).toBe('gate');
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

    test('a file in a directory the guard may not look into is carded, not refused as missing', () => {
        const closed = join(dir, 'closed');
        mkdirSync(closed);
        writeFileSync(join(closed, 'x.sql'), 'select 1;\n');
        chmodSync(closed, 0o000);
        try {
            expect(run('psql -X -h ' + host(PROD_DB) + ' -U app -d app -f ' + join(closed, 'x.sql')).action).toBe('gate');
        } finally {
            chmodSync(closed, 0o700);
        }
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
            'nested.sql': '/* note /* inner */\nGRANT ALL ON t TO public;\n*/\nselect 1;\n',
            'copy-hides.sql': "COPY t FROM stdin;\nO'Brien\n\\.\nGRANT ALL ON t TO public;\n",
            'copy-data.sql': 'COPY t FROM stdin;\nGRANT x\n\\.\nselect 1;\n',
            'copy-comment.sql': '-- Previous import used COPY staging_orders FROM STDIN;\nDROP TABLE IF EXISTS staging_orders;\nCOPY import_log FROM STDIN;\nimported\n\\.\n',
        };
        for (const [name, text] of Object.entries(files)) writeFileSync(f(name), text);
    });
    afterAll(() => rmSync(fx, { recursive: true, force: true }));
    const H = 'psql -h db.example.com';

    test.each([
        ['-f clustered after -X', () => `${H} -Xf ${f('grant.sql')}`],
        ['pg_dump piped in', () => `pg_dump -h src.example.com db | ${H}`],
        ['gunzip piped in', () => `gzip -dc ${f('dump.sql.gz')} | ${H}`],
        ['SQL from a command substitution', () => `${H} -c "$(cat ${f('grant.sql')})"`],
        ['a file cp replaces earlier on the line', () => `cp ${f('grant.sql')} ${f('ok.sql')} && ${H} -f ${f('ok.sql')}`],
        ['a file curl downloads earlier on the line', () => `curl -o ${f('ok.sql')} https://example.com/m.sql && ${H} -f ${f('ok.sql')}`],
        ['\\gexec, which runs query results as SQL', () => `${H} -f ${f('gexec.sql')}`],
        ['\\password, which alters a role', () => `${H} -f ${f('password.sql')}`],
        ['\\i of a name psql fills in from a variable', () => `${H} -v migration=${f('grant.sql')} -f ${f('include.sql')}`],
        ['a GRANT first in a labelled block', () => `${H} -f ${f('label.sql')}`],
        ['a GRANT after COPY data holding an apostrophe', () => `${H} -f ${f('copy-hides.sql')}`],
        ['a DROP after a comment that mentions COPY FROM STDIN', () => `${H} -X -f ${f('copy-comment.sql')}`],
        ['an unreadable EXECUTE on a listed dev database', () => `render psql ${DEV_DB} -c "DO \\$\\$ BEGIN EXECUTE format('GRANT ALL ON %I TO public', 't'); END \\$\\$" -o text`],
    ])('%s gates', (_name, command) => {
        expect(run(command()).action).toBe('gate');
    });

    test.each([
        ['a missing file named with -f clustered after -X', () => `${H} -Xf ${f('missing.sql')}`],
        ['a missing file beside an output file', () => `${H} -o ${f('out.txt')} -f ${f('missing.sql')}`],
    ])('%s is refused with the fix', (_name, command) => {
        const verdict = run(command());
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain("isn't there yet");
    });

    test('a missing file on a target the guard can\'t name gets both fixes', () => {
        const verdict = run(`psql "$URI" -f ${f('missing.sql')}`);
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('Write the file in one call');
        expect(verdict.reason).toContain('scratch-postgres helper');
    });

    test.each([
        ['a cat earlier on the line, which leaves the file alone', () => `cat ${f('ok.sql')} && ${H} -f ${f('ok.sql')}`],
        ['a cat of a readable file piped in', () => `cat ${f('ok.sql')} | ${H}`],
        ['a literal echo piped in', () => `echo 'select 1' | ${H}`],
        ['a literal printf piped in', () => `printf 'select 1;\\n' | ${H}`],
        ['a GRANT inside a nested comment', () => `${H} -f ${f('nested.sql')}`],
        ['COPY data whose row starts with GRANT', () => `${H} -f ${f('copy-data.sql')}`],
        ['a $( ) psql gets in single quotes, as text', () => `${H} -c '$(not run)'`],
    ])('%s runs', (_name, command) => {
        expect(run(command()).action).toBe('allow');
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

describe('psql input outside the listed forms takes a card, and only a missing file is refused', () => {
    let fx = '';
    const f = (name: string) => join(fx, name);
    beforeAll(() => {
        fx = mkdtempSync(join(tmpdir(), 'pg-forms-'));
        writeFileSync(f('m.sql'), 'select 1;\n');
        writeFileSync(f('mention.sql'), '-- \\gexec and \\password are covered in the runbook\nselect 1;\n');
        writeFileSync(f('client-copy.sql'), "\\copy t from stdin\nO'Brien\n\\.\nGRANT ALL ON t TO public;\n");
    });
    afterAll(() => rmSync(fx, { recursive: true, force: true }));
    const H = 'psql -h db.example.com';

    test.each([
        ['a dump through tee', () => `pg_dump -h src.example.com db | tee ${f('copy.sql')} | ${H}`],
        ['a file an unquoted heredoc writes, whose expansions the guard does not trace', () => `cat > ${f('w1.sql')} <<EOF\nselect $X;\nEOF\n${H} -f ${f('w1.sql')}`],
        ['a file an echo of a variable writes', () => `echo "$SQL" > ${f('w2.sql')}; ${H} -f ${f('w2.sql')}`],
        ['a file cp writes, rather than a refusal for a file not there yet', () => `cp ${f('m.sql')} ${f('w3.sql')}; ${H} -f ${f('w3.sql')}`],
        ['a traced write that cp then replaces', () => `cat > ${f('w4.sql')} <<'EOF'\nselect 1;\nEOF\ncp ${f('m.sql')} ${f('w4.sql')}; ${H} -f ${f('w4.sql')}`],
        ['a GRANT a quoted heredoc writes, which is read and carded for what it is', () => `cat > ${f('w5.sql')} <<'EOF'\nGRANT ALL ON t TO public;\nEOF\n${H} -f ${f('w5.sql')}`],
        ['echo -e, whose escapes can build SQL', () => `echo -e '\\x47RANT ALL ON t TO r' | ${H}`],
        ['printf with a hex escape', () => `printf '\\x47RANT ALL ON t TO r' | ${H}`],
        ['an echo of a variable', () => `echo "$SQL" | ${H}`],
        ['a cat reading its own stdin', () => `cat | ${H}`],
        ['a cat of a file cp replaced earlier on the line', () => `cp ${f('m.sql')} ${f('n.sql')}; cat ${f('n.sql')} | ${H}`],
        ['a GRANT piped from a literal echo', () => `echo 'GRANT ALL ON t TO public' | ${H}`],
        ['a pipe inside a command substitution', () => `x=$(pg_dump -h src.example.com db | ${H})`],
        ['a file a redirect wrote earlier on the line', () => `pg_dump -h src.example.com db > ${f('m.sql')}; ${H} -f ${f('m.sql')}`],
        ['\\copy FROM STDIN with no semicolon', () => `${H} -f ${f('client-copy.sql')}`],
    ])('%s gates', (_name, command) => {
        expect(run(command()).action).toBe('gate');
    });

    test.each([
        ['a comment that mentions \\gexec and \\password', () => `${H} -f ${f('mention.sql')}`],
        ['a substitution only in -h, with literal SQL', () => `psql -h "$(cat ${f('m.sql')})" -c 'SELECT 1'`],
        ['a read-only sed preview before -f', () => `sed -n 1,5p ${f('m.sql')} && ${H} -f ${f('m.sql')}`],
        ['CREATE USER MAPPING, which is not a role', () => `${H} -c "CREATE USER MAPPING FOR app SERVER s"`],
        ['a read-only file a quoted heredoc writes earlier on the line', () => `cat > ${f('r1.sql')} <<'EOF'\nBEGIN READ ONLY;\nselect 1;\nEOF\n${H} -f ${f('r1.sql')}`],
        ['a file a literal echo writes', () => `echo 'select 1;' > ${f('r2.sql')}; ${H} -f ${f('r2.sql')}`],
        ['a file a literal printf writes', () => `printf 'select 1;\\n' > ${f('r3.sql')} && ${H} -f ${f('r3.sql')}`],
        ['a file tee writes from a quoted heredoc, read through <', () => `tee ${f('r4.sql')} <<'EOF'\nselect 1;\nEOF\n${H} < ${f('r4.sql')}`],
    ])('%s runs', (_name, command) => {
        expect(run(command()).action).toBe('allow');
    });

    test('a missing file is refused even after a readable one beside -o', () => {
        const verdict = run(`${H} -o ${f('out.txt')} -f ${f('m.sql')} -f ${f('missing.sql')}`);
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain("isn't there yet");
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

describe('psql input, writers and coverage after review', () => {
    let fx = '';
    const f = (name: string) => join(fx, name);
    beforeAll(() => {
        fx = mkdtempSync(join(tmpdir(), 'pg-review-'));
        mkdirSync(f('staging'));
        mkdirSync(f('other'));
        writeFileSync(f('migration.sql'), 'select 1;\n');
        writeFileSync(f('staging/migration.sql'), 'GRANT ALL ON t TO public;\n');
        writeFileSync(f('grant.sql'), 'GRANT ALL ON t TO public;\n');
        writeFileSync(f('ok.sql'), 'GRANT ALL ON t TO public;\n');
        writeFileSync(f('other/ok.sql'), 'select 1;\n');
        writeFileSync(f('inc.sql'), 'select 1;\n');
        writeFileSync(f('outer.sql'), `\\i ${f('inc.sql')}\n`);
        writeFileSync(f('vars.sql'), ':sql\n');
    });
    afterAll(() => rmSync(fx, { recursive: true, force: true }));
    const H = 'psql -h db.example.com';

    test.each([
        ['SQL a variable holds from a substitution, in -c', () => `SQL=$(cat ${f('grant.sql')}); ${H} -c "$SQL"`],
        ['SQL a variable holds from a substitution, in a here-string', () => `SQL=$(cat ${f('grant.sql')}); ${H} <<< "$SQL"`],
        ['a variable the line never sets, in -c', () => `${H} -c "$UNKNOWN"`],
        ['bare psql on the stdin it inherits', () => H],
        ['a psql variable run as SQL from a file', () => `${H} -v sql='GRANT ALL ON t TO public' -f ${f('vars.sql')}`],
        ['a grant below a -- header, through printf', () => `printf '%s\\n' '-- header\nGRANT ALL ON t TO public;' | ${H}`],
        ['a grant below a -- header, through echo', () => `echo '-- header\nGRANT ALL ON t TO public;' | ${H}`],
        ['a copy into the directory that replaces the file', () => `cp ${f('staging/migration.sql')} ${fx} && ${H} -f ${f('migration.sql')}`],
        ['a file an earlier psql -o writes', () => `${H} -o ${f('migration.sql')} -c 'select 1'; ${H} -f ${f('migration.sql')}`],
        ['an \\i file an untraced writer replaces', () => `cp ${f('grant.sql')} ${f('inc.sql')}; ${H} -f ${f('outer.sql')}`],
        ['a cat read from another directory than psql runs in', () => `cat ${'ok.sql'} | env -C ${f('other')} ${H}`],
        ['createuser', () => 'createuser -h db.example.com app_reader'],
        ['dropuser', () => 'dropuser -h db.example.com app_reader'],
        ['pg_restore -d to another server', () => 'pg_restore -d "postgresql://app@db.example.com/app" dump.custom'],
        ['ALTER POLICY', () => `${H} -c "ALTER POLICY p ON t USING (true)"`],
        ['DISABLE ROW LEVEL SECURITY', () => `${H} -c "ALTER TABLE t DISABLE ROW LEVEL SECURITY"`],
        ['NO FORCE ROW LEVEL SECURITY', () => `${H} -c "ALTER TABLE t NO FORCE ROW LEVEL SECURITY"`],
        ['a copy to a variable path the file is read under', () => `F=${f('migration.sql')}; cp ${f('staging/migration.sql')} "$F" && ${H} -f ${f('migration.sql')}`],
        ['a copy made after a cd into the file\'s directory', () => `cd ${f('staging')} && cp ${f('grant.sql')} migration.sql && cd ${fx} && ${H} -f staging/migration.sql`],
        ['a copy into the file\'s directory written with a trailing slash', () => `cp ${f('staging/migration.sql')} ${fx}/ && ${H} -f ${f('migration.sql')}`],
        ['a script pg_restore -vf writes', () => `pg_restore -vf ${f('migration.sql')} dump.custom; ${H} -f ${f('migration.sql')}`],
        ['a script pg_restore -f writes', () => `pg_restore -f ${f('migration.sql')} dump.custom; ${H} -f ${f('migration.sql')}`],
        ['pg_restore with -d clustered after another flag', () => 'pg_restore -cd app -h db.example.com dump.custom'],
        ['CREATE POLICY', () => `${H} -c "CREATE POLICY p ON t USING (true)"`],
        ['PostgreSQL DROP POLICY', () => `${H} -c "DROP POLICY tenant_isolation ON orders"`],
        ['a view made security_invoker', () => `${H} -X -d app -c 'BEGIN; ALTER VIEW reporting.orders SET (security_invoker = true); ROLLBACK'`],
        ['a view without security_barrier', () => `${H} -X -d app -c 'ALTER VIEW reporting.orders RESET (security_barrier)'`],
        ['-d taking -l as its value, so psql reads the stdin it inherits', () => `${H} -d -l`],
        ['a :name the line sets from a variable', () => `${H} -v t="$X" <<'SQL'\nselect * from :t;\nSQL`],
        ["a :'name' the line sets from a variable", () => `${H} -v t="$X" <<'SQL'\nselect :'t';\nSQL`],
        ['a :name the line never sets', () => `${H} <<'SQL'\nselect * from :t;\nSQL`],
        ['a :name whose literal value is more than a word', () => `${H} -v s='DROP TABLE x' <<'SQL'\nselect * from :s;\nSQL`],
    ])('%s takes a card', (_name, command) => {
        expect(evaluateBashCommand(command(), { cwd: fx }).action).toBe('gate');
    });

    test.each([
        ['psql -l, which reads no SQL', () => `${H} -l`],
        ['-l first in a cluster', () => `${H} -lq`],
        ['a -P display setting that reads like a variable', () => `${H} -X -P 'null=:missing' -c 'SELECT NULL'`],
        ['pg_restore --no-policies writing a script to stdout', () => 'pg_restore --no-policies --file=- dump.custom'],
        ['pg_restore --statistics and --restrict-key writing a script', () => 'pg_restore --statistics --restrict-key=abc --file=- dump.custom'],
        ['-l after another flag in a cluster', () => `${H} -Xl`],
        ['printf -- with the format after it', () => `printf -- '%s\\n' 'SELECT 1;' | ${H}`],
        ['a variable the line sets to a literal', () => `B='SELECT 1;'; ${H} -c "$B"`],
        ['LIKE with a percent sign in a printf argument', () => `printf '%s\\n' "SELECT * FROM t WHERE n LIKE '%bob%'" | ${H}`],
        ['a literal printf piped in inside a substitution', () => `result=$(printf 'SELECT 1;' | ${H})`],
        ['a substitution only in -h', () => `${H.replace('db.example.com', '"$(cat h)"')} -c 'SELECT 1'`],
        ['pg_restore -l, which lists the archive', () => 'pg_restore -l dump.custom'],
        ['pg_restore --help', () => 'pg_restore --help'],
        ['pg_restore --version', () => 'pg_restore --version'],
        ['pg_restore -V', () => 'pg_restore -V'],
        ['psql --help', () => `${H} --help`],
        ['psql --version', () => 'psql --version'],
        ['a :name set to a plain word', () => `${H} -v t=orders <<'SQL'\nselect * from :t;\nSQL`],
        ["a :'name' set to a literal", () => `${H} -v n='bob' <<'SQL'\nselect :'n';\nSQL`],
        ['a time literal and a cast, which interpolate nothing', () => `${H} <<'SQL'\nselect '12:30', x::int from t;\nSQL`],
        ['a cat of an absolute path, which env -C does not move', () => `cat ${f('other/ok.sql')} | env -C ${f('staging')} ${H}`],
        ['pg_restore -Fcd, whose -F takes "cd" as its format, so nothing restores to a database', () => 'pg_restore -Fcd dump.custom'],
        ['a -c value, which psql sends to the server with no interpolation', () => `${H} -v t="$X" -c 'select * from :t'`],
    ])('%s runs', (_name, command) => {
        expect(evaluateBashCommand(command(), { cwd: fx }).action).toBe('allow');
    });

    test('a file cp creates on the line, named through a variable, is unread rather than missing', () => {
        expect(evaluateBashCommand(`F=${f('new.sql')}; cp ${f('grant.sql')} "$F"; ${H} -f "$F"`, { cwd: fx }).action).toBe('gate');
    });

    test('a suggested command never repeats the SQL it was given', () => {
        const v = evaluateBashCommand(`psql "$DATABASE_URL" -c "ALTER ROLE app PASSWORD 'zz9-example'; DROP TABLE orders"`, { cwd: fx });
        expect(v.action).toBe('block');
        expect(v.reason).toContain("-c '<your SQL>'");
        expect(v.reason).not.toContain('zz9-example');
    });

    test('a missing file on a listed dev host is refused with its own hint before the -X advice', () => {
        const v = run(`psql -h ${host(DEV_DB)} -U app -d app -f ${f('missing.sql')}`);
        expect(v.action).toBe('block');
        expect(v.reason).toContain("isn't there yet");
        expect(v.reason).not.toContain('with -X added');
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
        ['DROP DATABASE beside -P and a positional database name', `psql -X -P pager=off -h db.example.com lab_app -c "DROP DATABASE prod_app"`],
        ['DROP DATABASE naming another lab_ database', `${LAB} -c "DROP DATABASE IF EXISTS lab_archive"`],
        ['DROP DATABASE after a comment', `${LAB} -c "/* cleanup */ DROP DATABASE prod_app"`],
        ['a Lab database without -X, where a psqlrc could connect elsewhere', `psql -h db.example.com -d lab_app -c "DROP TABLE staging_orders"`],
        ['a MySQL table qualified by another database', `mysql -h db.example.com -D lab_app -e 'TRUNCATE TABLE app.orders'`],
        ['a MySQL table qualified by a quoted database', `mysql -h db.example.com -D lab_app -e 'DELETE FROM \`app\`.orders'`],
        ['a MySQL table qualified by another database in a list', `mysql -h db.example.com -D lab_app -e 'DROP TABLE orders, app.orders'`],
        ['a MySQL USE of another database', `mysql -h db.example.com -D lab_app -e 'USE app; TRUNCATE TABLE orders'`],
        ['a MySQL TRUNCATE short form qualified by another database', `mysql -h db.example.com -D lab_app -e 'TRUNCATE app.orders'`],
        ['a MySQL column qualified by its table', `mysql -h db.example.com -D lab_app -e 'DELETE FROM orders WHERE orders.id = 1'`],
        ['a MySQL table qualified by the default database', `mysql -h db.example.com -D lab_app -e 'TRUNCATE TABLE lab_app.orders'`],
        ['a MySQL client command', `mysql -h db.example.com -D lab_app -e 'TRUNCATE TABLE orders; \\u app'`],
        ['a psql \\connect after SQL on the same line', () => `${LAB} -f ${join(fx, 'connect-inline.sql')}`],
        ['a database rename', `${LAB} -c "ALTER DATABASE prod_app RENAME TO old_app"`],
        ['a MySQL operand that overrides -D', `mysql -h db.example.com -D lab_app inventory -e 'DELETE FROM orders WHERE FALSE'`],
        ['a tablespace rename', `${LAB} -c 'BEGIN; ALTER TABLESPACE archive RENAME TO archive_review; ROLLBACK'`],
        ['an ALTER DATABASE beside a grant', `${LAB} -c "GRANT SELECT ON t TO r; ALTER DATABASE prod_app SET search_path = x"`],
    ])('%s on a lab database gates', (_name, command) => {
        expect(run(typeof command === 'function' ? command() : command).action).toBe('gate');
    });
    test.each([
        ['a grant on an object', `${LAB} -c "GRANT SELECT ON t TO app_reader"`],
        ['CREATE USER MAPPING', `${LAB} -c "CREATE USER MAPPING FOR app SERVER s"`],
        ['a quoted Lab dbname in a conninfo', `psql -X "host=db.example.com dbname='lab_app'" -c "GRANT SELECT ON t TO r"`],
        ['a psql -P setting beside a Lab database', `psql -X -P pager=off -h db.example.com -d lab_app -c "GRANT SELECT ON t TO r"`],
        ['a Lab URI with channel_binding', `psql -X "postgresql://app@192.0.2.30/lab_app?channel_binding=require" -c "GRANT SELECT ON t TO r"`],
        ['a Lab database in a URI', `psql -X "postgresql://app@db.example.com/lab_app" -c "GRANT SELECT ON t TO r"`],
        ['a grant on an object, chosen by the database and not the user', `psql -X -h db.example.com -U app -d lab_app -c "GRANT SELECT ON t TO r"`],
        ['DROP TABLE beside -P and a positional database name', `psql -X -P pager=off -h db.example.com lab_app -c "DROP TABLE t"`],
        ['DROP SCHEMA in the connected database', `${LAB} -c "DROP SCHEMA old_area CASCADE"`],
        ['a MySQL Lab operand that overrides another -D', `mysql -h db.example.com -D inventory lab_app -e 'TRUNCATE TABLE orders'`],
        ['a MySQL table in the default database', `mysql -h db.example.com -D lab_app -e 'TRUNCATE TABLE orders'`],
    ])('%s on a lab database runs', (_name, command) => {
        expect(run(command).action).toBe('allow');
    });
});

test('the DROP OWNED card says it deletes what the role owns', () => {
    const card = describeGate('psql -X -h db.example.com -d app -c "DROP OWNED BY retired_app CASCADE"', 'Destructive PostgreSQL SQL detected (DROP OWNED)', '/tmp');
    expect(card.summary).toContain('Deletes every object the named roles own');
    expect(card.summary).toContain("can't be recovered without a backup");
    expect(card.summary).not.toContain('Changes who can sign in');
});
