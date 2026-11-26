import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { changesProduction, describeGateForApproval, evaluateBashCommand, gateRequestContent, redactCredentials } from './block-destructive-core';

/**
 * Approval text never carries a credential the gated command passes: not the staged request the host persists and
 * renders, nor the native prompt. Only the span the credential occupies changes.
 */
const shown = (command: string) => redactCredentials(command)[0];

describe('each credential form is redacted where it is written, and only there', () => {
    test.each([
        ['a quoted bearer header', "curl -H 'Authorization: Bearer s3cretvalue' -X DELETE https://api.example.com/v1/x", "curl -H 'Authorization: Bearer [redacted]' -X DELETE https://api.example.com/v1/x"],
        ['a bearer header written with escaped spaces', 'curl -H Authorization:\\ Bearer\\ s3cretvalue https://api.example.com/v1/x', "curl -H 'Authorization: Bearer [redacted]' https://api.example.com/v1/x"],
        ['an API-key header', 'curl -H "X-Api-Key: s3cretvalue" https://api.example.com/v1/x', 'curl -H "X-Api-Key: [redacted]" https://api.example.com/v1/x'],
        ['curl -u with a quoted password holding a space', "curl -sSu 'admin:two words' https://api.example.com/v1/x", "curl -sSu 'admin:[redacted]' https://api.example.com/v1/x"],
        ['curl -u glued to its value', 'curl -uadmin:s3cretvalue https://api.example.com/v1/x', "curl -u'admin:[redacted]' https://api.example.com/v1/x"],
        ['curl -U for a proxy', 'curl -U proxyuser:s3cretvalue https://api.example.com/v1/x', "curl -U 'proxyuser:[redacted]' https://api.example.com/v1/x"],
        ['curl --proxy with a password in its URL', 'curl --proxy http://user:s3cretvalue@192.0.2.10:3128 https://api.example.com/v1/x', 'curl --proxy http://user:[redacted]@192.0.2.10:3128 https://api.example.com/v1/x'],
        ['a libpq password', 'psql "host=192.0.2.20 password=s3cretvalue dbname=app" -c "drop table t"', 'psql "host=192.0.2.20 password=[redacted] dbname=app" -c "drop table t"'],
        ['a URL password equal to the database name', 'psql "postgresql://app:app@192.0.2.20/app" -c "drop table t"', 'psql "postgresql://app:[redacted]@192.0.2.20/app" -c "drop table t"'],
        ['the default postgres password', 'psql postgresql://postgres:postgres@192.0.2.20/postgres -c "drop table t"', 'psql postgresql://postgres:[redacted]@192.0.2.20/postgres -c "drop table t"'],
        ['a URL keeping a variable the card resolves', 'DB=app; psql "postgresql://app:s3cretvalue@192.0.2.20/$DB" -c "drop table t"', 'DB=app; psql "postgresql://app:[redacted]@192.0.2.20/$DB" -c "drop table t"'],
        ['a PGPASSWORD prefix', "PGPASSWORD=s3cretvalue psql -h db.example.com -c 'drop table t'", "PGPASSWORD=[redacted] psql -h db.example.com -c 'drop table t'"],
        ['an exported PGPASSWORD', "export PGPASSWORD=s3cretvalue; psql -h db.example.com -c 'drop table t'", "export PGPASSWORD=[redacted]; psql -h db.example.com -c 'drop table t'"],
        ['an assigned URL', 'DATABASE_URL=postgresql://app:s3cretvalue@192.0.2.20/app; psql "$DATABASE_URL" -c "drop table t"', 'DATABASE_URL=postgresql://app:[redacted]@192.0.2.20/app; psql "$DATABASE_URL" -c "drop table t"'],
        ['a role password in --command=', `psql -h db.example.com --command="CREATE ROLE app PASSWORD 's3cretvalue'"`, `psql -h db.example.com --command="CREATE ROLE app PASSWORD '[redacted]'"`],
        ['a role password after -Xc', `psql -h db.example.com -Xc "ALTER USER app PASSWORD 's3cretvalue'"`, `psql -h db.example.com -Xc "ALTER USER app PASSWORD '[redacted]'"`],
        ['two passwords in one SQL argument', `psql -h db.example.com -c "CREATE ROLE a PASSWORD 'one-s3cret'; CREATE ROLE b PASSWORD 'two-s3cret'"`, `psql -h db.example.com -c "CREATE ROLE a PASSWORD '[redacted]'; CREATE ROLE b PASSWORD '[redacted]'"`],
        ['a role password in a here-string', `psql -h db.example.com <<< "CREATE ROLE app PASSWORD 's3cretvalue'"`, `psql -h db.example.com <<< "CREATE ROLE app PASSWORD '[redacted]'"`],
        ['a role password piped in from echo', `echo "CREATE ROLE app PASSWORD 's3cretvalue'" | psql -h db.example.com`, `echo "CREATE ROLE app PASSWORD '[redacted]'" | psql -h db.example.com`],
        ['a role password in a heredoc', "psql -h db.example.com <<'SQL'\nCREATE ROLE app PASSWORD 's3cretvalue';\nSQL", "psql -h db.example.com <<'SQL'\nCREATE ROLE app PASSWORD '[redacted]';\nSQL"],
        ['curl -u inside a command substitution', "r=$(curl -sSu 'admin:two words' https://api.example.com/v1/x) && echo \"$r\"", "r=$(curl -sSu 'admin:[redacted]' https://api.example.com/v1/x) && echo \"$r\""],
        ['a Snowflake user password', `snow sql -c acme_prod -q "create user u password = 's3cretvalue'"`, `snow sql -c acme_prod -q "create user u password = '[redacted]'"`],
    ])('%s', (_name, command, expected) => {
        expect(shown(command)).toBe(expected);
    });

    test.each([
        ['git push -fu git@github.com:org/repo main'],
        ['git push -fu https://github.com/org/repo main'],
        ['rm -rf /tmp/build'],
        ['echo password=abc'],
        ['psql -h db.example.com -c "select password_changed_at from users"'],
    ])('%s is left as written', (command) => {
        expect(shown(command)).toBe(command);
    });
});

