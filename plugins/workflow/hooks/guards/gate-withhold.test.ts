import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { approvalCard, approvalText, changesProduction, containsCredential, evaluateBashCommand, gateRequestContent } from './block-destructive-core';

// approvalCard is the one card every approval surface shows; gateRequestContent is what the host persists and renders.
const SECRET = 'rnd_s3cret';
let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'withhold-'));
    writeFileSync(join(dir, 'scram.sql'), "create role app login password '" + 'SCRAM-SHA-256$4096:' + SECRET + 'Zk9x'.repeat(60) + "';\ndrop table orders;\n");
    writeFileSync(join(dir, 'dynamic.sql'), "DO $$ BEGIN EXECUTE 'DROP TABLE orders; ALTER ROLE app PASSWORD ''" + SECRET + 'x'.repeat(300) + "'''; END $$;\n");
    // The card quotes this file's statement, password included.
    writeFileSync(join(dir, 'scram-quoted.sql'), "delete from accounts where password = 'short-" + SECRET + "';\n");
    writeFileSync(join(dir, 'comments.sql'), "-- don't run on prod\nselect 'password reset';\n-- it's the cleanup step\ndrop table staging_orders;\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const surfaces = (command: string) => {
    const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
    expect(verdict.action).not.toBe('allow');
    const card = approvalCard(command, verdict.reason ?? '', '/tmp');
    const action = changesProduction(command, '/tmp') ? 'request_prod_gate' : 'request_destructive_gate';
    // As runNanoclawGate stages it: the card's decision to withhold travels with it.
    const staged = JSON.parse(gateRequestContent('gate-1', card.label, card.summary, command, action, {}, undefined, card.withheld)) as Record<string, string>;
    return { prompt: approvalText(card), staged, stagedText: JSON.stringify(staged) };
};

const PROD = 'https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO';
const H = 'psql -h db.example.com';

