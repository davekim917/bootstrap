import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evaluateBashCommand } from './block-destructive-core';

let dir = '';
let n = 0;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'statement-forms-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLIENTS = {
    snow: (file: string) => `snow sql -f ${file}`,
    psql: (file: string) => `psql -h db.example -f ${file}`,
    mysql: (file: string) => `mysql -h db.example < ${file}`,
};
type Client = keyof typeof CLIENTS;

function evaluate(client: Client, sql: string) {
    const file = join(dir, `q${n++}.sql`);
    writeFileSync(file, sql);
    return evaluateBashCommand(CLIENTS[client](file), { cwd: dir });
}

const quoted = (sql: string) => sql.replace(/'/g, "''");

const SNOW = ['DROP TABLE example_db.core.orders', 'ALTER MASKING POLICY mask_email SET BODY -> val'];
const POSTGRES = ['DROP TABLE orders', 'DELETE FROM orders'];

const HELD: Array<[Client, string, string[], (stmt: string) => string]> = [
    ['snow', 'an anonymous SQL procedure', SNOW, s => `WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE SQL AS '${quoted(`BEGIN ${s}; RETURN 1; END`)}' CALL p();`],
    ['snow', 'an anonymous procedure with a $$ body', SNOW, s => `WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN ${s}; RETURN 1; END $$ CALL p();`],
    ['snow', 'an anonymous procedure with no LANGUAGE', SNOW, s => `WITH p AS PROCEDURE() RETURNS VARCHAR AS $$ BEGIN ${s}; RETURN 1; END $$ CALL p();`],
    ['snow', 'a second anonymous procedure', SNOW, s => `WITH a AS PROCEDURE() RETURNS VARCHAR AS $$ BEGIN RETURN 1; END $$, b AS PROCEDURE() RETURNS VARCHAR AS $$ BEGIN ${s}; RETURN 1; END $$ CALL b();`],
    ['snow', 'a created SQL procedure', SNOW, s => `CREATE PROCEDURE example_db.core.cleanup() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN ${s}; RETURN 1; END $$;`],
    ['snow', 'a created SQL function', SNOW, s => `CREATE FUNCTION example_db.core.f() RETURNS VARCHAR LANGUAGE SQL AS '${quoted(`BEGIN ${s}; RETURN 1; END`)}';`],
    ['psql', 'a created PL/pgSQL function', POSTGRES, s => `CREATE FUNCTION cleanup() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${s}; END $$;`],
    ['psql', 'a created procedure with the language after the body', POSTGRES, s => `CREATE PROCEDURE cleanup() AS $$ BEGIN ${s}; END $$ LANGUAGE plpgsql;`],
    ['psql', "an E'' string that ends at an escaped quote", POSTGRES, s => `SELECT E'\\''; ${s}; --'`],
    ['psql', "a DO E'' body", POSTGRES, s => `DO E'BEGIN ${quoted(s)}; END';`],
    ['psql', 'a PL/pgSQL EXECUTE in a DO body', POSTGRES, s => `DO $$ BEGIN EXECUTE '${quoted(s)}'; END $$;`],
    ['psql', 'a PL/pgSQL EXECUTE with INTO in a DO body', POSTGRES, s => `DO $$ DECLARE n int; BEGIN EXECUTE '${quoted(s)}' INTO n; END $$;`],
    ['psql', 'a PL/pgSQL EXECUTE inside IF', POSTGRES, s => `DO $body$ BEGIN IF true THEN EXECUTE $q$${s}$q$; END IF; END $body$;`],
    ['psql', 'a PL/pgSQL EXECUTE in a created function', POSTGRES, s => `CREATE FUNCTION cleanup() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE '${quoted(s)}'; END $$;`],
    ['mysql', 'a backslash-escaped quote', POSTGRES, s => `SELECT '\\''; ${s}; -- '`],
];

describe('a destructive statement in these forms is held', () => {
    test.each(HELD.flatMap(([client, how, stmts, wrap]) => stmts.map(stmt => [client, how, stmt, wrap(stmt)] as const)))(
        '%s: %s: %s',
        (client, _how, _stmt, sql) => {
            const result = evaluate(client, sql);
            expect(result.action).toBe('gate');
            expect(result.reason).toMatch(/^Destructive \w+ SQL detected/);
        },
    );
});

describe('a body the guard cannot read is held', () => {
    test.each<[Client, string]>([
        ['snow', "WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE PYTHON RUNTIME_VERSION = '3.12' PACKAGES = ('snowflake-snowpark-python') HANDLER = 'run' AS $$\ndef run(session):\n    return 'ok'\n$$ CALL p();"],
        ['snow', "WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE JAVASCRIPT AS $$ return 'ok'; $$ CALL p();"],
        ['snow', "WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN EXECUTE IMMEDIATE 'SEL' || 'ECT 1'; RETURN 1; END $$ CALL p();"],
        ['psql', "DO E'BEGIN RAISE NOTICE ''\\n''; END';"],
        ['psql', "DO $$ BEGIN EXECUTE 'SELECT ' || quote_ident('orders'); END $$;"],
        ['psql', "DO $$ BEGIN EXECUTE format('SELECT count(*) FROM %I', 'orders'); END $$;"],
        ['psql', "DO $$ DECLARE q text := 'SELECT 1'; BEGIN EXECUTE q; END $$;"],
        ['psql', "DO LANGUAGE plpython3u $$ plpy.notice('hello') $$;"],
        ['psql', "DO $$ plpy.notice('hello') $$ LANGUAGE plpython3u;"],
    ])('%s: %s', (client, sql) => {
        const result = evaluate(client, sql);
        expect(result.action).toBe('gate');
        expect(result.reason).toMatch(/can't read/);
    });
});

describe('the same forms around safe SQL pass', () => {
    test.each<[Client, string]>([
        ['snow', "WITH p AS PROCEDURE() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN RETURN 'ok'; END $$ CALL p();"],
        ['snow', "WITH recent AS (SELECT * FROM example_db.core.orders) SELECT 'AS PROCEDURE' AS phrase FROM recent;"],
        ['snow', "CREATE PROCEDURE example_db.core.report() RETURNS VARCHAR LANGUAGE SQL AS $$ BEGIN RETURN 'ok'; END $$;"],
        ['snow', "CREATE FUNCTION example_db.core.double(x NUMBER) RETURNS NUMBER AS 'x * 2';"],
        ['snow', "CREATE FUNCTION example_db.core.greet() RETURNS VARCHAR LANGUAGE PYTHON RUNTIME_VERSION = '3.12' HANDLER = 'run' AS $$\ndef run():\n    return 'hi'\n$$;"],
        ['psql', "CREATE FUNCTION add_one(x int) RETURNS int LANGUAGE sql AS 'SELECT x + 1';"],
        ['psql', "SELECT E'it\\'s' AS phrase;"],
        ['psql', "SELECT 'C:\\temp' AS path;"],
        ['psql', "DO $$ BEGIN RAISE NOTICE 'hello'; END $$;"],
        ['psql', "DO 'BEGIN RAISE NOTICE ''a\\b''; END';"],
        ['psql', "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;"],
        ['psql', "DO $$ BEGIN IF 'a1' ~ '\\d' THEN RAISE NOTICE 'digit'; END IF; END $$;"],
        ['psql', 'INSERT INTO orders (id) VALUES (1) ON CONFLICT DO NOTHING;'],
        ['psql', 'PREPARE recent AS SELECT * FROM orders; EXECUTE recent;'],
        ['mysql', "SELECT 'it\\'s' AS phrase;"],
    ])('%s: %s', (client, sql) => {
        expect(evaluate(client, sql).action).toBe('allow');
    });
});
