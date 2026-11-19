import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realCore from './guards/block-destructive-core';
import * as realEmail from './guards/email-gate-core';

// NanoClaw's in-tree Codex email hook (container/agent-runner/src/providers/claude.ts, createEmailGateHook) joins the
// card this adapter staged only when peerRequestMatches says the stored request is the one it would file itself. The
// two functions below are ported from that repo; the in-tree hook's request is built from the same core verdict.

function peerRequestMatches(peer: Record<string, unknown>, requestId: string, own: Record<string, unknown>): boolean {
    if (peer.requestId !== requestId) return false;
    if (typeof own.toolUseId !== 'string' || !own.toolUseId) return false;
    const keys = new Set([...Object.keys(own), ...Object.keys(peer)]);
    keys.delete('requestId');
    for (const key of keys) {
        if (JSON.stringify(peer[key]) !== JSON.stringify(own[key])) return false;
    }
    return true;
}

interface Verdict {
    action: string;
    label?: string;
    summary?: string;
    sendParts?: unknown;
    pureSend?: boolean;
    fullSummary?: string;
    wholeEmail?: string;
}

function inTreeRequest(verdict: Verdict, command: string, toolUseId: string, requestId: string): Record<string, unknown> {
    const verb = command.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
    const request: Record<string, unknown> = {
        action: 'request_bash_gate',
        label: verdict.label ?? `Email ${verb}`,
        summary: verdict.summary ?? '',
        ...(Array.isArray(verdict.sendParts) && verdict.sendParts.every((p) => typeof p === 'string')
            ? { sendParts: verdict.sendParts }
            : {}),
        ...(verdict.pureSend === true ? { pureSend: true } : {}),
        ...(typeof verdict.fullSummary === 'string' && verdict.fullSummary ? { fullSummary: verdict.fullSummary } : {}),
        ...(typeof verdict.wholeEmail === 'string' && verdict.wholeEmail ? { wholeEmail: verdict.wholeEmail } : {}),
        command,
        toolUseId,
    };
    return { action: request.action, requestId, ...request };
}

// Codex can send the command as argv. The in-tree chain reads it with this (container/agent-runner/src/codex-hooks/runner.ts).
const ARGV_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
function argvCommandLine(argv: unknown[]): string {
    const words = argv.map(String);
    const shell = (words[0] ?? '').split('/').pop() ?? '';
    if (words.length === 3 && ARGV_SHELLS.has(shell) && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[1])) return words[2];
    return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

const CORE = './guards/block-destructive-core';
const emailExports = { ...realEmail };
const coreExports = { ...realCore };
mock.module('./guards/email-gate-core', () => ({
    ...emailExports,
    evaluateEmailSend: (command: string, env: Parameters<typeof realEmail.evaluateEmailSend>[1]) =>
        emailExports.evaluateEmailSend(command, { signaturesDir, ...env }),
}));
const EMAIL_CORE = './guards/email-gate-core';
const REQUEST_ID = 'gate-test-id';

// A sender on file, so the core can mark a send pure or give its whole text: production reads a fixed host path.
const root = mkdtempSync(join(tmpdir(), 'gate-peer-'));
const accounts = join(root, 'accounts');
const signaturesDir = join(root, 'email-signatures');
mkdirSync(accounts);
mkdirSync(signaturesDir);
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    mock.module('./guards/email-gate-core', () => emailExports);
    mock.module(CORE, () => coreExports);
});
const token = '{"refresh_token":"example-co"}';
writeFileSync(join(accounts, 'example-co.json'), token);
writeFileSync(join(signaturesDir, 'identities.json'), JSON.stringify({
    [createHash('sha256').update(token).digest('hex')]: { account: 'example-co', mailbox: 'team@example.com' },
}));

const CREDS = `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${accounts}/example-co.json`;
const SEND = ['gws', 'gmail', '+send'].join(' ');
const withBody = (body: string, flags = '') => `${CREDS}\nBODY=$(cat <<'EOF'\n${body}\nEOF\n)\n${SEND} --to pat@example.com --subject Hi --body "$BODY"${flags}`;

const BODY_FROM_FILE = `${CREDS}\nBODY=$(cat /workspace/notes/reply.txt)\n${SEND} --to pat@example.com --subject Hi --body "$BODY"`;

const SENDS: Record<string, string> = {
    'heredoc body, pure': withBody('Can you confirm the file works?'),
    'heredoc body, cut, cc': withBody(Array.from({ length: 30 }, (_, i) => `Line ${i} of the weekly notes, kept short.`).join('\n'), ' --cc lee@example.com'),
    'heredoc body, too long for the card': withBody(Array.from({ length: 400 }, (_, i) => `Row ${i} of a long export that no card holds.`).join('\n')),
    'heredoc body, html': withBody('<p>Hi Pat,</p><p>Can you confirm the file works?</p>', ' --html'),
    'quoted body variable': `${CREDS}\nBODY='Hi Pat,\n\nCan you confirm the file works?'\n${SEND} --to pat@example.com --subject Hi --body "$BODY"`,
    'inline body': `${CREDS}\n${SEND} --to pat@example.com --subject Hi --body 'Can you confirm the file works?'`,
    'prefixed credentials': `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${accounts}/example-co.json ${SEND} --to pat@example.com --subject Hi --body 'Short note.'`,
    'reply': `${CREDS}\nBODY='Thanks, confirmed.'\n${['gws', 'gmail', '+reply'].join(' ')} --message-id 18f0aa11bb22cc33 --body "$BODY"`,
    'forward': `${CREDS}\n${['gws', 'gmail', '+forward'].join(' ')} --message-id 18f0aa11bb22cc33 --to lee@example.com`,
};

