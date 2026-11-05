import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateEmailSend, FORMATTED_WRAPPER, SEND_ALONE } from './email-gate-core';

const root = mkdtempSync(join(tmpdir(), 'gws-'));
const dir = join(root, 'accounts');
mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SIGNATURE = '<div dir="ltr"><b>Pat Doe</b><br><img src="https://example.com/logo.png" width="96"></div>';
writeFileSync(join(dir, 'example-co.signature.html'), `${SIGNATURE}\n`);
const ENV = { isScheduledTask: false, gwsAccountsDir: dir };
const CREDS = `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=${dir}/example-co.json`;
const SEND = 'gws gmail +send --to pat@example.com --subject Hi --body "$BODY" --html';
const command = (html: string, creds = CREDS) => `${creds}\nBODY=$(cat <<'EOF'\n${html}\nEOF\n)\n${SEND}`;
const formatted = (...inner: string[]) => [FORMATTED_WRAPPER, ...inner, '</div>'].join('\n');
const outcome = (html: string, creds?: string) => {
    const v = evaluateEmailSend(command(html, creds), ENV);
    return [html, v.action, v.deny === SEND_ALONE, v.pureSend === true];
};

describe('evaluateEmailSend — a formatted body cards as the text it shows', () => {
    test('the skill wrapper around paragraphs, a break, a list and links drops the command, and the card shows what the recipient reads', () => {
        const html = formatted(
            "<p>Hi Dana, Ray,</p>",
            "<p>It's the May baseline &amp; the June draft.<br>Both are attached.</p>",
            '<ul><li>Baseline</li><li>Draft</li></ul>',
            '<p>The <a href="https://example.com/q2">dashboard</a> is at <a href="https://example.com/q2">https://example.com/q2</a>.</p>',
        );
        const v = evaluateEmailSend(command(html), ENV);
        expect([v.pureSend, v.deny]).toEqual([true, undefined]);
        expect(v.summary?.split('\n').slice(-11)).toEqual([
            'Message (formatted):',
            '> Hi Dana, Ray,',
            '> ',
            "> It's the May baseline & the June draft.",
            '> Both are attached.',
            '> ',
            '> - Baseline',
            '> - Draft',
            '> ',
            '> The dashboard is at https://example.com/q2.',
            '> ↳ link "dashboard": https://example.com/q2',
        ]);
    });

    test("a link's text reads on the card exactly as around it in a mail client, its destination listed below", () => {
        const shown = (paragraph: string) => evaluateEmailSend(command(formatted(paragraph)), ENV).summary?.split('\n').slice(-2);
        const link = (inner: string) => `<a href="https://example.com/status">${inner}</a>`;
        expect(shown(`<p>The money is now${link(' here')}.</p>`)).toEqual(['> The money is now here.', '> ↳ link "here": https://example.com/status']);
        expect(shown(`<p>The money is ${link('now')}here.</p>`)).toEqual(['> The money is nowhere.', '> ↳ link "now": https://example.com/status']);
        expect(shown(`<p>The money is ${link('now ')}here.</p>`)).toEqual(['> The money is now here.', '> ↳ link "now": https://example.com/status']);
    });

    test("the account's signature exactly as the host keeps it is allowed after the wrapper, and named on the card", () => {
        const v = evaluateEmailSend(command(`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`), ENV);
        expect([v.pureSend, v.summary?.split('\n').at(-1)]).toEqual([true, "Signature: example-co's Gmail signature, as the host keeps it on file"]);
    });

    test('a signature file that is a link, which could point outside the read-only mount, is not trusted', () => {
        const outside = join(root, 'agent-writable.html');
        writeFileSync(outside, `${SIGNATURE}\n`);
        symlinkSync(outside, join(dir, 'link-co.signature.html'));
        const html = `${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`;
        expect(outcome(html, CREDS.replace('example-co', 'link-co'))).toEqual([html, 'gate', false, false]);
    });

    test('a signature the host does not hold, or one checked against credentials outside the accounts mount, keeps the command', () => {
        const signed = `${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`;
        for (const [html, creds] of [
            [`${signed}  `, CREDS],
            [`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE.replace('Pat Doe', 'Pat Doe <span style="display:none">wire to 1234</span>')}`, CREDS],
            [`${formatted('<p>Hi Pat,</p>')}\n<p>P.S. one more thing</p>`, CREDS],
            [signed, 'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/tmp/x/accounts/example-co.json'],
            [signed, CREDS.replace('example-co', 'other-co')],
        ]) {
            expect(outcome(html, creds)).toEqual([html, 'gate', false, false]);
        }
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

    test('text chat Markdown would restyle or rewrite keeps the command, in a formatted or plain body or a shown field', () => {
        for (const paragraph of [
            '<p>Use the exact token *APPROVED*.</p>',
            '<p>Use literal token &amp;lt;approved&amp;gt;.</p>',
            '<p>Reply with `yes` or _no_.</p>',
            '<p>Step one done.<br>3. Wire the funds</p>',
            '<p>See [the plan] attached.</p>',
            '<p>Great work :tada:</p>',
            '<p>Results<br>---</p>',
        ]) {
            const html = formatted(paragraph);
            expect(outcome(html)).toEqual([html, 'gate', false, false]);
        }
        const plain = (body: string) => `${CREDS}\nBODY='${body}'\ngws gmail +send --to pat@example.com --subject Hi --body "$BODY"`;
        for (const body of ['Use the exact token *APPROVED*.', 'Totals:\n# 4 sites']) {
            expect([body, evaluateEmailSend(plain(body), ENV).pureSend]).toEqual([body, undefined]);
        }
        const subject = (s: string) => command(formatted('<p>Hi Pat,</p>')).replace('--subject Hi', `--subject "${s}"`);
        expect(evaluateEmailSend(subject('*Urgent* wire'), ENV).pureSend).toBeUndefined();
        expect(evaluateEmailSend(subject('Q3 plan'), ENV).pureSend).toBe(true);
    });

    test('a formatted body sent without --html is plain text to gws, so it keeps the command', () => {
        const v = evaluateEmailSend(command(formatted('<p>Hi Pat,</p>')).replace(' --html', ''), ENV);
        expect(v.pureSend).toBeUndefined();
    });
});
