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
        ['a listed identity posting through a base URL already in the environment', undefined, `onecli run --agent ag-acme -- curl "$SLACK_API/chat.postMessage" --json '{"channel":"C1","text":"hi"}'`, 'gate'],
        ['an unwrapped post in a container beside a wrapped read', 'acme', `onecli run --agent ag-other -- curl https://slack.com/api/conversations.list; docker exec worker curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"hi"}'`, 'gate'],
        ['a search for a posting method in code', 'acme', `rg -n 'chat.postMessage' src/`, 'allow'],
        ['a post on a workspace subdomain', 'acme', `curl https://acme.slack.com/api/chat.postMessage -d text=x`, 'gate'],
        ['a post after a read in the same curl', 'acme', `curl https://slack.com/api/conversations.list --next https://slack.com/api/chat.postMessage -d text=x`, 'gate'],
        ['a wrapped curl named by its path', undefined, `onecli run --agent ag-acme -- /usr/bin/curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a post whose URL is given with --url=', 'acme', `curl --url=https://slack.com/api/chat.postMessage -d channel=C1 -d text=hello`, 'gate'],
        ['a wrapped post behind env', undefined, `onecli run --agent ag-acme -- env curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a listed OneCLI identity given with --agent=', undefined, `onecli run --agent=ag-acme -- curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a post whose Slack URL a variable holds', 'acme', `URL=https://slack.com/api/chat.postMessage; curl "$URL" -d channel=C1 -d text=hello`, 'gate'],
        ['a remote file share', 'acme', `curl -G https://slack.com/api/files.remote.share --data-urlencode channels=C1 --data-urlencode file=F1`, 'gate'],
        ['a permalink read', 'acme', `curl https://slack.com/api/chat.getPermalink -d channel=C1 -d message_ts=1`, 'allow'],
        ['a file listing', 'acme', `curl https://slack.com/api/files.list -d channel=C1`, 'allow'],
        ['an ephemeral post', 'acme', `curl https://slack.com/api/chat.postEphemeral -d channel=C1 -d user=U1 -d text=hello`, 'gate'],
        ['a direct post through a variable URL beside an unlisted OneCLI post', 'acme', `URL=https://slack.com/api/chat.postMessage; onecli run --agent ag-other -- curl https://slack.com/api/chat.postMessage -d channel=C1 -d text=bot; curl "$URL" -d channel=C2 -d text=person`, 'gate'],
        ['a post whose Slack host a variable holds', 'acme', `SLACK=https://slack.com; curl "$SLACK/api/chat.postMessage" -d channel=C1 -d text=hello`, 'gate'],
        ['a post joining a variable base URL with a slash', 'acme', `SLACK_API=https://slack.com/api; curl "$SLACK_API/chat.postMessage" -d channel=C1 -d text=hello`, 'gate'],
        ['a OneCLI identity on a continued line with the URL in a variable', undefined, `URL=https://slack.com/api/chat.postMessage; onecli run --agent \\\n  ag-acme -- curl "$URL" -d channel=C1 -d text=hello`, 'gate'],
        ['a post whose Slack base URL a variable holds', 'acme', `SLACK_API=https://slack.com/api/; curl "\${SLACK_API}chat.postMessage" -d channel=C1 -d text=hello`, 'gate'],
        ['a listed identity posting beside an ordinary post', undefined, `URL=https://slack.com/api/chat.postMessage; onecli run --agent ag-acme -- curl "$URL" -d channel=C1 -d text=hello; curl https://slack.com/api/chat.postMessage -d channel=C2 -d text=hi`, 'gate'],
        ['a quoted OneCLI identity with the posting URL in a variable', undefined, `URL=https://slack.com/api/chat.postMessage; onecli run --agent 'ag-acme' -- curl "$URL" -d text=hello`, 'gate'],
        ['a quoted OneCLI identity given with --agent= and the URL in a variable', undefined, `URL=https://slack.com/api/chat.postMessage; onecli run --agent="ag-acme" -- curl "$URL" -d text=hello`, 'gate'],
        ['a OneCLI identity held in a variable', undefined, `AGENT=ag-acme; onecli run --agent "$AGENT" -- curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a OneCLI identity held in a variable, given with --agent=', undefined, `AGENT=ag-acme; onecli run --agent="$AGENT" -- curl https://slack.com/api/chat.postMessage -d text=hello`, 'gate'],
        ['a post run by a shell', 'acme', `bash -lc 'curl https://slack.com/api/chat.postMessage -d text=hello'`, 'gate'],
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
        ['a posting URL inside the text of a scheduled send offers no exact text', `curl --data-urlencode 'text=Use https://slack.com/api/chat.postMessage' -d channel=C1 -d post_at=1793415108 https://slack.com/api/chat.scheduleMessage`, null],
        ['a JSON body to a method outside the exact set', `curl https://slack.com/api/chat.scheduleMessage -d '{"channel":"C1","text":"hi","post_at":1}'`, null],
        ['a form field: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage -d channel=C1 -d 'text=hello%20there'`, null],
        ['a urlencoded field: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage --data-urlencode 'text=50% done'`, null],
        ['a variable', `curl https://slack.com/api/chat.postMessage --data "{\\"text\\":\\"$T\\"}"`, null],
        ['a body file', `curl https://slack.com/api/chat.postMessage --data @msg.json`, null],
        ['two texts', `curl https://slack.com/api/chat.postMessage -d text=a -d text=b`, null],
        ['a second request after --next', `curl https://slack.com/api/chat.postMessage -d text=ok --next https://slack.com/api/chat.delete -d channel=C1 -d ts=1`, null],
        ['a multipart field read from a file', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=<body.txt'`, null],
        ['a literal multipart field: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=hi'`, null],
        ['a multipart field with a semicolon, which curl cuts', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=Approved; do not deploy yet.'`, null],
        ['a --form-string field keeps its semicolon: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage --form-string 'text=Approved; do not deploy yet.'`, null],
        ['blocks beside the text', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"ok","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"other"}}]}'`, null],
        ['attachments in a form body', `curl https://slack.com/api/chat.postMessage -d 'channel=C1&text=ok&attachments=%5B%5D'`, null],
        ['a joined form body: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage -d 'channel=C1&text=hello+there'`, null],
        ['a delete carries no text', `curl https://slack.com/api/chat.delete -d channel=C1 -d ts=1 -d text=x`, null],
        ['an attached multipart file field', `curl https://slack.com/api/chat.postMessage -F text=ok -Fblocks=@blocks.json`, null],
        ['an attached config file', `curl https://slack.com/api/chat.postMessage -d text=ok -Kextra.conf`, null],
        ['an attached data value: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage -dtext=hi`, null],
        ['a cluster ending in a data flag: not the one exact spelling, so a card', `curl -sSd text=hi https://slack.com/api/chat.postMessage`, null],
        ['a curl option outside the known set', `curl https://slack.com/api/chat.postMessage --variable t@file --expand-data 'text={{t}}'`, null],
        ['a client other than curl', `http POST https://slack.com/api/chat.postMessage text=hi`, null],
        ['a URL given with --url=: not the one exact spelling, so a card', `curl --url=https://slack.com/api/chat.postMessage -d channel=C1 -d text=hello`, null],
        ['an ANSI-C \\u escape, which the parser leaves as written', `curl https://slack.com/api/chat.postMessage -d channel=C1 --data-urlencode $'text=a \\u2014 b'`, null],
        ['an ANSI-C octal escape, which the parser leaves as written', `curl https://slack.com/api/chat.postMessage -d channel=C1 --data-urlencode $'text=a\\101b'`, null],
        ['an ANSI-C \\? escape, which the parser leaves as written', `curl https://slack.com/api/chat.postMessage -d channel=C1 --data-urlencode $'text=ready\\?'`, null],
        ['a multipart value with a trailing newline, which curl drops', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=ready\n'`, null],
        ['an ANSI-C newline, which the parser decodes: not the one exact spelling, so a card', `curl https://slack.com/api/chat.postMessage -d channel=C1 --data-urlencode $'text=a\\nb'`, null],
        ['a multipart value with leading spaces, which curl drops', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text=    if approved:'`, null],
        ['a quoted multipart value after a space, which curl also ends at its closing quote', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text= "Approved" do not deploy yet.'`, null],
        ['a quoted multipart value, which curl ends at its closing quote', `curl https://slack.com/api/chat.postMessage -F channel=C1 -F 'text="Approved" do not deploy yet.'`, null],
        ['a query text before a fragment, which curl never sends: not the one exact spelling, so a card', `curl 'https://slack.com/api/chat.postMessage?channel=C1&text=Ship%20it%20#after-review'`, null],
        ['a query text holding a question mark: not the one exact spelling, so a card', `curl 'https://slack.com/api/chat.postMessage?channel=C1&text=Deploy?%20Not%20yet'`, null],
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
        ['a lone Slack post through a OneCLI identity carries its text', `onecli run --agent ag-acme -- ${POST}`, ['Numbers are in.']],
        ['a lone email carries its body, recipients and subject', `gws gmail +send --to a@example.com,b@example.com --subject 'Q3' --body 'Numbers are in.'`, ['Numbers are in.', 'to:a@example.com', 'to:b@example.com', 'subject:Q3']],
        ['a Slack post beside another command carries nothing', `gws gmail +send --to a@example.com; ${POST}`, undefined],
        ['a Slack post inside a loop carries nothing', `for c in C1 C2; do ${POST}; done`, undefined],
        ['an email inside a loop carries nothing', `for n in 1 2; do gws gmail +send --to a@example.com --body hi; done`, undefined],
        ['an email beside another command carries nothing', `cd /tmp && gws gmail +send --to a@example.com --body 'hi'`, undefined],
        ['an email whose body runs a command carries nothing', `gws gmail +send --to a@example.com --body "$(cat notes.txt)"`, undefined],
        ['an email with an attachment carries nothing', `gws gmail +send --to a@example.com --subject Q3 --body 'Numbers are in.' --attach confidential.pdf`, undefined],
        ['an email inside a shell program carries nothing', `bash -c 'gws gmail +send --to a@example.com --body "Numbers are in." --attach confidential.pdf'`, undefined],
        ['an email with an attached -a attachment carries nothing', `gws gmail +send --to a@example.com --subject Q3 --body 'Numbers are in.' -aconfidential.pdf`, undefined],
        ['an email body drops a line continuation, as bash does: not the one exact spelling, so a card', `gws gmail +send --to a@example.com --body "Do not\\\nrelease until approved."`, undefined],
        ['an email body with UTF-8 byte escapes carries the decoded text: not the one exact spelling, so a card', `gws gmail +send --to a@example.com --body $'Caf\\303\\251 is open.'`, undefined],
        ['an email body with ANSI-C escapes carries the decoded text: not the one exact spelling, so a card', `gws gmail +send --to a@example.com --body $'a \\u2014 b\\101'`, undefined],
        ['an email body keeps its leading indentation', `gws gmail +send --to a@example.com --body '    if approved:\n        release()'`, ['    if approved:\n        release()', 'to:a@example.com']],
        ['a forward carries nothing', `gws gmail +forward --message-id m1 --to a@example.com --body 'FYI'`, undefined],
        ['a reply carries nothing', `gws gmail +reply --message-id m1 --body 'Approved text'`, undefined],
        ['a reply-all carries nothing', `gws gmail +reply-all --message-id m1 --body 'Approved text'`, undefined],
        ['a Slack post whose URL a variable holds is gated with nothing', `URL=https://slack.com/api/chat.postMessage; curl "$URL" -d channel=C1 -d text=hello`, undefined],
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
        [{ slack: [{ workgroups: ['acme'] }] }, false],
        [{ slack: { workgroups: ['has space'] } }, false],
        [{}, false],
    ])('%j parses: %p', (scope, ok) => {
        expect(parseSendScope(JSON.stringify(scope)) !== null).toBe(ok);
    });
});
