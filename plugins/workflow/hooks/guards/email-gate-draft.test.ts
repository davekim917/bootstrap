import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { draftChangedSince, evaluateEmailSend, type DraftBinding } from './email-gate-core';

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A stand-in gws that records its argv and credentials file, then prints `stdout` and exits with `status`. */
function stubGws(opts: { stdout?: string; status?: number; sleepSeconds?: number }): { bin: string; calls: () => string[]; creds: () => string[] } {
    const root = mkdtempSync(join(tmpdir(), 'gws-draft-stub-'));
    roots.push(root);
    writeFileSync(join(root, 'stdout'), opts.stdout ?? '');
    const bin = join(root, 'gws');
    writeFileSync(bin, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${root}/calls'`,
        `printf '%s\\n' "$GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE" >> '${root}/creds'`,
        opts.sleepSeconds ? `sleep ${opts.sleepSeconds}` : '',
        `cat '${root}/stdout'`,
        `exit ${opts.status ?? 0}`,
        '',
    ].join('\n'));
    chmodSync(bin, 0o755);
    const lines = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8').trim().split('\n') : []);
    return { bin, calls: () => lines('calls'), creds: () => lines('creds') };
}

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const CREDS_FILE = '/home/node/.config/gws/accounts/team-inbox.json';
const DRAFT_ID = 'r-draft-0001';
const SEND = `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS_FILE} gws gmail users drafts send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}"}' 2>&1 | tail -15`;
const BODY = `Hi Pat,\n\nThe renewal terms are attached. ${'Details follow. '.repeat(40)}END-OF-BODY`;
const INTERACTIVE = { isScheduledTask: false };

function draftJson(messageId: string, overrides: { id?: string } = {}): string {
    return JSON.stringify({
        id: overrides.id ?? DRAFT_ID,
        message: {
            id: messageId,
            snippet: 'Hi Pat, The renewal terms are attached.',
            payload: {
                mimeType: 'multipart/mixed',
                headers: [
                    { name: 'From', value: 'Team Inbox <team@example.com>' },
                    { name: 'To', value: 'pat@example.com' },
                    { name: 'Cc', value: 'lee@example.com' },
                    { name: 'Bcc', value: 'records@example.com' },
                    { name: 'Subject', value: 'Renewal terms' },
                ],
                parts: [
                    {
                        mimeType: 'multipart/alternative',
                        parts: [
                            { mimeType: 'text/plain', body: { data: b64url('plain version') } },
                            { mimeType: 'text/html', body: { data: b64url(`<div>${BODY}</div>`) } },
                        ],
                    },
                    { mimeType: 'application/pdf', filename: 'renewal-terms.pdf', body: { attachmentId: 'att-1' } },
                ],
            },
        },
    });
}

