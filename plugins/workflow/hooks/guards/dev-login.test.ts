import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_SCOPE_FILE_ENV, devLoginTestHooks, evaluateBashCommand } from './block-destructive-core';

/**
 * TRUSTED DEV LOGIN. A dev-scope entry may name the login its connection signs in as. When the Snowflake CLI's own
 * config shows that connection signing in as that user on that account, and a grants check vouched for the login
 * recently, any SQL on the connection skips approval: Snowflake itself refuses writes outside the dev databases.
 * Anything that could point the command at another login keeps the card. The container mounts that config
 * read-only; these tests stand in for the mount through `devLoginTestHooks`, except where they test it.
 */

let dir = '';
let home = '';
let scopeFile = '';
const saved: Record<string, string | undefined> = {};
const realConfigLocked = devLoginTestHooks.configLocked;
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
    for (const k of ['HOME', DEV_SCOPE_FILE_ENV, 'DEV_LOGIN_TEST_EXPORTED']) saved[k] = process.env[k];
    process.env.DEV_LOGIN_TEST_EXPORTED = '1';
    dir = mkdtempSync(join(tmpdir(), 'dev-login-test-'));
    home = join(dir, 'home');
    mkdirSync(join(home, '.snowflake'), { recursive: true });
    scopeFile = join(dir, 'dev-scope.local.json');
    process.env.HOME = home;
    process.env[DEV_SCOPE_FILE_ENV] = scopeFile;
    devLoginTestHooks.configLocked = () => true;
});

afterEach(() => {
    writeScope({ user: 'AGENT_DEV_USER', account: 'ACME-DEV1', verifiedUntil: hours(24) });
    writeConnections(GOOD_CONNECTIONS);
});

