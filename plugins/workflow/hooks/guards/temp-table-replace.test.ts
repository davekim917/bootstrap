import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeGate, evaluateBashCommand } from './block-destructive-core';

/**
 * A Snowflake temporary table shadows a durable table of the same name for the session and leaves it intact, so
 * replacing one is not destructive. Every other CREATE OR REPLACE still gates.
 */

let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'temp-table-replace-test-'));
    writeFileSync(
        join(dir, 'proc.sql'),
        [
            'CREATE PROCEDURE stage_widgets()',
            'RETURNS STRING',
            'LANGUAGE SQL',
            'AS',
            '$$',
            'BEGIN',
            "    EXECUTE IMMEDIATE 'CREATE OR REPLACE TEMPORARY TABLE tmp_widget_deps AS SELECT 1 AS id';",
            "    EXECUTE IMMEDIATE 'CREATE OR REPLACE TEMP TABLE tmp_widget_ids (id INT)';",
            "    RETURN 'ok';",
            'END;',
            '$$;',
            'CALL stage_widgets();',
            '',
        ].join('\n'),
    );
    writeFileSync(
        join(dir, 'mixed.sql'),
        [
            'CREATE OR REPLACE TEMPORARY TABLE tmp_gadget_stage AS SELECT 1 AS id;',
            'CREATE OR REPLACE TABLE gadget_facts AS SELECT * FROM tmp_gadget_stage;',
            'CREATE OR REPLACE TEMP TABLE tmp_gadget_more (id INT);',
            '',
        ].join('\n'),
    );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const evaluate = (command: string) => evaluateBashCommand(command, { cwd: dir });

// snow reads a file with universal newlines, so a lone carriage return ends a `--` comment and the statement after it runs.
test('a statement after a lone carriage return in a snow file still gates', () => {
    writeFileSync(join(dir, 'cr-temp.sql'), 'CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1-- note\r; CREATE OR REPLACE TABLE widget_facts AS SELECT 2;\r');
    writeFileSync(join(dir, 'cr-select.sql'), 'SELECT 1-- note\r; DROP TABLE widget_facts;\r');
    writeFileSync(join(dir, 'crlf-temp.sql'), 'CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1; -- note\r\nSELECT 2;\r\n');
    expect(evaluate(`snow sql -f ${dir}/cr-temp.sql`).action).toBe('gate');
    expect(evaluate(`snow sql -f ${dir}/cr-select.sql`).action).toBe('gate');
    expect(evaluate(`snow sql -q '!source ${dir}/cr-select.sql'`).action).toBe('gate');
    expect(evaluate(`snow sql -f ${dir}/crlf-temp.sql`).action).toBe('allow');
});

// Any gap between how the scanner and snow split SQL must not let a temporary replace front a statement the scanner misses.
test('a statement hidden from the scanner beside a temporary replace still gates', () => {
    writeFileSync(join(dir, 'cr-comment.sql'), 'CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1-- note\r; CREATE/**/OR/**/REPLACE TABLE widget_facts AS SELECT 2;\r');
    expect(evaluate(`snow sql -f ${dir}/cr-comment.sql`).action).toBe('gate');
    expect(evaluate(`snow sql -q '!source ${dir}/cr-comment.sql'`).action).toBe('gate');
    for (const ws of ['\u0085', '\x1c', '\x1f']) {
        expect(evaluate(`snow sql -q 'CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1;${ws}DROP TABLE widget_facts;'`).action).toBe('gate');
        expect(evaluate(`snow sql -q 'SELECT 1;${ws}DROP TABLE widget_facts;'`).action).toBe('gate');
    }
});