describe('a send of a stored draft by id', () => {
    test('the card shows the envelope, a body preview and attachments read from the draft, and binds to its version', () => {
        const gws = stubGws({ stdout: draftJson('18c00000000000a1') });
        const v = evaluateEmailSend(SEND, { ...INTERACTIVE, gwsBin: gws.bin });

        expect(v.action).toBe('gate');
        expect(v.deny).toBeUndefined();
        expect(v.label).toBe('Email send to pat@example.com: "Renewal terms"');
        expect(v.summary).toContain('From header in the message: Team Inbox ‹team@example.com>');
        expect(v.summary).toContain('To: pat@example.com');
        expect(v.summary).toContain('Cc: lee@example.com');
        expect(v.summary).toContain('Bcc: records@example.com');
        expect(v.summary).toContain('Subject: Renewal terms');
        expect(v.summary).toContain('Attachments: `renewal-terms.pdf`');
        expect(v.summary).toContain('Message (HTML, shown as text), first 400 of 692 characters:');
        expect(v.summary).toContain('Hi Pat,\n\nThe renewal terms are attached.');
        expect(v.summary).not.toContain('END-OF-BODY');
        expect(v.summary).not.toContain('plain version');
        expect(v.summary).not.toContain('⚠️');
        expect(v.summary).toContain('Draft `r-draft-0001`, version `18c00000000000a1`');
        expect(v.summary).not.toContain('Message: not shown');
        expect(v.pureSend).toBeUndefined();
        expect(v.draft).toEqual({ draftId: DRAFT_ID, messageId: '18c00000000000a1', userId: 'me', credentialsFile: CREDS_FILE });

        expect(gws.calls()).toEqual([`gmail users drafts get --params {"userId":"me","id":"${DRAFT_ID}","format":"full"}`]);
        expect(gws.creds()).toEqual([CREDS_FILE]);
    });

    test('an HTML-only draft is shown as text', () => {
        const draft = JSON.parse(draftJson('18c00000000000a2'));
        draft.message.payload = {
            mimeType: 'text/html',
            headers: [{ name: 'To', value: 'pat@example.com' }],
            body: { data: b64url('<div><p>Only <b>html</b> here</p></div>') },
        };
        const v = evaluateEmailSend(SEND, { ...INTERACTIVE, gwsBin: stubGws({ stdout: JSON.stringify(draft) }).bin });
        expect(v.summary).toContain('Message (HTML, shown as text), 14 characters:');
        expect(v.summary).toContain('Only html here');
    });

    describe('what the card cannot show faithfully, it says first', () => {
        const withPayload = (payload: unknown) => {
            const draft = JSON.parse(draftJson('18c00000000000c1'));
            draft.message.payload = payload;
            return evaluateEmailSend(SEND, { ...INTERACTIVE, gwsBin: stubGws({ stdout: JSON.stringify(draft) }).bin }).summary!;
        };
        const part = (mimeType: string, text: string, filename?: string) => ({ mimeType, filename, body: { data: b64url(text) } });
        const TO = [{ name: 'To', value: 'pat@example.com' }];

        test('the HTML version is shown, since that is what recipients read', () => {
            const summary = withPayload({ mimeType: 'multipart/alternative', headers: TO, parts: [part('text/plain', 'Lunch Thursday?'), part('text/html', '<p>Quarterly figures enclosed</p>')] });
            expect(summary).toContain('Quarterly figures enclosed');
            expect(summary).not.toContain('Lunch Thursday?');
            expect(summary).not.toContain('⚠️');
        });

        test('an HTML version before its plain one is flagged, since a client may prefer the last', () => {
            const summary = withPayload({ mimeType: 'multipart/alternative', headers: TO, parts: [part('text/html', '<p>Lunch Thursday?</p>'), part('text/plain', 'Quarterly figures enclosed')] });
            expect(summary.startsWith('⚠️ This draft has 2 text parts and the card shows one.')).toBe(true);
        });

        test("a text part is decoded in its own charset, and one that can't be decoded exactly is flagged", () => {
            const latin1 = (charset: string, bytes: Buffer) => ({ mimeType: 'text/plain', headers: [...TO, { name: 'Content-Type', value: `text/plain; charset="${charset}"` }], body: { data: bytes.toString('base64url') } });
            expect(withPayload(latin1('ISO-8859-1', Buffer.from([0x43, 0x61, 0x66, 0xe9])))).toContain('Café');
            expect(withPayload(latin1('x-no-such-charset', Buffer.from('hi'))))
                .toStartWith('⚠️ The text of this draft could not be decoded');
            expect(withPayload({ mimeType: 'text/plain', headers: TO, body: { data: Buffer.from([0x43, 0x61, 0x66, 0xe9]).toString('base64url') } }))
                .toStartWith('⚠️ The text of this draft could not be decoded');
        });

        test('a third version beside the pair is flagged', () => {
            const summary = withPayload({ mimeType: 'multipart/alternative', headers: TO, parts: [part('text/plain', 'a'), part('text/html', '<p>a</p>'), part('text/x-amp-html', '<p>b</p>')] });
            expect(summary.startsWith('⚠️ This draft has 2 text parts and the card shows one.')).toBe(true);
        });

        test('an ordinary emoji is not flagged, but joiners padding after one are', () => {
            expect(withPayload({ mimeType: 'text/plain', headers: TO, body: { data: b64url('Thanks ❤️ and 👩‍💻') } })).not.toContain('⚠️');
            expect(withPayload({ mimeType: 'text/plain', headers: TO, body: { data: b64url('❤' + '‍'.repeat(50) + 'text') } }))
                .toStartWith('⚠️ This draft holds invisible or direction-changing characters');
        });

        test('a plain version, then HTML with inline images, is one pair', () => {
            const summary = withPayload({ mimeType: 'multipart/alternative', headers: TO, parts: [
                part('text/plain', 'See the chart'),
                { mimeType: 'multipart/related', parts: [part('text/html', '<p>See the chart</p>'), part('image/png', 'png', 'chart.png')] },
            ] });
            expect(summary).not.toContain('⚠️');
            expect(summary).toContain('Attachments: `chart.png`');
        });

        test('an HTML body too long to measure says so', () => {
            const summary = withPayload({ mimeType: 'text/html', headers: TO, body: { data: b64url(`<p>${'word '.repeat(5000)}</p>`) } });
            expect(summary).toContain('Message (HTML, shown as text), first 400 of more than 20,000 characters:');
        });

        test('a second text part is flagged, and an unnamed part is listed as an attachment', () => {
            const summary = withPayload({ mimeType: 'multipart/mixed', headers: TO, parts: [part('text/plain', 'hello'), part('text/plain', 'second part'), part('application/pdf', '%PDF', '')] });
            expect(summary.startsWith('⚠️ This draft has 2 text parts and the card shows one.')).toBe(true);
            expect(summary).toContain('Attachments: `unnamed application/pdf`');
        });

        test('every value of a repeated header is shown', () => {
            const summary = withPayload({ mimeType: 'text/plain', headers: [...TO, { name: 'To', value: 'lee@example.com' }], body: { data: b64url('hi') } });
            expect(summary).toContain('To: pat@example.com, lee@example.com');
        });

        test('a card too long to show whole says so before anything is cut', () => {
            const cc = Array.from({ length: 60 }, (_, i) => `person${i}@example.com`).join(', ');
            const summary = withPayload({ mimeType: 'text/plain', headers: [...TO, { name: 'Cc', value: cc }, { name: 'Bcc', value: 'records@example.com' }], body: { data: b64url('hi') } });
            expect(summary.startsWith('⚠️ This draft is longer than the card can show, so lines below are cut.')).toBe(true);
            expect(summary).not.toContain('records@example.com');
        });

        test('invisible characters and chat markup are flagged', () => {
            expect(withPayload({ mimeType: 'text/plain', headers: TO, body: { data: b64url('​'.repeat(50) + 'hidden text') } }))
                .toStartWith('⚠️ This draft holds invisible or direction-changing characters');
            expect(withPayload({ mimeType: 'multipart/mixed', headers: TO, parts: [part('text/plain', 'hi'), part('application/octet-stream', 'x', 'invoice‮fdp.exe')] }))
                .toStartWith('⚠️ This draft holds invisible or direction-changing characters');
            expect(withPayload({ mimeType: 'text/plain', headers: TO, body: { data: b64url('\u{E0041}'.repeat(50) + 'tagged') } }))
                .toStartWith('⚠️ This draft holds invisible or direction-changing characters');
            expect(withPayload({ mimeType: 'text/plain', headers: [...TO, { name: 'Subject', value: 'Totals ```' }], body: { data: b64url('hi') } }))
                .toStartWith('⚠️ A header in this draft holds characters chat formatting may change');
        });
    });

    test('a failed, slow, empty or mismatched read keeps the gate and the card it had before', () => {
        const before = evaluateEmailSend(SEND, { ...INTERACTIVE, gwsBin: '/nonexistent/gws' });
        expect(before.action).toBe('gate');
        expect(before.label).toBe('Email send to unknown recipient');
        expect(before.summary).toContain('To: unknown recipient');
        expect(before.summary).toContain('Message: not shown. This send passes a raw MIME message');
        expect(before.draft).toBeUndefined();

        const failures = {
            'exits non-zero': stubGws({ stdout: draftJson('18c00000000000a3'), status: 1 }),
            'prints no JSON': stubGws({ stdout: 'error: invalid_grant' }),
            'returns another draft': stubGws({ stdout: draftJson('18c00000000000a4', { id: 'r-draft-0002' }) }),
            'returns no message id': stubGws({ stdout: JSON.stringify({ id: DRAFT_ID, message: {} }) }),
            'returns an API error': stubGws({ stdout: JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }) }),
            'outlasts the time limit': stubGws({ stdout: draftJson('18c00000000000a5'), sleepSeconds: 8 }),
        };
        for (const [name, gws] of Object.entries(failures)) {
            const v = evaluateEmailSend(SEND, { ...INTERACTIVE, gwsBin: gws.bin });
            expect({ name, ...v }).toEqual({ name, ...before });
        }
    }, 20_000);

    test('no draft is read for a send that is not exactly a send of a draft by id', () => {
        const gws = stubGws({ stdout: draftJson('18c00000000000a6') });
        for (const command of [
            // No credentials file named: the read could use another account than the send.
            `gws gmail users drafts send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}"}'`,
            // A relative credentials path resolves against the hook's cwd, not the shell's.
            `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=accounts/team-inbox.json gws gmail users drafts send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}"}'`,
            // The payload carries a message of its own.
            `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS_FILE} gws gmail users drafts send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}","message":{"raw":"eA"}}'`,
            // A message send, not a draft send.
            `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS_FILE} gws gmail users messages send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}"}'`,
            // An option beyond --params and --json.
            `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS_FILE} gws gmail users drafts send --params '{"userId":"me"}' --json '{"id":"${DRAFT_ID}"}' --upload x.eml`,
            // The id is only known when the command runs.
            `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${CREDS_FILE} gws gmail users drafts send --params '{"userId":"me"}' --json "$PAYLOAD"`,
        ]) {
            const v = evaluateEmailSend(command, { ...INTERACTIVE, gwsBin: gws.bin });
            expect({ command, action: v.action, draft: v.draft }).toEqual({ command, action: 'gate', draft: undefined });
        }
        expect(gws.calls()).toEqual([]);
    });

    test('a scheduled task sends without reading the draft', () => {
        const gws = stubGws({ stdout: draftJson('18c00000000000a7') });
        expect(evaluateEmailSend(SEND, { isScheduledTask: true, gwsBin: gws.bin })).toEqual({ action: 'allow' });
        expect(gws.calls()).toEqual([]);
    });
});

