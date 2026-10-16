import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

/**
 * SQL FROM FILES. A SQL client's file input is read and scanned like an
 * argument, wherever the file is named: an option, a `<` redirect, a `cat`
 * piped in, or an include inside the SQL. A file too large to check gates.
 */

let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sql-input-test-'));
    writeFileSync(join(dir, 'bad.sql'), 'select 1;\ndrop table users;\n');
    writeFileSync(join(dir, 'ok.sql'), 'select 1;\n');
    writeFileSync(join(dir, 'huge.sql'), 'select 1;\n'.repeat(120_000));
    writeFileSync(join(dir, 'outer.sql'), `\\i ${join(dir, 'inner.sql')}\n`);
    writeFileSync(join(dir, 'inner.sql'), `\\i ${join(dir, 'bad.sql')}\n`);
    mkdirSync(join(dir, 'job'));
    writeFileSync(join(dir, 'job', 'outer.sql'), '\\ir drop.sql\n');
    writeFileSync(join(dir, 'job', 'drop.sql'), 'drop table users;\n');
    writeFileSync(join(dir, 'drop schema.sql'), 'drop schema s;\n');
    writeFileSync(join(dir, 'template.sql'), '<% action %> TABLE users;\n');
    writeFileSync(join(dir, 'include-template.sql'), '!source <% path %>\n');
    mkdirSync(join(dir, 'source'));
    writeFileSync(join(dir, 'source', 'only-here.sql'), 'drop table users;\n');
    writeFileSync(join(dir, 'quoted.sql'), `\\i '${join(dir, 'drop schema.sql')}'\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const verdict = (command: string) => evaluateBashCommand(command, { cwd: dir }).action;

describe('a destructive SQL file is gated however it reaches the client', () => {
    test.each([
        (d: string) => `snow sql -f ${d}/bad.sql`,
        (d: string) => `snow sql --filename=${d}/bad.sql`,
        (d: string) => `psql -f ${d}/bad.sql`,
        (d: string) => `psql < ${d}/bad.sql`,
        (d: string) => `cat ${d}/bad.sql | psql`,
        (d: string) => `snow sql -q "!source ${d}/bad.sql"`,
        (d: string) => `psql -c "\\i ${d}/bad.sql"`,
        () => 'psql -f bad.sql',
        (d: string) => `psql -f ${d}/outer.sql`,
        (d: string) => `psql -f ${d}/job/outer.sql`,
        (d: string) => `psql -f ${d}/quoted.sql`,
    ])('%#', (make) => {
        expect(verdict(make(dir))).toBe('gate');
    });
});

describe('a read-only SQL file is not', () => {
    test.each([
        (d: string) => `snow sql -f ${d}/ok.sql`,
        (d: string) => `psql < ${d}/ok.sql`,
        (d: string) => `cat ${d}/ok.sql | psql`,
    ])('%#', (make) => {
        expect(verdict(make(dir))).toBe('allow');
    });
});

test('a SQL file too large to check gates', () => {
    expect(verdict(`snow sql -f ${dir}/huge.sql`)).toBe('gate');
});

test('a file path the command proves is read: a variable with a known value, or a plain top-level cd', () => {
    expect(verdict(`f=${dir}/bad.sql; psql -f "$f"`)).toBe('gate');
    expect(verdict(`cd ${dir} && snow sql -f bad.sql`)).toBe('gate');
    expect(verdict(`D=${dir}; cd $D; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`f=${dir}/ok.sql; psql -f "$f"`)).toBe('allow');
    expect(verdict(`cd ${dir}; snow sql -f ok.sql`)).toBe('allow');
});

