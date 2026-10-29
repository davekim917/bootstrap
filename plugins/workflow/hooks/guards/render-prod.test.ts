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

let dir = '';
let saved: string | undefined;
let savedProfile: string | undefined;

beforeAll(() => {
    saved = process.env[DEV_SCOPE_FILE_ENV];
    savedProfile = process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
    dir = mkdtempSync(join(tmpdir(), 'render-prod-test-'));
    const scopeFile = join(dir, 'dev-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({ snowflake: [], render: { resources: [DEV] } }));
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
        'render services list -o json',
        'render services -o json',
        'render services instances ' + PROD,
        `render deploys list ${PROD} -o json`,
        `render jobs list ${PROD}`,
        `render logs -r ${PROD} --limit 50`,
        `render postgres get ${PROD_DB}`,
        'render workspace set tea-workspace000000000001',
        'render whoami -o json',
        'render --version',
        `render jobs create ${PROD} --help`,
        `render psql ${PROD_DB}`,
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
        ['a target given only after a flag value', `render jobs create --start-command "node job.js" ${DEV}`],
        ['a dev target run through xargs', `echo ${DEV} | xargs render restart`],
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
