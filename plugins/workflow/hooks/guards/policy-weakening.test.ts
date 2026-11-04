import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

let dir = '';
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'policy-weakening-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const verdict = (sql: string) => evaluateBashCommand(`snow sql -q "${sql}"`, { cwd: dir }).action;

describe('a statement that weakens a data-protection policy is held', () => {
    test.each([
        ['DROP MASKING POLICY example_db.gov.mask_email'],
        ['drop masking policy if exists mask_email'],
        ['DROP ROW ACCESS POLICY example_db.gov.region_filter'],
        ['DROP PROJECTION POLICY hide_ssn'],
        ['DROP AGGREGATION POLICY min_group'],
        ['DROP JOIN POLICY join_only_on_key'],
        ['DROP NETWORK POLICY office_only'],
        ['DROP STORAGE LIFECYCLE POLICY keep_ninety_days'],
        ['ALTER MASKING POLICY mask_email SET BODY -> val'],
        ['ALTER MASKING POLICY IF EXISTS mask_email SET BODY -> val'],
        ['ALTER ROW ACCESS POLICY region_filter SET BODY -> TRUE'],
        ['ALTER MASKING POLICY mask_email RENAME TO mask_email_old'],
        ['ALTER MASKING POLICY mask_email UNSET COMMENT'],
        ['ALTER PROJECTION POLICY hide_ssn SET BODY -> PROJECTION_CONSTRAINT(ALLOW => true)'],
        ['ALTER AGGREGATION POLICY min_group SET BODY -> NO_AGGREGATION_CONSTRAINT()'],
        ['ALTER JOIN POLICY join_only_on_key SET BODY -> JOIN_CONSTRAINT(JOIN_REQUIRED => FALSE)'],
        ['ALTER TABLE example_db.crm.customers ALTER COLUMN email UNSET MASKING POLICY'],
        ['ALTER TABLE customers MODIFY COLUMN email UNSET MASKING POLICY'],
        ['ALTER VIEW customer_view MODIFY COLUMN email UNSET MASKING POLICY'],
        ['ALTER TABLE customers UNSET AGGREGATION POLICY'],
        ['ALTER TABLE customers UNSET JOIN POLICY'],
        ['ALTER TABLE customers MODIFY COLUMN ssn UNSET PROJECTION POLICY'],
        ['ALTER TAG gov.pii UNSET MASKING POLICY mask_email'],
        ['ALTER ACCOUNT UNSET PASSWORD POLICY'],
        ['ALTER TABLE customers DROP ROW ACCESS POLICY region_filter'],
        ['ALTER TABLE customers DROP ALL ROW ACCESS POLICIES'],
        ['ALTER TABLE customers ALTER COLUMN email SET MASKING POLICY mask_none FORCE'],
        ['ALTER TABLE customers MODIFY COLUMN email SET MASKING POLICY mask_none USING (email, region) FORCE'],
        ['ALTER TAG gov.pii SET MASKING POLICY mask_none FORCE'],
        ['ALTER TABLE customers MODIFY COLUMN email SET MASKING POLICY mask_none FORCE, COLUMN ssn SET MASKING POLICY mask_ssn'],
        ['ALTER ACCOUNT UNSET NETWORK_POLICY'],
        ['ALTER ACCOUNT SET NETWORK_POLICY = open_network'],
        ['ALTER USER example_user UNSET PASSWORD_POLICY'],
        ['ALTER TABLE customers MODIFY COLUMN email SET TAG gov.pii = \'visible\''],
        ['ALTER TABLE customers MODIFY COLUMN email UNSET TAG gov.pii'],
        ['ALTER TABLE customers UNSET TAG gov.pii'],
        ['DROP TAG gov.pii'],
        ['SELECT 1; ALTER MASKING POLICY mask_email SET BODY -> val'],
        ["EXECUTE IMMEDIATE 'DROP MASKING POLICY mask_email'"],
    ])('%s', (sql) => {
        expect(verdict(sql)).toBe('gate');
    });
});

describe('attaching protection, or naming a policy only in a literal, passes', () => {
    test.each([
        ['ALTER TABLE customers ALTER COLUMN email SET MASKING POLICY mask_email'],
        ['ALTER TABLE customers MODIFY COLUMN email SET MASKING POLICY mask_email USING (email, region)'],
        ['ALTER TABLE customers ADD ROW ACCESS POLICY region_filter ON (region)'],
        ['ALTER TAG gov.pii SET MASKING POLICY mask_email'],
        ['ALTER TABLE policy ADD COLUMN status VARCHAR'],
        ['ALTER TABLE customers MODIFY COLUMN email SET MASKING POLICY mask_email USING (email, force)'],
        ['ALTER TABLE customers MODIFY COLUMN email SET MASKING POLICY gov.force.mask_email'],
        ['CREATE MASKING POLICY mask_email AS (val STRING) RETURNS STRING -> val'],
        ['GRANT APPLY MASKING POLICY ON ACCOUNT TO ROLE EXAMPLE_ROLE'],
        ["SELECT 'DROP MASKING POLICY mask_email; ALTER TABLE t UNSET MASKING POLICY' AS note"],
    ])('%s', (sql) => {
        expect(verdict(sql)).toBe('allow');
    });
});
