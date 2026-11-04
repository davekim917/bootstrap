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
    ])('%s', (sql) => {
        expect(evaluate(sql).action).toBe('allow');
    });
});
