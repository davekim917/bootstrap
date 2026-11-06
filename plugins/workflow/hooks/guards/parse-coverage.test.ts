import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

// bash runs every part of a line; a parse that silently stops partway leaves the rest unchecked. Expected verdicts
// were checked against bash 5.2.

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

describe('a line the parser stops reading partway through blocks', () => {
    test.each([
        ['a line continuation after $', 'ls $\\\n((1)); shred /tmp/report.txt'],
        ['a line continuation after <', 'cat <\\\n(true); shred /tmp/report.txt'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('block');
    });
});

describe('ordinary multi-line lines still read whole', () => {
    test.each([
        ['a heredoc, then a command', 'cat <<EOF\nnotes\nEOF\necho done'],
        ['a heredoc with a redirect after it', 'cat <<EOF > /tmp/notes.txt\nnotes\nEOF\necho done'],
        ['two heredocs on one line', 'cat <<A <<B\none\nA\ntwo\nB\necho done'],
        ['the tab-stripping form', 'cat <<-EOF\n\tnotes\n\tEOF\necho done'],
        ['a heredoc whose line goes on past it', 'cat <<EOF; echo next\nnotes\nEOF\necho done'],
        ['a heredoc feeding a pipeline', 'cat <<EOF | grep n\nnotes\nEOF\necho done'],
        ['a heredoc inside a loop', 'for i in 1; do cat <<EOF\nnotes\nEOF\ndone; echo done'],
        ['an unquoted heredoc body that expands', 'cat >> /tmp/notes.md <<EOF\n- $(date -u +%H:%M) note (one, two)\nEOF\necho done'],
        ['a line continuation between commands', 'echo a; \\\necho b'],
        ['a heredoc inside a command substitution', 'x=$(cat <<EOF\nnotes\nEOF\n)\necho "$x"'],
        ['a heredoc the input ends inside', 'cat <<EOF\nnotes'],
        ['line continuations between arguments', 'grep -rn \\\n  --include=*.ts \\\n  needle /tmp/src'],
        ['comments on their own lines and after commands', '# list\nls /tmp # every file\necho done'],
        ['a redirected group joined to the next command', 'cd /tmp && { echo a; echo b; } > /tmp/out.txt && wc -l /tmp/out.txt'],
        ['a pipeline into a while loop', "ls /tmp | while IFS=$'\\t' read -r f; do echo \"$f\"; done"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });
});
