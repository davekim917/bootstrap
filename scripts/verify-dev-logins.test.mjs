import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectGrants, duplicateConnections, publishEntry, SnowTimeout, verifyAll, verifyEntry, writeGrantsOutside } from './verify-dev-logins.mjs';

const MODULE = process.env.VERIFY_DEV_LOGINS_MODULE || fileURLToPath(new URL('./verify-dev-logins.mjs', import.meta.url));

const g = (privilege, granted_on, name) => ({ privilege, granted_on, name });
// Every role has no future grants unless a fixture lists some.
const fixture = grants => sql => grants[sql] ?? (sql.startsWith('show future grants') ? [] : assert.fail(`unexpected ${sql}`));

test('writes inside the dev databases and reads anywhere pass', () => {
  assert.deepEqual(writeGrantsOutside([
    g('OWNERSHIP', 'TABLE', 'DEV_DB.S.T'),
    g('CREATE SCHEMA', 'DATABASE', 'DEV_DB'),
    g('OWNERSHIP', 'TABLE', '"DEV_DB".S."t"'),
    g('SELECT', 'TABLE', 'PROD_DB.S.T'),
    g('USAGE', 'SCHEMA', 'PROD_DB.S'),
    g('USAGE', 'DATABASE', 'PROD_DB'),
    g('USAGE', 'FILE_FORMAT', 'PROD_DB.S.CSV'),
    g('USAGE', 'SEQUENCE', 'DEV_DB.S.SEQ'),
    g('USAGE', 'STAGE', 'PROD_DB.S.EXT'),
    g('WRITE', 'STAGE', 'PROD_DB.S.INT'),
    g('USAGE', 'STAGE', 'DEV_DB.<STAGE>'),
    g('REFERENCE_USAGE', 'DATABASE', 'PROD_DB'),
    g('IMPORTED PRIVILEGES', 'DATABASE', 'SNOWFLAKE'),
    g('USAGE', 'WAREHOUSE', 'DEV_WH'),
    g('USAGE', 'ROLE', 'READER'),
    g('USAGE', 'COMPUTE_POOL', 'SYSTEM_COMPUTE_POOL_CPU'),
    g('USE AI FUNCTIONS', 'ACCOUNT', 'ACME'),
    g('USAGE', 'PROCEDURE', 'SNOWFLAKE.CORTEX.CREATE_AI_FUNCTION(VARCHAR)'),
    g('INSTANTIATE', 'CLASS', 'SNOWFLAKE.ML.FORECAST'),
    g('OWNERSHIP', 'ROLE', 'OWNED_ROLE'),
    g('OWNERSHIP', 'USER', 'HELPER_USER'),
    g('OPERATE', 'WAREHOUSE', 'PROD_WH'),
  ], ['dev_db']), []);
});

test('any write outside the dev databases fails', () => {
  const problems = writeGrantsOutside([
    g('OWNERSHIP', 'TABLE', 'PROD_DB.S.T'),
    g('INSERT', 'TABLE', 'PROD_DB.S.T'),
    g('CREATE TABLE', 'SCHEMA', 'PROD_DB.S'),
    g('MODIFY', 'DATABASE', 'PROD_DB'),
    g('OWNERSHIP', 'TABLE', '"dev_db".S.T'),
    g('USAGE', 'PROCEDURE', 'PROD_DB.S.WRITER()'),
    g('OPERATE', 'TASK', 'PROD_DB.S.LOAD'),
    g('MANAGE GRANTS', 'ACCOUNT', 'ACME'),
    g('CREATE DATABASE', 'ACCOUNT', 'ACME'),
    g('EXECUTE TASK', 'ACCOUNT', 'ACME'),
    g('MODIFY', 'WAREHOUSE', 'PROD_WH'),
    g('OWNERSHIP', 'SHARE', 'ACME_SHARE'),
    g('OWNERSHIP', 'DATABASE', 'SNOWFLAKE'),
    g('USAGE', 'INTEGRATION', 'S3_INT'),
    g('OWNERSHIP', 'STAGE', 'PROD_DB.S.EXT'),
    g('USAGE', 'SERVICE', 'PROD_DB.S.SVC'),
    g('USAGE', 'PROCEDURE', 'DEV_DB.S.RUNS_AS_OWNER()'),
    g('OPERATE', 'TASK', 'DEV_DB.S.OWNED_BY_PROD_WRITER'),
    g('OPERATE', 'ALERT', 'DEV_DB.S.A'),
    g('USAGE', 'NOTEBOOK', 'DEV_DB.S.NB'),
    g('USAGE', 'STREAMLIT', 'DEV_DB.S.APP'),
    g('USAGE', 'FUNCTION', 'DEV_DB.S.CALLS_A_SERVICE(VARCHAR)'),
    g('USAGE', 'A_KIND_ADDED_LATER', 'DEV_DB.S.X'),
  ], ['DEV_DB']);
  assert.equal(problems.length, 23);
});

