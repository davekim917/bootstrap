import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateEmailSend, leftOffRefusal } from './email-gate-core';

const root = mkdtempSync(join(tmpdir(), 'email-gate-reply-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const accounts = join(root, 'accounts');
const signaturesDir = join(root, 'signatures');
mkdirSync(accounts, { recursive: true });
mkdirSync(signaturesDir, { recursive: true });
writeFileSync(join(accounts, 'team.json'), '{"refresh_token":"t"}');
writeFileSync(join(signaturesDir, 'identities.json'), JSON.stringify({
    [createHash('sha256').update('{"refresh_token":"t"}').digest('hex')]: { account: 'team', mailbox: 'team@example.com' },
}));
const CREDS = join(accounts, 'team.json');
const MESSAGE_ID = '18f0aa11bb22cc33';

type Header = [name: string, value: string];
let stubs = 0;

/**
 * A stand-in gws answering the three reads a reply card makes. It records each call's argv and credentials file; a
 * read given no answer exits 1, as gws does on an API error.
 */
function gws(answers: { headers?: Header[]; profile?: string; defaultSendAs?: string }) {
    const dir = join(root, `stub-${stubs++}`);
    mkdirSync(dir);
    const message = answers.headers && {
        id: '__ID__', threadId: 't-1',
        payload: { mimeType: 'multipart/alternative', headers: answers.headers.map(([name, value]) => ({ name, value })) },
    };
    if (message) writeFileSync(join(dir, 'message'), JSON.stringify(message));
    if (answers.profile) writeFileSync(join(dir, 'profile'), JSON.stringify({ emailAddress: answers.profile, messagesTotal: 1 }));
    if (answers.defaultSendAs) {
        writeFileSync(join(dir, 'sendas'), JSON.stringify({ sendAs: [
            { sendAsEmail: 'team@example.com', isPrimary: true, isDefault: answers.defaultSendAs === 'team@example.com' },
            { sendAsEmail: answers.defaultSendAs, isDefault: true },
        ] }));
    }
    const bin = join(dir, 'gws');
    writeFileSync(bin, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${dir}/calls'`,
        `printf '%s\\n' "$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE" >> '${dir}/creds'`,
        'case "$*" in',
        `  *"messages get"*) f='${dir}/message' ;;`,
        `  *getProfile*) f='${dir}/profile' ;;`,
        `  *"sendAs list"*) f='${dir}/sendas' ;;`,
        '  *) exit 2 ;;',
        'esac',
        '[ -f "$f" ] || exit 1',
        'id=$(printf \'%s\' "$*" | sed -n \'s/.*"id":"\\([^"]*\\)".*/\\1/p\')',
        'sed "s/__ID__/$id/" "$f"',
        '',
    ].join('\n'));
    chmodSync(bin, 0o755);
    const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n') : []);
    return { bin, calls: () => lines('calls'), creds: () => lines('creds') };
}

const reply = (verb: '+reply' | '+reply-all', extra = '') =>
    `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS}\ngws gmail ${verb} --message-id ${MESSAGE_ID} --body "Thanks, that works."${extra ? ` ${extra}` : ''}`;
const card = (command: string, stub: ReturnType<typeof gws>) =>
    evaluateEmailSend(command, { isScheduledTask: false, signaturesDir, gwsBin: stub.bin });
const recipientLines = (summary: string | undefined) => (summary ?? '').split('\n').filter(l => /^(?:To|Cc|Bcc): /.test(l));

// The thread from the incident: a client writes to the team and one colleague, with two people on a header Outlook
// spells CC.
const OUTLOOK_THREAD: Header[] = [
    ['From', 'Morgan Client <morgan@example.net>'],
    ['To', 'team@example.com, Riley <riley@example.com>'],
    ['CC', 'Jordan <jordan@example.net>, sam@example.net'],
    ['Message-ID', '<orig-1@example.net>'],
];

describe('a reply card lists the addresses gws sends to', () => {
    test('a reply-all that would drop the people on a CC header is refused, naming them and the option that adds them', () => {
        const stub = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com', defaultSendAs: 'team@example.com' });
        const v = card(reply('+reply-all'), stub);
        expect(v.deny).toBe(leftOffRefusal(['jordan@example.net', 'sam@example.net'], true));
        expect(v.deny).toContain('--cc jordan@example.net,sam@example.net');
        expect(recipientLines(v.summary)).toEqual(['To: morgan@example.net', 'Cc: riley@example.com']);
    });

    test('the same reply-all with those people added by --cc is asked for, every address on the card and no command', () => {
        const stub = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com', defaultSendAs: 'team@example.com' });
        const v = card(reply('+reply-all', '--cc jordan@example.net,sam@example.net'), stub);
        expect([v.action, v.deny, v.pureSend]).toEqual(['gate', undefined, true]);
        expect(v.label).toBe('Email reply-all to morgan@example.net');
        expect(recipientLines(v.summary)).toEqual([
            'To: morgan@example.net',
            'Cc: riley@example.com, jordan@example.net, sam@example.net',
        ]);
        expect(v.summary).toContain(`In reply to: Gmail message \`${MESSAGE_ID}\`, quoted under the reply; the recipients above are read from it`);
    });

    test('leaving them off on purpose with --remove is asked for, not refused', () => {
        const stub = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com', defaultSendAs: 'team@example.com' });
        const v = card(reply('+reply-all', '--remove jordan@example.net,sam@example.net'), stub);
        expect([v.action, v.deny]).toEqual(['gate', undefined]);
        expect(recipientLines(v.summary)).toEqual(['To: morgan@example.net', 'Cc: riley@example.com']);
    });

    // Rows follow gws 0.22.5's own reply.rs tests.
    test.each([
        {
            name: 'reply-all: Reply-To takes To; original To and Cc go to Cc, less the account and duplicates',
            verb: '+reply-all' as const, extra: '',
            headers: [['From', 'alice@example.org'], ['Reply-To', 'list@example.org, owner@example.org'], ['To', 'bob@example.org, list@example.org, Team@Example.com'], ['Cc', 'owner@example.org, drew@example.org'], ['Message-ID', '<m@x>']] as Header[],
            lines: ['To: list@example.org, owner@example.org', 'Cc: bob@example.org, drew@example.org'],
        },
        {
            name: 'reply-all to the account\'s own message, sent from its default alias, goes to the original To and Cc',
            verb: '+reply-all' as const, extra: '', alias: 'sales@example.com',
            headers: [['From', 'sales@example.com'], ['Reply-To', 'list@example.org'], ['To', 'alice@example.org, team@example.com'], ['Cc', 'carol@example.org'], ['Message-ID', '<m@x>']] as Header[],
            lines: ['To: alice@example.org', 'Cc: carol@example.org'],
        },
        {
            name: 'reply-all: a quoted display name with a comma is one mailbox; --to and --bcc add, each address kept once',
            verb: '+reply-all' as const, extra: '--to bob@example.org,new@example.org --bcc new@example.org,audit@example.org',
            headers: [['From', 'sender@example.org'], ['To', '"Doe, John" <john@example.org>, bob@example.org'], ['Message-ID', '<m@x>']] as Header[],
            lines: ['To: sender@example.org, bob@example.org, new@example.org', 'Cc: john@example.org', 'Bcc: audit@example.org'],
        },
        {
            name: 'reply: Reply-To or else From, plus only what the command adds',
            verb: '+reply' as const, extra: '--cc lee@example.org',
            headers: [['From', 'alice@example.org'], ['Reply-To', 'desk@example.org'], ['To', 'team@example.com, bob@example.org'], ['Cc', 'carol@example.org'], ['Message-ID', '<m@x>']] as Header[],
            lines: ['To: desk@example.org', 'Cc: lee@example.org'],
        },
    ])('$name', ({ verb, extra, headers, lines, alias }) => {
        const stub = gws({ headers, profile: 'team@example.com', defaultSendAs: alias ?? 'team@example.com' });
        const v = card(reply(verb, extra), stub);
        expect(v.deny).toBeUndefined();
        expect(recipientLines(v.summary)).toEqual([...lines]);
    });

    test('the reads are read-only Gmail calls made with the send\'s own credentials, and --from stands in for the send-as lookup', () => {
        const stub = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com', defaultSendAs: 'team@example.com' });
        card(reply('+reply-all'), stub);
        expect(stub.calls()).toEqual([
            `gmail users messages get --params {"userId":"me","id":"${MESSAGE_ID}","format":"metadata","metadataHeaders":["From","Reply-To","To","Cc","Message-ID"]}`,
            'gmail users getProfile --params {"userId":"me"}',
            'gmail users settings sendAs list --params {"userId":"me"}',
        ]);
        expect(new Set(stub.creds())).toEqual(new Set([CREDS]));
        const withFrom = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com' });
        card(reply('+reply-all', '--from team@example.com --cc jordan@example.net,sam@example.net'), withFrom);
        expect(withFrom.calls().some(c => c.includes('sendAs'))).toBe(false);
        const plain = gws({ headers: OUTLOOK_THREAD });
        card(reply('+reply'), plain);
        expect(plain.calls()).toHaveLength(1);
    });

    test('a plain reply ignores a misspelled CC, since it never takes the original Cc, but not a misspelled Reply-To', () => {
        expect(card(reply('+reply'), gws({ headers: OUTLOOK_THREAD })).deny).toBeUndefined();
        const v = card(reply('+reply'), gws({ headers: [['From', 'alice@example.org'], ['Reply-to', 'desk@example.org'], ['Message-ID', '<m@x>']] }));
        expect(v.deny).toBe(leftOffRefusal(['desk@example.org'], false));
        expect(recipientLines(v.summary)).toEqual(['To: alice@example.org']);
    });
});

test('a reply-all to the account\'s own message is not refused over a misspelled Reply-To, which gws never uses there', () => {
    const headers: Header[] = [['From', 'team@example.com'], ['Reply-to', 'desk@example.org'], ['To', 'alice@example.org'], ['Message-ID', '<m@x>']];
    const v = card(reply('+reply-all'), gws({ headers, profile: 'team@example.com', defaultSendAs: 'team@example.com' }));
    expect(v.deny).toBeUndefined();
    expect(recipientLines(v.summary)).toEqual(['To: alice@example.org']);
});

describe('when the gate cannot work out who a reply reaches', () => {
    const NOT_RESOLVED = /^⚠️ Recipients not resolved: .+, so this card cannot list who the reply reaches\. Decline unless you know everyone on the thread\.$/;

    test.each([
        { why: 'the original cannot be read', verb: '+reply-all' as const, stub: () => gws({ profile: 'team@example.com' }) },
        { why: 'the account\'s own address cannot be read', verb: '+reply-all' as const, stub: () => gws({ headers: OUTLOOK_THREAD }) },
        { why: 'gws itself would refuse: no Message-ID header', verb: '+reply' as const, stub: () => gws({ headers: [['From', 'alice@example.org']] }) },
    ])('$why: the card says so first, still asks, and never leaves the command off', ({ verb, stub }) => {
        const v = card(reply(verb, '--to added@example.org --cc extra@example.org'), stub());
        const lines = (v.summary ?? '').split('\n');
        expect([v.action, v.deny, v.pureSend, v.fullSummary]).toEqual(['gate', undefined, undefined, undefined]);
        expect(lines[0]).toMatch(NOT_RESOLVED);
        expect(recipientLines(v.summary)).toEqual(verb === '+reply-all'
            ? ['To: not resolved, plus added@example.org', 'Cc: not resolved, plus extra@example.org']
            : ['To: not resolved, plus added@example.org', 'Cc: extra@example.org']);
    });

    test('a reply that names no absolute credentials file is not read at all', () => {
        const stub = gws({ headers: OUTLOOK_THREAD, profile: 'team@example.com' });
        const v = evaluateEmailSend(`gws gmail +reply-all --message-id ${MESSAGE_ID} --body "ok"`, { isScheduledTask: false, gwsBin: stub.bin });
        expect(stub.calls()).toEqual([]);
        expect(v.summary?.split('\n')[0]).toContain('names no absolute GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE');
    });
});