afterAll(() => {
    devLoginTestHooks.configLocked = realConfigLocked;
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
        ['a file written on the line', `python3 gen.py > /tmp/q.sql; snow sql -c acme_dev -f /tmp/q.sql`],
        ['a role and database of its own choosing', 'snow sql --connection=acme_dev --role OTHER --database prod_db -q "delete from s.t"'],
        ['templating', `snow sql -c acme_dev -q '<% ctx.env.q %>' --env 'q=drop table t'`],
        ['after a cd', 'cd /tmp && snow sql -c acme_dev -q "truncate table s.t"'],
        ['under timeout', 'timeout 60 snow sql -c acme_dev -q "drop schema s"'],
        ['commands after the step and beside it in a pipeline', 'snow sql -c acme_dev -q "drop table t" 2>&1 | python3 -c "import sys"; HOME=/x; echo done'],
        ['a pipeline before the step', 'cat a | grep b; snow sql -c acme_dev -q "drop table t"'],
        ['external programs before the step', `sed -i 's/a/b/' /tmp/q.sql && python3 gen.py; timeout 60 snow sql -c acme_dev -f /tmp/q.sql`],
        ['PATH named on the line', 'ls $PATH; snow sql -c acme_dev -q "drop table t"'],
        ['HOME read on the line', 'cd $HOME/work && snow sql -c acme_dev -q "drop table t"'],
        ['a steering name inside the SQL itself', `snow sql -c acme_dev -q "select 'PATH', home_dir from s.t"`],
        ['a file under HOME', 'snow sql -c acme_dev -f "$HOME/q.sql"'],
        ['a shell variable the environment does not hold', 'S=dev_db.scratch; snow sql -c acme_dev -q "drop table $S.t"'],
        ['a quoted variable as an option value', 'R=DEV_RW; snow sql -c acme_dev --role "$R" -q "drop table t"'],
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
        ['PATH set on the line', 'PATH=/tmp/bin; snow sql -c acme_dev -q "drop table t"'],
        ['a loop over PATH', 'for PATH in /tmp/bin; do snow sql -c acme_dev -q "drop table t"; done'],
        ['a HOME default', 'echo ${HOME:=/tmp/h}; snow sql -c acme_dev -q "drop table t"'],
        ['arithmetic', '(( HOME = 1 )); snow sql -c acme_dev -q "drop table t"'],
        ['an arithmetic expansion', 'n=$((HOME=1)); snow sql -c acme_dev -q "drop table t"'],
        ['the admin connection in a shell variable', 'C=acme_admin; snow sql -c $C -q "drop table t"'],
        ['old-style arithmetic', 'echo $[HOME=1]; snow sql -c acme_dev -q "drop table t"'],
        ['arithmetic in an array subscript', 'echo ${a[HOME=1]}; snow sql -c acme_dev -q "drop table t"'],
        ['arithmetic in a substring offset', 'echo ${x:HOME=1}; snow sql -c acme_dev -q "drop table t"'],
        ['a [[ ]] test', '[[ HOME -eq 1 ]]; snow sql -c acme_dev -q "drop table t"'],
        ['an indexed assignment', 'a[HOME=1]=x; snow sql -c acme_dev -q "drop table t"'],
        ['arithmetic in the step itself', 'snow sql -c acme_dev -q "drop table t$((HOME=1))"'],
        ['printf -v', `printf -v X '%s' 1; snow sql -c acme_dev -q "drop table t"`],
        ['a builtin other than cd before the step', `echo hi; snow sql -c acme_dev -q "drop table t"`],
        ['test -v with an array subscript', `test -v 'a[HOME=1]'; snow sql -c acme_dev -q "drop table t"`],
        ['jobs -x running a command', `jobs -x export HOME=/tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['arithmetic in a redirect', `ls > $((HOME=1)); snow sql -c acme_dev -q "drop table t"`],
        ['arithmetic in an array assignment', `a=( $((HOME=1)) ); snow sql -c acme_dev -q "drop table t"`],
        ['printf with an option held in a variable', `OPT=-v; printf "$OPT" HOME /tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['printf with a quoted option', `printf '-v' HOME /tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['printf with an escaped option', `printf \\-v HOME /tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['printf with a brace-expanded option', `printf {-v,} HOME /tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['printf with a globbed option', `printf -[v] HOME /tmp/other; snow sql -c acme_dev -q "drop table t"`],
        ['a builtin that changes shell state', 'shopt -s lastpipe; snow sql -c acme_dev -q "drop table t"'],
        ['hash repointing snow', 'hash -p /tmp/evil snow; snow sql -c acme_dev -q "drop table t"'],
        ['a command name that expands', '$CMD x; snow sql -c acme_dev -q "drop table t"'],
        ['arithmetic in an external command', 'ls $((HOME=1)); snow sql -c acme_dev -q "drop table t"'],
        ['assigning any name the environment holds', 'DEV_LOGIN_TEST_EXPORTED=x; snow sql -c acme_dev -q "drop table t"'],
        ['a subshell holding the step', '( snow sql -c acme_dev -q "drop table t" )'],
        ['a loop over a shell variable', 'for i in 1 2; do snow sql -c acme_dev -q "drop table t$i"; done'],
        ['PYTHONPATH named on the line', 'PYTHONPATH=/tmp/x; snow sql -c acme_dev -q "drop table t"'],
        ['a SNOWFLAKE_ name on the line', 'SNOWFLAKE_HOME=/tmp/sf; snow sql -c acme_dev -q "drop table t"'],
        ['a coprocess', 'coproc snow sql -c acme_dev -q "drop table t"'],
        ['a step xargs runs', `echo t | xargs -I{} snow sql -c acme_dev -q "drop table {}"`],
        ['a literal step xargs runs', `echo t | xargs -I{} snow sql -c acme_dev -q "drop table t"`],
        ['a literal step find runs', `find /tmp -maxdepth 0 -exec snow sql -c acme_dev -q "drop table t" \\;`],
        ['a step find runs', `find /tmp -name q.sql -exec snow sql -c acme_dev -f {} \\;`],
        ['even the dev connection in a shell variable', 'C=acme_dev; snow sql -c $C -q "drop table t"'],
        ['an exported variable', 'export SNOWFLAKE_CONNECTIONS_ACME_DEV_USER=ADMIN_USER; snow sql -c acme_dev -q "drop table t"'],
        ['an unquoted variable that splits into more options', `R='DEV_RW --user ADMIN_USER'; snow sql -c acme_dev --role $R -q "drop table t"`],
        ['an unquoted command substitution', 'snow sql -c acme_dev --role $(cat /tmp/r) -q "drop table t"'],
        ['an unquoted glob', 'snow sql -c acme_dev --role DEV* -q "drop table t"'],
        ['"$@" in the step', 'snow sql -c acme_dev --role "$@" -q "drop table t"'],
        ['a function named snow', 'snow() { command snow sql -c acme_admin -q "$5"; }; snow sql -c acme_dev -q "drop table t"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test('a config reached through a symlink is never trusted', () => {
        const target = join(dir, 'elsewhere.toml');
        const link = join(home, '.snowflake', 'connections.toml');
        writeFileSync(target, GOOD_CONNECTIONS);
        rmSync(link);
        symlinkSync(target, link);
        try {
            expect(verdict('snow sql -c acme_dev -q "drop table prod_db.s.t"')).toBe('gate');
        } finally {
            rmSync(link);
            writeConnections(GOOD_CONNECTIONS);
        }
    });

    test('a config the agent can write is never trusted', () => {
        devLoginTestHooks.configLocked = realConfigLocked;
        try {
            expect(verdict('snow sql -c acme_dev -q "drop table prod_db.s.t"')).toBe('gate');
        } finally {
            devLoginTestHooks.configLocked = () => true;
        }
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
        ['it reads a token file', `${GOOD_CONNECTIONS.replace('role = "AGENT_DEV"', 'token_file_path = "/tmp/t"')}`, ''],
        ['it signs in through OAuth', GOOD_CONNECTIONS.replace('authenticator = "SNOWFLAKE_JWT"', 'authenticator = "OAUTH"'), ''],
        ['it names no key', GOOD_CONNECTIONS.replace('private_key_path = "/home/node/.snowflake/keys/dev/rsa_key.p8"', ''), ''],
        ['a header quoted differently', GOOD_CONNECTIONS.replace('[acme_dev]', '["acme_dev"]') + '\n[ acme_dev ]\nuser = "ADMIN_USER"\n', ''],
        ['a value that is not a string', GOOD_CONNECTIONS.replace('role = "AGENT_DEV"', 'role = 1'), ''],
    ])('%s', (_name, connections, config) => {
        writeConnections(connections, config);
        expect(verdict('snow sql -c acme_dev -q "drop table prod_db.s.t"')).toBe('gate');
    });
});
