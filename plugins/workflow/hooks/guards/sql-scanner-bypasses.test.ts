import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

let dir = '';
let n = 0;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sql-scanner-bypasses-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function evaluate(sql: string) {
    const file = join(dir, `q${n++}.sql`);
    writeFileSync(file, sql);
    return evaluateBashCommand(`snow sql -f ${file}`, { cwd: dir });
}

const DESTRUCTIVE = ['DROP TABLE example_db.core.orders', 'ALTER MASKING POLICY mask_email SET BODY -> val'];

const nested = (stmt: string, levels: number): string =>
    levels === 0 ? stmt : nested(`EXECUTE IMMEDIATE '${stmt.replace(/'/g, "''")}'`, levels - 1);

const HIDDEN: Array<[string, (stmt: string) => string]> = [
    ['a searched CASE branch', s => `BEGIN CASE WHEN TRUE THEN ${s}; END CASE; END;`],
    ['a simple CASE branch', s => `BEGIN CASE (1) WHEN 1 THEN ${s}; END CASE; END;`],
    ['a CASE branch in EXECUTE IMMEDIATE', s => `EXECUTE IMMEDIATE 'BEGIN CASE WHEN TRUE THEN ${s}; END CASE; END;'`],
    ['a RESULTSET assignment', s => `BEGIN LET r RESULTSET := (${s}); RETURN TABLE(r); END;`],
    ['an ASYNC child job', s => `BEGIN ASYNC (${s}); AWAIT ALL; END;`],
    ["a // comment after a quoted '--'", s => `SELECT '--'; ${s.replace(' ', ' // note\n ')}`],
    ['a || concatenation in EXECUTE IMMEDIATE', s => `EXECUTE IMMEDIATE '${s.slice(0, 4)}' || '${s.slice(4)}'`],
    ['a nested || concatenation', s => `EXECUTE IMMEDIATE $$ BEGIN EXECUTE IMMEDIATE '${s.slice(0, 4)}' || '${s.slice(4)}'; END; $$`],
    ['nested doubled quotes', s => `EXECUTE IMMEDIATE 'EXECUTE IMMEDIATE ''${s}'''`],
    ['a CASE expression in a CASE condition', s => `BEGIN CASE WHEN CASE WHEN TRUE THEN TRUE ELSE FALSE END THEN ${s}; END CASE; END;`],
    ['a CASE expression in an IF condition', s => `BEGIN IF (CASE WHEN TRUE THEN 1 ELSE 0 END = 1) THEN ${s}; END IF; END;`],
    ['a RESULTSET declaration', s => `DECLARE r RESULTSET DEFAULT (${s}); BEGIN RETURN TABLE(r); END;`],
    ['a nested block after a label', s => `BEGIN <<inner>> BEGIN ${s}; END inner; END;`],
    ['a hex escape in EXECUTE IMMEDIATE', s => `EXECUTE IMMEDIATE '\\x${s.charCodeAt(0).toString(16)}${s.slice(1)}'`],
    ['a unicode escape in EXECUTE IMMEDIATE', s => `EXECUTE IMMEDIATE '\\u00${s.charCodeAt(0).toString(16)}${s.slice(1)}'`],
    ['a // comment inside EXECUTE IMMEDIATE', s => `EXECUTE // note\n IMMEDIATE '${s.slice(0, 4)}' || '${s.slice(4)}'`],
    ['a // comment before || in a nested literal', s => `EXECUTE IMMEDIATE $$ BEGIN EXECUTE IMMEDIATE '${s.slice(0, 4)}' // note\n || '${s.slice(4)}'; END; $$`],
    ["a backslash-escaped quote before EXECUTE IMMEDIATE", s => `SELECT 'a\\''; EXECUTE IMMEDIATE '${s.slice(0, 4)}' || '${s.slice(4)}'`],
    ['EXECUTE IMMEDIATE nested past the recursion limit', s => nested(s, 5)],
];

describe('a destructive statement hidden behind scripting, comments or dynamic SQL is held', () => {
    test.each(HIDDEN.flatMap(([how, wrap]) => DESTRUCTIVE.map(stmt => [how, stmt, wrap(stmt)] as const)))(
        '%s: %s',
        (_how, _stmt, sql) => {
            const result = evaluate(sql);
            expect(result.action).toBe('gate');
            expect(result.reason).toMatch(/^Destructive Snowflake SQL detected/);
        },
    );
});

