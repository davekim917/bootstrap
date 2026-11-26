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
const CLUSTER_SQL = new Set(PRIVILEGE_SQL.filter(sql => /^(?:create|alter|drop)\s+(?:role|user|group)\b|^grant\s+app_admin\b|^reassign\s+owned\b/i.test(sql)));

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
        expect(run('psql -h db.example.com -d lab_app -c "GRANT SELECT ON t TO app_reader"').action).toBe('allow');
    });
    test.each([['CREATE ROLE app LOGIN'], ['ALTER ROLE app SUPERUSER'], ['DROP USER app']])('%s on a lab database gates', (sql) => {
        expect(run(`psql -h db.example.com -d lab_app -c "${sql}"`).action).toBe('gate');
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
    const LAB = 'psql -h db.example.com -d lab_app';
    test.each([
        ['role membership', `${LAB} -c "GRANT app_admin TO app_reader"`],
        ['revoking role membership', `${LAB} -c "REVOKE app_admin FROM app_reader"`],
        ['REASSIGN OWNED', `${LAB} -c "REASSIGN OWNED BY app_a TO app_b"`],
        ['DROP OWNED', `${LAB} -c "DROP OWNED BY app_a"`],
        ['\\password', () => `${LAB} -f ${join(fx, 'password.sql')}`],
        ['\\gexec', () => `${LAB} -f ${join(fx, 'gexec.sql')}`],
    ])('%s on a lab database gates', (_name, command) => {
        expect(run(typeof command === 'function' ? command() : command).action).toBe('gate');
    });
    test.each([
        ['a grant on an object', `${LAB} -c "GRANT SELECT ON t TO app_reader"`],
        ['CREATE USER MAPPING', `${LAB} -c "CREATE USER MAPPING FOR app SERVER s"`],
    ])('%s on a lab database runs', (_name, command) => {
        expect(run(command).action).toBe('allow');
    });
});
