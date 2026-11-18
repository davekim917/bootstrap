import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateEmailSend, evaluateEmailToolCall, FORMATTED_WRAPPER, SEND_ALONE } from './email-gate-core';

const root = mkdtempSync(join(tmpdir(), 'gws-'));
const signatures = join(root, 'email-signatures');
const accounts = join(root, 'accounts');
mkdirSync(signatures);
mkdirSync(accounts);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SIGNATURE = '<div dir="ltr"><b>Pat Doe</b><br><img src="https://example.com/logo.png" width="96"></div>';
writeFileSync(join(signatures, 'example-co.signature.html'), `${SIGNATURE}\n`);
// Every account here has a confirmed sender, so each case below keeps or drops the command for the reason it names.
const identities: Record<string, { account: string; mailbox: string }> = {};
for (const [account, mailbox] of [
    ['example-co', 'team@example.com'],
    ['link-co', 'link@example.com'],
    ['beside-co', 'beside@example.com'],
    ['other-co', 'other@example.com'],
    ['pat@example.com', 'pat@example.com'],
]) {
    const bytes = `{"refresh_token":"${account}"}`;
    writeFileSync(join(accounts, `${account}.json`), bytes);
    identities[createHash('sha256').update(bytes).digest('hex')] = { account, mailbox };
}
writeFileSync(join(signatures, 'identities.json'), JSON.stringify(identities));
const ENV = { isScheduledTask: false, signaturesDir: signatures };
const CREDS = `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${accounts}/example-co.json`;
const SEND = 'gws gmail +send --to pat@example.com --subject Hi --body "$BODY" --html';
const command = (html: string, creds = CREDS) => `${creds}\nBODY=$(cat <<'EOF'\n${html}\nEOF\n)\n${SEND}`;
const formatted = (...inner: string[]) => [FORMATTED_WRAPPER, ...inner, '</div>'].join('\n');
const outcome = (html: string, creds?: string) => {
    const v = evaluateEmailSend(command(html, creds), ENV);
    return [html, v.action, v.deny === SEND_ALONE, v.pureSend === true];
};
const messageLines = (summary: string | undefined) => {
    const lines = summary?.split('\n') ?? [];
    return lines.slice(lines.findIndex(l => l.startsWith('Message')));
};

