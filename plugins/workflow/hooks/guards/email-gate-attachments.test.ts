import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateEmailSend, FORMATTED_WRAPPER } from './email-gate-core';

const root = mkdtempSync(join(tmpdir(), 'gws-attach-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const agent = join(root, 'agent');
const shared = join(root, 'workgroup', 'artifacts', 'spring-budget');
mkdirSync(join(agent, 'send'), { recursive: true });
mkdirSync(join(agent, 'folder'));
mkdirSync(shared, { recursive: true });
const SHEET = 'Spring budget - comparisons to confirm.xlsx';
writeFileSync(join(shared, SHEET), 'sheet');
writeFileSync(join(agent, 'send', SHEET), 'sheet');
writeFileSync(join(agent, 'empty.txt'), '');
writeFileSync(join(agent, 'locked.txt'), 'locked');
chmodSync(join(agent, 'locked.txt'), 0o000);
symlinkSync(join(shared, SHEET), join(agent, 'linked.xlsx'));
symlinkSync(join(agent, 'send', SHEET), join(agent, 'linked-inside.xlsx'));
mkdirSync(join(agent, 'deep', 'er'), { recursive: true });
writeFileSync(join(agent, 'deep', 'x.txt'), 'x');
symlinkSync(join(agent, 'deep', 'er'), join(agent, 'up'));
mkdirSync(join(agent, 'deep', 'cwd-target'));
writeFileSync(join(agent, 'deep', 'cwd-target', 'f.txt'), 'f');
symlinkSync(join(agent, 'deep', 'cwd-target'), join(root, 'cwd-link'));
writeFileSync(join(agent, 'big-a.bin'), '');
truncateSync(join(agent, 'big-a.bin'), 13 * 1024 * 1024);
writeFileSync(join(agent, 'big-b.bin'), '');
truncateSync(join(agent, 'big-b.bin'), 13 * 1024 * 1024);
const ENV = { isScheduledTask: false, cwd: agent, signaturesDir: join(root, 'no-signatures') };

// The shape of the send the gate carded on 11-18 and gws then refused: a credentials export, a formatted body, and a
// helper send with one `-a`, its output trimmed.
const send = (...attachments: string[]) => [
    'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/example-co.json',
    "BODY=$(cat <<'EOF'",
    FORMATTED_WRAPPER,
    '<p>Hi Dana, Ray,</p>',
    '<ul>',
    '<li>The comparisons. Confirm or swap each one.</li>',
    '</ul>',
    '</div>',
    'EOF',
    ')',
    `gws gmail +send --to "dana@example.org,ray@example.org" --cc "lee@example.com" --subject "Spring budget: comparisons to confirm" --body "$BODY" --html ${attachments.map(a => `-a "${a}"`).join(' ')} --format json 2>&1 | tail -8`,
].join('\n');
const refusal = (...attachments: string[]) => evaluateEmailSend(send(...attachments), ENV).deny;

describe('evaluateEmailSend — an attachment gws would refuse is refused before any card', () => {
    test('the 11-18 send, attaching a file outside the directory the command runs in, is refused with how to fix it', () => {
        const v = evaluateEmailSend(send(join(shared, SHEET)), ENV);
        expect(v.action).toBe('gate');
        expect(v.deny).toContain('outside that directory');
        expect(v.deny).toContain(`(\`${agent}\`)`);
        expect(v.deny).toContain(`mkdir -p send && cp '${join(shared, SHEET)}' send/`);
        expect([v.pureSend, v.fullSummary]).toEqual([undefined, undefined]);
    });

    test('each file gws refuses is refused, naming why', () => {
        const big = join(agent, 'big-a.bin');
        for (const [attachments, why] of [
            [['../workgroup/artifacts/spring-budget/' + SHEET], 'outside that directory'],
            [['linked.xlsx'], `resolves to \`${join(shared, SHEET)}\`, outside that directory`],
            [['missing.xlsx'], 'it does not exist'],
            [['missing/../send/' + SHEET], 'it does not exist'],
            [['up/x.txt'], 'it does not exist'],
            [['folder'], 'it is not a regular file'],
            [['empty.txt'], 'it is empty'],
            [[`send/${SHEET}`, join(shared, SHEET)], `\`${join(shared, SHEET)}\``],
            [[big, join(agent, 'big-b.bin')], 'more than 25 MiB'],
            [['send/report‮.xlsx'], 'direction-changing character'],
        ] as Array<[string[], string]>) {
            expect([attachments, refusal(...attachments)?.includes(why)]).toEqual([attachments, true]);
        }
    });

    test('a file only root could read is refused when the hook cannot read it either', () => {
        const unreadable = process.getuid?.() !== 0;
        expect(refusal('locked.txt')?.includes('it cannot be read') ?? false).toBe(unreadable);
    });

    test('files gws attaches, or a send whose working directory is unknown, still get their card', () => {
        for (const attachments of [[`send/${SHEET}`], [join(agent, 'send', SHEET)], ['linked-inside.xlsx'], [join(agent, 'big-a.bin')],
            // gws resolves `..` after a symlink from where the link points.
            ['up/../x.txt']]) {
            expect([attachments, refusal(...attachments)]).toEqual([attachments, undefined]);
        }
        // From a symlinked cwd, `..` climbs from the directory the link points to, which has another parent.
        const viaLinkedCwd = evaluateEmailSend(send('../cwd-target/f.txt'), { ...ENV, cwd: join(root, 'cwd-link') });
        expect(viaLinkedCwd.deny).toBeUndefined();
        for (const cwd of [undefined, 'relative/dir', join(root, 'gone')]) {
            const v = evaluateEmailSend(send(join(shared, SHEET)), { ...ENV, cwd });
            expect([cwd, v.action, v.deny]).toEqual([cwd, 'gate', undefined]);
        }
    });

    test('a scheduled task, which sends without a card, is not refused here', () => {
        expect(evaluateEmailSend(send(join(shared, SHEET)), { ...ENV, isScheduledTask: true })).toEqual({ action: 'allow' });
    });
});
