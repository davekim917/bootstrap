import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LITERAL_CREDENTIAL_REASON, containsCredential, describeGate, evaluateBashCommand } from './block-destructive-core';

// A command the guard would hold or refuse that writes out a credential is refused with fixed text, so no card,
// refusal or staged request repeats it; adapters stage a request only for a gate, never for a block.
const SECRET = 'rnd_s3cret';
let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'literal-credential-'));
    writeFileSync(join(dir, 'scram.sql'), "create role app login password '" + 'SCRAM-SHA-256$4096:' + SECRET + 'Zk9x'.repeat(60) + "';\ndrop table orders;\n");
    writeFileSync(join(dir, 'dynamic.sql'), "DO $$ BEGIN EXECUTE 'DROP TABLE orders; ALTER ROLE app PASSWORD ''" + SECRET + 'x'.repeat(300) + "'''; END $$;\n");
    writeFileSync(join(dir, 'quoted.sql'), "delete from accounts where password = 'short-" + SECRET + "';\n");
    writeFileSync(join(dir, 'in-list.sql'), "DELETE FROM integrations WHERE api_key IN ('" + SECRET + "');\n");
    writeFileSync(join(dir, 'quoted-column.sql'), 'DELETE FROM integrations WHERE "api_key" = \'' + SECRET + "';\n");
    writeFileSync(join(dir, 'format.sql'), "DO $$ BEGIN EXECUTE format('ALTER ROLE app PASSWORD\n%L', '" + SECRET + "'); END $$;\nDROP TABLE orders;\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const evaluate = (command: string) => evaluateBashCommand(command, { cwd: dir });
const PROD = 'https://api.render.com/v1/services/srv-prodservice000000001/env-vars/FOO';
const H = 'psql -h db.example.com';

describe('a gated or refused command that writes out a credential is refused with the fixed text', () => {
    test.each([
        ['a quoted bearer header', `curl -H 'Authorization: Bearer ${SECRET}' -X DELETE ${PROD}`],
        ['a bearer header with escaped spaces', `curl -H Authorization:\\ Bearer\\ ${SECRET} -X DELETE ${PROD}`],
        ['an API-key header', `curl -H "X-Api-Key: ${SECRET}" -X DELETE ${PROD}`],
        ['a header held in a variable assigned on the line', `AUTH_HEADER="Authorization: Bearer ${SECRET}"; curl -H "$AUTH_HEADER" -X DELETE ${PROD}`],
        ['curl -u with a space in the password', `curl -sSu 'admin:two ${SECRET}' -X DELETE ${PROD}`],
        ['curl -u glued to its value', `curl -uadmin:${SECRET} -X DELETE ${PROD}`],
        ['curl -U for a proxy', `curl -U proxyuser:${SECRET} -X DELETE ${PROD}`],
        ['a proxy URL password', `curl --proxy http://user:${SECRET}@192.0.2.10:3128 -X DELETE ${PROD}`],
        ['curl -u inside a command substitution', `r=$(curl -sSu admin:${SECRET} -X DELETE ${PROD}) && echo "$r"`],
        ['curl -u in a process substitution', `cat < <(curl -sSu admin:${SECRET} -X DELETE ${PROD})`],
        ['curl -u in an earlier step of a gated line', `curl -u deploy:${SECRET} https://staging.example.com/health && git push --force origin release`],
        ['a curl OAuth2 bearer token', `curl --oauth2-bearer ${SECRET} -X DELETE ${PROD}`],
        ['a curl proxy OAuth2 bearer token', `curl --proxy-oauth2-bearer ${SECRET} -X DELETE ${PROD}`],
        ['an HTTPie bearer token', `http -A bearer -a ${SECRET} DELETE https://api.render.com/v1/services/srv-prodservice000000001`],
        ['an HTTPie --auth password', `http --auth admin:${SECRET} DELETE https://api.render.com/v1/services/srv-prodservice000000001`],
        ['a libpq password', `psql "host=192.0.2.20 password=${SECRET} dbname=app" -c "drop table orders"`],
        ['a libpq password with an escaped space', `psql host=192.0.2.20\\ password=two\\ ${SECRET} -c "drop table orders"`],
        ['a URI whose only query parameter is password', `psql "postgresql://app@192.0.2.20/app?password=${SECRET}" -c "drop table orders"`],
        ['a libpq sslpassword', `psql "host=192.0.2.20 sslpassword=${SECRET} dbname=app" -c "drop table orders"`],
        ['an sslpassword in a URI query', `psql "postgresql://app@192.0.2.20/app?sslmode=verify-full&sslpassword=${SECRET}" -c "drop table orders"`],
        ['an sslpassword in a connection string glued to --dbname', `psql -X --dbname="sslpassword=${SECRET} host=192.0.2.20 dbname=app" -c "drop table orders"`],
        ['an sslpassword in a connection string attached to -d', `psql -X -d"host=192.0.2.20 sslpassword=${SECRET} dbname=app" -c "drop table orders"`],
        ['an sslpassword whose value percent-encodes a dollar sign', `psql "postgresql://app@192.0.2.20/app?sslpassword=%24${SECRET}" -c "drop table orders"`],
        ['an sslpassword in a trailing --dbn psql ignores under POSIXLY_CORRECT, which the card still prints', `POSIXLY_CORRECT=1 psql -X -U app -c 'DROP TABLE old_orders' postgresql://192.0.2.20/live_app '--dbn=postgresql://192.0.2.20/other_app?sslpassword=%24${SECRET}'`],
        ['an sslpassword in a pg_restore connection string', `pg_restore -d "host=192.0.2.20 sslpassword=${SECRET} dbname=app" app.dump`],
        ['an sslpassword in a URI attached to a clustered -Xd', `psql -Xd"postgresql://app@192.0.2.20/app?sslpassword=${SECRET}" -c "drop table orders"`],
        ['an sslpassword after a value with an escaped space', `psql "host=192.0.2.20 application_name=nightly\\ cleanup sslpassword=${SECRET} dbname=app" -c "drop table orders"`],
        ['an sslpassword whose value percent-encodes a backtick', `psql "postgresql://app@192.0.2.20/app?sslpassword=%60${SECRET}" -c "drop table orders"`],
        ['a URI password in adjacent quoted pieces', `psql postgresql://app:"${SECRET}"'x'@192.0.2.20/app -c "drop table orders"`],
        ['a PGPASSWORD prefix', `PGPASSWORD=${SECRET} ${H} -c "drop table orders"`],
        ['a PGPASSWORD prefix on a psql the dev waiver would hold', `PGPASSWORD=example-pw psql -h dpg-devdatabase000000001-a.example-postgres.render.com -X -d app -c 'delete from accounts'`],
        ['an exported PGPASSWORD', `export PGPASSWORD=${SECRET}; ${H} -c "drop table orders"`],
        ['an appended PGPASSWORD', `export PGPASSWORD+=${SECRET}; ${H} -c "drop table orders"`],
        ['an assigned URL', `DATABASE_URL=postgresql://app:${SECRET}@192.0.2.20/app; psql "$DATABASE_URL" -c "drop table orders"`],
        ['a role password in --command=', `${H} --command="CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a role password after -Xc', `${H} -Xc "ALTER USER app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a role password in a here-string', `${H} <<< "CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders"`],
        ['a role password piped from echo', `echo "CREATE ROLE app PASSWORD '${SECRET}'; DROP TABLE orders" | ${H}`],
        ['a role password in a heredoc', `${H} <<'SQL'\nALTER ROLE app PASSWORD '${SECRET}';\nDROP TABLE orders;\nSQL`],
        ['an escape-string password', `${H} -c "ALTER ROLE app PASSWORD E'${SECRET}'; DROP TABLE orders"`],
        ['a dollar-quoted password', `${H} -c 'ALTER ROLE app PASSWORD $p$${SECRET}$p$; DROP TABLE orders'`],
        ['a dollar-quoted password through render psql', `render psql dpg-proddatabase00000001-a -c 'ALTER ROLE app PASSWORD $p$${SECRET}$p$'`],
        ['a comment between PASSWORD and its value', `${H} -c "ALTER ROLE app PASSWORD /* new */ '${SECRET}'; DROP TABLE orders"`],
        ['a password on the line after PASSWORD, refused for its target', `psql "$DATABASE_URL" -c "ALTER ROLE app PASSWORD\n'${SECRET}'; DROP TABLE orders"`],
        ['a Snowflake user password', `snow sql -c acme_prod -q "create user u password = '${SECRET}'; drop table orders"`],
        ['IDENTIFIED BY', `mysql -h db.example.com -e "ALTER USER app IDENTIFIED BY '${SECRET}'; DROP TABLE orders"`],
        ['a MySQL password attached to -p', `mysql -h db.example.com -p${SECRET} -e "drop table orders"`],
        ['redis-cli -a', `redis-cli -h cache.example.com -a ${SECRET} FLUSHALL`],
        ['redis-cli --user and --pass', `redis-cli -h cache.example.com --user app --pass ${SECRET} FLUSHALL`],
        ['REDISCLI_AUTH', `REDISCLI_AUTH=${SECRET} redis-cli -h cache.example.com FLUSHALL`],
        ['a token as the only HTTPS user info', `git push --force https://ghp_${SECRET}@github.com/org/repo main`],
        ['a userinfo password on a git remote', `git push --force https://alice:${SECRET}@github.com/example/release main`],
        ['an AWS session token', `AWS_SESSION_TOKEN=${SECRET} aws s3 rm s3://example-prod/backups/ --recursive`],
        ['kubectl --token=', `kubectl delete deployment old-api -n staging --token=${SECRET}`],
        ['kubectl --token with a separate value', `kubectl delete deployment old-api -n staging --token ${SECRET}`],
        ['an api_key literal in SQL, refused for its target', `psql -d billing -c "DELETE FROM integrations WHERE api_key = '${SECRET}'"`],
        ['a psql variable named for a token', `psql -d app_test -v API_TOKEN=${SECRET} <<< "DELETE FROM integrations WHERE api_key = :'API_TOKEN'"`],
        ['a psql variable named for a password', `${H} -v app_password=${SECRET} -c "ALTER ROLE app PASSWORD :'pw'; DROP TABLE orders"`],
        ['a password beside -1 and ON_ERROR_STOP', `PGPASSWORD=${SECRET} psql -d app_test -1 -v ON_ERROR_STOP=1 -c 'DROP TABLE stage_a' -c 'DROP TABLE stage_b'`],
        ['a chained dropdb refused toward scratch-pg', `dropdb -h db.example.com --maintenance-db postgres old_archive && PGPASSWORD=${SECRET} dropdb app_test`],
        ['a second curl transfer with a bearer header', `curl -X GET https://api.render.com/v1/services --next -H 'Authorization: Bearer ${SECRET}' -X DELETE ${PROD}`],
        ['a bare TOKEN assignment a later header uses', `TOKEN=${SECRET}; curl -H "Authorization: Bearer $TOKEN" -X DELETE ${PROD}`],
        ['a bare PASSWORD assignment', `PASSWORD=${SECRET} ${H} -c "drop table orders"`],
        ['an api_key NOT IN list', `${H} -c "DELETE FROM integrations WHERE api_key NOT IN ('${SECRET}')"`],
        ['a PGPASSWORD that starts with a slash', `PGPASSWORD='/sample-${SECRET}' ${H} -c "drop table orders"`],
        ['a token after a valueless long flag', `kubectl delete deployment old-api --ignore-not-found --token ${SECRET}`],
        ['a slash-leading curl password', `curl -u 'deploy:/${SECRET}' https://staging.example.com/health && git push --force origin release`],
        ['a PGPASSWORD with a leading space', `PGPASSWORD=' ${SECRET}' ${H} -d app -c 'DROP TABLE expired_sessions'`],
        ['a MySQL authentication-plugin password', `mysql -h db.example.com -e "ALTER USER app IDENTIFIED WITH caching_sha2_password BY '${SECRET}'; DROP TABLE expired_sessions"`],
        ['a kubectl step beside a credentialed psql', `kubectl scale deployment archive-worker -n staging --replicas=0 && PGPASSWORD=${SECRET} ${H} -d billing -c 'DROP TABLE old_invoices'`],
    ])('%s', (_name, command) => {
        expect(evaluate(command)).toEqual({ action: 'block', reason: LITERAL_CREDENTIAL_REASON });
    });

    test.each([
        ['a long SCRAM verifier', 'scram.sql'],
        ['a long password in opaque dynamic SQL', 'dynamic.sql'],
        ['a password the statement compares', 'quoted.sql'],
        ['an api_key IN list', 'in-list.sql'],
        ['a quoted api_key column', 'quoted-column.sql'],
    ])('%s in a SQL file the command reads', (_name, name) => {
        expect(evaluate(`${H} -f ${join(dir, name)}`)).toEqual({ action: 'block', reason: LITERAL_CREDENTIAL_REASON });
    });

    test.each([
        ['find -exec', (f: string) => `find ${dir} -maxdepth 0 -exec ${H} -f ${f} \\;`],
        ['xargs', (f: string) => `xargs ${H} -f ${f} < /dev/null`],
    ])('a SQL file a psql under %s reads', (_name, made) => {
        const command = made(join(dir, 'quoted.sql'));
        expect(evaluate(command)).toEqual({ action: 'block', reason: LITERAL_CREDENTIAL_REASON });
    });

    test('the refusal names no part of the command', () => {
        expect(LITERAL_CREDENTIAL_REASON).toBe('This command contains a literal credential. Move it into an environment variable or the gateway, then run it again.');
    });
});

describe('the same command with the credential in a variable takes the ordinary card', () => {
    test.each([
        ['PGPASSWORD from a variable', `PGPASSWORD="$PW" ${H} -c "drop table orders"`, 'drop table orders'],
        ['an sslpassword from a variable', `psql -X "host=192.0.2.20 sslpassword=$SSL_PW dbname=app" -c "drop table orders"`, 'drop table orders'],
        ['a column named sslpassword set to DEFAULT', `${H} -X -d app -c "UPDATE accounts SET sslpassword=DEFAULT WHERE id = 1"`, 'accounts'],
        ['a bearer header from a variable', `curl -H "Authorization: Bearer $TOKEN" -X DELETE ${PROD}`, PROD],
        ['a psql variable from the environment', `${H} -v pw="$NEW_PW" -c "ALTER ROLE app PASSWORD :'pw'; DROP TABLE orders"`, 'DROP TABLE orders'],
        ['a kubectl token from a variable', 'kubectl delete deployment old-api -n staging --token="$KUBE_TOKEN"', 'old-api'],
        ['curl -u with the password in a variable', `curl -u "deploy:$DEPLOY_PASS" https://staging.example.com/health && git push --force origin release`, 'release'],
        ['a git token from a variable', 'git push --force https://$GH_TOKEN@192.0.2.40/example/release main', 'main'],
        ['an HTTPie token from a variable', 'http -A bearer -a "$RENDER_TOKEN" DELETE https://api.render.com/v1/services/srv-prodservice000000001', 'srv-prodservice000000001'],
        ['a helper path in GIT_ASKPASS', 'GIT_ASKPASS=/usr/local/bin/git-askpass git push origin --delete stale-topic', 'stale-topic'],
        ['psql --password before the database name', `${H} -c 'DROP TABLE orders' --password "app"`, 'DROP TABLE orders'],
        ['a curl client key file', `curl --key client.pem --cert client.crt -X DELETE ${PROD}`, PROD],
        ['a settings key compared with a literal', `${H} -d app -c "DELETE FROM settings WHERE key = 'feature_enabled'"`, 'settings'],
        ['a password column tested for NULL, with a literal on the next line', `${H} -d app -c "DELETE FROM accounts WHERE password\nIS NULL AND status = 'disabled'"`, 'accounts'],
        ['a long user name in a git URL', 'git push --force https://deployment-service@192.0.2.40/team/repo.git main', 'main'],
        ['PWD, the working directory', 'PWD=/srv/repo git push --force origin release', 'release'],
        ['a kubectl label selector named key', 'kubectl delete pods -l key=preview', 'preview'],
        ['an empty Authorization header', `curl -H Authorization: -X DELETE ${PROD}`, PROD],
        ['a bearer header made only of variables', `curl -H "Authorization: Bearer $PREFIX$TOKEN$PREFIX$SUFFIX" -X DELETE ${PROD}`, PROD],
        ['a URL user from a parameter expansion', 'git push --force "https://${GIT_USER:?}@192.0.2.40/team/repo.git" release', 'release'],
        ['a password compared with another column', `${H} -X -d app -c 'DELETE FROM accounts WHERE password = archived_password'`, 'accounts'],
        ['a password compared with another column, with no spaces', `${H} -X -d app -c 'DELETE FROM accounts WHERE password=archived_password'`, 'accounts'],
        ['psql --no-password before a single-quoted database name', `${H} -X -c 'DROP TABLE orders' --no-password 'app'`, 'DROP TABLE orders'],
        ['psql --password before a single-quoted database name', `${H} -X -c 'DROP TABLE orders' --password 'app'`, 'DROP TABLE orders'],
        ['psql -w before a single-quoted database name', `${H} -X -c 'DROP TABLE orders' -w 'app'`, 'DROP TABLE orders'],
        ['psql -W before a single-quoted database name', `${H} -X -c 'DROP TABLE orders' -W 'app'`, 'DROP TABLE orders'],
        ['a token bound to $1', `${H} -X -d app -c 'PREPARE q(text) AS SELECT 1 FROM sessions WHERE refresh_token = $1; EXECUTE q(NULL); DROP TABLE expired_sessions'`, 'expired_sessions'],
        ['a token_type category in SQL', `${H} -d app -c "DELETE FROM sessions WHERE token_type = 'refresh'"`, 'token_type'],
        ['a MySQL password from a variable', 'mysql -h db.example.com -p"$MYSQL_PW" -e "drop table orders"', 'drop table orders'],
        ['a URI password from a variable', 'psql "postgresql://app:$PGPW@192.0.2.20/app" -c "drop table orders"', 'drop table orders'],
    ])('%s', (_name, command, shown) => {
        const verdict = evaluate(command);
        expect(verdict.action).toBe('gate');
        expect(verdict.reason).not.toBe(LITERAL_CREDENTIAL_REASON);
        const card = describeGate(command, verdict.reason ?? '', dir);
        expect(`${card.label}\n${card.summary}`).toContain(shown);
    });
});

test.each([
    ['a health check with a literal curl password', `curl -u admin:${SECRET} https://example.com/health`],
    ['a read with PGPASSWORD written out', `PGPASSWORD=${SECRET} ${H} -c "select 1"`],
])('a command that needs no approval is unaffected: %s', (_name, command) => {
    expect(evaluate(command).action).toBe('allow');
});

describe('the detector fires on literal values only', () => {
    test.each([
        ['a user with no password in a URI', 'psql postgresql://app@192.0.2.20/app'],
        ['an ssh git remote', 'git push ssh://git@github.com/org/repo main'],
        ['a token file option', 'kubectl delete pod web-1 --token-file /var/run/token'],
        ['a column compared with a number', 'SELECT * FROM t WHERE token_count = 5'],
        ['a table named for passwords', 'DELETE FROM password_reset_tokens'],
        ['psql --password, which takes no value', 'psql --password -h db.example.com app'],
        ['an askpass helper', 'SSH_ASKPASS=/usr/bin/ssh-askpass'],
        ['a bare key column', "SELECT 1 FROM settings WHERE key = 'feature_enabled'"],
        ['a user name with no colon in a URL', 'https://deployment-service@192.0.2.40/team/repo.git'],
        ['psql -W', 'psql -W -h db.example.com app'],
        ['curl --key and --cacert files', 'curl --key client.pem --cacert ca.pem https://example.com'],
        ['ssh -i', 'ssh -i deploy_key host.example.com'],
        ['a --*-file option', 'gcloud auth activate-service-account --key-file sa.json'],
        ['a sort key', 'SORT_KEY=name'],
        ['a bare KEY, which names a storage key as often as a secret', 'KEY=sb-app-auth-token; agent-browser eval x'],
        ['an --auth option, as initdb --auth=trust', 'initdb -D data --auth=trust'],
        ['a template placeholder in a URL', 'print("postgresql://%s:%s@%s/%s" % (u, p, h, d))'],
        ['PGPASSWORD inside a Python env dict', 'env=dict(os.environ,PGPASSWORD=p,PGSSLMODE="require")'],
        ['a key file path', 'API_KEY=/run/secrets/api_key'],
        ['a token count column', "SELECT 1 WHERE token_type = 'refresh'"],
        ['a header from a command substitution', 'curl -H "Authorization: Bearer $(cat /run/token)" https://example.com'],
        ['a braced variable', 'PGPASSWORD=${PGPW} psql'],
        ['curl -u with only a user', 'curl -u admin https://example.com'],
        ['a psql setting', 'psql -v ON_ERROR_STOP=1 -c "select 1"'],
    ])('%s does not fire', (_name, text) => {
        expect(containsCredential(text)).toBe(false);
    });

    test.each([
        ['a secret column given a literal', `UPDATE integrations SET client_secret = '${SECRET}'`],
        ['a token column matched with LIKE', `DELETE FROM sessions WHERE refresh_token LIKE '${SECRET}%'`],
        ['an option named for a secret', `vault write x --client-secret ${SECRET}`],
        ['bare SECRET', `SECRET=${SECRET}`],
        ['an api_key IN list', `DELETE FROM integrations WHERE api_key IN ('${SECRET}')`],
        ['a token IN list after a space', `DELETE FROM sessions WHERE refresh_token IN ( '${SECRET}', 'b')`],
        ['bare API_KEY', `API_KEY=${SECRET}`],
        ['a backtick-quoted secret column', `UPDATE t SET \`client_secret\` = '${SECRET}'`],
        ['a Slack token as a URL user', `https://xoxb-${SECRET}@192.0.2.40/x`],
        ['an api_key NOT IN list', `DELETE FROM integrations WHERE api_key NOT IN ('${SECRET}')`],
        ['a password that starts with a slash', `PGPASSWORD='/sample-${SECRET}'`],
    ])('%s fires', (_name, text) => {
        expect(containsCredential(text)).toBe(true);
    });
});
