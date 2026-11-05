import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateEmailSend, FORMATTED_WRAPPER, SEND_ALONE } from './email-gate-core';

const root = mkdtempSync(join(tmpdir(), 'gws-'));
const signatures = join(root, 'email-signatures');
const accounts = join(root, 'accounts');
mkdirSync(signatures);
mkdirSync(accounts);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SIGNATURE = '<div dir="ltr"><b>Pat Doe</b><br><img src="https://example.com/logo.png" width="96"></div>';
writeFileSync(join(signatures, 'example-co.signature.html'), `${SIGNATURE}\n`);
const ENV = { isScheduledTask: false, signaturesDir: signatures };
const CREDS = 'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/example-co.json';
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
        ]) {
            const html = formatted(paragraph);
            expect(outcome(html)).toEqual([html, 'gate', false, false]);
        }
        const plain = `${CREDS}\nBODY='Done.\n\`\`\`'\ngws gmail +send --to pat@example.com --subject Hi --body "$BODY"`;
        expect(evaluateEmailSend(plain, ENV).pureSend).toBeUndefined();
        const subject = (s: string) => command(formatted('<p>Hi Pat,</p>')).replace('--subject Hi', `--subject "${s}"`);
        expect(evaluateEmailSend(subject('*Urgent* wire'), ENV).pureSend).toBeUndefined();
        expect(evaluateEmailSend(subject('Q3 plan'), ENV).pureSend).toBe(true);
    });

    test("the account's signature exactly as the host keeps it is allowed after the wrapper, and named on the card", () => {
        const v = evaluateEmailSend(command(`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`), ENV);
        expect([v.pureSend, v.summary?.split('\n').at(-1)]).toEqual([true, "Signature: example-co's Gmail signature, as the host keeps it on file"]);
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
        expect([v.deny, v.summary?.split('\n')[0]]).toEqual([undefined, 'From: pat@example.com']);
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