test('a cd the step does not depend on leaves both directories possible, and each is read', () => {
    expect(verdict(`cd /does/not/exist || psql -f bad.sql`)).toBe('gate');
    expect(verdict(`cd /does/not/exist; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`cd /does/not/exist && psql -f bad.sql`)).toBe('allow');
});

test('env -C with a relative directory resolves from where the command starts', () => {
    expect(verdict(`env -C job psql -f drop.sql`)).toBe('gate');
});

test('text piped through tee into a file is what that file holds', () => {
    expect(verdict(`echo 'DROP TABLE users' | tee fresh.sql; psql -f fresh.sql`)).toBe('gate');
});

test('-f - reads the pipe', () => {
    expect(verdict(`printf 'DROP TABLE users;' | psql -f -`)).toBe('gate');
});

test('a file written under one name and run through a variable holding it is the same file', () => {
    expect(verdict(`echo 'DROP TABLE users' > fresh2.sql; f=fresh2.sql; psql -f "$f"`)).toBe('gate');
});

test('a cd inside a command substitution does not move the shell the client runs in', () => {
    expect(verdict(`echo "$(cd /tmp)"; psql -f bad.sql`)).toBe('gate');
});

test('a file cat feeds through tee is what tee writes', () => {
    expect(verdict(`cat bad.sql | tee fresh3.sql; psql -f fresh3.sql`)).toBe('gate');
});

test('printf output is scanned operand by operand, as it formats them', () => {
    expect(verdict(`printf '%s' 'DROP TABLE users;' | psql`)).toBe('gate');
});

test('a pipeline inside an if feeds its client like a top-level one', () => {
    expect(verdict(`if echo 'DROP TABLE users' | psql; then :; fi`)).toBe('gate');
});

test('env -C with a variable directory reads the file from that directory', () => {
    expect(evaluateBashCommand(`D=${dir}; env -C "$D" psql -f bad.sql`, { cwd: '/' }).action).toBe('gate');
});

test('a write after the SQL client does not count as the file it read', () => {
    expect(verdict(`psql -f safe.sql; echo 'DROP TABLE users' > safe.sql`)).toBe('allow');
});

test('many SQL readers over a deep variable chain resolve in bounded time', () => {
    const chain = 'A0=/;' + Array.from({ length: 1000 }, (_, i) => `A${i + 1}=$A${i};`).join('');
    const reader = 'psql ' + Array.from({ length: 16 }, (_, i) => `-f g${i}`).join(' ') + ';';
    const started = Date.now();
    verdict(chain + 'N=f;' + 'cd $A1000;echo>$N;'.repeat(64) + reader.repeat(400));
    expect(Date.now() - started).toBeLessThan(3000);
});

test('a SQL client inside a command substitution after a cd reads the file there', () => {
    expect(evaluateBashCommand(`cd ${dir} && echo "$(psql -f bad.sql)"`, { cwd: '/' }).action).toBe('gate');
});

test('a quoted heredoc is not variable-expanded', () => {
    expect(verdict(`sql='DROP TABLE users'; psql <<'EOF'\n$sql\nEOF`)).toBe('allow');
    expect(verdict(`sql='DROP TABLE users'; psql <<EOF\n$sql\nEOF`)).toBe('gate');
});

test('SQL held in a shell variable is expanded where a client reads it', () => {
    for (const command of [
        `B='DROP TABLE users;'; psql -c "$B"`,
        `B='DROP TABLE users;'; psql -c "\${B}"`,
        `B='DROP TABLE users;'; psql --command="$B"`,
        `B='DROP TABLE users;'; echo "$B" | psql`,
        `B='DROP TABLE users;'; printf '%s\n' "$B" | psql`,
        `T=users; psql -c "DROP TABLE $T"`,
        `B='DROP TABLE users;'; cat <<EOF | psql\n$B\nEOF`,
        `B='DROP TABLE users;'; echo "$B" > q.sql && psql -f q.sql`,
        `export B='DROP TABLE users;'; mysql -e "$B"`,
        `B='DROP TABLE users;'; echo $B | psql`,
        `B='DROP TABLE users;'; printf '%s\\n' $B | psql`,
        `B='-e DROP TABLE users;'; echo $B | psql`,
        `FMT='DROP TABLE users;'; B='-v x'; printf "$FMT" $B | psql`,
    ]) {
        expect(verdict(command)).toBe('gate');
    }
    for (const command of [
        `B='SELECT 1;'; psql -c "$B"`,
        `B='SELECT 1;'; echo "$B" | psql`,
        `B='DROP TABLE users;'; echo "$B"`,
        `psql -c "$UNKNOWN"`,
        `B='DROP TABLE users;'; cat <<'EOF' | psql\n$B\nEOF`,
        `B='-- DROP TABLE users;'; echo "$B" | psql`,
        `B='-- DROP TABLE users;'; echo $B | psql`,
        `B='-v x DROP TABLE users;'; printf $B | psql`,
        `O=-v; SQL='DROP TABLE users;'; printf $O x "$SQL" | psql`,
        `B='-e DROP TABLE users;'; echo 'SELECT 1; --' $B | psql`,
        `F='DROP TABLE ok.sql'; psql -f "$F"`,
        `B='SELECT 1'; echo 'DROP TABLE users;' | psql -c "$B"`,
        `F='DROP TABLE ok.sql'; cat "$F" | psql`,
    ]) {
        expect(verdict(command)).toBe('allow');
    }
});

test('SQL reaching a client through a substitution pipe, -init, a template file, env -C, a flag cluster or pushd', () => {
    for (const command of [
        `result=$(printf 'DROP TABLE users;' | psql)`,
        `echo "$(cat bad.sql | psql)"`,
        `printf 'DROP TABLE users;' | sqlite3 -init ok.sql db.sqlite`,
        `printf 'DROP TABLE users;' | duckdb -init ok.sql`,
        `snow sql -f template.sql -D action=DROP`,
        `env -C source cat only-here.sql | psql`,
        `psql -Xc'DROP TABLE users'`,
        `psql -Xqc 'DROP TABLE users'`,
        `pushd job && psql -f drop.sql`,
        `psql -XAtqc'DROP TABLE users'`,
        `x=$(if true; then printf 'DROP TABLE users' | psql; fi)`,
        `x=$(for t in a; do cat bad.sql | psql; done)`,
        `B='DROP TABLE users'; x=$(echo "$B" | psql)`,
        `snow sql -f include-template.sql -D path=bad.sql`,
        `printf 'DROP TABLE users' | sqlite3 -lookaside 100 50 db.sqlite`,
        `printf 'DROP TABLE users' | sqlite3 -nonce token db.sqlite`,
        `printf 'DROP TABLE users' | sqlite3 -unknown-option x db.sqlite`,
        `x=$(printf 'DROP TABLE users' | { psql; })`,
        `x=$(printf 'DROP TABLE users' | ( psql ))`,
        `x=$(B='DROP TABLE users'; echo "$B" | psql)`,
        `psql -XXXXXXXXXXXXXXXXXXXXc'DROP TABLE users'`,
        `x=$(cd job; cat drop.sql | psql)`,
        `x=$(printf '' | { cat bad.sql | psql; })`,
        `B='DROP TABLE users'; x=$(echo "$B" | psql; B='SELECT 1')`,
        `x=$(cd missing; cat bad.sql | psql)`,
    ]) {
        expect(verdict(command)).toBe('gate');
    }
    for (const command of [
        `result=$(printf 'SELECT 1;' | psql)`,
        `printf 'select 1;' | sqlite3 -init ok.sql db.sqlite`,
        `snow sql -f template.sql -D action=SELECT`,
        `psql -Xc'SELECT 1'`,
        `pushd job && psql -f ok.sql`,
        `pushd +1 && psql -c 'select 1'`,
        `printf 'DROP TABLE users' | sqlite3 -init ok.sql db.sqlite 'SELECT 1'`,
        `printf 'DROP TABLE users' | sqlite3 -readonly -json db.sqlite 'SELECT 1'`,
        `B='SELECT 1'; x=$(echo "$B" | psql)`,
        `x=$(B='SELECT 1'; echo "$B" | psql)`,
        `x=$(cd job; cat ok.sql | psql)`,
        `B='DROP TABLE users'; x=$(B='SELECT 1'; echo "$B" | psql)`,
        `printf 'DROP TABLE users' | psql -Xc'SELECT 1'`,
        `printf 'DROP TABLE users' | duckdb -init ok.sql -c 'SELECT 1'`,
        `snow sql -f include-template.sql -D path=ok.sql`,
    ]) {
        expect(verdict(command)).toBe('allow');
    }
});

test('deeply nested pipelines and many same-file writes resolve in bounded time', () => {
    const d = 2000;
    for (const command of [
        'echo x | ' + '{ echo x | '.repeat(d) + 'psql' + '; }'.repeat(d),
        'r=' + '$(echo x | '.repeat(d) + 'psql' + ')'.repeat(d),
        'echo>f;'.repeat(4000) + 'psql<f;'.repeat(4000),
        'echo a | ' + 'tee f | '.repeat(3000) + 'cat; ' + 'psql<f;'.repeat(3000),
        `printf '%s' '${'insert into t values (1); '.repeat(1200)}' > f; ` + 'psql<f;'.repeat(4500),
        'Q0="insert into t values (1); "; ' + Array.from({ length: 22 }, (_, i) => `Q${i + 1}="$Q${i}$Q${i}"; `).join('') + 'psql<<<"$Q22"',
    ]) {
        const started = Date.now();
        verdict(command);
        expect(Date.now() - started).toBeLessThan(3000);
    }
});

test('more writes to a SQL file than can be checked make it unknown, so the command gates', () => {
    expect(verdict(`echo 'DROP TABLE users;' > q.sql; ` + `echo 'SELECT 1;' >> q.sql; `.repeat(65) + 'psql -f q.sql')).toBe('gate');
});

test('readers inside separate $(...) with different env -C directories resolve separately', () => {
    mkdirSync(join(dir, 'safe'), { recursive: true });
    writeFileSync(join(dir, 'safe', 'q.sql'), 'SELECT 1;');
    mkdirSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(join(dir, 'bad', 'q.sql'), 'DROP TABLE users;');
    expect(verdict(`X=$(env -C ${dir}/safe psql -f q.sql); Y=$(env -C ${dir}/bad psql -f q.sql)`)).toBe('gate');
});

test('echo -e newlines are rendered before scanning', () => {
    expect(verdict(`echo -e "SELECT 1;\\nDROP TABLE users;" | psql`)).toBe('gate');
    expect(verdict(`echo -e 'BEGIN;\\nDROP TABLE users;\\nCOMMIT;' | psql`)).toBe('gate');
});

test('a pipeline inside a loop keeps its own input when the loop is itself a pipe stage', () => {
    expect(verdict(`psql -Atc "select tablename from pg_tables" | grep tmp_ | while read t; do echo "DROP TABLE $t;" | psql; done`)).toBe('gate');
});

test('many cds and writes before a SQL file resolve in bounded time', () => {
    const command = 'D=/;N=f;' + 'cd $D;echo>$N;'.repeat(4400) + 'psql ' + Array.from({ length: 16 }, (_, i) => `-f g${i}`).join(' ');
    const started = Date.now();
    verdict(command);
    expect(Date.now() - started).toBeLessThan(3000);
});

test('a cd inside a branch leaves the starting directory a candidate', () => {
    expect(verdict(`if false; then cd /tmp; fi; psql -f bad.sql`)).toBe('gate');
    expect(verdict(`if true; then cd /elsewhere; fi; psql -f bad.sql`)).toBe('gate');
});

test('printf output is rendered from its format', () => {
    expect(verdict(`printf 'DROP %s users;' TABLE | psql`)).toBe('gate');
});

test('a file cat feeds through tee also reaches the next stage', () => {
    expect(verdict(`cat bad.sql | tee copy.sql | psql`)).toBe('gate');
});

test('a relative write after a cd matches the absolute path the client reads', () => {
    expect(verdict(`cd ${dir} && echo 'DROP TABLE users' > fresh4.sql && psql -f ${dir}/fresh4.sql`)).toBe('gate');
});

test('text echoed to the terminal is not fed to a client that is not in its pipeline', () => {
    expect(verdict(`echo 'DROP TABLE users'; psql`)).toBe('allow');
    expect(verdict(`echo 'DROP TABLE users' | psql`)).toBe('gate');
});

test('after a cd the command implies, a relative file is not read from the starting directory, where it names a different file', () => {
    expect(verdict(`cd /elsewhere && psql -f bad.sql`)).toBe('allow');
});