test('the walk covers PUBLIC, inherited roles, database roles and users the login owns', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [g('USAGE', 'ROLE', 'CHILD'), g('USAGE', 'DATABASE_ROLE', 'PROD_DB.DBR'), g('OWNERSHIP', 'USER', 'OTHER'), g('OWNERSHIP', 'ROLE', 'OWNED')],
    'show grants to role "OWNED"': [g('TRUNCATE', 'TABLE', 'PROD_DB.S.FROM_OWNED_ROLE')],
    'show grants to role "CHILD"': [g('SELECT', 'TABLE', 'PROD_DB.S.T')],
    'show grants to database role "PROD_DB"."DBR"': [g('INSERT', 'TABLE', 'PROD_DB.S.FROM_DB_ROLE')],
    'show grants to user "OTHER"': [{ role: 'OTHER_ROLE' }],
    'show grants to role "OTHER_ROLE"': [g('DELETE', 'TABLE', 'PROD_DB.S.FROM_OWNED_USER')],
    'show grants to role "PUBLIC"': [g('UPDATE', 'TABLE', 'PROD_DB.S.FROM_PUBLIC')],
  };
  const seen = [];
  const rows = sql => {
    seen.push(sql);
    return fixture(grants)(sql);
  };
  const names = writeGrantsOutside(collectGrants('AGENT', rows, 'DEV_ROLE'), ['DEV_DB']).join(' ');
  for (const t of ['FROM_DB_ROLE', 'FROM_OWNED_USER', 'FROM_OWNED_ROLE', 'FROM_PUBLIC']) assert.match(names, new RegExp(t));
  assert.ok(seen.includes('show grants to role "CHILD"'));
  // Owning a role or a user does not put its grants in the session's view.
  assert.match(names, /GRANTS HIDDEN FROM DEV_ROLE on ROLE OWNED\b/);
  assert.match(names, /GRANTS HIDDEN FROM DEV_ROLE on ROLE OTHER_ROLE/);
  assert.doesNotMatch(names, /HIDDEN FROM DEV_ROLE on (ROLE CHILD|DATABASE_ROLE)/);
});

test('a connection that signs in as another user fails before any grant is read', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'ADMIN_USER', A: 'ORG-A' }];
    throw new Error(`unexpected ${sql}`);
  };
  assert.match(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'ORG-A' } }, rows), /signs in as ADMIN_USER/);
});

test('a connection that signs in to another account fails before any grant is read', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-PROD' }];
    throw new Error(`unexpected ${sql}`);
  };
  assert.match(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'ORG-A' } }, rows), /signs in to ORG-PROD/);
});

test('a dev-only login passes', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-A', R: 'DEV_ROLE' }];
    if (sql.startsWith('show future grants')) return [];
    if (sql === 'show grants to user "AGENT"') return [{ role: 'DEV_ROLE' }];
    if (sql === 'show grants to role "DEV_ROLE"') return [g('OWNERSHIP', 'SCHEMA', 'DEV_DB.S'), g('SELECT', 'VIEW', 'PROD_DB.S.V')];
    if (sql === 'show grants to role "PUBLIC"') return [];
    throw new Error(`unexpected ${sql}`);
  };
  assert.equal(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'ORG-A' } }, rows), null);
});

