import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeGate, evaluateBashCommand } from './block-destructive-core';

/**
 * dbt run-operation. A macro's SQL sits in Jinja strings and template text, so the guard hands those to the SQL scanner
 * without rendering anything: a macro that deletes names its statement on the card, a read-only one runs free.
 */

let project = '';
const inProject = (command: string) => evaluateBashCommand(command, { cwd: project });

const macro = (name: string, body: string) => `{% macro ${name}(dry_run='false') %}\n${body}\n{% endmacro %}\n`;

beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'dbt-macro-test-'));
    writeFileSync(join(project, 'dbt_project.yml'), 'name: example\nprofile: example\n');
    mkdirSync(join(project, 'macros', 'ops'), { recursive: true });
    mkdirSync(join(project, 'dbt_packages', 'pkg', 'macros'), { recursive: true });
    writeFileSync(join(project, 'macros', 'reads.sql'), macro('reads', `{% set r = run_query("select count(*) from s.t") %}{{ log(r) }}`));
    writeFileSync(join(project, 'macros', 'commented.sql'), macro('commented', `{# first check; drop table s.t once this ships #}{% do run_query('select 1') %}`));
    writeFileSync(join(project, 'macros', 'ops', 'drops.sql'), macro('drops', `{% do run_query('DROP TABLE IF EXISTS s.t') %}`));
    writeFileSync(join(project, 'macros', 'deletes.sql'), macro('deletes', `{% set q = run_query("delete from s.t where d < '2020-01-01'") %}`));
    writeFileSync(join(project, 'macros', 'block.sql'), macro('block', `{% set q %}truncate table s.t{% endset %}{% do run_query(q) %}`));
    writeFileSync(join(project, 'macros', 'relation.sql'), macro('relation', `{% do adapter.drop_relation(this) %}`));
    writeFileSync(join(project, 'macros', 'sweep.sql'), macro('sweep', `{% set q %}select 'drop ' || kind || ' ' || name from s.objects{% endset %}{% for c in run_query(q).columns[0].values() %}{% do run_query(c) %}{% endfor %}`));
    writeFileSync(join(project, 'dbt_packages', 'pkg', 'macros', 'tool.sql'), macro('tool', `{% do run_query('select 1') %}`));
    writeFileSync(join(project, 'dbt_packages', 'pkg', 'macros', 'wipe.sql'), macro('wipe', `{% do run_query('drop schema s') %}`));
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('a macro in the project', () => {
    test.each([
        ['a read-only macro', 'dbt run-operation reads'],
        ['a read-only macro with options around it', `dbt -q run-operation reads --target prod --args '{a: 1}' 2>&1 | tail -3`],
        ['a drop that is only a Jinja comment', 'dbt run-operation commented'],
        ['a package macro named with its package', 'dbt run-operation pkg.tool'],
        ['a macro with no file, alone on the line', 'dbt run-operation a_dbt_builtin'],
        ['a macro named through a variable', 'dbt run-operation "$M"'],
        ['an unknown option whose value is not the macro', 'dbt run-operation --some-new-flag drops reads'],
    ])('%s runs with no card', (_label, command) => {
        expect(inProject(command).action).toBe('allow');
    });

    test.each([
        ['a string passed to run_query', 'dbt run-operation drops', 'DROP TABLE'],
        ['a filtered delete', 'dbt run-operation deletes --target prod', 'delete'],
        ['a set block', 'dbt run-operation block', 'truncate'],
        ['an adapter call', 'dbt run-operation relation', 'adapter.drop_relation'],
        ['a package macro', 'dbt run-operation wipe', 'drop schema'],
        ['a package macro named with its package', 'dbt run-operation pkg.wipe', 'drop schema'],
        ['a project named by --project-dir', `cd /tmp && dbt run-operation drops --project-dir PROJECT`, 'DROP TABLE'],
    ])('%s gates and names what it runs', (_label, command, statement) => {
        const verdict = evaluateBashCommand(command.replace('PROJECT', project), { cwd: project });
        expect(verdict.action).toBe('gate');
        expect((verdict.reason ?? '').toLowerCase()).toContain(statement.toLowerCase());
    });
});

