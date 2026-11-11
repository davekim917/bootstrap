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
        ['a substitution in a subscript holding a nested subscript', 'echo ${a[b[0]+$(shred /tmp/report.txt)]}'],
        ['a substitution in a subscript after a quoted ]', 'echo ${a["]"$(shred /tmp/report.txt)]}'],
        ['a process substitution spanning lines that holds a literal <<', "cat <(echo '<<'\nshred /tmp/report.txt)"],
        ['a substitution in a subscript expansion', 'echo ${a[$(shred /tmp/report.txt)]}'],
        ['a process substitution spanning lines', 'cat <(echo a\nshred /tmp/report.txt)'],
        ['a loop fed by a process substitution spanning lines', 'while read -r l; do echo "$l"; done < <(\n  shred /tmp/report.txt\n)'],
        ['a single-quoted $( in a word spanning lines', `echo '$(\n'"$(shred /tmp/report.txt)"')'`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('block');
    });
});

describe('a heredoc or comment inside $( ) is read as bash reads it', () => {
    test.each([
        ['an apostrophe in a quoted body', "DECISION=$(python3 - <<'PY'\n# it's fine\nprint('ok')\nPY\n)\necho $DECISION"],
        ['the same body without one', "DECISION=$(python3 - <<'PY'\n# its fine\nprint('ok')\nPY\n)\necho $DECISION"],
        ['the same heredoc outside $( )', "python3 - <<'PY'\n# it's fine\nprint('ok')\nPY"],
        ['an apostrophe in a commit message', `git commit -m "$(cat <<'EOF'\nfix: it's done\nEOF\n)"`],
        ['a ) and a literal $( ) in a quoted body', `x=$(cat <<'EOF'\n) $(shred /tmp/report.txt)\nEOF\n)\necho "$x"`],
        ['a ) in a tab-stripped body', `x=$(cat <<-EOF\n\t)it's\n\tEOF\n)\necho "$x"`],
        ['a substitution in double quotes before the heredoc', `x=$(echo "$(date)"; cat <<'EOF'\nit's\nEOF\n)\necho "$x"`],
        ['an apostrophe in a comment', `x=$(echo two # it's )\n)\necho "$x"`],
        ['a heredoc in a case arm', `x=$(case y in y) cat <<'E'\nit's)\nE\n;; esac)\necho "$x"`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });

    const shredAlone = evaluateBashCommand('shred /tmp/report.txt', { cwd: '/tmp' });
    test.each([
        ['a command after the substitution', `git commit -m "$(cat <<'EOF'\nit's done\nEOF\n)" && shred /tmp/report.txt`],
        ['a substitution in an unquoted body', `x=$(cat <<EOF\n) it's $(shred /tmp/report.txt)\nEOF\n)\necho "$x"`],
        ['a command after a body whose ) and apostrophe would hide it', `x=$(cat <<-EOF\n\t)it's\n\tEOF\n)\nshred /tmp/report.txt`],
        ["a command after a comment's ) and a $'…' string", `x=$(echo hi # )\necho $'\\'#)'; shred /tmp/report.txt\n)`],
        ["a command after a comment's ) inside an unquoted body", `x=$(cat <<EOF\n$(echo hi # )\nshred /tmp/report.txt\n)\nEOF\n)`],
        ['a case arm inside an unquoted body', `x=$(cat <<EOF\n$(case y in y) shred /tmp/report.txt;; esac)\nEOF\n)`],
    ])('%s is checked as the command it is', (_name, command) => {
        const result = evaluateBashCommand(command, { cwd: '/tmp' });
        expect(shredAlone.action).toBe('block');
        expect(result).toEqual(shredAlone);
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
        ['arithmetic continued across lines', 'echo $(( 1 + \\\n  2 ))'],
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
