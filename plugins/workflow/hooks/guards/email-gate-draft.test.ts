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
                            { mimeType: 'text/plain', body: { data: b64url(BODY) } },
                            { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
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
        expect(v.summary).toContain('Message, first 400 characters:');
        expect(v.summary).toContain('Hi Pat,\n\nThe renewal terms are attached.');
        expect(v.summary).not.toContain('END-OF-BODY');
        expect(v.summary).not.toContain('html version');
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
        expect(v.summary).toContain('Message (HTML, shown as text), first 400 characters:');
        expect(v.summary).toContain('Only html here');
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