test('roles differing only in case are both walked, and privileges granted to the user directly are kept', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'READER' }, { role: 'reader' }, g('INSERT', 'TABLE', 'PROD_DB.S.DIRECT')],
    'show grants to role "READER"': [g('SELECT', 'TABLE', 'PROD_DB.S.T')],
    'show grants to role "reader"': [g('DELETE', 'TABLE', 'PROD_DB.S.FROM_QUOTED')],
    'show grants to role "PUBLIC"': [],
  };
  const all = collectGrants('AGENT', fixture(grants), 'READER');
  assert.deepEqual(writeGrantsOutside(all, ['DEV_DB']).sort(), [
    'DELETE on TABLE PROD_DB.S.FROM_QUOTED', 'GRANTS HIDDEN FROM READER on ROLE reader', 'INSERT on TABLE PROD_DB.S.DIRECT',
  ]);
});

test('a procedure that runs with its owner\'s rights walks its owner; one that runs as the caller passes', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [g('USAGE', 'PROCEDURE', 'DEV_DB.S.AS_OWNER(VARCHAR)'), g('USAGE', 'PROCEDURE', 'DEV_DB.S.AS_CALLER(VARCHAR, DEFAULT BOOLEAN)')],
    'describe procedure DEV_DB.S.AS_OWNER(VARCHAR)': [{ property: 'execute as', value: 'OWNER' }],
    'show grants on procedure DEV_DB.S.AS_OWNER(VARCHAR)': [{ privilege: 'OWNERSHIP', granted_to: 'ROLE', grantee_name: 'PROD_WRITER' }],
    'show grants to role "PROD_WRITER"': [g('DELETE', 'TABLE', 'PROD_DB.S.T')],
    'describe procedure DEV_DB.S.AS_CALLER(VARCHAR, BOOLEAN)': [{ property: 'execute as', value: 'CALLER' }],
    'show grants to role "PUBLIC"': [],
  };
  const all = collectGrants('AGENT', fixture(grants), 'DEV_ROLE');
  assert.deepEqual(writeGrantsOutside(all, ['DEV_DB']), ['DELETE on TABLE PROD_DB.S.T', 'GRANTS HIDDEN FROM DEV_ROLE on ROLE PROD_WRITER']);
});

test('the grants read are the signed-in user\'s, not those of a configured spelling that names another user', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-A', R: 'PROD_ROLE' }];
    if (sql.startsWith('show future grants')) return [];
    if (sql === 'show grants to user "AGENT"') return [{ role: 'PROD_ROLE' }];
    if (sql === 'show grants to user "agent"') return [{ role: 'DEV_ROLE' }];
    if (sql === 'show grants to role "PROD_ROLE"') return [g('DELETE', 'TABLE', 'PROD_DB.S.T')];
    if (sql === 'show grants to role "DEV_ROLE"') return [];
    if (sql === 'show grants to role "PUBLIC"') return [];
    throw new Error(`unexpected ${sql}`);
  };
  assert.match(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'agent', account: 'ORG-A' } }, rows), /DELETE on TABLE PROD_DB\.S\.T/);
});

test('a procedure with a quoted name fails the check rather than having its signature rewritten', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [g('USAGE', 'PROCEDURE', 'DEV_DB.S."DEFAULT P"()')],
    'show grants to role "PUBLIC"': [],
  };
  assert.throws(() => collectGrants('AGENT', fixture(grants), 'DEV_ROLE'), /quoted name/);
});

