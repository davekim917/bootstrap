import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, changesProduction, evaluateBashCommand, parseDevScope } from './block-destructive-core';

/**
 * RENDER PRODUCTION CHANGES. Every Render command except a short read-only list
 * stops for an approval, and the approval is a production gate, which the host
 * lets only an owner or admin answer. A command whose target is a Render
 * resource id the operator listed as dev runs without one.
 */

const DEV = 'srv-devservice0000000001';
const PROD = 'srv-prodservice000000001';
const PROD_DB = 'dpg-proddatabase00000001-a';
const DEV_DB = 'dpg-devdatabase000000001-a';

let dir = '';
let saved: string | undefined;
let savedProfile: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    savedProfile = process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
    dir = mkdtempSync(join(tmpdir(), 'render-prod-test-'));
    const scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({ snowflake: [], render: { resources: [DEV, DEV_DB] } }));
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
});

afterEach(() => {
    if (savedProfile === undefined) delete process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
    else process.env.NANOCLAW_INSTRUCTIONS_PROFILE = savedProfile;
});

afterAll(() => {
    if (saved === undefined) delete process.env[DEV_SCOPE_FILE_ENV];
    else process.env[DEV_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

describe('reading Render needs no approval', () => {
    test.each([
        'onecli agents list',
        `onecli run --agent ag-example -- render services -o json`,
        'render services list -o json',
        'render services -o json',
        'render services instances ' + PROD + ' -o json',
        `render deploys list ${PROD} -o json`,
        `render jobs list ${PROD} -o json`,
        `render logs -r ${PROD} --limit 50`,
        `render postgres get ${PROD_DB} -o json`,
        'render workspace set tea-workspace000000000001',
        'render whoami -o json',
        'render --version',
        `render jobs create ${PROD} --help`,
        `render services delete ${PROD} --help`,
        'render services -e evm-environment000000001 -o json',
        'render service list -o json',
        `render workflows tasks list ${PROD} -o json`,
        `render workflows tasks runs show ${PROD} -o json`,
        `render workflows versions list ${PROD} -o json`,
        `render logs --text delete -r ${PROD}`,
        'render -ojson services',
        'render postgres ls -o json',
        'render pg ls -o json',
        'render keyvalue list -o json',
        `render workflows runs list ${PROD} -o json`,
        `render keyvalues get ${PROD} --include-sensitive-connection-info -o json`,
        'render blueprints validate -w tea-workspace000000000001',
        `render workflows tasks runs show ${PROD} --local -o json`,
        'render skills list --scope project',
        'render postgres list',
        `render keyvalues get ${PROD}`,
        `render services instances ${PROD}`,
        'render workspaces',
        `render workflows tasks runs list ${PROD}`,
        `render logs --tail=false -r ${PROD}`,
        `render logs -r ${PROD} -o interactive`,
        `render services instances ${PROD} -o interactive`,
    ])('%s', (command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('changing a Render resource not listed as dev is a production change', () => {
    test.each([
        ['a one-off job', `render jobs create ${PROD} --confirm -o json --start-command "node job.js"`],
        ['a one-off job after a global flag', `render -o json jobs create ${PROD} --start-command "node job.js"`],
        ['a restart', `render restart ${PROD} --confirm`],
        ['a deploy', `render deploys create ${PROD} --wait`],
        ['a service update', `render services update ${PROD} --plan pro`],
        ['a service delete', `render services delete ${PROD} --confirm`],
        ['a database suspend', `render postgres suspend ${PROD_DB}`],
        ['a shell on the service', `render ssh ${PROD}`],
        ['a command the read list does not know', 'render ea sandboxes create'],
        ['a listed target beside an unlisted id', `render jobs create ${DEV} --start-command "curl -X POST x/${PROD}"`],
        ['a listed target beside an unlisted id in a list', `render restart ${DEV},${PROD}`],
        ['a target held in a variable', `S=${DEV}; render restart $S`],
        ['a dev id given as a flag value beside a production target', `render jobs create --start-command ${DEV} ${PROD}`],
        ['a dev target run through xargs', `echo ${DEV} | xargs render restart`],
        ['an interactive SQL session', `render psql ${PROD_DB}`],
        ['a SQL read on a production database', `render psql ${PROD_DB} -c 'select count(*) from accounts' -o text`],
        ['a SQL write', `render psql ${PROD_DB} -c 'DROP TABLE public.accounts'`],
        ['a subcommand after a switch given with =', `render services --confirm=true update ${PROD} --plan pro`],
        ['a subcommand after an attached output flag', `render services -ojson update ${PROD} --plan pro`],
        ['a subcommand held in a variable', `A=update; render services "$A" ${PROD} --plan pro`],
        ['a shell escape on a dev database', `render psql ${DEV_DB} -c '\\! render restart srv-"prodservice000000001"'`],
        ['psql arguments passed through on a dev database', `render psql ${DEV_DB} -c 'select 1' -- -d postgresql://db.example.com/app -c 'DROP TABLE accounts'`],
        ['an interactive session on a dev database', `render psql ${DEV_DB}`],
        ['a help flag set to false', `render restart ${PROD} --help=false --confirm`],
        ['a subcommand spelled as a glob', `touch delete; render services [d]elete ${PROD} --confirm`],
        ['a production database named before a listed dev one', `render psql production ${DEV_DB} -c 'DROP TABLE accounts'`],
        ['a flag the guard does not know', `render services update ${PROD} --suspend-everything`],
        ['a database version flag, which is not help', `render postgres create --version 17 --name production-db --confirm`],
        ['a command the tree does not know, beside a listed dev id', `render ea objects delete backups ${DEV} --region oregon`],
        ['a listing with no output format, which may open a menu', 'render services list'],
        ['a listing forced interactive with an equals sign', 'render services -o=interactive'],
        ['a listing whose output mode comes from the environment', 'RENDER_OUTPUT=interactive render services'],
        ['a shell whose flag the guard would misread as taking a value', `render ssh -e production-api ${DEV} -o interactive`],
        ['a services menu named with a dev id it ignores', `render services ${DEV} -o interactive`],
        ['a projects menu named with a dev id it ignores', `render projects ${DEV} -o interactive`],
        ['psql on a dev database, which reads startup files', `render psql ${DEV_DB} -c 'select 1' -o text`],
        ['a workflow start on a dev id, which opens an input form', `render workflows start ${DEV}`],
        ['a restart behind timeout options', `timeout --signal=TERM 60s render restart ${PROD} --confirm`],
        ['a restart behind timeout with a separate signal', `timeout -s TERM 60 render restart ${PROD} --confirm`],
        ['a restart behind command --', `command -- render restart ${PROD} --confirm`],
        ['a restart behind nice with an attached niceness', `nice -n10 render restart ${PROD} --confirm`],
        ['a deploy behind nohup and its option terminator', `nohup -- render deploys create ${PROD} --wait --confirm`],
        ['a restart behind time -p', `time -p render restart ${PROD} --confirm`],
        ['a restart behind GNU time writing its report to a file', `/usr/bin/time -o /tmp/render.time render restart ${PROD} --confirm`],
        ['a restart behind GNU time with a format', `/usr/bin/time -f '%e' render restart ${PROD} --confirm`],
        ['a restart behind GNU time with a clustered -ao', `/usr/bin/time -ao /tmp/render.time render restart ${PROD} --confirm`],
        ['a restart behind GNU time with an attached output file', `/usr/bin/time -o/tmp/render.time render restart ${PROD} --confirm`],
        ['a restart behind GNU time with --output=', `/usr/bin/time --output=/tmp/render.time render restart ${PROD} --confirm`],
        ['a deploy behind stdbuf', `stdbuf -oL render deploys create ${PROD} --wait --confirm`],
        ['a deploy behind stdbuf with a separate mode', `stdbuf -o L render deploys create ${PROD} --wait --confirm`],
        ['a deploy behind setsid', `setsid -f render deploys create ${PROD} --confirm`],
        ['a restart behind onecli run', `onecli run --agent ag-example -- render restart ${PROD} --confirm`],
        ['a restart behind nice --adjustment', `nice --adjustment=10 render restart ${PROD} --confirm`],
        ['a read followed by a write', `render psql ${PROD_DB} -c 'select 1; delete from accounts'`],
        ['a read that calls a side-effecting function', `render psql ${PROD_DB} -c "select pg_terminate_backend(42)"`],
        ['psql arguments passed through', `render psql ${PROD_DB} -- -c 'select 1'`],
        ['a pgcli session', `render pgcli ${PROD_DB}`],
        ['a workflow dev run, which runs any program', `render workflows dev -- render restart ${PROD}`],
        ['a help word given as a flag value', `render jobs create ${PROD} --start-command --help --confirm`],
        ['a dev id given as a flag value beside a variable target', `S=${PROD}; render jobs create --start-command ${DEV} "$S" --confirm`],
        ['a task run start', `render workflows tasks runs start ${PROD}`],
        ['a version release', `render workflows versions release ${PROD}`],
        ['a listing forced into interactive mode', 'render services -o interactive'],
        ['an inherited object key as a command', 'render constructor'],
        ['another inherited object key', 'render toString'],
    ])('%s', (_label, command) => {
        expect(verdict(command)).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });
});

describe('a Render resource listed as dev changes freely', () => {
    test.each([
        `render jobs create ${DEV} --confirm -o json --start-command "node job.js"`,
        `render restart ${DEV}`,
        `render deploys create ${DEV}`,
        `render jobs create --start-command "node job.js" ${DEV}`,
    ])('%s', (command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('which gate a stopped command takes', () => {
    test('a destructive command that touches no Render resource keeps the destructive gate', () => {
        expect(verdict('kubectl delete deployment app')).toBe('gate');
        expect(changesProduction('kubectl delete deployment app', '/tmp')).toBe(false);
    });

    test('a Render production change beside another destructive step takes the production gate', () => {
        const command = `kubectl delete deployment app && render restart ${PROD}`;
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a render command run by a SQL client takes the production gate', () => {
        const command = `psql -X -c '\\! render restart ${PROD}'`;
        expect(verdict(command)).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a render command in a SQL file a client runs takes the production gate', () => {
        const file = join(dir, 'prodguard.sql');
        writeFileSync(file, `\\! render restart ${PROD}\n`);
        const command = `psql -X -f ${file}`;
        expect(verdict(command)).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a render command after another gated program in a SQL file still takes the production gate', () => {
        const file = join(dir, 'two.sql');
        writeFileSync(file, `\\! kubectl delete deployment app\n\\! render restart ${PROD} --confirm\n`);
        const command = `psql -X -f ${file}`;
        expect(verdict(command)).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(true);
    });

    test('a dev Render change beside another destructive step keeps the destructive gate', () => {
        const command = `kubectl delete deployment app && render restart ${DEV}`;
        expect(verdict(command)).toBe('gate');
        expect(changesProduction(command, '/tmp')).toBe(false);
    });
});

describe('a lab session', () => {
    test('a lab- word does not vouch for a command that names a Render resource id', () => {
        process.env.NANOCLAW_INSTRUCTIONS_PROFILE = 'lab';
        expect(verdict(`render services delete ${PROD} lab-app-api --confirm`)).toBe('gate');
        expect(verdict(`render jobs create ${PROD} --start-command lab-app-api`)).toBe('gate');
        expect(verdict(`render jobs create "$S" --start-command lab-task --confirm`)).toBe('gate');
        expect(verdict(`render psql production lab-db -c 'DROP TABLE accounts'`)).toBe('gate');
        expect(verdict('render ea objects delete backups lab-cache --region oregon')).toBe('gate');
        expect(verdict('render services delete lab-app-api --confirm')).toBe('allow');
    });
});

describe('dev-scope render entries', () => {
    test.each([
        [{ snowflake: [], render: { resources: [DEV] } }, true],
        [{ snowflake: [] }, true],
        [{ snowflake: [], render: { resources: [] } }, false],
        [{ snowflake: [], render: { resources: ['my-dev-service'] } }, false],
        [{ snowflake: [], render: [DEV] }, false],
    ])('%j parses: %p', (scope, ok) => {
        expect(parseDevScope(JSON.stringify(scope)) !== null).toBe(ok);
    });
});