describe('evaluateEmailSend — a formatted body cards as the text it shows', () => {
    test('the skill wrapper around paragraphs, a break, a list and links drops the command, and the card shows what the recipient reads in a code block', () => {
        const html = formatted(
            "<p>Hi Dana, Ray,</p>",
            "<p>It's the May baseline &amp; the June draft.<br>Both are attached.</p>",
            '<ul><li>Baseline</li><li>Draft</li></ul>',
            '<p>The <a href="https://example.com/q2">dashboard</a> is at <a href="https://example.com/q2">https://example.com/q2</a>.</p>',
        );
        const v = evaluateEmailSend(command(html), ENV);
        expect([v.pureSend, v.deny]).toEqual([true, undefined]);
        expect(messageLines(v.summary)).toEqual([
            'Message (formatted):',
            '```',
            'Hi Dana, Ray,',
            '',
            "It's the May baseline & the June draft.",
            'Both are attached.',
            '',
            '- Baseline',
            '- Draft',
            '',
            'The dashboard is at https://example.com/q2.',
            '↳ link "dashboard": https://example.com/q2',
            '```',
        ]);
    });

    test("a link's text reads on the card exactly as around it in a mail client, its destination listed below", () => {
        const shown = (paragraph: string) => messageLines(evaluateEmailSend(command(formatted(paragraph)), ENV).summary).slice(2, 4);
        const link = (inner: string) => `<a href="https://example.com/status">${inner}</a>`;
        expect(shown(`<p>The money is now${link(' here')}.</p>`)).toEqual(['The money is now here.', '↳ link "here": https://example.com/status']);
        expect(shown(`<p>The money is ${link('now')}here.</p>`)).toEqual(['The money is nowhere.', '↳ link "now": https://example.com/status']);
        expect(shown(`<p>The money is ${link('now ')}here.</p>`)).toEqual(['The money is now here.', '↳ link "now": https://example.com/status']);
    });

    test('text chat Markdown would restyle is shown literally in the code block, so it still drops the command', () => {
        for (const [paragraph, line] of [
            ['<p>Use the exact token *APPROVED*.</p>', 'Use the exact token *APPROVED*.'],
            ['<p>- 100 dollars</p>', '- 100 dollars'],
            ['<p>Step one done.<br>3. Wire the funds</p>', '3. Wire the funds'],
            ['<p>&gt; 100 dollars</p>', '> 100 dollars'],
        ]) {
            const v = evaluateEmailSend(command(formatted(paragraph)), ENV);
            expect([paragraph, v.pureSend, messageLines(v.summary).includes(line)]).toEqual([paragraph, true, true]);
        }
        const plain = `${CREDS}\nBODY='Totals:\n# 4 sites'\ngws gmail +send --to pat@example.com --subject Hi --body "$BODY"`;
        expect(evaluateEmailSend(plain, ENV).pureSend).toBe(true);
    });

    test('a body line that would end the code block, entity-like text, or a field chat Markdown would restyle keeps the command', () => {
        for (const paragraph of [
            '<p>Done.<br>```</p>',
            '<p>Done.<br>~~~ end</p>',
            '<p>Use literal token &amp;lt;approved&amp;gt;.</p>',
            '<p>Authorized ```<br>~do not transfer~<br>Transfer 100000</p>',
            '<p>Use token {{emoji:check}} as written</p>',
            '<p>Use token {{EMOJI:check}} as written</p>',
        ]) {
            const html = formatted(paragraph);
            expect(outcome(html)).toEqual([html, 'gate', false, false]);
        }
        const plain = `${CREDS}\nBODY='Done.\n\`\`\`'\ngws gmail +send --to pat@example.com --subject Hi --body "$BODY"`;
        expect(evaluateEmailSend(plain, ENV).pureSend).toBeUndefined();
        const subject = (s: string) => command(formatted('<p>Hi Pat,</p>')).replace('--subject Hi', `--subject "${s}"`);
        expect(evaluateEmailSend(subject('*Urgent* wire'), ENV).pureSend).toBeUndefined();
        for (const s of ['@everyone', 'Hi @here', 'see #general']) expect([s, evaluateEmailSend(subject(s), ENV).pureSend]).toEqual([s, undefined]);
        expect(evaluateEmailSend(subject('Q3 plan for pat@example.com'), ENV).pureSend).toBe(true);
        const attached = (file: string) => command(formatted('<p>Hi Pat,</p>')).replace(' --html', ` --html -a '${file}'`);
        for (const file of ['/workspace/{{Emoji:check}}.xlsx', '/workspace/invoice‮fdp.exe']) {
            expect([file, evaluateEmailSend(attached(file), ENV).pureSend]).toEqual([file, undefined]);
        }
        expect(evaluateEmailSend(subject('Q3 ⁦plan'), ENV).pureSend).toBeUndefined();
        expect(evaluateEmailSend(subject('Q3 plan'), ENV).pureSend).toBe(true);
    });

    test("the account's signature exactly as the host keeps it is allowed after the wrapper, and named on the card", () => {
        const v = evaluateEmailSend(command(`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`), ENV);
        expect([v.pureSend, v.summary?.split('\n').at(-1)]).toEqual([true, "Signature: team@example.com's Gmail signature, as the host keeps it on file"]);
    });

    test('only the trusted signatures directory counts: a link there, or a copy beside the credentials, is not trusted', () => {
        const outside = join(root, 'agent-writable.html');
        writeFileSync(outside, `${SIGNATURE}\n`);
        symlinkSync(outside, join(signatures, 'link-co.signature.html'));
        writeFileSync(join(accounts, 'beside-co.signature.html'), `${SIGNATURE}\n`);
        const html = `${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`;
        expect(outcome(html, CREDS.replace('example-co', 'link-co'))).toEqual([html, 'gate', false, false]);
        expect(outcome(html, `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${accounts}/beside-co.json`)).toEqual([html, 'gate', false, false]);
    });

    test('a signature the host does not hold for that account keeps the command', () => {
        const signed = `${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`;
        for (const [html, creds] of [
            [`${signed}  `, CREDS],
            [`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE.replace('Pat Doe', 'Pat Doe <span style="display:none">wire to 1234</span>')}`, CREDS],
            [`${formatted('<p>Hi Pat,</p>')}\n<p>P.S. one more thing</p>`, CREDS],
            [signed, CREDS.replace('example-co', 'other-co')],
        ]) {
            expect(outcome(html, creds)).toEqual([html, 'gate', false, false]);
        }
    });

    test('an email-style account name reads its credentials, so the send is not refused', () => {
        const v = evaluateEmailSend(command(formatted('<p>Hi Pat,</p>'), CREDS.replace('example-co', 'pat@example.com')), ENV);
        expect([v.deny, v.pureSend, v.summary?.split('\n')[0]]).toEqual([undefined, true, 'From: pat@example.com']);
    });

    test("a renamed copy of an account's credentials cards as that account, and its signature is that account's", () => {
        writeFileSync(join(accounts, 'renamed.json'), '{"refresh_token":"example-co"}');
        writeFileSync(join(signatures, 'renamed.signature.html'), '<b>Someone else</b>\n');
        const renamed = CREDS.replace('example-co', 'renamed');
        const signed = (signature: string) => command(`${formatted('<p>Hi Pat,</p>')}\n${signature}`, renamed);

        const v = evaluateEmailSend(signed(SIGNATURE), ENV);
        expect([v.pureSend, v.summary?.split('\n')[0], v.summary?.split('\n').at(-1)]).toEqual([
            true,
            'From: team@example.com',
            "Signature: team@example.com's Gmail signature, as the host keeps it on file",
        ]);
        expect(evaluateEmailSend(signed('<b>Someone else</b>'), ENV).pureSend).toBeUndefined();
    });

    test('any other markup, attribute, entity or style keeps the command on the card', () => {
        for (const html of [
            '<p>Hi Pat,</p>',
            formatted('<p>Hi <b>Pat</b>,</p>'),
            formatted('<p>Hi <span style="display:none">wire</span>Pat,</p>'),
            formatted('<p style="color:#fff">Hi Pat,</p>'),
            formatted('<p>Hi&nbsp;Pat,</p>'),
            formatted('<p>Hi &#60;Pat,</p>'),
            formatted('<p>Hi Pat,<br/>there</p>'),
            formatted('<p>Hi Pat,'),
            formatted('<p></p>'),
            formatted('<p>Hi<br><br>Pat</p>'),
            formatted('<ul></ul>'),
            formatted('<ol><li>Approve</li></ol>'),
            formatted('<ul><li>a<br>b</li></ul>'),
            formatted('<p><a href="javascript:alert(1)">pay</a></p>'),
            formatted("<p><a href='https://example.com'>pay</a></p>"),
            formatted('<p><a href="https://example.com" title="x">pay</a></p>'),
            formatted('<p><a href="https://example.com?a=1&amp;b=2">pay</a></p>'),
            formatted('<p><a href="https://example.com"><a href="https://evil.example">pay</a></a></p>'),
            formatted('<p><a href="https://example.com"></a></p>'),
            formatted('<p>Hi ‮Pat</p>'),
            formatted('<p>Pay <a href="https://evil.example">here</a>.</p>\n<p>↳ link "here": https://bank.example</p>'),
            formatted('<style>p{display:none}</style><p>Hi Pat,</p>'),
            formatted('<p>Hi Pat,</p>') + '\n<p>after the wrapper</p>',
            FORMATTED_WRAPPER.replace('color:#222', 'color:#fff') + '\n<p>Hi Pat,</p>\n</div>',
            formatted('<p>Use <billing@example.com></p>'.replace('<billing', '&lt;billing')),
        ]) {
            expect(outcome(html)).toEqual([html, 'gate', false, false]);
        }
    });

    test('a formatted body sent without --html is plain text to gws, so it keeps the command', () => {
        const v = evaluateEmailSend(command(formatted('<p>Hi Pat,</p>')).replace(' --html', ''), ENV);
        expect(v.pureSend).toBeUndefined();
    });
});