describe('a macro that builds its own drop statements', () => {
    test.each([
        ['yaml form', `dbt run-operation sweep --args "{dry_run: 'true'}"`],
        ['json form', `dbt run-operation sweep --args '{"dry_run": "true"}'`],
        ['beside another argument', `dbt run-operation sweep --args '{schema: s, dry_run: true}'`],
    ])('a literal dry run runs with no card (%s)', (_label, command) => {
        expect(inProject(command).action).toBe('allow');
    });

    test.each([
        ['no arguments', 'dbt run-operation sweep'],
        ['dry_run false', `dbt run-operation sweep --args "{dry_run: 'false'}"`],
        ['arguments the line does not show', 'dbt run-operation sweep --args "$ARGS"'],
        ['a dry run built from a variable', `dbt run-operation sweep --args "{dry_run: $D}"`],
        ['a dry run beside a variable that could override it', `dbt run-operation sweep --args "{dry_run: true, $MORE}"`],
        ['a key that only ends in dry_run', `dbt run-operation sweep --args '{not_dry_run: true}'`],
        ['a dry run nested under another key', `dbt run-operation sweep --args '{"dry_run": false, "options": {"dry_run": true}}'`],
        ['a dry run only under another key', `dbt run-operation sweep --args '{options: {dry_run: true}}'`],
        ['a repeated key, which leaves the real value unclear', `dbt run-operation sweep --args '{dry_run: true, dry_run: false}'`],
    ])('%s holds', (_label, command) => {
        expect(inProject(command).action).toBe('gate');
    });

    test('a dry-run argument does not excuse a macro that deletes outright', () => {
        expect(inProject(`dbt run-operation drops --args "{dry_run: 'true'}"`).action).toBe('gate');
    });
});

describe('a macro written on the line', () => {
    const written = (body: string) => `cat > macros/zz_tmp.sql <<'EOF'\n${macro('zz_tmp', body)}EOF\ndbt run-operation zz_tmp 2>&1 | tail -3; git clean -n macros/zz_tmp.sql`;

    test('a read-only one runs straight away', () => {
        expect(inProject(written(`{% do run_query('select 1') %}`)).action).toBe('allow');
    });

    test('a destructive one gates, and the card names the statement, not only what else is on the line', () => {
        const command = `cat > macros/zz_tmp.sql <<'EOF'\n${macro('zz_tmp', `{% do run_query('DROP TABLE IF EXISTS s.t') %}`)}EOF\ndbt run-operation zz_tmp; git clean -f macros/zz_tmp.sql`;
        const verdict = inProject(command);
        expect(verdict.action).toBe('gate');
        expect(verdict.reason).toContain('DROP TABLE');
        const card = describeGate(command, verdict.reason ?? '', project);
        expect(`${card.label} ${card.summary}`).toContain('DROP TABLE');
        expect(`${card.label} ${card.summary}`).not.toContain('--full-refresh');
    });
});

describe('a macro a program generates on the line', () => {
    test.each([
        ['after a semicolon', 'python3 gen.py; dbt run-operation generated'],
        ['in a chain', 'python3 gen.py && timeout 60 dbt run-operation generated 2>&1 | tail -3'],
    ])('is refused with the next-call fix (%s)', (_label, command) => {
        const verdict = inProject(command);
        expect(verdict.action).toBe('block');
        expect(verdict.reason).toContain('run it in the next');
    });

    test('a cd beside it is not a generator, so the retry is not refused too', () => {
        expect(inProject(`cd ${project} && dbt run-operation a_dbt_builtin`).action).toBe('allow');
    });

    test('a directory that is not a dbt project stays as it was', () => {
        expect(evaluateBashCommand('python3 gen.py; dbt run-operation generated', { cwd: tmpdir() }).action).toBe('allow');
    });
});

test('custom macro paths are read, and a form the guard cannot read leaves the macro unjudged', () => {
    const other = mkdtempSync(join(tmpdir(), 'dbt-macro-paths-'));
    mkdirSync(join(other, 'lib'));
    writeFileSync(join(other, 'lib', 'drops.sql'), macro('drops', `{% do run_query('drop table s.t') %}`));
    writeFileSync(join(other, 'dbt_project.yml'), 'name: other\nmacro-paths: ["lib"]\n');
    expect(evaluateBashCommand('dbt run-operation drops', { cwd: other }).action).toBe('gate');
    writeFileSync(join(other, 'dbt_project.yml'), 'name: other\nmacro-paths:\n  - lib\n');
    expect(evaluateBashCommand('python3 gen.py; dbt run-operation drops', { cwd: other }).action).toBe('allow');
    rmSync(other, { recursive: true, force: true });
});

test('a full refresh keeps its own rule and its own card', () => {
    const verdict = inProject('dbt run --full-refresh');
    expect(verdict.action).toBe('gate');
    expect(describeGate('dbt run --full-refresh', verdict.reason ?? '', project).label).toContain('--full-refresh');
});