async function stagedRequests() {
    const real = await import(CORE);
    const staged: Record<string, unknown>[] = [];
    mock.module(CORE, () => ({
        ...real,
        writeGateRequest: (...args: Parameters<typeof real.writeGateRequest>): string => {
            staged.push(JSON.parse(real.gateRequestContent(REQUEST_ID, ...args)));
            return REQUEST_ID;
        },
        pollDeliveredTable: (): 'approved' => 'approved',
        claimGateRequest: (): { owner: true } => ({ owner: true }),
        publishGateClaim: (): void => {},
    }));
    return { staged, core: await import(CORE), evaluate: (await import(EMAIL_CORE)).evaluateEmailSend, guard: await import('./codex-guard') };
}

/** Stages one send the way codex-guard's main does for a gated shell email, and the verdict the in-tree hook reads. */
async function stage(commands: string[], toolUseId: string | undefined) {
    const { staged, core, evaluate, guard } = await stagedRequests();
    const verdicts: Verdict[] = [];
    for (const command of commands) {
        const email = guard.emailReason(command);
        if (email.action !== 'gate' || email.deny) throw new Error(`files no card: ${command.slice(0, 80)}`);
        core.runEmailGate(command, email.reason, () => {}, email.summary, toolUseId, email.card);
        verdicts.push(evaluate(command, { isScheduledTask: false }) as Verdict);
    }
    return { staged, verdicts, core };
}

describe('the email card this adapter stages is the one the in-tree Codex hook would file', () => {
    afterEach(() => {
        mock.restore();
    });

    test('for the same tool call the two requests compare equal under the in-tree join rule, in every send form', async () => {
        const names = Object.keys(SENDS);
        const commands = Object.values(SENDS);
        const { staged, verdicts } = await stage(commands, 'call-1');
        expect(staged).toHaveLength(commands.length);
        expect(verdicts.some(v => v.pureSend === true)).toBe(true);
        expect(verdicts.some(v => typeof v.fullSummary === 'string')).toBe(true);
        expect(verdicts.some(v => typeof v.wholeEmail === 'string' && v.fullSummary === undefined)).toBe(true);
        const joined = staged.map((peer, i) =>
            [names[i], peerRequestMatches(peer, REQUEST_ID, inTreeRequest(verdicts[i], commands[i], 'call-1', REQUEST_ID))]);
        expect(joined).toEqual(names.map(name => [name, true]));
    });

    test('a command Codex sends as argv reads as the same text on both sides', async () => {
        const { core } = await stagedRequests();
        const script = SENDS['heredoc body, pure'];
        const argvs = [...ARGV_SHELLS].flatMap(shell => [[shell, '-c', script], [shell, '-lc', script], [`/bin/${shell}`, '-c', script]]);
        for (const argv of argvs) {
            expect([argv[0], argv[1], core.commandLineOf(argv)]).toEqual([argv[0], argv[1], argvCommandLine(argv)]);
        }
    });

    test('a body read from a file is refused by the verdict both hooks share, so neither files a card', async () => {
        const { guard, evaluate } = await stagedRequests();
        const email = guard.emailReason(BODY_FROM_FILE);
        expect(email.action === 'gate' && typeof email.deny === 'string').toBe(true);
        expect(typeof (evaluate(BODY_FROM_FILE, { isScheduledTask: false }) as { deny?: unknown }).deny).toBe('string');
    });

    test('a card staged for another tool call is not joined', async () => {
        const command = SENDS['heredoc body, pure'];
        const { staged, verdicts } = await stage([command], 'call-1');
        expect(peerRequestMatches(staged[0], REQUEST_ID, inTreeRequest(verdicts[0], command, 'call-2', REQUEST_ID))).toBe(false);
    });

    test('a request with no tool call, as staged before this change, is not joined', async () => {
        const command = SENDS['heredoc body, pure'];
        const { staged, verdicts } = await stage([command], 'call-1');
        const { toolUseId: _dropped, ...withoutCall } = staged[0];
        expect(peerRequestMatches(withoutCall, REQUEST_ID, inTreeRequest(verdicts[0], command, 'call-1', REQUEST_ID))).toBe(false);
    });

    test('a tool call adds one field after the rest, so a reader of the named fields sees the same request', () => {
        const card = { pureSend: true, fullSummary: 'whole', wholeEmail: 'all of it' };
        const before = realCore.gateRequestContent(REQUEST_ID, 'Email send to pat@example.com', 'summary', 'cmd', 'request_bash_gate', card);
        const after = realCore.gateRequestContent(REQUEST_ID, 'Email send to pat@example.com', 'summary', 'cmd', 'request_bash_gate', card, 'call-1');
        expect(after).toBe(`${before.slice(0, -1)},"toolUseId":"call-1"}`);
    });

    test('with no tool call the staged request is the one staged before this change', async () => {
        const { staged } = await stage(Object.values(SENDS), undefined);
        for (const peer of staged) expect('toolUseId' in peer).toBe(false);
    });
});