describe('the staged request and the native prompt hold no credential', () => {
    const PROD_URL = 'https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO';
    test.each([
        ['a bearer header', `curl -H 'Authorization: Bearer rnd_s3cretvalue' -X DELETE ${PROD_URL}`],
        ['curl -u with a space', `curl -sSu 'admin:two rnd_s3cretvalue' -X DELETE ${PROD_URL}`],
        ['curl -u in a command substitution', `r=$(curl -sSu admin:rnd_s3cretvalue -X DELETE ${PROD_URL}) && echo "$r"`],
        ['a proxy URL password', `curl -x http://user:rnd_s3cretvalue@192.0.2.10:3128 -X DELETE ${PROD_URL}`],
        ['a libpq password', 'psql "host=192.0.2.20 password=rnd_s3cretvalue dbname=app" -c "drop table orders"'],
        ['an exported PGPASSWORD', 'export PGPASSWORD=rnd_s3cretvalue; psql -h db.example.com -c "drop table orders"'],
    ])('%s', (_name, command) => {
        const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(verdict.action).not.toBe('allow');
        const card = describeGateForApproval(command, verdict.reason ?? '', '/tmp');
        const action = changesProduction(command, '/tmp') ? 'request_prod_gate' : 'request_destructive_gate';
        const staged = gateRequestContent('gate-1', card.label, card.summary, command, action);
        expect(staged).not.toContain('rnd_s3cretvalue');
        expect(`${card.label}\n${card.summary}`).not.toContain('rnd_s3cretvalue');
    });

    test('a long role password in a SQL file is redacted before the card cuts it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'redact-sql-'));
        const sql = join(dir, 'users.sql');
        writeFileSync(sql, "create or replace user app password = 'SCRAM-SHA-256$4096:Zk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9xZk9x';\n");
        try {
            const command = `snow sql -c acme_prod -f ${sql}`;
            const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
            expect(verdict.action).toBe('gate');
            const card = describeGateForApproval(command, verdict.reason ?? '', '/tmp');
            expect(`${card.label}\n${card.summary}`).not.toContain('Zk9xZk9x');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an email card stays exactly as it will send, since the person approves that text', () => {
        const text = "Reset steps: ALTER USER app PASSWORD 'temp-pass-1'";
        const staged = JSON.parse(gateRequestContent('gate-2', 'Send an email', text, `gws gmail send --body "${text}"`, 'request_bash_gate')) as Record<string, string>;
        expect(staged.summary).toBe(text);
        expect(staged.command).toContain('temp-pass-1');
    });
});