describe('evaluateEmailSend — a whole formatted email too long for the summary', () => {
    // The 11-18 shape: two recipients, a Cc, an attachment, a formatted body with a list, the output trimmed. The body
    // is longer than the summary beside the command has room for.
    const SHEET = join(root, 'Spring budget - comparisons to confirm.xlsx');
    writeFileSync(SHEET, 'sheet');
    symlinkSync(SHEET, join(root, 'renamed.xlsx'));
    const LONG = 'Before we share the spring view, we would like your input on the items below. '.repeat(9).trim();
    const ITEM = 'The attached sheet lists each new item, the comparison we would use, and why. '.repeat(4).trim();
    const body = (...extra: string[]) => formatted('<p>Hi Dana, Ray,</p>', `<p>${LONG}</p>`, '<ul>', `<li>${ITEM}</li>`, `<li>Anything else. ${ITEM}</li>`, '</ul>', ...extra, '<p>Partial answers help too.</p>');
    const sendLine = (tail = '') => `gws gmail +send --to "dana@example.org,ray@example.org" --cc "lee@example.com" --subject "Spring budget: comparisons to confirm" --body "$BODY" --html -a "${SHEET}"${tail} --format json 2>&1 | tail -8`;
    const longSend = (html = body(), line = sendLine()) => `${CREDS}\nBODY=$(cat <<'EOF'\n${html}\nEOF\n)\n${line}`;

    test('the 11-18 shape carries the whole email for a card without the command: every field, the attachment and the full list', () => {
        const v = evaluateEmailSend(longSend(), ENV);
        expect([v.action, v.deny, v.pureSend]).toEqual(['gate', undefined, undefined]);
        expect(v.summary!.length).toBeLessThanOrEqual(1300);
        const whole = ['Hi Dana, Ray,', '', LONG, '', `- ${ITEM}`, `- Anything else. ${ITEM}`, '', 'Partial answers help too.'].join('\n');
        expect(v.summary).toMatch(new RegExp(`\nBody cut: showing [0-9,]+ of ${whole.length.toLocaleString('en-US')} characters\\.\nMessage \\(formatted\\):\n`));
        expect(v.wholeEmail!.endsWith(`\n\nMessage source, exactly as sent:\n${body()}`)).toBe(true);
        expect(v.wholeEmail!.split('\nMessage, as the recipient reads it:\n')[1].split('\n\nMessage source')[0]).toBe(whole);
        expect(v.fullSummary).toBe([
            'From: team@example.com',
            'To: dana@example.org,ray@example.org',
            'Cc: lee@example.com',
            'Subject: Spring budget: comparisons to confirm',
            `Attachments: \`${SHEET}\``,
            '',
            'Message (formatted):',
            '```',
            'Hi Dana, Ray,',
            '',
            LONG,
            '',
            `- ${ITEM}`,
            `- Anything else. ${ITEM}`,
            '',
            'Partial answers help too.',
            '```',
        ].join('\n'));
    });

    test('a near miss keeps the command: another step, markup the card cannot render, an attachment it does not list, or too long', () => {
        for (const [name, command] of [
            ['a second command', `${longSend()}\necho sent`],
            ['bold text', longSend(body('<p>Reply by <b>Friday</b>.</p>'))],
            ['a numbered list', longSend(body('<ol><li>First</li></ol>'))],
            ['a second attachment as --attach=', longSend(body(), sendLine(' --attach=/workspace/agent/send/notes.pdf'))],
            ['an unconfirmed sender', longSend().replace('example-co.json', 'unknown-co.json')],
            ['an attachment gws sends under another name', longSend().replace(SHEET, join(root, 'renamed.xlsx'))],
            ['more than any card holds', longSend(body(`<p>${LONG.repeat(3)}</p>`))],
        ]) {
            const v = evaluateEmailSend(command, ENV);
            expect([name, v.action, v.pureSend, v.fullSummary]).toEqual([name, 'gate', undefined, undefined]);
        }
    });
});

