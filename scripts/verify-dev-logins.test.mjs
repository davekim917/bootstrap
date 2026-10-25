import assert from 'node:assert/strict';
import test from 'node:test';

import { collectGrants, verifyEntry, writeGrantsOutside } from './verify-dev-logins.mjs';

const g = (privilege, granted_on, name) => ({ privilege, granted_on, name });

test('writes inside the dev databases and reads anywhere pass', () => {
  assert.deepEqual(writeGrantsOutside([
    g('OWNERSHIP', 'TABLE', 'DEV_DB.S.T'),
    g('CREATE SCHEMA', 'DATABASE', 'DEV_DB'),
    g('OWNERSHIP', 'TABLE', '"DEV_DB".S."t"'),
    g('SELECT', 'TABLE', 'PROD_DB.S.T'),
    g('USAGE', 'SCHEMA', 'PROD_DB.S'),
    g('USAGE', 'DATABASE', 'PROD_DB'),
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
    g('USAGE', 'STAGE', 'PROD_DB.S.EXT'),
    g('USAGE', 'SERVICE', 'PROD_DB.S.SVC'),
    g('USAGE', 'PROCEDURE', 'DEV_DB.S.RUNS_AS_OWNER()'),
    g('USAGE', 'STAGE', 'DEV_DB.S.EXT'),
  ], ['DEV_DB']);
  assert.equal(problems.length, 18);
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
    if (!(sql in grants)) throw new Error(`unexpected ${sql}`);
    return grants[sql];
  };
  const names = writeGrantsOutside(collectGrants('AGENT', rows), ['DEV_DB']).join(' ');
  for (const t of ['FROM_DB_ROLE', 'FROM_OWNED_USER', 'FROM_OWNED_ROLE', 'FROM_PUBLIC']) assert.match(names, new RegExp(t));
  assert.ok(seen.includes('show grants to role "CHILD"'));
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
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT', A: 'ORG-A' }];
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
  const all = collectGrants('AGENT', sql => grants[sql] ?? assert.fail(`unexpected ${sql}`));
  assert.deepEqual(writeGrantsOutside(all, ['DEV_DB']).sort(), ['DELETE on TABLE PROD_DB.S.FROM_QUOTED', 'INSERT on TABLE PROD_DB.S.DIRECT']);
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
  const all = collectGrants('AGENT', sql => grants[sql] ?? assert.fail(`unexpected ${sql}`));
  assert.deepEqual(writeGrantsOutside(all, ['DEV_DB']), ['DELETE on TABLE PROD_DB.S.T']);
});