describe('EXECUTE IMMEDIATE of SQL the guard cannot read is held', () => {
    test.each([
        ['BEGIN EXECUTE IMMEDIATE :stmt; END;'],
        ['EXECUTE IMMEDIATE FROM @example_stage/job.sql'],
        ["EXECUTE IMMEDIATE CONCAT('SEL', 'ECT 1')"],
        ['BEGIN EXECUTE IMMEDIATE "STMT"; END;'],
    ])('%s', (sql) => {
        const result = evaluate(sql);
        expect(result.action).toBe('gate');
        expect(result.reason).toMatch(/^Destructive Snowflake SQL detected \(EXECUTE IMMEDIATE/);
    });
});

describe('the same constructs around safe SQL pass', () => {
    test.each([
        ["SELECT CASE WHEN amount > 0 THEN 'credit' ELSE 'debit' END FROM example_db.core.orders"],
        ["SELECT CASE WHEN amount > 0 THEN TRUNCATE(amount, 2) ELSE 0 END FROM example_db.core.orders"],
        ['BEGIN CASE WHEN TRUE THEN SELECT 1; END CASE; END;'],
        ['BEGIN LET r RESULTSET := (SELECT 1); RETURN TABLE(r); END;'],
        ["SELECT '--', 1 // trailing note"],
        ["SELECT 'it''s' AS phrase // note"],
        ["EXECUTE IMMEDIATE 'SELECT 1'"],
        ["EXECUTE IMMEDIATE 'SELECT 1' ;"],
        ["EXECUTE IMMEDIATE 'EXECUTE IMMEDIATE ''SELECT ''''DROP TABLE t'''' AS phrase'''"],
        ["SELECT 'DROP TABLE t' || ' is just text' AS phrase"],
        ['BEGIN SELECT CASE WHEN amount > 0 THEN TRUNCATE(amount, 2) ELSE 0 END FROM example_db.core.orders; END;'],
        ["SELECT 'https://example.com/report' AS link // where it came from"],
        ["EXECUTE IMMEDIATE 'SELECT 1' // a note"],
        [nested('SELECT 1', 4)],
    ])('%s', (sql) => {
        expect(evaluate(sql).action).toBe('allow');
    });
});

const LOADER_QUERY = String.raw`-- How the nightly loader's MERGE into example_db.core.accounts assigns a column
with q as (
  select query_id, start_time, regexp_replace(query_text, '\\s+', ' ') as t
  from example_db.account_usage.query_history
  where start_time >= dateadd(day, -2, current_timestamp())
    and user_name = 'LOADER_USER' and query_type = 'MERGE'
    and query_text ilike 'MERGE INTO accounts %' or (query_type = 'MERGE' and query_text ilike '% MERGE INTO accounts %')
  qualify row_number() over (order by start_time desc) = 1
)
select start_time, regexp_count(t, ' = staging\\.', 1, 'i') as n_direct
from q;`;

describe('a statement word inside a comment or literal passes, beside a backslash, $ or //', () => {
    test.each([
        ['a comment and literals naming MERGE, with a regex backslash', LOADER_QUERY],
        ['the same without the comment', LOADER_QUERY.slice(LOADER_QUERY.indexOf('\n') + 1)],
        ["a literal holding statements, beside a '\\\\' pattern", String.raw`SELECT 'DELETE FROM example_db.core.orders; DROP TABLE example_db.core.orders' AS note FROM t WHERE c LIKE '%\\%'`],
        ['a $$ literal holding MERGE', 'SELECT $$ MERGE INTO example_db.core.orders $$ AS note'],
        ['a URL literal holding MERGE', "SELECT 'https://docs.example/merge into' AS link"],
        ['positional columns and a // comment naming DROP', 'SELECT $1, $2 FROM @example_stage/file.csv // DROP TABLE example_db.core.orders later\n;'],
        ['a /* */ comment naming DROP', '/* DROP TABLE example_db.core.orders */ SELECT 1'],
        ["a \\' that keeps the literal open over a DROP", String.raw`SELECT 'x\'; DROP TABLE example_db.core.orders; --'`],
        ['an UPDATE with a WHERE on a positional parameter', "UPDATE example_db.core.orders SET status = 'closed' WHERE id = $1 AND note LIKE '%\\\\%'"],
    ])('%s', (_name, sql) => {
        expect(evaluate(sql).action).toBe('allow');
    });
});

describe('a statement after a literal or comment that holds ;, a comment marker, \\ or $$ is held', () => {
    test.each([
        ["a literal holding ;", String.raw`SELECT 'a;b\\' AS x; MERGE INTO example_db.core.orders o USING s ON o.id = s.id WHEN MATCHED THEN DELETE`],
        ['a literal holding --', String.raw`SELECT 'x -- y\\' AS x; DELETE FROM example_db.core.orders`],
        ["a literal holding \\' and ;", String.raw`SELECT 'it\'s; still' AS x; DROP TABLE example_db.core.orders`],
        ['a literal ending in an escaped backslash', String.raw`SELECT 'C:\\'; DROP TABLE example_db.core.orders`],
        ['a $$ literal holding ;', String.raw`SELECT $$ ; MERGE \ $$ AS x; MERGE INTO example_db.core.orders o USING s ON 1 = 1 WHEN MATCHED THEN DELETE`],
        ['a $tag$, which Snowflake does not quote with', 'SELECT $a$ ; $a$ AS x; DROP TABLE example_db.core.orders'],
        ["a // comment holding an apostrophe", "SELECT 1 // it's here\n; DROP TABLE example_db.core.orders"],
        ["a /* */ comment holding an apostrophe", "SELECT 1 /* it's */; TRUNCATE TABLE example_db.core.orders"],
        ['a backtick, which Snowflake does not quote with', 'SELECT `x; y` FROM t; DROP TABLE example_db.core.orders'],
        ["an escaped newline in EXECUTE IMMEDIATE", String.raw`EXECUTE IMMEDIATE 'SELECT 1;\nDROP TABLE example_db.core.orders'`],
        ['an UPDATE whose only WHERE is inside a name holding $', 'UPDATE example_db.core.orders SET status = old$where$flag'],
        ['a DROP between names holding $$', "EXECUTE IMMEDIATE 'BEGIN SELECT 1 AS a$$b; DROP TABLE example_db.core.orders; SELECT 1 AS c$$; END;'"],
        ['the same at top level', 'SELECT 1 AS a$$b; DROP TABLE example_db.core.orders; SELECT 1 AS c$$;'],
    ])('%s', (_name, sql) => {
        const result = evaluate(sql);
        expect(result.action).toBe('gate');
        expect(result.reason).toMatch(/^Destructive Snowflake SQL detected/);
    });
});

describe('a scripting statement too large to scan one start at a time holds, quickly', () => {
    const cases: Array<[string, string]> = [
        ['10,000 CASE branches', `BEGIN SELECT CASE ${'WHEN x = 1 THEN TRUNCATE(x, 2) '.repeat(10_000)}ELSE 0 END FROM t; END;`],
        ['10,000 CASE branches each followed by a statement verb', `BEGIN SELECT CASE ${'WHEN x = 1 THEN ALTER '.repeat(10_000)}ELSE 0 END FROM t; END;`],
        ['600 statement verbs after THEN', `BEGIN CASE WHEN TRUE THEN ${'UPDATE t SET a = 1 WHERE id = 1 ELSE '.repeat(600)}SELECT 1; END CASE; END;`],
    ];
    test.each(cases)('%s', (_name, sql) => {
        const started = performance.now();
        const result = evaluate(sql);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(result.action).toBe('gate');
        expect(result.reason).toContain('SQL too complex to scan');
    });
});

describe('a psql DO body is still scanned when it holds a backslash', () => {
    test('DO with a backslash in the body', () => {
        const file = join(dir, `q${n++}.sql`);
        writeFileSync(file, "DO 'BEGIN DROP TABLE t; RAISE NOTICE ''a\\b''; END';");
        expect(evaluateBashCommand(`psql -h db.example -f ${file}`, { cwd: dir }).action).toBe('gate');
    });
});
