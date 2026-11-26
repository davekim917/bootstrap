import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand, gateRequestContent, nanoclawGateParts } from './block-destructive-core';

/**
 * The staged approval request is persisted by the host and rendered on the card, so a credential the gated command
 * passes must not reach it: not in the command, nor in the label or summary that quote it.
 */
const staged = (command: string, summary = command) =>
    JSON.parse(gateRequestContent('gate-1', 'Run a command', summary, command, 'request_destructive_gate')) as Record<string, string>;

describe('a credential in a gated command never reaches the staged request', () => {
    test.each([
        ['a bearer header', `curl -H 'Authorization: Bearer rnd_s3cretvalue' -X DELETE https://api.render.com/v1/services/srv-x`, 'rnd_s3cretvalue', 'Authorization: Bearer [redacted]'],
        ['an API-key header', 'curl -H "X-Api-Key: k3y-s3cretvalue" https://api.example.com/v1/x', 'k3y-s3cretvalue', 'X-Api-Key: [redacted]'],
        ['curl -u', 'curl -u admin:s3cretvalue -X DELETE https://api.example.com/v1/x', 's3cretvalue', 'admin:[redacted]'],
        ['a password in a connection URL', 'psql "postgresql://app:s3cretvalue@127.0.0.1:5432/app" -c "drop table t"', 's3cretvalue', 'app:[redacted]@'],
        ['a PGPASSWORD assignment', 'PGPASSWORD=s3cretvalue psql -h db.example.com -c "drop table t"', 's3cretvalue', 'PGPASSWORD=[redacted]'],
        ['curl -u glued to its value', 'curl -uadmin:s3cretvalue -X DELETE https://api.example.com/v1/x', 's3cretvalue', 'admin:[redacted]'],
        ['curl -u ending a cluster of flags', 'curl -sSu admin:s3cretvalue -X DELETE https://api.example.com/v1/x', 's3cretvalue', 'admin:[redacted]'],
        ['a bearer header written with escaped spaces', 'curl -H Authorization:\\ Bearer\\ s3cretvalue -X DELETE https://api.example.com/v1/x', 's3cretvalue', 'Bearer [redacted]'],
        ['a libpq password in a connection string', 'psql "host=db.example.com password=s3cretvalue dbname=app" -c "drop table t"', 's3cretvalue', 'password=[redacted]'],
        ['curl -u with a quoted password holding a space', "curl -sSu 'admin:two words' -X DELETE https://api.example.com/v1/x", 'words', 'admin:[redacted]'],
        ['curl -U for a proxy', 'curl -U proxyuser:s3cretvalue https://api.example.com/v1/x', 's3cretvalue', 'proxyuser:[redacted]'],
        ['a bare TOKEN assignment', 'TOKEN=s3cretvalue ./deploy.sh --force', 's3cretvalue', 'TOKEN=[redacted]'],
        ['a Postgres role password', `psql -h db.example.com -c "CREATE ROLE app LOGIN PASSWORD 's3cretvalue'"`, 's3cretvalue', "PASSWORD '[redacted]'"],
        ['an encrypted password holding a quote', `psql -h db.example.com -c "ALTER USER app WITH ENCRYPTED PASSWORD 's3cret''value'"`, 'value', "PASSWORD '[redacted]'"],
        ['a Snowflake user password', `snow sql -c acme_prod -q "create user u password = 's3cretvalue'"`, 's3cretvalue', "password = '[redacted]'"],
    ])('%s', (_name, command, secret, shown) => {
        const request = staged(command, `The command runs: ${command}`);
        expect(JSON.stringify(request)).not.toContain(secret);
        expect(request.command).toContain(shown);
        expect(request.summary).toContain('[redacted]');
    });

    test('an email card stays exactly as it will send, since the person approves that text', () => {
        const text = "Reset steps: ALTER USER app PASSWORD 'temp-pass-1'";
        const request = JSON.parse(gateRequestContent('gate-2', 'Send an email', text, `gws gmail send --body "${text}"`, 'request_bash_gate')) as Record<string, string>;
        expect(request.summary).toBe(text);
        expect(request.command).toContain('temp-pass-1');
    });

    test('a command with no credential is staged as written', () => {
        for (const command of ['rm -rf /tmp/build', 'git push --force origin main', 'git push -fu git@github.com:org/repo main', 'git push -fu https://github.com/org/repo main', 'echo password=abc', `psql -h db.example.com -c "select password_changed_at from users"`]) {
            expect(staged(command).command).toBe(command);
        }
    });
});

describe('the full staged request, built as the gate builds it, holds no credential', () => {
    const PROD_URL = 'https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO';
    test.each([
        ['a quoted bearer header', `curl -H 'Authorization: Bearer rnd_s3cretvalue' -X DELETE ${PROD_URL}`],
        ['a bearer header written with escaped spaces', `curl -H Authorization:\\ Bearer\\ rnd_s3cretvalue -X DELETE ${PROD_URL}`],
        ['curl -u glued to its value', `curl -uadmin:rnd_s3cretvalue -X DELETE ${PROD_URL}`],
        ['curl -u ending a cluster of flags', `curl -sSu admin:rnd_s3cretvalue -X DELETE ${PROD_URL}`],
        ['a libpq password', 'psql "host=db.example.com password=rnd_s3cretvalue dbname=app" -c "drop table orders"'],
        ['a URL password', 'psql "postgresql://app:rnd_s3cretvalue@127.0.0.1:5432/app" -c "drop table orders"'],
        ['a role password', `psql -h db.example.com -c "CREATE ROLE app LOGIN PASSWORD 'rnd_s3cretvalue'; DROP TABLE orders"`],
    ])('%s', (_name, command) => {
        const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(verdict.action).not.toBe('allow');
        const parts = nanoclawGateParts(command, verdict.reason ?? '', '/tmp');
        const staged = gateRequestContent('gate-3', parts.label, parts.summary, command, parts.action);
        expect(staged).not.toContain('rnd_s3cretvalue');
        expect(staged).toContain('[redacted]');
    });
});
