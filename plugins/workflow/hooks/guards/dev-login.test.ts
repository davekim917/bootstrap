import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, evaluateBashCommand } from './block-destructive-core';

/**
 * TRUSTED DEV LOGIN. A dev-scope entry may name the login its connection signs in as. When the Snowflake CLI's own
 * config shows that connection signing in as that user on that account, and a grants check vouched for the login
 * recently, any SQL on the connection skips approval: Snowflake itself refuses writes outside the dev databases.
 * Anything that could point the command at another login keeps the card.
 */

let dir = '';
let home = '';
let scopeFile = '';
const saved: Record<string, string | undefined> = {};
const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function writeScope(login: Record<string, unknown> | undefined, connection = 'acme_dev') {
    writeFileSync(scopeFile, JSON.stringify({ snowflake: [{ connection, databases: ['dev_db'], ...(login ? { login } : {}) }] }));
}

function writeConnections(text: string, config = '') {
    writeFileSync(join(home, '.snowflake', 'connections.toml'), text);
    writeFileSync(join(home, '.snowflake', 'config.toml'), config);
}

const GOOD_CONNECTIONS = [
    '[acme_dev]',
    'account = "ACME-DEV1"',
    'user = "AGENT_DEV_USER"',
    'role = "AGENT_DEV"',
    'authenticator = "SNOWFLAKE_JWT"',
    'private_key_path = "/home/node/.snowflake/keys/dev/rsa_key.p8"',
    '',
    '[acme_admin]',
    'account = "ACME-DEV1"',
    'user = "ADMIN_USER"',
    '',
].join('\n');

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

beforeAll(() => {
    for (const k of ['HOME', DEV_SCOPE_FILE_ENV]) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'dev-login-test-'));
    home = join(dir, 'home');
    mkdirSync(join(home, '.snowflake'), { recursive: true });
    scopeFile = join(dir, 'dev-scope.local.json');
    process.env.HOME = home;
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
});

afterEach(() => {
    writeScope({ user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) });
    writeConnections(GOOD_CONNECTIONS);
});

afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
});

describe('a verified dev login runs any SQL without a card', () => {
    beforeAll(() => {
        writeScope({ user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) });
        writeConnections(GOOD_CONNECTIONS);
    });
    test.each([
        ['a prod drop, which the login cannot do', 'snow sql -c acme_dev -q "drop table prod_db.s.t"'],
        ['a file it reads', 'snow sql -c acme_dev -f /tmp/dev-login-never-written.sql'],
        ['a file written on the line', `printf 'drop table t;' > /tmp/q.sql; snow sql -c acme_dev -f /tmp/q.sql`],
        ['a role and database of its own choosing', 'snow sql --connection=acme_dev --role OTHER --database prod_db -q "delete from s.t"'],
        ['templating', `snow sql -c acme_dev -q '<% ctx.env.q %>' --env 'q=drop table t'`],
        ['after a cd', 'cd /tmp && snow sql -c acme_dev -q "truncate table s.t"'],
        ['under timeout', 'timeout 60 snow sql -c acme_dev -q "drop schema s"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('anything that could point the command at another login keeps the card', () => {
    afterEach(() => {
        writeScope({ user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) });
        writeConnections(GOOD_CONNECTIONS);
    });
    test.each([
        ['an account override', 'snow sql -c acme_dev -a OTHER-ACCT -q "drop table t"'],
        ['a long account override', 'snow sql -c acme_dev --account=OTHER-ACCT -q "drop table t"'],
        ['a user override', 'snow sql -c acme_dev --user ADMIN_USER -q "drop table t"'],
        ['a key override', 'snow sql -c acme_dev --private-key-file /tmp/k.p8 -q "drop table t"'],
        ['an authenticator override', 'snow sql -c acme_dev --authenticator externalbrowser -q "drop table t"'],
        ['a host override', 'snow sql -c acme_dev --host evil.example -q "drop table t"'],
        ['a temporary connection', 'snow sql -x --account A --user U -q "drop table t"'],
        ['a config file', 'snow sql --config-file /tmp/c.toml -c acme_dev -q "drop table t"'],
        ['the --environment alias', 'snow sql --environment acme_dev -q "drop table t"'],
        ['two connections', 'snow sql -c acme_dev -c acme_admin -q "drop table t"'],
        ['two connections, the trusted one last', 'snow sql -c acme_admin -c acme_dev -q "drop table t"'],
        ['no connection', 'snow sql -q "drop table t"'],
        ['the admin connection', 'snow sql -c acme_admin -q "drop table t"'],
        ['SNOWFLAKE_HOME on the command', 'SNOWFLAKE_HOME=/tmp/sf snow sql -c acme_dev -q "drop table t"'],
        ['HOME set on the line', 'HOME=/tmp/h; snow sql -c acme_dev -q "drop table t"'],
        ['an exported variable', 'export SNOWFLAKE_CONNECTIONS_ACME_DEV_USER=ADMIN_USER; snow sql -c acme_dev -q "drop table t"'],
        ['a function named snow', 'snow() { command snow sql -c acme_admin -q "$5"; }; snow sql -c acme_dev -q "drop table t"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test.each([
        ['no verification', { user: 'AGENT_DEV_USER', account: 'ACME-DEV1' }],
        ['an expired verification', { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(-1) }],
        ['a verification dated too far ahead', { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24 * 30) }],
        ['an unparseable date', { user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: 'soon' }],
        ['a different user', { user: 'ADMIN_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) }],
        ['a different account', { user: 'AGENT_DEV_USER', account: 'ACME-PROD', verifiedUntil: hours(24) }],
    ])('the scope entry has %s', (_name, login) => {
        writeScope(login);
        expect(verdict('snow sql -c acme_dev -q "drop table prod_db.s.t"')).toBe('gate');
    });

    test.each([
        ['the connection is missing', '[acme_admin]\nuser = "ADMIN_USER"\naccount = "ACME-DEV1"\n', ''],
        ['the connection is defined twice', `${GOOD_CONNECTIONS}\n[acme_dev]\nuser = "ADMIN_USER"\naccount = "ACME-DEV1"\n`, ''],
        ['a key is set twice', '[acme_dev]\naccount = "ACME-DEV1"\nuser = "ADMIN_USER"\nuser = "AGENT_DEV_USER"\n', ''],
        ['it signs in with a password', `${GOOD_CONNECTIONS.replace('role = "AGENT_DEV"', 'password = "x"')}`, ''],
        ['config.toml defines it too', GOOD_CONNECTIONS, '[connections.acme_dev]\nuser = "ADMIN_USER"\n'],
        ['config.toml defines it quoted', GOOD_CONNECTIONS, '[connections."acme_dev"]\nuser = "ADMIN_USER"\n'],
    ])('%s', (_name, connections, config) => {
        writeConnections(connections, config);
        expect(verdict('snow sql -c acme_dev -q "drop table prod_db.s.t"')).toBe('gate');
    });
});
