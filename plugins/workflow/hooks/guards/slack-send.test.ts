import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SEND_SCOPE_FILE_ENV, parseSendScope, slackPostsOf } from './block-destructive-core';
import { evaluateEmailSend } from './email-gate-core';

/**
 * SLACK POSTS IN A PERSON'S NAME. In a workgroup or OneCLI identity the send
 * scope lists, a Slack post stops for that person's OK, and its gate request
 * carries the exact text so the host can accept a "send" they already gave.
 */

const MODULE = './block-destructive-core';
let dir = '';
let scopeFile = '';
let saved: string | undefined;
let savedWorkgroup: string | undefined;

const POST = `curl -sS https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data '{"channel":"C1","text":"Numbers are in."}'`;

beforeAll(() => {
    saved = process.env[SEND_SCOPE_FILE_ENV];
    savedWorkgroup = process.env.NANOCLAW_WORKGROUP_ID;
    dir = mkdtempSync(join(tmpdir(), 'send-scope-test-'));
    scopeFile = join(dir, 'send-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({ slack: { workgroups: ['acme'], onecliAgents: ['ag-acme'] } }));
});

afterEach(() => {
    process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
    if (savedWorkgroup === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
    else process.env.NANOCLAW_WORKGROUP_ID = savedWorkgroup;
    mock.restore();
});

afterAll(() => {
    if (saved === undefined) delete process.env[SEND_SCOPE_FILE_ENV];
    else process.env[SEND_SCOPE_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const verdict = (command: string) => evaluateEmailSend(command, { isScheduledTask: false }).action;

describe('which Slack calls stop for approval', () => {
    test.each([
        ['a post from a listed workgroup', 'acme', POST, 'gate'],
        ['the same post from another workgroup', 'other', POST, 'allow'],
        ['an edit', 'acme', `curl https://slack.com/api/chat.update -d channel=C1 -d ts=1 -d text=x`, 'gate'],
        ['a delete', 'acme', `curl https://slack.com/api/chat.delete -d channel=C1 -d ts=1`, 'gate'],
        ['a file share', 'acme', `curl -F file=@a.png https://slack.com/api/files.upload`, 'gate'],
        ['a read', 'acme', `curl -G https://slack.com/api/conversations.replies --data-urlencode channel=C1`, 'allow'],
        ['a listed OneCLI identity outside any workgroup', undefined, `onecli run --agent ag-acme -- ${POST}`, 'gate'],
        ['another OneCLI identity', 'acme', `onecli run --agent ag-other -- ${POST}`, 'allow'],
        ['a post after another command', 'acme', `cd /tmp && ${POST}`, 'gate'],
        ['a post on a workspace subdomain', 'acme', `curl https://acme.slack.com/api/chat.postMessage -d text=x`, 'gate'],
        ['a post after a read in the same curl', 'acme', `curl https://slack.com/api/conversations.list --next https://slack.com/api/chat.postMessage -d text=x`, 'gate'],
        ['a wrapped curl named by its path', undefined, `onecli run --agent ag-acme -- /usr/bin/curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a post whose URL is given with --url=', 'acme', `curl --url=https://slack.com/api/chat.postMessage -d channel=C1 -d text=hello`, 'gate'],
    ] as Array<[string, string | undefined, string, 'allow' | 'gate']>)('%s', (_label, workgroup, command, expected) => {
        process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
        if (workgroup === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
        else process.env.NANOCLAW_WORKGROUP_ID = workgroup;
        expect(verdict(command)).toBe(expected);
    });

    test('no send-scope file gates no Slack post', () => {
        process.env[SEND_SCOPE_FILE_ENV] = join(dir, 'missing.json');
        process.env.NANOCLAW_WORKGROUP_ID = 'acme';
        expect(verdict(POST)).toBe('allow');
    });

    test('an unreadable send-scope file gates every Slack post', () => {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"slack": ');
        process.env[SEND_SCOPE_FILE_ENV] = broken;
        process.env.NANOCLAW_WORKGROUP_ID = 'other';
        expect(verdict(POST)).toBe('gate');
    });
});

describe('the message text a post carries', () => {
    test.each([
        ['a JSON body', POST, 'Numbers are in.'],
        ['a --json body', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"a\\nb"}'`, 'a\nb'],
        ['a form field', `curl https://slack.com/api/chat.postMessage -d channel=C1 -d 'text=hello%20there'`, 'hello there'],
        ['a urlencoded field', `curl https://slack.com/api/chat.postMessage --data-urlencode 'text=50% done'`, '50% done'],
        ['a variable', `curl https://slack.com/api/chat.postMessage --data "{\\"text\\":\\"$T\\"}"`, null],
        ['a body file', `curl https://slack.com/api/chat.postMessage --data @msg.json`, null],
        ['two texts', `curl https://slack.com/api/chat.postMessage -d text=a -d text=b`, null],
        ['a second request after --next', `curl https://slack.com/api/chat.postMessage -d text=ok --next https://slack.com/api/chat.delete -d channel=C1 -d ts=1`, null],
        ['a multipart field read from a file', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=<body.txt'`, null],
        ['a literal multipart field', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=hi'`, 'hi'],
        ['blocks beside the text', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"ok","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"other"}}]}'`, null],
        ['attachments in a form body', `curl https://slack.com/api/chat.postMessage -d 'channel=C1&text=ok&attachments=%5B%5D'`, null],
        ['a joined form body', `curl https://slack.com/api/chat.postMessage -d 'channel=C1&text=hello+there'`, 'hello there'],
        ['a delete carries no text', `curl https://slack.com/api/chat.delete -d channel=C1 -d ts=1 -d text=x`, null],
        ['an attached multipart file field', `curl https://slack.com/api/chat.postMessage -F text=ok -Fblocks=@blocks.json`, null],
        ['an attached config file', `curl https://slack.com/api/chat.postMessage -d text=ok -Kextra.conf`, null],
        ['an attached data value', `curl https://slack.com/api/chat.postMessage -dtext=hi`, 'hi'],
        ['a cluster ending in a data flag', `curl -sSd text=hi https://slack.com/api/chat.postMessage`, 'hi'],
        ['a curl option outside the known set', `curl https://slack.com/api/chat.postMessage --variable t@file --expand-data 'text={{t}}'`, null],
        ['a client other than curl', `http POST https://slack.com/api/chat.postMessage text=hi`, null],
        ['a URL given with --url=', `curl --url=https://slack.com/api/chat.postMessage -d channel=C1 -d text=hello`, 'hello'],
    ])('%s', (_label, command, text) => {
        expect(slackPostsOf(command)[0]?.text).toBe(text);
    });
});

describe('the gate request a send stages', () => {
    async function staged(command: string) {
        process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
        process.env.NANOCLAW_WORKGROUP_ID = 'acme';
        const real = await import(MODULE);
        const calls: Array<{ action?: string; sendParts?: string[] }> = [];
        mock.module(MODULE, () => ({
            ...real,
            writeGateRequest: (_l: string, _s: string, _c: string, action?: string, sendParts?: string[]) => {
                calls.push({ action, sendParts });
                return 'gate-test-id';
            },
            pollDeliveredTable: () => 'approved',
        }));
        const mod = await import(MODULE);
        const email = await import('./email-gate-core');
        email.evaluateEmailSend(command, { isScheduledTask: false });
        mod.runEmailGate(command, 'send');
        return calls[0];
    }

    test.each([
        ['a lone Slack post carries its text', POST, ['Numbers are in.']],
        ['a lone email carries its body, recipients and subject', `gws gmail +send --to a@example.com,b@example.com --subject 'Q3' --body 'Numbers are in.'`, ['Numbers are in.', 'to:a@example.com', 'to:b@example.com', 'subject:Q3']],
        ['a Slack post beside another command carries nothing', `gws gmail +send --to a@example.com; ${POST}`, undefined],
        ['a Slack post inside a loop carries nothing', `for c in C1 C2; do ${POST}; done`, undefined],
        ['an email beside another command carries nothing', `cd /tmp && gws gmail +send --to a@example.com --body 'hi'`, undefined],
        ['an email whose body runs a command carries nothing', `gws gmail +send --to a@example.com --body "$(cat notes.txt)"`, undefined],
        ['an email with an attachment carries nothing', `gws gmail +send --to a@example.com --subject Q3 --body 'Numbers are in.' --attach confidential.pdf`, undefined],
        ['a forward carries nothing', `gws gmail +forward --message-id m1 --to a@example.com --body 'FYI'`, undefined],
        ['a reply carries nothing', `gws gmail +reply --message-id m1 --body 'Approved text'`, undefined],
        ['a reply-all carries nothing', `gws gmail +reply-all --message-id m1 --body 'Approved text'`, undefined],
        ['a Slack delete carries nothing', `curl https://slack.com/api/chat.delete -d channel=C1 -d ts=1`, undefined],
    ] as Array<[string, string, string[] | undefined]>)('%s', async (_label, command, parts) => {
        expect(await staged(command)).toEqual({ action: 'request_send_gate', sendParts: parts });
    });
});

describe('send-scope files', () => {
    test.each([
        [{ slack: { workgroups: ['acme'] } }, true],
        [{ slack: { onecliAgents: ['ag-1'] } }, true],
        [{ slack: { workgroups: 'acme' } }, false],
        [{ slack: { workgroups: ['has space'] } }, false],
        [{}, false],
    ])('%j parses: %p', (scope, ok) => {
        expect(parseSendScope(JSON.stringify(scope)) !== null).toBe(ok);
    });
});