describe('draftChangedSince', () => {
    const binding: DraftBinding = { draftId: DRAFT_ID, messageId: '18c00000000000b1', userId: 'me', credentialsFile: CREDS_FILE };

    test('an unchanged draft passes, read with the same account', () => {
        const gws = stubGws({ stdout: JSON.stringify({ id: DRAFT_ID, message: { id: '18c00000000000b1' } }) });
        expect(draftChangedSince(binding, gws.bin)).toBeNull();
        expect(gws.calls()).toEqual([`gmail users drafts get --params {"userId":"me","id":"${DRAFT_ID}","format":"minimal"}`]);
        expect(gws.creds()).toEqual([CREDS_FILE]);
    });

    test('an edited draft is refused', () => {
        const gws = stubGws({ stdout: JSON.stringify({ id: DRAFT_ID, message: { id: '18c00000000000b2' } }) });
        expect(draftChangedSince(binding, gws.bin)).toBe(
            `Email send refused: draft ${DRAFT_ID} was edited after its approval card was shown, so the approval does not cover what it holds now. Ask for approval again with the same command; the new card shows the current draft.`,
        );
    });

    test('a draft that cannot be re-read is refused', () => {
        for (const gws of [stubGws({ status: 1 }), stubGws({ stdout: JSON.stringify({ id: 'r-3', message: { id: '18c00000000000b1' } }) })]) {
            expect(draftChangedSince(binding, gws.bin)).toBe(
                `Email send refused: draft ${DRAFT_ID} could not be re-read to confirm it is the version that was approved. Ask for approval again with the same command.`,
            );
        }
    });
});
