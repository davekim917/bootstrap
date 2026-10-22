import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

// Bash removes the quotes from a heredoc delimiter word, so E"O"F, 'E'OF and E\OF all end the body at a line reading
// EOF. Expected verdicts were checked against bash 5.2: what bash runs after the body is what the guard must see.

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

describe('a partly quoted delimiter ends the body where bash ends it', () => {
    test.each([
        ['double quotes inside the word', 'cat <<E"O"F\nnotes\nEOF\nshred /tmp/report.txt'],
        ['single quotes leading the word', "cat <<'E'OF\nnotes\nEOF\nshred /tmp/report.txt"],
        ['a backslash inside the word', 'cat <<E\\OF\nnotes\nEOF\nshred /tmp/report.txt'],
        ['double quotes leading the word', 'cat <<"E"OF\nnotes\nEOF\nshred /tmp/report.txt'],
        ['the tab-stripping form', 'cat <<-E"O"F\n\tnotes\n\tEOF\nshred /tmp/report.txt'],
        ['the second of two heredocs on one line', 'cat <<EOF <<E"O"F\none\nEOF\ntwo\nEOF\nshred /tmp/report.txt'],
        ['a quoted space in the word', 'cat <<E"O F"\nnotes\nEO F\nshred /tmp/report.txt'],
        ['a backslash kept inside double quotes', 'cat <<"E\\OF"\nnotes\nE\\OF\nshred /tmp/report.txt'],
        ['inside an if body', 'if true; then cat <<E"O"F\nnotes\nEOF\nshred /tmp/report.txt\nfi'],
        // In an unquoted body bash joins a line ending in a backslash to the next before comparing it with the delimiter.
        ['a body line continued into the delimiter', 'cat <<EOF\nE\\\nOF\nshred /tmp/report.txt\nEOF'],
        // unbash drops the redirects of a command with no name, or of a coproc, so these heredocs are not in its tree.
        ['a heredoc on a command with no name', '<<E"O"F\nnotes\nEOF\nshred /tmp/report.txt'],
        ['a nameless heredoc after a pipe', 'true | <<E"O"F\nnotes\nEOF\nshred /tmp/report.txt'],
        ['a heredoc on a coproc', 'coproc cat <<E"O"F\nnotes\nEOF\nshred /tmp/report.txt'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('block');
    });
});

describe('a line held as unreadable keeps its tier-1 blocks even on the approval replay', () => {
    // When parseShell can't read the line, the gate holds it; approving the hold re-runs with the gate skipped, so the
    // hard-block pass must still see the commands unbash did parse. These are blocked at the top, before any hold.
    test.each([
        ['a backtick heredoc body with a backslash, which forces the fallback parse', 'x=`cat <<EOF\na\\tb\nEOF\n`\nif true; then shred /tmp/report.txt; fi'],
        ['a compound command on such a line', '( shred /tmp/report.txt ) <<E"O"F\nx\nEOF'],
    ])('%s', (_name, command) => {
        expect(evaluateBashCommand(command, { cwd: '/tmp', skipGate: true }).action).toBe('block');
        expect(verdict(command)).toBe('block');
    });
});

describe('the guard reads the delimiter as bash does, not just more strictly', () => {
    test.each([
        // In double quotes bash keeps a backslash before O, so a line reading EOF does not end the body.
        ['"E\\OF" is not ended by EOF', 'cat <<"E\\OF"\nnotes\nEOF\nshred /tmp/report.txt'],
        // Any quoting turns expansion off in the body, so the substitution is text.
        ['a partly quoted delimiter leaves the body unexpanded', 'cat <<E"O"F\n$(shred /tmp/report.txt)\nEOF'],
        ['a plain command after the body passes', 'cat <<E"O"F\nnotes\nEOF\necho done'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('a delimiter the guard cannot read the way bash does holds', () => {
    test.each([
        ["ANSI-C quoting, which bash versions read differently", "cat <<$'E'\nnotes\nE\necho done"],
        ['a partly quoted delimiter inside a command substitution', 'echo "$(cat <<E"O"F\nnotes\nEOF\necho done\n)"'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });
});