test('a future write grant outside the dev databases fails; a future read passes', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [],
    'show future grants to role "DEV_ROLE"': [
      { privilege: 'DELETE', grant_on: 'TABLE', name: 'PROD_DB.S.<TABLE>' },
      { privilege: 'SELECT', grant_on: 'TABLE', name: 'PROD_DB.S.<TABLE>' },
      { privilege: 'OWNERSHIP', grant_on: 'TABLE', name: 'DEV_DB.S.<TABLE>' },
    ],
    'show grants to role "PUBLIC"': [],
  };
  assert.deepEqual(writeGrantsOutside(collectGrants('AGENT', fixture(grants), 'DEV_ROLE'), ['DEV_DB']), ['DELETE on TABLE PROD_DB.S.<TABLE>']);
});

test('a login with no current role is not vouched for', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-A', R: null }];
    throw new Error(`unexpected ${sql}`);
  };
  assert.match(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'ORG-A' } }, rows), /no current role/);
});

test('an account role whose quoted name holds a period is queried as one name', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'TEAM.DEV' }],
    'show grants to role "TEAM.DEV"': [g('OWNERSHIP', 'SCHEMA', 'DEV_DB.S')],
    'show grants to role "PUBLIC"': [],
  };
  assert.deepEqual(writeGrantsOutside(collectGrants('AGENT', fixture(grants), 'TEAM.DEV'), ['DEV_DB']), []);
});

test('a SQL function passes; a function in any other language, or one whose name is quoted, fails', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [
      g('USAGE', 'FUNCTION', 'UTIL_DB.S.WHO()'),
      g('USAGE', 'FUNCTION', 'UTIL_DB.S.FETCH(VARCHAR, DEFAULT NUMBER)'),
      g('USAGE', 'FUNCTION', 'DEV_DB.S.CALLS_A_SERVICE(VARCHAR)'),
      g('USAGE', 'FUNCTION', 'UTIL_DB.S."Quoted"()'),
      g('USAGE', 'FUNCTION', 'SNOWFLAKE.CORTEX.COMPLETE(VARCHAR, VARCHAR)'),
    ],
    'describe function UTIL_DB.S.WHO()': [{ property: 'language', value: 'SQL' }],
    'describe function UTIL_DB.S.FETCH(VARCHAR, NUMBER)': [{ property: 'language', value: 'PYTHON' }],
    'describe function DEV_DB.S.CALLS_A_SERVICE(VARCHAR)': [{ property: 'language', value: 'EXTERNAL' }],
    'show grants to role "PUBLIC"': [],
  };
  assert.deepEqual(writeGrantsOutside(collectGrants('AGENT', fixture(grants), 'DEV_ROLE'), ['DEV_DB']), [
    'USAGE on FUNCTION UTIL_DB.S.FETCH(VARCHAR, DEFAULT NUMBER)',
    'USAGE on FUNCTION DEV_DB.S.CALLS_A_SERVICE(VARCHAR)',
    'USAGE on FUNCTION UTIL_DB.S."Quoted"()',
  ]);
});

const NOW = new Date('2027-03-01T00:05:00.000Z');
const entryFor = connection => ({ connection, databases: ['DEV_DB'], login: { user: 'AGENT', account: 'ORG-A', verifiedUntil: '2027-03-01T12:00:00.000Z' } });
const devOnly = sql => {
  if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-A', R: 'DEV_ROLE' }];
  if (sql.startsWith('show future grants')) return [];
  if (sql === 'show grants to user "AGENT"') return [{ role: 'DEV_ROLE' }];
  if (sql === 'show grants to role "DEV_ROLE"') return [g('OWNERSHIP', 'SCHEMA', 'DEV_DB.S')];
  if (sql === 'show grants to role "PUBLIC"') return [];
  throw new Error(`unexpected ${sql}`);
};
const prodWrite = sql => (sql === 'show grants to user "AGENT"' ? [g('DELETE', 'TABLE', 'PROD_DB.S.T'), { role: 'DEV_ROLE' }] : devOnly(sql));
// `rows`, except that the role walk times out on the first `times` checks.
const timingOut = (rows, times) => {
  let left = times;
  return sql => {
    if (sql === 'show grants to role "DEV_ROLE"' && left > 0) {
      left--;
      throw new SnowTimeout(`snow timed out on: ${sql}`);
    }
    return rows(sql);
  };
};
// Runs verifyAll over `entries` with `rowsByConnection`, recording the published file after every publish and every sleep.
function run(entries, rowsByConnection) {
  const scope = { snowflake: entries };
  const events = [];
  const failed = verifyAll(scope, {
    rowsFor: e => (events.push(['check', e.connection]), rowsByConnection[e.connection]),
    hours: 24,
    now: () => NOW,
    publish: e => events.push(['publish', e.connection, e.login.verifiedUntil ?? null]),
    sleep: ms => events.push(['sleep', ms]),
  });
  return { failed, events, scope };
}
const RENEWED = '2027-03-02T00:05:00.000Z';

