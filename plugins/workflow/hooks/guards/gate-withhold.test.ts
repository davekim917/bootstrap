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
    writeFileSync(join(dir, 'comments.sql'), "-- don't run on prod\nselect 'password reset';\n-- it's the cleanup step\ndrop table staging_orders;\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const surfaces = (command: string) => {
    const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
    expect(verdict.action).not.toBe('allow');
    const card = approvalCard(command, verdict.reason ?? '', '/tmp');
    const action = changesProduction(command, '/tmp') ? 'request_prod_gate' : 'request_destructive_gate';
    const staged = JSON.parse(gateRequestContent('gate-1', card.label, card.summary, command, action)) as Record<string, string>;
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

// A file's SQL reaches the card only as the card quotes it, so the card is withheld exactly when its own text would carry one.
test.each([
    ['a long SCRAM verifier in a SQL file', 'scram.sql'],
    ['a long password in opaque dynamic SQL in a file', 'dynamic.sql'],
])('%s reaches no surface', (_name, name) => {
    const { prompt, stagedText } = surfaces(`${H} -f ${join(dir, name)}`);
    expect(prompt).not.toContain(SECRET);
    expect(stagedText).not.toContain(SECRET);
    expect(/password/i.test(prompt)).toBe(prompt.includes('Command text withheld'));
});

describe('a withheld card keeps the destination, from the unaltered parse', () => {
    test.each([
        ['a password equal to the database name', `psql "postgresql://app:app@192.0.2.20/app" -c "drop table orders"`, ['192.0.2.20', '/app', 'SQL: DROP']],
        ['the default postgres password', `psql postgresql://postgres:postgres@192.0.2.20/postgres -c "drop table orders"`, ['192.0.2.20', '/postgres']],
        ['host and dbname after password= in a URI query', `psql "postgresql:///?password=${SECRET}&host=192.0.2.20&dbname=app" -c "drop table orders"`, ['host `192.0.2.20`', 'database `app`']],
        ['a force-push to a branch named curl', 'git push -fu git@github.com:org/repo curl', ['git@github.com:org/repo']],
        ['curl data that reads like -u', `curl -X DELETE -H "Authorization: Bearer ${SECRET}" -d '-u' ${PROD}`, ['https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO', 'DELETE']],
        ['a PASSWORD word inside a dollar-quoted DELETE', `${H} -d app -c "DELETE FROM accounts WHERE note = $$PASSWORD 'expired'$$"`, ['db.example.com', 'database `app`', 'SQL: DELETE']],
        ['a migration whose comments hold apostrophes', () => `${H} -f ${join(dir, 'comments.sql')}`, ['drop table staging_orders']],
    ])('%s', (_name, made, shown) => {
        const command = typeof made === 'function' ? made() : made;
        const { prompt } = surfaces(command);
        for (const s of shown) expect(prompt).toContain(s);
        expect(prompt).not.toContain(SECRET);
    });
});

describe('a command with no credential keeps its full card', () => {
    test('the step and its SQL are shown', () => {
        const { prompt, staged } = surfaces(`${H} -c "drop table orders"`);
        expect(prompt).toContain('drop table orders');
        expect(staged.command).toBe(`${H} -c "drop table orders"`);
        expect(staged.commandSha256).toBeUndefined();
    });

    test.each([['rm -rf /tmp/build'], ['git push origin main'], ['select password_changed_at']])('the detector reads %s by its words', (text) => {
        expect(containsCredential(text)).toBe(text.includes('password'));
    });
});

test('an email card stays exactly as it will send, since the person approves that text', () => {
    const text = "Reset steps: ALTER USER app PASSWORD 'temp-pass-1'";
    const staged = JSON.parse(gateRequestContent('gate-2', 'Send an email', text, `gws gmail send --body "${text}"`, 'request_bash_gate')) as Record<string, string>;
    expect(staged.summary).toBe(text);
    expect(staged.command).toContain('temp-pass-1');
});
