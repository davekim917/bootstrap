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
        ['a force-push to a branch named curl', 'git push -fu git@github.com:org/repo curl', ['git@github.com:org/repo']],
        ['curl data that reads like -u', `curl -X DELETE -H "Authorization: Bearer ${SECRET}" -d '-u' ${PROD}`, ['https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO', 'DELETE']],
        ['a PASSWORD word inside a dollar-quoted DELETE', `${H} -d app -c "DELETE FROM accounts WHERE note = $$PASSWORD 'expired'$$"`, ['db.example.com', 'database `app`', 'SQL: DELETE']],
        ['a variable the card resolves', `DB=app; PGPASSWORD=x ${H} -d "$DB" -c "drop table orders"`, ['database `app`']],
        ['a curl --url= destination', `curl -X DELETE -H "Authorization: Bearer ${SECRET}" --url=${PROD}`, [PROD]],
        ['a git push option value before the remote', `git push -o ci.skip --force https://${SECRET}@github.com/org/repo main`, ['remote `https://github.com/org/repo`', 'branch `main`']],
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