describe('replacing a temporary table passes', () => {
    test.each([
        `snow sql -q "CREATE OR REPLACE TEMPORARY TABLE tmp_widget_deps AS SELECT 1 AS id"`,
        `snow sql -q "create or replace temp table tmp_widget_ids (id int)"`,
        `snow sql -q "EXECUTE IMMEDIATE 'CREATE OR REPLACE TEMPORARY TABLE tmp_widget_deps (id INT)'"`,
    ])('%s', (command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test('inside EXECUTE IMMEDIATE in a procedure body', () => {
        expect(evaluate(`snow sql -c widget_dev -f ${dir}/proc.sql`).action).toBe('allow');
    });
});

describe('every other replace still gates', () => {
    test.each([
        [`snow sql -q "CREATE OR REPLACE TRANSIENT TABLE widget_snap AS SELECT 1 AS id"`, /TRANSIENT TABLE/i],
        [`snow sql -q "CREATE OR REPLACE TABLE widget_facts (id INT)"`, /CREATE OR REPLACE/],
        [`snow sql -q "CREATE OR REPLACE TEMPORARY VIEW widget_v AS SELECT 1"`, /CREATE OR REPLACE/],
        [`snow sql -q "CREATE OR REPLACE TEMPORARY STAGE widget_files"`, /CREATE OR REPLACE/],
        [`snow sql -q "CREATE OR REPLACE TEMPORARY PROCEDURE stage_widgets() RETURNS INT LANGUAGE SQL AS 'SELECT 1'"`, /CREATE OR REPLACE/],
        [`snow sql -q "CREATE OR REPLACE TEMPORARY /* scratch */ TABLE widget_facts (id INT)"`, /CREATE OR REPLACE/],
        [`snow sql -q "EXECUTE IMMEDIATE 'CREATE OR REPLACE TABLE widget_facts (id INT)'"`, /EXECUTE IMMEDIATE → CREATE OR REPLACE/],
        // Only Snowflake's temporary-table semantics are established; other clients keep gating a temporary replace.
        [`duckdb widgets.db "CREATE OR REPLACE TEMP TABLE widget_facts AS SELECT 1"`, /CREATE OR REPLACE/],
        [`mysql -e "CREATE OR REPLACE TEMPORARY TABLE widget_facts AS SELECT 1"`, /CREATE OR REPLACE/],
        [`mysql -e "CREATE OR REPLACE TEMPORARY TABLE tmp_widget AS SELECT 1--1; CREATE OR REPLACE TABLE widget_facts AS SELECT 2;"`, /CREATE OR REPLACE/],
    ])('%s', (command, reason) => {
        const verdict = evaluate(command);
        expect(verdict.action).toBe('gate');
        expect(verdict.reason ?? '').toMatch(reason);
    });
});

test('a file mixing temporary replaces with one permanent replace gates on the permanent one alone', () => {
    const command = `snow sql -c widget_dev -f ${dir}/mixed.sql`;
    const verdict = evaluate(command);
    expect(verdict.action).toBe('gate');
    const card = describeGate(command, verdict.reason ?? '', dir);
    expect(card.label).toMatch(/GADGET_FACTS/i);
    expect(card.label).not.toMatch(/TMP_GADGET|more\)/i);
    expect(card.summary).not.toMatch(/temporary table|more statement|TMP_GADGET_MORE/i);
});

test('dynamic SQL or a policy change hidden beside a temporary replace still gates', () => {
    writeFileSync(join(dir, 'cr-dynamic.sql'), "CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1-- note\r; EXECUTE IMMEDIATE 'DRO' || 'P TABLE widget_facts';\r");
    writeFileSync(join(dir, 'cr-policy.sql'), 'CREATE OR REPLACE TEMP TABLE tmp_widget AS SELECT 1-- note\r; ALTER USER widget_user SET NETWORK_POLICY/**/= open_policy;\r');
    for (const file of ['cr-dynamic.sql', 'cr-policy.sql']) {
        expect(evaluate(`snow sql -f ${dir}/${file}`).action).toBe('gate');
        expect(evaluate(`snow sql -q '!source ${dir}/${file}'`).action).toBe('gate');
    }
});

test('a temporary-replace phrase that runs from a comment into code is not read as one', () => {
    expect(evaluate(`snow sql -q 'SELECT 1 FROM -- CREATE OR REPLACE TEMP\nTABLE(GENERATOR(ROWCOUNT => 1)); CREATE OR REPLACE TABLE widget_facts AS SELECT 1;'`).action).toBe('gate');
    expect(evaluate(`snow sql -q 'DROP -- CREATE OR REPLACE TEMP\nTABLE widget_facts;'`).action).toBe('gate');
    expect(evaluate(`snow sql -q 'CREATE OR REPLACE TEMPORARY\nTABLE tmp_widget (id INT)'`).action).toBe('gate');
});

test('inline snow text keeps a lone carriage return inside a comment', () => {
    expect(evaluate(`snow sql -q $'SELECT 1 // note\\r/*\\n; CREATE /*x*/ OR REPLACE TABLE widget_facts AS SELECT 2;'`).action).toBe('gate');
});

test('the card quotes a statement as written, not as the temporary-replace check reads it', () => {
    const command = `snow sql -c widget_dev -q "DELETE FROM widget_log WHERE note = 'CREATE OR REPLACE TEMP TABLE'"`;
    const verdict = evaluate(command);
    expect(verdict.action).toBe('gate');
    expect(describeGate(command, verdict.reason ?? '', dir).summary).toContain("note = 'CREATE OR REPLACE TEMP TABLE'");
});
