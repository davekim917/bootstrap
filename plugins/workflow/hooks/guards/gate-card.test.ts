import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeGate, evaluateBashCommand } from './block-destructive-core';
import { evaluateEmailSend, evaluateEmailToolCall } from './email-gate-core';
import { CARD_LABEL_MAX_CHARS, CARD_SUMMARY_MAX_CHARS } from './gate-card-core';

const scratch = mkdtempSync(join(tmpdir(), 'gate-card-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function card(command: string) {
    const verdict = evaluateBashCommand(command, { cwd: scratch });
    expect(verdict.action).toBe('gate');
    return describeGate(command, verdict.reason!);
}

describe('destructive approval card', () => {
    test.each([
        {
            name: 'dbt full refresh resolves the model variable and flags --empty',
            command: 'cd /work/dbt && M=orders_daily; timeout 900 dbt run --select $M --empty --full-refresh',
            label: 'Rebuild dbt model orders_daily from scratch (--full-refresh)',
            has: ['--select orders_daily', '*zero rows*', "the profile's default", '*Directory:* `/work/dbt`'],
        },
        {
            name: 'SQL statement keeps its literal values and the connection',
            command: `T=tenant-42; psql "host=db.example.test dbname=app" -c "delete from public.sessions where tenant_id='$T'"`,
            label: 'Delete rows from PostgreSQL table public.sessions',
            has: ["where `tenant_id='tenant-42'`", 'host `db.example.test` · database `app`', 'only from a backup'],
        },
        {
            name: 'SQL without WHERE says every row',
            command: 'snow sql -c dev --role BUILDER -q "delete from analytics.scratch.events"',
            label: 'Delete rows from Snowflake table analytics.scratch.events',
            has: ['*every row*', 'connection `dev` · role `BUILDER`', 'Time Travel'],
        },
        {
            name: 'branch deletion names the branch and remote',
            command: 'cd /work/repo && git push -q origin --delete feature-x',
            label: 'Delete remote branch feature-x on origin',
            has: ['Pull requests from it close'],
        },
        {
            name: 'force push names the branch',
            command: 'git push -f origin feature-y',
            label: 'Force-push feature-y to origin',
            has: ['discarded for everyone'],
        },
    ])('$name', ({ command, label, has }) => {
        const c = card(command);
        expect(c.label).toBe(label);
        for (const text of has) expect(c.summary).toContain(text);
    });

    test('names a variable it cannot resolve instead of guessing', () => {
        const c = card('for b in a b; do git push origin --delete $b; done');
        expect(c.summary).toContain('`$b` is only set when the command runs');
    });

    test('says approval runs the whole command, not just the gated step', () => {
        const c = card('echo start && dbt run --full-refresh --select orders && echo done');
        expect(c.summary).toContain('Approving runs the whole command below (3 steps)');
    });

    test('reads the default dbt target from the project profile', () => {
        const project = join(scratch, 'dbt-project');
        mkdirSync(project);
        writeFileSync(join(project, 'dbt_project.yml'), "name: demo\nprofile: 'demo'\n");
        writeFileSync(join(project, 'profiles.yml'), 'other:\n  target: prod\ndemo:\n  target: dev\n  outputs: {}\n');
        const c = card(`cd ${project} && dbt build --full-refresh`);
        expect(c.summary).toContain("`dev` (the profile's default");
    });

    test('a non-gated command falls back to the reason', () => {
        expect(describeGate('ls -la', 'some reason')).toEqual({ label: 'some reason', summary: 'some reason' });
    });

    test('stays inside the Slack card budget', () => {
        const tables = Array.from({ length: 20 }, (_, i) => `drop table analytics.scratch.t${i}_${'x'.repeat(60)}`).join('; ');
        const c = card(`snow sql -q "${tables}"`);
        expect(Array.from(c.summary).length).toBeLessThanOrEqual(CARD_SUMMARY_MAX_CHARS);
        expect(Array.from(c.label).length).toBeLessThanOrEqual(CARD_LABEL_MAX_CHARS);
    });
});

const INTERACTIVE = { isScheduledTask: false };
const CREDS = 'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/support.json';

describe('email approval card', () => {
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

    test('reads a body file the command cats into the variable', () => {
        const file = join(scratch, 'reply.html');
        writeFileSync(file, '<p>Draft from a file.</p>');
        const v = evaluateEmailSend(`BODY=$(cat ${file})\ngws gmail +send --to a@example.com --body "$BODY" --html`, INTERACTIVE);
        expect(v.summary).toContain('> Draft from a file.');
        expect(v.summary).toContain(`Read from \`${file}\``);
    });

    test('says the body is hidden when it is only built at run time', () => {
        const v = evaluateEmailSend('BODY=$(python3 build.py)\ngws gmail +send --to a@example.com --body "$BODY"', INTERACTIVE);
        expect(v.summary).toContain('*Message:* not shown. The text comes from `$BODY`');
    });

    test.each([
        { verb: '+reply', extra: '', to: 'the original sender' },
        { verb: '+reply-all', extra: '', to: 'the original sender and everyone on To/Cc' },
        { verb: '+reply-all', extra: '--to new@example.com', to: 'the original sender and everyone on To/Cc, plus new@example.com' },
    ])('$verb $extra says who receives the reply', ({ verb, extra, to }) => {
        const v = evaluateEmailSend(`gws gmail ${verb} --message-id 18f1 --body "Thanks" ${extra}`, INTERACTIVE);
        expect(v.summary).toContain(`*To:* ${to}`);
        expect(v.label).not.toContain('unknown recipient');
    });

    test('flags a help or dry-run call that is gated only because the command chains other steps', () => {
        const v = evaluateEmailSend('gws gmail +reply --help 2>&1 | grep -i to; echo ok', INTERACTIVE);
        expect(v.action).toBe('gate');
        expect(v.label).toContain('(--help — check the command)');
        expect(v.summary).toContain('which on its own sends nothing');
    });

    test('a native connector send shows the message text', () => {
        const v = evaluateEmailToolCall('mcp__gmail__send_email', {
            to: 'sam@example.com',
            subject: 'Status',
            html_body: '<p>All <i>green</i>.</p>',
        }, INTERACTIVE);
        expect(v.summary).toContain('> All green.');
    });

    test('a body cannot ping the channel the card is posted in', () => {
        const v = evaluateEmailSend('gws gmail +send --to a@example.com --body "FYI <!channel> and <@U123>"', INTERACTIVE);
        expect(v.summary).toContain('> FYI ‹!channel> and ‹@U123>');
    });

    test('a long body is cut to fit the Slack card budget', () => {
        const v = evaluateEmailSend(`gws gmail +send --to a@example.com --body "${'word '.repeat(800)}"`, INTERACTIVE);
        expect(Array.from(v.summary!).length).toBeLessThanOrEqual(CARD_SUMMARY_MAX_CHARS);
        expect(v.summary).toContain('…');
    });
});