describe('no surface carries a credential the command passes', () => {
    test.each([
        ['a quoted bearer header', `curl -H 'Authorization: Bearer ${SECRET}' -X DELETE ${PROD}`],
        ['a bearer header with escaped spaces', `curl -H Authorization:\\ Bearer\\ ${SECRET} -X DELETE ${PROD}`],
        ['an API-key header', `curl -H "X-Api-Key: ${SECRET}" -X DELETE ${PROD}`],
        ['a header held in a variable', `AUTH_HEADER="Authorization: Bearer ${SECRET}"; curl -H "$AUTH_HEADER" -X DELETE ${PROD}`],
        ['curl -u with a space in the password', `curl -sSu 'admin:two ${SECRET}' -X DELETE ${PROD}`],
        ['curl -u glued to its value', `curl -uadmin:${SECRET} -X DELETE ${PROD}`],
        ['curl -U for a proxy', `curl -U proxyuser:${SECRET} -X DELETE ${PROD}`],
        ['a proxy URL password', `curl --proxy http://user:${SECRET}@192.0.2.10:3128 -X DELETE ${PROD}`],
        ['curl -u inside a command substitution', `r=$(curl -sSu admin:${SECRET} -X DELETE ${PROD}) && echo "$r"`],
        ['curl -u in a process substitution fed by a redirect', `cat < <(curl -sSu admin:${SECRET} -X DELETE ${PROD})`],
        ['a libpq password', `psql "host=192.0.2.20 password=${SECRET} dbname=app" -c "drop table orders"`],
        ['a libpq password with an escaped space', `psql host=192.0.2.20\\ password=two\\ ${SECRET} -c "drop table orders"`],
        ['a URI whose only query parameter is password', `psql "postgresql://app@192.0.2.20/app?password=${SECRET}" -c "drop table orders"`],
        ['a userinfo password in adjacent quoted pieces', `psql postgresql://app:"${SECRET}"'x'@192.0.2.20/app -c "drop table orders"`],
        ['a PGPASSWORD prefix', `PGPASSWORD=${SECRET} ${H} -c "drop table orders"`],
        ['an exported PGPASSWORD', `export PGPASSWORD=${SECRET}; ${H} -c "drop table orders"`],
        ['an appended PGPASSWORD', `export PGPASSWORD+=${SECRET}; ${H} -c "drop table orders"`],
        ['an assigned URL', `DATABASE_URL=postgresql://app:${SECRET}@192.0.2.20/app; psql "$DATABASE_URL" -c "drop table orders"`],
        ['a role password in --command=', `${H} --command="CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a role password after -Xc', `${H} -Xc "ALTER USER app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['two passwords in one argument', `${H} -c "CREATE ROLE a PASSWORD 'one-${SECRET}'; CREATE ROLE b PASSWORD 'two-${SECRET}'; DROP TABLE orders"`],
        ['a role password in a here-string', `${H} <<< "CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a role password piped from echo', `echo "CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders" | ${H}`],
        ['two identical heredoc bodies', `${H} <<'SQL'\nALTER ROLE app PASSWORD '${SECRET}';\nDROP TABLE orders;\nSQL\n${H} <<'SQL'\nALTER ROLE app PASSWORD '${SECRET}';\nDROP TABLE orders;\nSQL`],
        ['an escape-string password', `${H} -c "ALTER ROLE app PASSWORD E'${SECRET}'; DROP TABLE orders"`],
        ['a dollar-quoted password', `${H} -c 'ALTER ROLE app PASSWORD $p$${SECRET}$p$; DROP TABLE orders'`],
        ['a comment between PASSWORD and its value', `${H} -c "ALTER ROLE app PASSWORD /* new */ '${SECRET}'; DROP TABLE orders"`],
        ['a curl OAuth2 bearer token', `curl --oauth2-bearer ${SECRET} -X DELETE ${PROD}`],
        ['a curl proxy OAuth2 bearer token', `curl --proxy-oauth2-bearer ${SECRET} -X DELETE ${PROD}`],
        ['a role password given to format() through %L', `${H} -c "DO \\$\\$ BEGIN EXECUTE format('ALTER ROLE app PASSWORD %L', '${SECRET}'); END \\$\\$; DROP TABLE orders"`],
        ['a role password given as a $1 parameter', `${H} -c "PREPARE p AS ALTER ROLE app PASSWORD $1; EXECUTE p('${SECRET}'); DROP TABLE orders"`],
        ['redis-cli -a', `redis-cli -h cache.example.com -a ${SECRET} FLUSHALL`],
        ['redis-cli --user and --pass', `redis-cli -h cache.example.com --user app --pass ${SECRET} FLUSHALL`],
        ['REDISCLI_AUTH', `REDISCLI_AUTH=${SECRET} redis-cli -h cache.example.com FLUSHALL`],
        ['a MySQL password attached to -p', `mysql -h db.example.com -p${SECRET} -e "drop table orders"`],
        ['a token as the only HTTPS user info', `git push --force https://${SECRET}@github.com/org/repo main`],
        ['a URI with user info and query given to -d', `PGPASSWORD=x psql -d "postgresql://app:${SECRET}@192.0.2.20/app?sslmode=require&password=${SECRET}" -c "drop table orders"`],
        ['a Snowflake user password', `snow sql -c acme_prod -q "create user u password = '${SECRET}'; drop table orders"`],
    ])('%s', (_name, command) => {
        const { prompt, staged, stagedText } = surfaces(command);
        expect(prompt).not.toContain(SECRET);
        expect(stagedText).not.toContain(SECRET);
        expect(prompt).toContain('Command text withheld: it contains a credential.');
        expect(staged.command).toBe('');
        expect(staged.commandSha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

// SQL a command reads from a file counts as part of the command: a credential in it withholds every surface.
test.each([
    ['a long SCRAM verifier in a SQL file', 'scram.sql'],
    ['a long password in opaque dynamic SQL in a file', 'dynamic.sql'],
])('%s reaches no surface', (_name, name) => {
    const { prompt, stagedText } = surfaces(`${H} -f ${join(dir, name)}`);
    expect(prompt).not.toContain(SECRET);
    expect(stagedText).not.toContain(SECRET);
    expect(prompt).toContain('Command text withheld');
});

test('a credential found only in what the card quotes from a file keeps the request withheld', () => {
    const { prompt, staged } = surfaces(`${H} -f ${join(dir, 'scram.sql')}`);
    if (prompt.includes('Command text withheld')) {
        expect(staged.command).toBe('');
        expect(staged.commandSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const card = approvalCard(`${H} -f ${join(dir, 'scram-quoted.sql')}`, 'x', '/tmp');
    expect(card.withheld).toBe(true);
    const staged2 = JSON.parse(gateRequestContent('gate-3', card.label, card.summary, `${H} -f ${join(dir, 'scram-quoted.sql')}`, 'request_destructive_gate', {}, undefined, card.withheld)) as Record<string, string>;
    expect(staged2.command).toBe('');
    expect(staged2.commandSha256).toMatch(/^[0-9a-f]{64}$/);
});

describe('a withheld card keeps the destination, from the unaltered parse', () => {
    test.each([
        ['a password equal to the database name', `psql "postgresql://app:app@192.0.2.20/app" -c "drop table orders"`, ['192.0.2.20', '/app', 'SQL: DROP']],
        ['the default postgres password', `psql postgresql://postgres:postgres@192.0.2.20/postgres -c "drop table orders"`, ['192.0.2.20', '/postgres']],
        ['host and dbname after password= in a URI query', `psql "postgresql:///?password=${SECRET}&host=192.0.2.20&dbname=app" -c "drop table orders"`, ['host `192.0.2.20`', 'database `app`']],
        // A user@host remote can carry a token as its user, so it is withheld like a URL; the branch stays.
        ['a force-push to a branch named curl', 'git push -fu git@github.com:org/repo curl', ['remote `github.com:org/repo`', 'branch `curl`']],
        ['curl data that reads like -u', `curl -X DELETE -H "Authorization: Bearer ${SECRET}" -d '-u' ${PROD}`, ['https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO', 'DELETE']],
        ['a PASSWORD word inside a dollar-quoted DELETE', `${H} -d app -c "DELETE FROM accounts WHERE note = $$PASSWORD 'expired'$$"`, ['db.example.com', 'database `app`', 'SQL: DELETE']],
        ['a variable the card resolves', `DB=app; PGPASSWORD=x ${H} -d "$DB" -c "drop table orders"`, ['database `app`']],
        ['a curl --url= destination', `curl -X DELETE -H "Authorization: Bearer ${SECRET}" --url=${PROD}`, [PROD]],
        ['a git push option value before the remote', `git push -o ci.skip --force https://${SECRET}@github.com/org/repo main`, ['remote `https://github.com/org/repo`', 'branch `main`']],
        ['a token URL after a clustered -fo option', `git push -fo ci.skip https://${SECRET}@github.com/org/repo main`, ['remote `https://github.com/org/repo`', 'branch `main`']],
        ['the branch a refspec overwrites', `git push https://${SECRET}@github.com/org/repo +HEAD:release`, ['branch `release`']],
        ['every statement kind, not only the first', `PGPASSWORD=x ${H} -c "drop table a; truncate b"`, ['SQL: DROP, TRUNCATE']],
        ['a URI given to -d, without its user info or query', `PGPASSWORD=x psql -d "postgresql://app:${SECRET}@192.0.2.20/app?sslmode=require" -c "drop table orders"`, ['database `postgresql://192.0.2.20/app`']],
        ['a migration whose comments hold apostrophes', () => `${H} -f ${join(dir, 'comments.sql')}`, ['drop table staging_orders']],
    ])('%s', (_name, made, shown) => {
        const command = typeof made === 'function' ? made() : made;
        const { prompt } = surfaces(command);
        for (const s of shown) expect(prompt).toContain(s);
        expect(prompt).not.toContain(SECRET);
    });
});

describe('refusals and gate reasons withhold the same way', () => {
    test.each([
        ['a refusal for a target the guard cannot name', `psql "$DATABASE_URL" -c "ALTER ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a gate over opaque dynamic SQL from a file', () => `${H} -f ${join(dir, 'dynamic.sql')}`],
        ['a refusal whose password sits on the next line of -c', `psql "$DATABASE_URL" -c "ALTER ROLE app PASSWORD\n'${SECRET}'; DROP TABLE orders"`],
        ['a gate with a password in -c', `${H} -c "ALTER ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
    ])('%s', (_name, made) => {
        const command = typeof made === 'function' ? made() : made;
        const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(verdict.action).not.toBe('allow');
        expect(verdict.reason).not.toContain(SECRET);
        if (containsCredential(command)) expect(verdict.reason).toContain('Command text withheld');
    });

    test('a suggested retry keeps its shape with the SQL replaced by a placeholder', () => {
        const verdict = evaluateBashCommand(`psql "$DATABASE_URL" -c "ALTER ROLE app PASSWORD\n'${SECRET}'; DROP TABLE orders"`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain("-c '<your SQL>'");
        expect(verdict.reason).not.toContain(SECRET);
    });

    test('a retry that would copy a -v assignment holding a password copies nothing', () => {
        const verdict = evaluateBashCommand(`psql "$DATABASE_URL" -v password=${SECRET}-v -c "ALTER ROLE app PASSWORD\n'${SECRET}-sql'; DROP TABLE orders"`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).not.toContain(SECRET);
        expect(verdict.reason).toContain("-c '<your SQL>'");
    });

    test('a multiline EXECUTE in a relative file leaves no password on a rejection', () => {
        const work = mkdtempSync(join(tmpdir(), 'withhold-exec-'));
        try {
            writeFileSync(join(work, 'rotate.sql'), "DO $$ BEGIN EXECUTE format('DROP TABLE orders; ALTER ROLE app PASSWORD\n%L', '" + SECRET + "'); END $$;\n");
            const verdict = evaluateBashCommand(`${H} -f rotate.sql`, { cwd: work });
            expect(verdict.action).toBe('gate');
            expect(verdict.reason).not.toContain(SECRET);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    test('dropdb keeps its own program and database in the scratch line, with nothing else copied', () => {
        const verdict = evaluateBashCommand(`PGPASSWORD=${SECRET} dropdb app_test`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('/app/skills/scratch-postgres/scratch-pg dropdb app_test');
        expect(verdict.reason).not.toContain("<your SQL>");
        expect(verdict.reason).not.toContain(SECRET);
    });

    test('dropdb keeps the database its own parser reads, never -U\'s value', () => {
        const verdict = evaluateBashCommand(`PGPASSWORD=${SECRET} dropdb app_test -U postgres`, { cwd: '/tmp' });
        expect(verdict.reason).toContain('/app/skills/scratch-postgres/scratch-pg dropdb app_test');
        expect(verdict.reason).not.toContain('dropdb postgres');
    });

    test.each([
        ['--maintenance-db before it', 'dropdb --maintenance-db=postgres app_test', 'dropdb app_test'],
        ['a separate --maintenance-db value', 'dropdb --maintenance-db postgres app_test', 'dropdb app_test'],
        ['a username cluster and a port before it', 'dropdb -Upostgres -p 5432 app_test', 'dropdb app_test'],
    ])('the retry keeps the database operand with %s', (_name, tail, line) => {
        const verdict = evaluateBashCommand(`PGPASSWORD=${SECRET} ${tail}`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain(`/app/skills/scratch-postgres/scratch-pg ${line}`);
        expect(verdict.reason ?? '').not.toContain(SECRET);
    });

    test('a chained line retries the step that was refused, not the first dropdb on it', () => {
        const verdict = evaluateBashCommand(`dropdb -h db.example.com --maintenance-db postgres old_archive && PGPASSWORD=${SECRET} dropdb app_test`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('/app/skills/scratch-postgres/scratch-pg dropdb app_test');
        expect(verdict.reason).not.toContain('old_archive');
    });

    test('a credential either reading finds is kept: Snowflake files first, a PostgreSQL credential after them', () => {
        const work = mkdtempSync(join(tmpdir(), 'withhold-union-'));
        try {
            for (let i = 1; i <= 5; i++) writeFileSync(join(work, `big${i}.sql`), 'select 1;\n'.repeat(90_000));
            writeFileSync(join(work, 'creds.sql'), "alter role app password '" + SECRET + "';\ndrop table orders;\n");
            const command = `snow sql -c acme_prod -f big1.sql -f big2.sql -f big3.sql -f big4.sql -f big5.sql; ${H} -f creds.sql`;
            const verdict = evaluateBashCommand(command, { cwd: work });
            expect(verdict.action).not.toBe('allow');
            expect(verdict.reason).not.toContain(SECRET);
            expect(approvalCard(command, verdict.reason ?? '', work).withheld).toBe(true);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    test('a step the shared trace budget reached too late is read again before deciding to withhold', () => {
        const work = mkdtempSync(join(tmpdir(), 'withhold-budget-'));
        try {
            writeFileSync(join(work, 'creds.sql'), "create user u password = '" + SECRET + "';\ndrop table orders;\n");
            // Each under the per-file cap, together past the line's shared trace budget.
            for (let i = 1; i <= 5; i++) writeFileSync(join(work, `big${i}.sql`), 'select 1;\n'.repeat(90_000));
            const command = `snow sql -c acme_prod -f creds.sql; ${H} -f big1.sql -f big2.sql -f big3.sql -f big4.sql -f big5.sql`;
            const verdict = evaluateBashCommand(command, { cwd: work });
            expect(verdict.action).not.toBe('allow');
            expect(verdict.reason).not.toContain(SECRET);
            expect(approvalCard(command, verdict.reason ?? '', work).withheld).toBe(true);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    test('a relative SQL file is read from the directory the evaluator was given', () => {
        const work = mkdtempSync(join(tmpdir(), 'withhold-cwd-'));
        try {
            writeFileSync(join(work, 'rotate.sql'), "DO $$ BEGIN EXECUTE 'DROP TABLE orders; ALTER ROLE app PASSWORD ''" + SECRET + 'x'.repeat(300) + "'''; END $$;\n");
            const command = `${H} -f rotate.sql`;
            const verdict = evaluateBashCommand(command, { cwd: work });
            expect(verdict.action).toBe('gate');
            expect(verdict.reason).not.toContain(SECRET);
            expect(verdict.reason).toContain('Command text withheld');
            expect(approvalCard(command, verdict.reason ?? '', work).withheld).toBe(true);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});

describe('a command with no credential keeps its full card', () => {
    test('a table named for passwords keeps its table and predicate', () => {
        const { prompt } = surfaces(`${H} -c "DELETE FROM password_reset_tokens WHERE id = 1"`);
        expect(prompt).toContain('password_reset_tokens');
        expect(prompt).not.toContain('Command text withheld');
    });

    test('the step and its SQL are shown', () => {
        const { prompt, staged } = surfaces(`${H} -c "drop table orders"`);
        expect(prompt).toContain('drop table orders');
        expect(staged.command).toBe(`${H} -c "drop table orders"`);
        expect(staged.commandSha256).toBeUndefined();
    });

    // A password is a credential only when given a value; a column or table named for one is not.
    test.each([
        ['rm -rf /tmp/build', false], ['git push origin main', false], ['select password_changed_at from users', false],
        ['DELETE FROM password_reset_tokens', false], ["ALTER ROLE app PASSWORD 'x'", true], ['PGPASSWORD=x psql', true],
        ['mysql -h db -px -e "select 1"', true], ['git push https://tok@github.com/org/repo', true],
    ] as const)('the detector reads %s as %p', (text, expected) => {
        expect(containsCredential(text)).toBe(expected);
    });
});

test('an email card stays exactly as it will send, since the person approves that text', () => {
    const text = "Reset steps: ALTER USER app PASSWORD 'temp-pass-1'";
    const staged = JSON.parse(gateRequestContent('gate-2', 'Send an email', text, `gws gmail send --body "${text}"`, 'request_bash_gate')) as Record<string, string>;
    expect(staged.summary).toBe(text);
    expect(staged.command).toContain('temp-pass-1');
});

describe('review246fresh', () => {
    test.each([
        ['kubectl --token=', `kubectl delete deployment old-api -n staging --token=${SECRET}`],
        ['kubectl --token with a separate value', `kubectl delete deployment old-api -n staging --token ${SECRET}`],
    ])('%s reaches no surface', (_name, command) => {
        const { prompt, staged, stagedText } = surfaces(command);
        expect(prompt).not.toContain(SECRET);
        expect(stagedText).not.toContain(SECRET);
        expect(staged.command).toBe('');
    });

    test('an api_key literal in SQL stays out of the refusal and its retry', () => {
        const verdict = evaluateBashCommand(`psql -d billing -c "DELETE FROM integrations WHERE api_key = '${SECRET}'"`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).not.toContain(SECRET);
        expect(verdict.reason).toContain('Command text withheld');
    });

    test.each([
        ['a secret column', `UPDATE integrations SET client_secret = '${SECRET}'`],
        ['a token column', `DELETE FROM sessions WHERE refresh_token LIKE '${SECRET}%'`],
    ])('the detector finds %s given a literal', (_name, sql) => {
        expect(containsCredential(sql)).toBe(true);
    });

    test.each([
        ['a token file option', 'kubectl delete pod web-1 --token-file /var/run/token'],
        ['a column count', 'SELECT * FROM t WHERE token_count = 5'],
    ])('the detector passes %s', (_name, text) => {
        expect(containsCredential(text)).toBe(false);
    });

    test('a withheld S3 delete keeps the bucket, prefix and recursive scope', () => {
        const { prompt } = surfaces(`AWS_SESSION_TOKEN=${SECRET} aws s3 rm s3://example-prod/backups/ --recursive`);
        expect(prompt).not.toContain(SECRET);
        expect(prompt).toContain('Delete S3 objects under s3://example-prod/backups/');
    });

    test('a withheld git push keeps the repository without its user info', () => {
        const { prompt } = surfaces(`git push --force https://alice:${SECRET}@github.com/example/release main`);
        expect(prompt).not.toContain(SECRET);
        expect(prompt).not.toContain('alice');
        expect(prompt).toContain('remote `https://github.com/example/release`');
        expect(prompt).toContain('branch `main`');
    });

    test('each curl transfer shows its own method beside its URL', () => {
        const { prompt } = surfaces(`curl -X GET https://api.render.com/v1/services --next -H 'Authorization: Bearer ${SECRET}' -X DELETE ${PROD}`);
        expect(prompt).not.toContain(SECRET);
        expect(prompt).toContain('GET `https://api.render.com/v1/services`');
        expect(prompt).toContain(`DELETE \`${PROD}\``);
        expect(prompt).not.toContain('GET `' + PROD);
    });

    test('a withheld card says approval runs the whole line, and lists the step that needs none', () => {
        const { prompt } = surfaces(`kubectl scale deployment archive-worker -n staging --replicas=0 && PGPASSWORD=${SECRET} ${H} -d billing -c 'DROP TABLE old_invoices'`);
        expect(prompt).not.toContain(SECRET);
        expect(prompt).toContain('Approving runs the whole command (2 steps)');
        expect(prompt).toContain('`kubectl scale deployment archive-worker -n staging --replicas=0`');
    });

    test('the retry keeps -1 and psql settings, and no variable of the command own', () => {
        const verdict = evaluateBashCommand(`PGPASSWORD=${SECRET} psql -d app_test -1 -v ON_ERROR_STOP=1 -v note=x -c 'DROP TABLE stage_a' -c 'DROP TABLE stage_b'`, { cwd: '/tmp' });
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain("scratch-pg psql <db> -1 -v ON_ERROR_STOP=1 -c '<your SQL>'");
        expect(verdict.reason).not.toContain('note=x');
    });
});

