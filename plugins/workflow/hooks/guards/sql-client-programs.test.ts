import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

// A SQL client can run programs on this host: psql's \! and backquotes, mysql's system, sqlite3's .shell. The shell
// command each one runs is checked as if typed at the top; a program the guard can't read holds.

let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sql-client-programs-test-'));
    writeFileSync(join(dir, 'escape.sql'), 'select 1;\n\\! shred /tmp/report.txt\n');
    writeFileSync(join(dir, 'pipe.sql'), 'select 1 \\g | sh\n');
    writeFileSync(join(dir, 'escape-then-sql.sql'), '\\! echo start\ntruncate staging_orders;\n');
    mkdirSync(join(dir, 'db'));
    writeFileSync(join(dir, 'db', 'drop.sql'), 'drop table orders;\n');
    mkdirSync(join(dir, 'b'));
    // Only under b/, so a check of the base directory alone would miss it.
    writeFileSync(join(dir, 'b', 'only-in-b.sql'), '\\! shred /tmp/report.txt\n');
    writeFileSync(join(dir, 'cd-then-escape.sql'), '\\cd b\n\\! psql -f only-in-b.sql\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const verdict = (command: string) => evaluateBashCommand(command, { cwd: dir }).action;

describe('a blocked command a SQL client runs is blocked', () => {
    test.each([
        ['psql \\! in -c', "psql -d app_db -c '\\! shred /tmp/report.txt'"],
        ['psql \\! in a -f file', () => `psql -d app_db -f ${dir}/escape.sql`],
        ['psql \\! on piped stdin', "printf '%s\\n' '\\! shred /tmp/report.txt' | psql -d app_db"],
        ['psql \\! in a heredoc', "psql -d app_db <<'SQL'\nselect 1;\n\\! shred /tmp/report.txt\nSQL"],
        ['psql \\! past the first line of -c, which it reads whole', "psql -d app_db -c $'\\\\! echo start\\nshred /tmp/report.txt'"],
        ['psql backquotes in a backslash command', "psql -d app_db -c '\\echo `shred /tmp/report.txt`'"],
        ['psql \\! running rm on a kept path', "psql -d app_db -c '\\! rm -rf ~/projects'"],
        ['COPY … PROGRAM', `psql -d app_db -c "COPY orders FROM PROGRAM 'shred /tmp/report.txt'"`],
        ['mysql system', "mysql -e 'system shred /tmp/report.txt'"],
        ['mysql \\!', "mysql -e '\\! shred /tmp/report.txt'"],
        ['sqlite3 .shell', "sqlite3 app.db '.shell shred /tmp/report.txt'"],
        ['sqlite3 .system by a prefix of its name', "sqlite3 app.db '.sys shred /tmp/report.txt'"],
        ['a sqlite3 dot-command argument read whole across newlines', "sqlite3 app.db $'.shell echo hi;\\nshred /tmp/report.txt'"],
        ['mysql \\! with the first token glued, which mysql drops', "mysql -e '\\!x shred /tmp/report.txt'"],
        ['COPY … PROGRAM split by a SQL comment', `psql -d app_db -c "COPY orders FROM /*c*/ PROGRAM 'shred /tmp/report.txt'"`],
        ['a blocked command in the second of two candidate directories', () => `if true; then cd ${dir}/b; fi; psql -d app_db -c '\\! psql -f only-in-b.sql'`],
        ['psql \\copy … PROGRAM checked from the client\'s directory', () => `cd ${dir}/b && psql -d app_db -c "\\copy orders from program 'psql -f only-in-b.sql'"`],
        ['duckdb .system', "duckdb -c '.system shred /tmp/report.txt'"],
    ])('%s', (_name, command) => {
        expect(verdict(typeof command === 'function' ? command() : command)).toBe('block');
    });
});

describe('a program a SQL client runs that needs approval, or that the guard cannot read, holds', () => {
    test.each([
        ['psql \\! running destructive SQL elsewhere', `psql -d app_db -c '\\! psql -h db.example.internal -c "DROP TABLE orders"'`],
        ['psql \\! with no command, which reads a shell from stdin', "psql -d app_db -c '\\!'"],
        ['psql \\! running a relative SQL file from the directory the line moved to', () => `cd ${dir}/db && psql -d app_db -c '\\! psql -f drop.sql'`],
        ['psql backquotes naming a psql variable, whose value the line does not show', "psql -d app_db -v cmd=x -c '\\echo `:cmd`'"],
        ['psql backquotes naming a :\'quoted\' psql variable', `psql -d app_db -v a=-delete -c "\\echo \`find /tmp/x :'a'\`"`],
        ['psql \\o into a :variable, which may hold a pipe', "psql -d app_db -c '\\o :out'"],
        ['a psql \\cd before a shell escape, which moves where it starts', () => `psql -d app_db -f ${dir}/cd-then-escape.sql`],
        ['a sqlite3 .cd before a shell escape', "sqlite3 -cmd '.cd b' app.db '.shell psql -f only-in-b.sql'"],
        ['SQL after a psql \\\\ ends the backslash command on the same line', "printf '%s' '\\x \\\\ drop table orders;' | psql -d app_db"],
        // A file runs line by line, so the SQL after a \! line is SQL, gated as SQL, not part of the shell command.
        ['psql \\! in a file followed by destructive SQL', () => `psql -d app_db -f ${dir}/escape-then-sql.sql`],
        ['psql \\o into a pipe', "psql -d app_db -c '\\o | tee /tmp/out.txt'"],
        ['psql \\g into a pipe, from a -f file', () => `psql -d app_db -f ${dir}/pipe.sql`],
        ['psql \\w into a pipe', "psql -d app_db -c '\\w | sh'"],
        ['psql \\setenv', "psql -d app_db -c '\\setenv PAGER less'"],
        ['psql \\e, which runs an editor', "psql -d app_db -c '\\e'"],
        ['COPY … PROGRAM, which the server runs', `psql -d app_db -c "COPY orders TO PROGRAM 'gzip > /tmp/orders.gz'"`],
        ['psql \\copy … PROGRAM', `psql -d app_db -c "\\copy orders to program 'gzip > /tmp/orders.gz'"`],
        ['mysql pager', "mysql -e '\\P less'"],
        ['mysql --pager', "mysql --pager=less -e 'select 1'"],
        ['sqlite3 .once into a pipe', "sqlite3 app.db '.once |cat'"],
        ['sqlite3 .read from a pipe', `sqlite3 app.db ".read '|cat setup.sql'"`],
        ['sqlite3 .load', "sqlite3 app.db '.load ./ext'"],
        ['sqlite3 edit()', `sqlite3 app.db "select edit('x', 'vi')"`],
    ])('%s', (_name, command) => {
        expect(verdict(typeof command === 'function' ? command() : command)).toBe('gate');
    });
});

describe('client work that runs no program, or a harmless one, passes', () => {
    test.each([
        ['psql \\! running a harmless command', "psql -d app_db -c '\\! ls'"],
        ['a regex escape inside a SQL string', `psql -d app_db -c "select * from orders where code ~ '\\w+'"`],
        ['psql \\copy to a file', `psql -d app_db -c "\\copy orders to '/tmp/orders.csv' csv"`],
        ['psql \\o to a file', "psql -d app_db -c '\\o /tmp/out.txt'"],
        ['sqlite3 .output to a file', "sqlite3 app.db '.output /tmp/out.csv'"],
        ['sqlite3 .shell running a harmless command', "sqlite3 app.db '.shell ls'"],
        ['a -c value that does not start with a backslash goes to the server unread', `psql -d app_db -c "select '\\o | sh'"`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });
});
