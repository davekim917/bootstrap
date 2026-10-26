#!/usr/bin/env node
// Vouch for each dev-scope login: walk every role its user holds (and PUBLIC) and confirm none can write outside
// the entry's dev databases. A pass sets `login.verifiedUntil`, which the destructive guard requires before it lets
// that connection's SQL run without a card; a failure or an error removes it, so a lapsed check brings cards back.
//
// Usage: node scripts/verify-dev-logins.mjs [--file <dev-scope.local.json>] [--hours 48]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Privileges that read or describe and never write, on objects outside the dev databases.
const READ_PRIVILEGES = new Set(['SELECT', 'REFERENCES', 'MONITOR', 'READ', 'REFERENCE_USAGE', 'USAGE', 'IMPORTED PRIVILEGES']);
// Objects that run nothing when used. Using or operating anything else (a procedure, function, service, task, alert,
// notebook, app, stage, integration, or a kind added later) can act as its owner or reach outside the account, so it
// fails wherever it lives unless its owner was walked.
const INERT_OBJECTS = new Set(['DATABASE', 'SCHEMA', 'FILE_FORMAT', 'SEQUENCE']);

function invokesAnotherRole(on, privilege) {
  return (privilege === 'USAGE' || privilege === 'OPERATE') && !INERT_OBJECTS.has(on);
}
// The guard asks for approval only for SQL that destroys data, so a privilege whose actions it never gates (suspending
// a warehouse, aborting its queries, altering or dropping a user) is not widened by trusting the login.
const WAREHOUSE_PRIVILEGES = new Set(['USAGE', 'MONITOR', 'OPERATE']);
// Account-level privileges Snowflake grants PUBLIC for its own features (AI functions, lineage, Snowsight artifacts,
// service endpoints, agent tasks that run as their owning role); none reaches table data. Any other one fails.
const ACCOUNT_FEATURE_PRIVILEGES = new Set([
  'BIND SERVICE ENDPOINT', 'EXECUTE AGENT TASK', 'MANAGE ARTIFACT PUBLICATION', 'USE AI FUNCTIONS', 'VIEW LINEAGE',
  'MANAGE ACCESS ON CHART ARTIFACTS', 'MANAGE ACCESS ON DASHBOARD ARTIFACTS', 'MANAGE ACCESS ON FILE ARTIFACTS',
  'MANAGE ACCESS ON REPORT ARTIFACTS', 'MANAGE ACCESS ON THREAD ARTIFACTS',
]);
const COMPUTE_OBJECTS = new Set(['COMPUTE_POOL', 'AI_GATEWAY']);

/** The database an object's grant name lives in, upper-cased as Snowflake folds it; null for account-level objects. */
function databaseOf(grantedOn, name) {
  const first = String(name).match(/^\s*("(?:[^"]|"")+"|[^."]+)/)?.[1] ?? '';
  const db = first.startsWith('"') ? first.slice(1, -1).replace(/""/g, '"') : first.toUpperCase();
  if (grantedOn === 'DATABASE') return db;
  return String(name).includes('.') ? db : null;
}

/**
 * The grants among `grants` that could write outside `databases`. Each grant is `{ privilege, granted_on, name }` as
 * SHOW GRANTS returns it; role and database-role grants are the hierarchy, which the caller walks.
 */
