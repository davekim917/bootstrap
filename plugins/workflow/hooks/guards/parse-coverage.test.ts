import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

// bash runs every part of a line; a parse that silently stops partway leaves the rest unchecked. Expected verdicts
// were checked against bash 5.2.

const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/tmp' }).action;

describe('a line the parser stops reading partway through blocks', () => {
    test.each([
        ['a line continuation after $', 'ls $\\\n((1)); shred /tmp/report.txt'],
        ['a line continuation after <', 'cat <\\\n(true); shred /tmp/report.txt'],
        ['the same stop inside a command substitution', 'echo "$(ls $\\\n((1)); shred /tmp/report.txt)"'],
        ['the same stop inside a process substitution', 'cat <(ls $\\\n((1)); shred /tmp/report.txt)'],
        ['the same stop inside backticks', 'echo `ls $\\\n((1)); shred /tmp/report.txt`'],
        ['a line continuation after $ inside double quotes', 'echo "$\\\n(shred /tmp/report.txt)"'],
        ['a line continuation after $ in a heredoc body', 'cat <<EOF\n$\\\n(shred /tmp/report.txt)\nEOF'],
        ['a $(( whose first paren closes early', 'echo $((true); shred /tmp/report.txt)'],
        ['a (( whose first paren closes early', '((true); shred /tmp/report.txt)'],
        ['a # joined to a word by a line continuation', 'cat <(true)\\\n#x; shred /tmp/report.txt'],
        ['the same stop in a case arm another arm follows', 'case x in x) ls $\\\n((1)); shred /tmp/report.txt;; y) true;; esac'],
        ['a $(( whose first paren closes early in a heredoc body', 'cat <<EOF\n$((true); shred /tmp/report.txt)\nEOF'],
        ['a (( whose first paren closes early inside backticks with a backslash', 'echo `echo \\\\x; ((true); shred /tmp/report.txt)`'],
        ['a # joined by a line continuation inside backticks', 'echo `cat <(true)\\\n#x; shred /tmp/report.txt`'],
        ['arithmetic the parser ends early', 'echo $(( ($(date +%s) - $(stat -c %Y "/tmp/f")) / 3600 )); shred /tmp/report.txt'],
        ['a substitution in an array subscript', 'a[$(shred /tmp/report.txt)]=1'],
        ['a substitution in a subscript expansion', 'echo ${a[$(shred /tmp/report.txt)]}'],
        ['a process substitution spanning lines', 'cat <(echo a\nshred /tmp/report.txt)'],
        ['a loop fed by a process substitution spanning lines', 'while read -r l; do echo "$l"; done < <(\n  shred /tmp/report.txt\n)'],
        ['a single-quoted $( in a word spanning lines', `echo '$(\n'"$(shred /tmp/report.txt)"')'`],
        ["an apostrophe in a heredoc inside $( ), which the parser reads past", `git commit -m "$(cat <<'EOF'\nit's done\nEOF\n)" && shred /tmp/report.txt`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('block');
    });

    test('the refusal of a heredoc inside $( ) names the stdin form that reads whole', () => {
        const reason = evaluateBashCommand(`git commit -m "$(cat <<'EOF'\nit's done\nEOF\n)"`, { cwd: '/tmp' }).reason ?? '';
        expect(reason).toContain('git commit -F - <<');
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
        ['arithmetic with inner parens', 'echo $(( (1) + 2 )) $(((1+2)*3)); (( n = 1 << 3 )); echo "$n"'],
        ['backticks', 'echo `date +%s`'],
        ['a # after a line continuation that follows a blank', 'ls /tmp \\\n# note\necho done'],
        ['a heredoc whose line is continued', 'cat <<EOF \\\n  | grep n\nnotes\nEOF\necho done'],
        ['a heredoc inside $( ) for a commit message', `git commit -m "$(cat <<'EOF'\nfix: the guard reads the whole line\nEOF\n)"`],
        ['a comment after a background job', 'sleep 1 &# wait\necho done'],
        ['a backtick substitution with an escaped $', 'echo `echo \\$HOME; ls /tmp`'],
        ['a pipeline into a while loop', "ls /tmp | while IFS=$'\\t' read -r f; do echo \"$f\"; done"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });
});