describe('a body cut to fit the card says so, with how much it shows', () => {
    // 22 characters a sentence, 200 sentences, the last space trimmed: 4,399 characters.
    const TEXT = 'Thanks for the notes. '.repeat(200).trim();
    const cutOf = (summary: string | undefined) => {
        const lines = summary?.split('\n') ?? [];
        const at = lines.findIndex(l => l.startsWith('Body cut: '));
        return { note: lines[at], header: lines[at + 1] };
    };

    test('a Bash send names how many characters of the body it shows, and they are its start', () => {
        const v = evaluateEmailSend(`${CREDS}\ngws gmail +send --to pat@example.com --subject Notes --body '${TEXT}'`, ENV);
        expect(v.summary!.length).toBeLessThanOrEqual(1300);
        const { note, header } = cutOf(v.summary);
        const shown = Number(/^Body cut: showing ([0-9,]+) of 4,399 characters\.$/.exec(note)?.[1].replace(/,/g, ''));
        expect(header).toBe('Message:');
        const block = v.summary!.split('Message:\n```\n')[1].split('\n```')[0];
        expect(block).toBe(`${TEXT.slice(0, shown)}…`);
        expect(shown).toBeGreaterThan(500);
        expect(v.wholeEmail).toBe(['From: team@example.com', 'To: pat@example.com', 'Subject: Notes', '', 'Message, exactly as sent:', TEXT].join('\n'));
    });

    test('a native email tool names it the same way', () => {
        const v = evaluateEmailToolCall('gmail_send_email', { to: 'pat@example.com', subject: 'Notes', body: TEXT }, ENV);
        const { note, header } = cutOf(v.summary);
        expect(note).toMatch(/^Body cut: showing [0-9,]+ of 4,399 characters\.$/);
        expect(header).toBe('Message:');
        expect(v.wholeEmail).toBe(['Tool: gmail_send_email', 'To: pat@example.com', 'Subject: Notes', '', 'Message, exactly as sent:', TEXT].join('\n'));
    });

    test('a body that fits says nothing about a cut', () => {
        const v = evaluateEmailSend(`${CREDS}\ngws gmail +send --to pat@example.com --subject Notes --body 'Thanks for the notes.'`, ENV);
        expect(v.summary).not.toContain('Body cut');
        expect(v.pureSend).toBe(true);
        expect(v.wholeEmail).toBeUndefined();
    });
});