test('a timeout withdraws trust at once, and a later clean retry restores it', () => {
  const { failed, events } = run([entryFor('a')], { a: timingOut(devOnly, 1) });
  assert.deepEqual(events, [['check', 'a'], ['publish', 'a', null], ['sleep', 60_000], ['check', 'a'], ['publish', 'a', RENEWED]]);
  assert.equal(failed, 0);
});

test('when every retry times out, trust stays withdrawn', () => {
  const { failed, events, scope } = run([entryFor('a')], { a: timingOut(devOnly, 3) });
  assert.deepEqual(events, [['check', 'a'], ['publish', 'a', null], ['sleep', 60_000], ['check', 'a'], ['publish', 'a', null], ['sleep', 180_000], ['check', 'a'], ['publish', 'a', null]]);
  assert.equal(failed, 1);
  assert.match(scope.snowflake[0].login.lastProblem, /^check failed: snow timed out/);
});

test('a write grant seen around a timeout keeps trust withdrawn, whether the retry finishes or not', () => {
  for (const times of [1, 3]) {
    const { failed, scope } = run([entryFor('a')], { a: timingOut(prodWrite, times) });
    assert.equal(failed, 1);
    assert.equal(scope.snowflake[0].login.verifiedUntil, undefined);
  }
  const { events, scope } = run([entryFor('a')], { a: timingOut(prodWrite, 1) });
  assert.match(scope.snowflake[0].login.lastProblem, /^can write outside DEV_DB: DELETE on TABLE PROD_DB\.S\.T/);
  assert.equal(events.filter(e => e[0] === 'sleep').length, 1);
});

test('a finding or an error other than a timeout withdraws without a retry', () => {
  const broken = sql => (sql === 'show grants to role "DEV_ROLE"' ? (() => { throw new Error('insufficient privileges'); })() : devOnly(sql));
  for (const rows of [prodWrite, broken]) {
    const { failed, events } = run([entryFor('a')], { a: rows });
    assert.equal(failed, 1);
    assert.deepEqual(events, [['check', 'a'], ['publish', 'a', null]]);
  }
});

test('every entry gets its first check before any retry, and each is published as it finishes', () => {
  const { events } = run([entryFor('a'), entryFor('b'), entryFor('c')], { a: timingOut(devOnly, 1), b: timingOut(devOnly, 1), c: devOnly });
  assert.deepEqual(events, [
    ['check', 'a'], ['publish', 'a', null],
    ['check', 'b'], ['publish', 'b', null],
    ['check', 'c'], ['publish', 'c', RENEWED],
    ['sleep', 60_000],
    ['check', 'a'], ['publish', 'a', RENEWED],
    ['check', 'b'], ['publish', 'b', RENEWED],
  ]);
});

