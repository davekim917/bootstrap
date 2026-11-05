import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
        expect(v.summary?.split('\n').slice(-10)).toEqual([
            'Message (formatted):',
            '> Hi Dana, Ray,',
            '> ',
            "> It's the May baseline & the June draft.",
            '> Both are attached.',
            '> ',
            '> - Baseline',
            '> - Draft',
            '> ',
            '> The dashboard (https://example.com/q2) is at https://example.com/q2.',
        ]);
    });

    test("a link's edge spaces still separate the words around it on the card, as in a mail client", () => {
        const v = evaluateEmailSend(command(formatted('<p>The money is now<a href="https://example.com/status"> here</a>.</p>')), ENV);
        expect([v.pureSend, v.summary?.split('\n').at(-1)]).toEqual([true, '> The money is now here (https://example.com/status).']);
    });

    test("the account's signature exactly as the host keeps it is allowed after the wrapper, and named on the card", () => {
        const v = evaluateEmailSend(command(`${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`), ENV);
        expect([v.pureSend, v.summary?.split('\n').at(-1)]).toEqual([true, "Signature: example-co's Gmail signature, as the host keeps it on file"]);
    });

    test('a signature the host does not hold, or one checked against credentials outside the accounts mount, keeps the command', () => {
        const signed = `${formatted('<p>Hi Pat,</p>')}\n${SIGNATURE}`;
        for (const [html, creds] of [
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