export function writeGrantsOutside(grants, databases) {
  const dev = new Set(databases.map(d => d.toUpperCase()));
  const problems = [];
  for (const g of grants) {
    if (g.hidden) {
      problems.push(`${g.privilege} on ${g.granted_on} ${g.name}`);
      continue;
    }
    const on = String(g.granted_on).toUpperCase();
    const privilege = String(g.privilege).toUpperCase();
    // A role it holds or owns is walked; owning one lets it grant that role to itself.
    if ((on === 'ROLE' || on === 'DATABASE_ROLE') && (privilege === 'USAGE' || privilege === 'OWNERSHIP')) continue;
    if (on === 'WAREHOUSE' && WAREHOUSE_PRIVILEGES.has(privilege)) continue;
    if (COMPUTE_OBJECTS.has(on) && privilege === 'USAGE') continue;
    if (on === 'ACCOUNT' && ACCOUNT_FEATURE_PRIVILEGES.has(privilege)) continue;
    // Signing in as an owned user is walked like a role it holds.
    if (on === 'USER' && privilege === 'OWNERSHIP') continue;
    const db = databaseOf(on, g.name);
    // Snowflake's own database: its procedures run with the caller's rights or need schema access the role lacks.
    if (db === 'SNOWFLAKE' && on !== 'DATABASE') continue;
    if (invokesAnotherRole(on, privilege) && !g.ownerWalked) {
      problems.push(`${privilege} on ${on} ${g.name}`);
      continue;
    }
    if (db !== null && dev.has(db)) continue;
    if (db !== null && READ_PRIVILEGES.has(privilege)) continue;
    problems.push(`${privilege} on ${on} ${g.name}`);
  }
  return problems;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** A database role's `DB.ROLE` name, each part quoted. */
function quoteDatabaseRole(name) {
  return String(name).split('.').map(p => (p.startsWith('"') ? p : quoteIdent(p))).join('.');
}

function snowRows(connection, sql) {
  const out = execFileSync('snow', ['sql', '-c', connection, '--format', 'json', '--enable-templating', 'NONE', '-q', sql], {
    encoding: 'utf-8', timeout: 120_000, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const data = JSON.parse(out);
  return Array.isArray(data) && data.length && Array.isArray(data[0]) ? data.at(-1) : data;
}

/**
 * The grants, current and future, of every role `user` can use, PUBLIC included, walking role and database-role
 * grants. SHOW GRANTS lists only objects the session's role can see, so a role outside `sessionRole`'s hierarchy is
 * reported as a grant that can't be vouched for rather than read.
 */
export function collectGrants(user, rows, sessionRole) {
  const seen = new Set();
  const grants = [];
  const queue = [{ kind: 'ROLE', name: 'PUBLIC' }];
  // A user holds roles and may also hold privileges granted to it directly, which carry no role.
  const userGrants = name => {
    for (const r of rows(`show grants to user ${quoteIdent(name)}`)) {
      if (r.role) queue.push({ kind: 'ROLE', name: r.role });
      else grants.push(r);
    }
  };
  userGrants(user);
  const inSession = new Set();
  const sessionQueue = [`ROLE:${sessionRole}`, 'ROLE:PUBLIC'];
  const edges = new Map();
  while (queue.length) {
    const { kind, name } = queue.shift();
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'USER') {
      userGrants(name);
      continue;
    }
    const grantee = kind === 'ROLE' ? `role ${quoteIdent(name)}` : `database role ${quoteDatabaseRole(name)}`;
    for (const f of rows(`show future grants to ${grantee}`)) grants.push({ privilege: f.privilege, granted_on: f.grant_on, name: f.name });
    for (const g of rows(`show grants to ${grantee}`)) {
      const on = String(g.granted_on).toUpperCase();
      const privilege = String(g.privilege).toUpperCase();
      if ((on === 'ROLE' || on === 'DATABASE_ROLE') && (privilege === 'USAGE' || privilege === 'OWNERSHIP')) {
        queue.push({ kind: on, name: g.name });
        if (privilege === 'USAGE') edges.set(key, [...(edges.get(key) ?? []), `${on}:${g.name}`]);
      }
      else if (on === 'USER' && privilege === 'OWNERSHIP') queue.push({ kind: 'USER', name: g.name });
      else if (on === 'PROCEDURE' && privilege === 'USAGE' && !/^"?SNOWFLAKE"?\./i.test(g.name)) {
        // A procedure that runs with its owner's rights lets the caller act as that owner, so its owner is walked too.
        // SHOW GRANTS writes an optional argument as `DEFAULT TYPE`; DESCRIBE and SHOW GRANTS ON take the bare type.
        const name = String(g.name);
        if (name.includes('"')) throw new Error(`procedure ${name} has a quoted name; its signature isn't rewritten safely`);
        const signature = name.replace(/\bDEFAULT\s+/g, '');
        const executeAs = rows(`describe procedure ${signature}`).find(r => String(r.property).toLowerCase() === 'execute as')?.value;
        if (executeAs === 'OWNER') {
          const owner = rows(`show grants on procedure ${signature}`).find(r => String(r.privilege).toUpperCase() === 'OWNERSHIP');
          if (!owner) throw new Error(`no owner found for procedure ${g.name}`);
          queue.push({ kind: owner.granted_to === 'DATABASE_ROLE' ? 'DATABASE_ROLE' : 'ROLE', name: owner.grantee_name });
          grants.push({ ...g, ownerWalked: true });
          continue;
        }
        if (executeAs !== 'CALLER' && executeAs !== 'RESTRICTED CALLER') throw new Error(`unknown execute-as for procedure ${g.name}: ${executeAs}`);
        grants.push({ ...g, ownerWalked: true });
        continue;
      }
      grants.push(g);
    }
  }
  while (sessionQueue.length) {
    const key = sessionQueue.shift();
    if (inSession.has(key)) continue;
    inSession.add(key);
    sessionQueue.push(...(edges.get(key) ?? []));
  }
  for (const key of seen) {
    if (key.startsWith('USER:') || inSession.has(key)) continue;
    const [kind, ...name] = key.split(':');
    grants.push({ privilege: `GRANTS HIDDEN FROM ${sessionRole}`, granted_on: kind, name: name.join(':'), hidden: true });
  }
  return grants;
}

/** Check one entry's login; returns null when it is dev-only, else the reason it is not. */
export function verifyEntry(entry, rows) {
  const me = rows("select current_user() as U, current_organization_name() || '-' || current_account_name() as A, current_role() as R")[0] ?? {};
  if (String(me.U).toUpperCase() !== entry.login.user.toUpperCase()) return `connection signs in as ${me.U}, not ${entry.login.user}`;
  if (String(me.A).toUpperCase() !== entry.login.account.toUpperCase()) return `connection signs in to ${me.A}, not ${entry.login.account}`;
  // The grants walked are the signed-in user's, as Snowflake names it, never the configured spelling.
  if (!me.R) return 'connection has no current role';
  const problems = writeGrantsOutside(collectGrants(String(me.U), rows, String(me.R)), entry.databases);
  if (process.env.VERIFY_DEV_LOGINS_VERBOSE) for (const p of problems) console.error(`  ${entry.connection}: ${p}`);
  return problems.length ? `can write outside ${entry.databases.join('/')}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}` : null;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = arg('--file', process.env.BOOTSTRAP_DEV_SCOPE_FILE || path.join(repoRoot, 'dev-scope.local.json'));
  const hours = Number(arg('--hours', '48'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) throw new Error(`--hours must be between 0 and 72, not ${arg('--hours')}`);
  const scope = JSON.parse(fs.readFileSync(file, 'utf-8'));
  let failed = 0;
  for (const entry of scope.snowflake ?? []) {
    if (!entry.login) continue;
    let problem;
    try {
      problem = verifyEntry(entry, sql => snowRows(entry.connection, sql));
    } catch (err) {
      problem = `check failed: ${String(err?.message ?? err).split('\n')[0]}`;
    }
    const now = new Date();
    entry.login.lastCheckedAt = now.toISOString();
    if (problem) {
      failed++;
      delete entry.login.verifiedUntil;
      entry.login.lastProblem = problem;
      console.error(`${entry.connection}: NOT trusted — ${problem}`);
    } else {
      entry.login.verifiedUntil = new Date(now.getTime() + hours * 3600_000).toISOString();
      delete entry.login.lastProblem;
      console.log(`${entry.connection}: dev-only login ${entry.login.user} verified until ${entry.login.verifiedUntil}`);
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(scope, null, 2)}\n`);
  fs.renameSync(tmp, file);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