test('publishing one entry rewrites only its login, keeps what another writer put in the file since, and never replaces a newer result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-entry-'));
  try {
    const file = path.join(dir, 'dev-scope.local.json');
    const scope = { snowflake: [entryFor('a'), entryFor('b'), { connection: 'n', databases: ['DEV_DB'] }], render: { resources: ['srv-x'] } };
    fs.writeFileSync(file, JSON.stringify(scope));
    const stale = structuredClone(scope.snowflake[0]);
    stale.login.verifiedUntil = RENEWED;
    const changed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    changed.snowflake[1].login.verifiedUntil = '2027-03-01T20:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(changed));
    publishEntry(file, stale);
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.snowflake[0].login.verifiedUntil, RENEWED);
    assert.equal(after.snowflake[1].login.verifiedUntil, '2027-03-01T20:00:00.000Z');
    assert.deepEqual(after.render, { resources: ['srv-x'] });
    assert.deepEqual(fs.readdirSync(dir), ['dev-scope.local.json']);
    publishEntry(file, { connection: 'gone', login: { user: 'X', account: 'Y' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), after);
    const newer = structuredClone(after);
    newer.snowflake[0].login = { ...newer.snowflake[0].login, lastCheckedAt: '2027-03-01T00:10:00.000Z', verifiedUntil: undefined, lastProblem: 'can write outside DEV_DB' };
    fs.writeFileSync(file, JSON.stringify(newer));
    publishEntry(file, { ...stale, login: { ...stale.login, lastCheckedAt: '2027-03-01T00:06:00.000Z' } });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).snowflake[0].login.lastProblem, 'can write outside DEV_DB');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Publishes `entry` from a separate process, holding the read for `holdMs` before the rename.
function publishFromChild(file, entry, holdMs) {
  const code = `import { publishEntry } from ${JSON.stringify(MODULE)};
const until = Date.now() + ${holdMs};
publishEntry(${JSON.stringify(file)}, ${JSON.stringify(entry)}, { hold: () => { while (Date.now() < until) {} } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
  return new Promise((resolve, reject) => child.on('exit', c => (c === 0 ? resolve() : reject(new Error(`exit ${c}`)))));
}

test('two writers interleaving, the second reading before the first renames, both land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-race-'));
  try {
    const file = path.join(dir, 'dev-scope.local.json');
    fs.writeFileSync(file, JSON.stringify({ snowflake: [entryFor('a'), entryFor('b')] }));
    const stamp = (c, until) => ({ ...entryFor(c), login: { ...entryFor(c).login, lastCheckedAt: '2027-03-01T00:06:00.000Z', verifiedUntil: until } });
    const first = publishFromChild(file, stamp('a', RENEWED), 800);
    await new Promise(r => setTimeout(r, 250));
    await Promise.all([first, publishFromChild(file, stamp('b', '2027-03-02T09:00:00.000Z'), 0)]);
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.snowflake[0].login.verifiedUntil, RENEWED);
    assert.equal(after.snowflake[1].login.verifiedUntil, '2027-03-02T09:00:00.000Z');
    assert.deepEqual(fs.readdirSync(dir), ['dev-scope.local.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a writer that died is broken; a fresh one is waited for', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-lock-'));
  try {
    const file = path.join(dir, 'dev-scope.local.json');
    fs.writeFileSync(file, JSON.stringify({ snowflake: [entryFor('a')] }));
    fs.writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${file}.lock`, old, old);
    publishEntry(file, { ...entryFor('a'), login: { ...entryFor('a').login, lastCheckedAt: '2027-03-01T00:06:00.000Z', verifiedUntil: RENEWED } });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).snowflake[0].login.verifiedUntil, RENEWED);
    assert.deepEqual(fs.readdirSync(dir), ['dev-scope.local.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection listed twice: nothing is checked or published', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-dup-'));
  try {
    const file = path.join(dir, 'dev-scope.local.json');
    const text = JSON.stringify({ snowflake: [entryFor('a'), { ...entryFor('a'), databases: ['OTHER_DB'] }] });
    fs.writeFileSync(file, text);
    assert.deepEqual(duplicateConnections(JSON.parse(text)), ['a']);
    assert.throws(() => publishEntry(file, { ...entryFor('a'), login: { ...entryFor('a').login, lastCheckedAt: '2027-03-01T00:06:00.000Z' } }), /lists a connection twice/);
    const run = spawnSync(process.execPath, [MODULE, '--file', file, '--hours', '24'], { encoding: 'utf-8', env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lists connection a more than once/);
    assert.equal(fs.readFileSync(file, 'utf-8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
