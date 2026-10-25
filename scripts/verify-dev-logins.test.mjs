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
    g('OWNERSHIP', 'USER', 'HELPER_USER'),
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
  ], ['DEV_DB']);
  assert.equal(problems.length, 13);
});

test('the walk covers PUBLIC, inherited roles, database roles and users the login owns', () => {
  const grants = {
    'show grants to user "AGENT"': [{ role: 'DEV_ROLE' }],
    'show grants to role "DEV_ROLE"': [g('USAGE', 'ROLE', 'CHILD'), g('USAGE', 'DATABASE_ROLE', 'PROD_DB.DBR'), g('OWNERSHIP', 'USER', 'OTHER')],
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
  for (const t of ['FROM_DB_ROLE', 'FROM_OWNED_USER', 'FROM_PUBLIC']) assert.match(names, new RegExp(t));
  assert.ok(seen.includes('show grants to role "CHILD"'));
});

test('a connection that signs in as another user fails before any grant is read', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'ADMIN_USER' }];
    throw new Error(`unexpected ${sql}`);
  };
  assert.match(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'A' } }, rows), /signs in as ADMIN_USER/);
});

test('a dev-only login passes', () => {
  const rows = sql => {
    if (sql.startsWith('select current_user()')) return [{ U: 'AGENT' }];
    if (sql === 'show grants to user "AGENT"') return [{ role: 'DEV_ROLE' }];
    if (sql === 'show grants to role "DEV_ROLE"') return [g('OWNERSHIP', 'SCHEMA', 'DEV_DB.S'), g('SELECT', 'VIEW', 'PROD_DB.S.V')];
    if (sql === 'show grants to role "PUBLIC"') return [];
    throw new Error(`unexpected ${sql}`);
  };
  assert.equal(verifyEntry({ connection: 'c', databases: ['DEV_DB'], login: { user: 'AGENT', account: 'A' } }, rows), null);
});
