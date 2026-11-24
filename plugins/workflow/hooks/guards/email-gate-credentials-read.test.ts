import { afterAll, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A credentials file that reads as one account and then as another, as a swap between two reads of it would.
const root = fs.mkdtempSync(join(tmpdir(), 'email-gate-one-read-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const signaturesDir = join(root, 'signatures');
fs.mkdirSync(join(root, 'accounts'));
fs.mkdirSync(signaturesDir);
const creds = join(root, 'accounts', 'swap-co.json');
const FIRST = '{"type":"authorized_user","refresh_token":"first"}';
const SECOND = '{"type":"authorized_user","refresh_token":"second"}';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
fs.writeFileSync(creds, FIRST);
fs.writeFileSync(join(signaturesDir, 'identities.json'), JSON.stringify({
    [sha(FIRST)]: { account: 'first-co', mailbox: 'first@example.com' },
    [sha(SECOND)]: { account: 'second-co', mailbox: 'second@example.com' },
}));
const realRead = fs.readFileSync;
let reads = 0;
mock.module('fs', () => ({
    ...fs,
    readFileSync: (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (path !== creds) return (realRead as (...a: unknown[]) => unknown)(path, ...rest);
        reads++;
        return Buffer.from(reads === 1 ? FIRST : SECOND);
    },
}));
const { evaluateEmailSend } = await import('./email-gate-core');

test("the card's mailbox comes from the same read of the credentials file as the binding's hash", () => {
    const v = evaluateEmailSend(
        `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${join(root, 'send-1')} GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${creds} gws gmail +send --to pat@example.com --subject Hi --body "Can you confirm the file works?"`,
        { isScheduledTask: false, signaturesDir },
    );
    expect(v.deny).toBeUndefined();
    expect(v.account?.credentials.hash).toBe(sha(FIRST));
    expect(v.summary).toContain('From: first@example.com');
    expect(reads).toBe(1);
});
