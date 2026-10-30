import { describe, expect, spyOn, test } from 'bun:test';

import { evaluateBashCommand, type LocalPgHost } from './block-destructive-core';

// The host is a fixture: procfs, /etc files and the environment are all supplied, so nothing here reads this machine.

const PORT_HEX = 'D888'; // 55432
const LISTEN_UNIX = '00010000';

type Proc = { comm: string; sockets: string[]; cwd?: string; fdsHidden?: boolean; linkHidden?: boolean; linkGone?: boolean };

interface Fixture {
    platform?: string;
    env?: Record<string, string | undefined>;
    tcp?: Array<[string, string, string]>; // [address hex, port hex, inode]
    tcp6?: Array<[string, string, string]>;
    unix?: Array<[string, string, string]>; // [flags, inode, path]
    procs?: Record<string, Proc>;
    files?: Record<string, string>;
    home?: string[];
    noProc?: boolean;
}

const tcpTable = (rows: Array<[string, string, string]>) => [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    ...rows.map(([addr, port, inode], i) => `   ${i}: ${addr}:${port} ${'0'.repeat(addr.length)}:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`),
].join('\n');

const unixTable = (rows: Array<[string, string, string]>) => [
    'Num       RefCount Protocol Flags    Type St Inode Path',
    ...rows.map(([flags, inode, path]) => `0000000000000000: 00000002 00000000 ${flags} 0001 01 ${inode} ${path}`),
].join('\n');

function fixtureHost(f: Fixture): LocalPgHost {
    const procs = f.procs ?? {};
    const files: Record<string, string> = {
        '/proc/net/tcp': tcpTable(f.tcp ?? []),
        '/proc/net/tcp6': tcpTable(f.tcp6 ?? []),
        '/proc/net/unix': unixTable(f.unix ?? []),
        ...Object.fromEntries(Object.entries(procs).map(([pid, p]) => [`/proc/${pid}/comm`, `${p.comm}\n`])),
        ...f.files,
    };
    const env = f.env ?? { HOME: '/home/tester' };
    const dirs: Record<string, string[]> = {
        '/proc': ['self', 'net', ...Object.keys(procs)],
        ...Object.fromEntries(Object.entries(procs).filter(([, p]) => !p.fdsHidden).map(([pid, p]) => [`/proc/${pid}/fd`, ['0', '1', ...p.sockets.map((_, i) => String(i + 3))]])),
        ...(env.HOME ? { [env.HOME]: f.home ?? ['.bashrc', '.profile'] } : {}),
    };
    const links: Record<string, string> = {};
    for (const [pid, p] of Object.entries(procs)) {
        links[`/proc/${pid}/cwd`] = p.cwd ?? '/tmp/embedded-pg/data';
        links[`/proc/${pid}/fd/0`] = '/dev/null';
        links[`/proc/${pid}/fd/1`] = 'pipe:[77]';
        p.sockets.forEach((inode, i) => { if (!p.linkHidden) links[`/proc/${pid}/fd/${i + 3}`] = p.linkGone ? '' : `socket:[${inode}]`; });
    }
    const hidden = (p: string) => f.noProc === true && p.startsWith('/proc');
    return {
        platform: f.platform ?? 'linux',
        env,
        readFile: (p) => (hidden(p) ? null : files[p] ?? null),
        readDir: (p) => (hidden(p) ? null : dirs[p] ?? null),
        readLink: (p) => (hidden(p) ? null : links[p] ?? null),
    };
}

// A scratch postgres (pid 4242) listening on 127.0.0.1:55432 and on /tmp/embedded-pg/.s.PGSQL.55432.
const scratch: Fixture = {
    tcp: [['0100007F', PORT_HEX, '9001']],
    unix: [[LISTEN_UNIX, '9002', '/tmp/embedded-pg/.s.PGSQL.55432']],
    procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'] } },
};

const verdict = (command: string, f: Fixture = scratch) =>
    evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) }).action;

/**
 * Refused rather than sent to an approver: no host outside this container is written out, so the target is a local
 * Postgres the guard couldn't prove is scratch, and the refusal names the scratch-pg helper.
 */
const refusedToScratchPg = (command: string, f: Fixture = scratch) => {
    const v = evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) });
    expect(v.action).toBe('block');
    expect(v.reason).toContain('/app/skills/scratch-postgres/scratch-pg');
};

const TCP = "psql -X -h 127.0.0.1 -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'";
const SOCKET = "psql -X -h /tmp/embedded-pg -p 55432 -d foo_test -c 'DROP TABLE orders'";

describe('destructive psql against a scratch postgres in this container skips approval', () => {
    test.each([
        ['TCP on 127.0.0.1', TCP],
        ['the unix socket under /tmp', SOCKET],
        ['clustered flags, a long option and a pipe into tail', "psql -XAtq --host=127.0.0.1 -p55432 -d foo_test -c 'DROP SCHEMA tmp CASCADE' 2>&1 | tail -3"],
        ['an operand psql ignores, since -d and -U are given', "psql -X -h 127.0.0.1 -p 55432 -U tester -d foo_test 'host=203.0.113.9' -c 'DROP TABLE orders'"],
        ['a cd first, and psql by path under timeout', "cd /tmp && timeout 60 /tmp/embedded-pg/bin/psql -X -h /tmp/embedded-pg -p 55432 -c \"DROP TABLE orders\" > /dev/null"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });

    test('a descriptor closed while its directory was listed holds nothing', () => {
        const f: Fixture = { ...scratch, procs: { ...scratch.procs, 6001: { comm: 'bun', sockets: ['7777'], linkGone: true } } };
        expect(verdict(TCP, f)).toBe('allow');
    });

    test('a scratch postgres listening on every address over IPv6 counts for ::1', () => {
        const f: Fixture = { tcp6: [['0'.repeat(32), PORT_HEX, '9004']], procs: { 4301: { comm: 'postgres', sockets: ['9004'] } } };
        expect(verdict("psql -X -h ::1 -p 55432 -c 'DROP TABLE orders'", f)).toBe('allow');
    });

    test('the allow is logged on stderr', () => {
        const err = spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(verdict(TCP)).toBe('allow');
            expect(err.mock.calls.map(c => String(c[0]))).toContain('local-pg: allowed psql against 127.0.0.1:55432 (postgres pid 4242, data /tmp/embedded-pg/data)');
        } finally {
            err.mockRestore();
        }
    });
});

describe('a forwarder or an unproven listener is never exempted, and the refusal names scratch-pg', () => {
    test.each<[string, string, Fixture]>([
        ['an ssh -L tunnel on the port', TCP, { tcp: [['0100007F', PORT_HEX, '9101']], procs: { 5001: { comm: 'ssh', sockets: ['9101'] } } }],
        ['socat on the socket path', SOCKET, { unix: [[LISTEN_UNIX, '9102', '/tmp/embedded-pg/.s.PGSQL.55432']], procs: { 5002: { comm: 'socat', sockets: ['9102'] } } }],
        ['kubectl port-forward on all addresses', TCP, { tcp: [['00000000', PORT_HEX, '9103']], procs: { 5003: { comm: 'kubectl', sockets: ['9103'] } } }],
        ['a tunnel on 0.0.0.0 beside the scratch postgres on 127.0.0.1', TCP, {
            tcp: [['0100007F', PORT_HEX, '9001'], ['00000000', PORT_HEX, '9104']],
            procs: { 4242: { comm: 'postgres', sockets: ['9001'] }, 5004: { comm: 'cloudflared', sockets: ['9104'] } },
        }],
        ['a tunnel on the IPv6 wildcard, which also takes 127.0.0.1', TCP, {
            tcp: [['0100007F', PORT_HEX, '9001']], tcp6: [['0'.repeat(32), PORT_HEX, '9105']],
            procs: { 4242: { comm: 'postgres', sockets: ['9001'] }, 5005: { comm: 'ssh', sockets: ['9105'] } },
        }],
        ['a listen socket shared with a non-postgres process', TCP, {
            tcp: [['0100007F', PORT_HEX, '9001']],
            procs: { 4242: { comm: 'postgres', sockets: ['9001'] }, 5006: { comm: 'ssh', sockets: ['9001'] } },
        }],
        ['a process whose descriptors cannot be listed', TCP, {
            ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'] }, 5007: { comm: 'ssh', sockets: ['9001'], fdsHidden: true } },
        }],
        ['a descriptor that cannot be read', TCP, {
            ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'] }, 5008: { comm: 'ssh', sockets: ['9001'], linkHidden: true } },
        }],
        ['a postgres whose data directory is a volume, not scratch', TCP, { ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'], cwd: '/workspace/data/pg' } } }],
        ['a system postgres', SOCKET, { ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'], cwd: '/var/lib/postgresql/16/main' } } }],
        ['a tunnel on the v4-mapped wildcard beside a postgres on ::, which takes no IPv4', TCP, {
            tcp6: [['0'.repeat(32), PORT_HEX, '9001'], ['0000000000000000FFFF000000000000', PORT_HEX, '9109']],
            procs: { 4242: { comm: 'postgres', sockets: ['9001'] }, 5009: { comm: 'ssh', sockets: ['9109'] } },
        }],
        ['a comma in the socket directory, which libpq splits into two hosts', "psql -X -h /tmp/embedded-pg,/tmp/other -p 55432 -c 'DROP TABLE orders'", {
            unix: [[LISTEN_UNIX, '9110', '/tmp/embedded-pg,/tmp/other/.s.PGSQL.55432']], procs: { 4242: { comm: 'postgres', sockets: ['9110'] } },
        }],
        ['postgres only on another port', TCP, { tcp: [['0100007F', '1538', '9001']], procs: { 4242: { comm: 'postgres', sockets: ['9001'] } } }],
        ['a listener whose holder this process cannot see', TCP, { tcp: [['0100007F', PORT_HEX, '9106']] }],
        ['the socket path only as an accepted connection, not a listener', SOCKET, {
            unix: [['00000000', '9107', '/tmp/embedded-pg/.s.PGSQL.55432']], procs: { 4242: { comm: 'postgres', sockets: ['9107'] } },
        }],
        ['no /proc', TCP, { ...scratch, noProc: true }],
        ['a host that is not Linux', TCP, { ...scratch, platform: 'darwin' }],
    ])('%s', (_name, command, f) => {
        refusedToScratchPg(command, f);
    });
});

describe('a connection the guard cannot read exactly as psql will make it is never exempted', () => {
    // A host outside this container written out goes to an approver; anything else is refused toward scratch-pg.
    // Refused with the 127.0.0.1 form the exemption reads.
    const REFUSED_WITH_THE_FORM_IT_READS = new Set(['localhost, which NSS resolves', 'a URI naming the same address, which libpq parses, not the guard']);
    const NAMES_A_REMOTE_HOST = new Set([
        'a non-local host',
        'a URI whose userinfo hides the real host',
        'a URI to a non-local host',
        'a local -h overridden by a remote URI in -d',
        'two hosts',
        'two dbnames',
        'a connection string as the first operand, which psql makes the dbname',
        'a multi-host URI',
        'hostaddr= in a connection string',
    ]);
    test.each([
        ['a non-local host', "psql -X -h db.example.internal -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['localhost, which NSS resolves', "psql -X -h localhost -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['no host', "psql -X -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['no port, which a client build can default to anything', "psql -X -h 127.0.0.1 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['a URI naming the same address, which libpq parses, not the guard', "psql -X -h 127.0.0.1 -p 55432 'postgresql://tester@127.0.0.1:55432/foo_test' -c 'TRUNCATE orders'"],
        ['a URI whose userinfo hides the real host', "psql -X -h 127.0.0.1 -p 55432 'postgresql://127.0.0.1:55432?sslmode=disable@203.0.113.9:5432/foo_test' -c 'DROP TABLE orders'"],
        ['a key=value string naming the socket directory', "psql -X -h 127.0.0.1 -p 55432 'host=/tmp/embedded-pg port=55432 dbname=foo_test' -c 'DROP TABLE orders'"],
        ['a key=value string split by a non-ASCII space', "psql -X -h 127.0.0.1 -p 55432 'application_name=x\u00a0port=55432' -c 'DROP TABLE orders'"],
        ['a URI to a non-local host', "psql -X -h 127.0.0.1 -p 55432 postgresql://tester@db.example.internal:55432/foo_test -c 'DROP TABLE orders'"],
        ['a local -h overridden by a remote URI in -d', "psql -X -h 127.0.0.1 -p 55432 -d postgresql://db.example.internal/foo_test -c 'DROP TABLE orders'"],
        ['an empty host= in -d, which replaces -h with the default socket', "psql -X -h 127.0.0.1 -p 55432 -d \"host='' dbname=foo_test\" -c 'DROP TABLE orders'"],
        ['two hosts', "psql -X -h 127.0.0.1 -h db.example.internal -p 55432 -c 'DROP TABLE orders'"],
        ['two dbnames', "psql -X -h 127.0.0.1 -p 55432 -d foo_test -d 'host=203.0.113.9' -c 'DROP TABLE orders'"],
        ['a connection string as the first operand, which psql makes the dbname', "psql -X -h 127.0.0.1 -p 55432 'host=203.0.113.9' -c 'DROP TABLE orders'"],
        ['a multi-host URI', "psql -X -h 127.0.0.1 -p 55432 postgresql://127.0.0.1:55432,db.example.internal:5432/foo_test -c 'DROP TABLE orders'"],
        ['hostaddr= in a connection string', "psql -X -h 127.0.0.1 -p 55432 'host=127.0.0.1 hostaddr=203.0.113.5 port=55432' -c 'DROP TABLE orders'"],
        ['service= in a connection string', "psql -X 'service=scratch' -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['service= in a URI', "psql -X -h 127.0.0.1 -p 55432 'postgresql://127.0.0.1:55432/foo_test?service=scratch' -c 'DROP TABLE orders'"],
        ['an option the guard does not place', "psql -X -h 127.0.0.1 -p 55432 --log-file=/tmp/l -c 'DROP TABLE orders'"],
        ['SQL on stdin', "psql -X -h 127.0.0.1 -p 55432 <<'SQL'\nDROP TABLE orders;\nSQL"],
        ['a stdin file read beside -c', "echo x | psql -X -h 127.0.0.1 -p 55432 -Xf- -c 'DROP TABLE orders'"],
    ])('%s', (name, command) => {
        if (REFUSED_WITH_THE_FORM_IT_READS.has(name)) expect(verdict(command)).toBe('block');
        else if (NAMES_A_REMOTE_HOST.has(name)) expect(verdict(command)).toBe('gate');
        else refusedToScratchPg(command);
    });
});

describe('anything that could expand, redirect or run another connection is never exempted', () => {
    // PGHOSTADDR on the command and the brace expansion write out a host outside this container, and the shell escape
    // runs a psql that names one, so those go to an approver; every other line is refused toward scratch-pg.
    const NAMES_A_REMOTE_HOST = new Set(['PGHOSTADDR on the command', 'a shell escape in the SQL', 'a brace expansion that adds a host option']);
    test.each([
        ['PGHOSTADDR on the command', "PGHOSTADDR=203.0.113.5 psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['PGHOSTADDR exported earlier', "export PGHOSTADDR=203.0.113.5; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['PGSERVICEFILE on the command', "PGSERVICEFILE=/tmp/svc psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a sourced env file', ". /tmp/pg.env; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['an assignment anywhere in the command', "X=1; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['printf -v, which assigns', "printf -v HOME /tmp/other-home; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a psqlrc written on the same line', "echo '\\c host=db.example.internal' > /home/tester/.psqlrc; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a file written through stderr', "echo x 2>/home/tester/.psqlrc; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a variable host', "psql -X -h $PGH -p 55432 -c 'DROP TABLE orders'"],
        ['a substituted host', "psql -X -h \"$(cat /tmp/pg-host)\" -p 55432 -c 'DROP TABLE orders'"],
        ['a dbname held in a variable, which could expand to a connection string', "psql -X -h 127.0.0.1 -p 55432 -d \"$DSN\" -c 'DROP TABLE orders'"],
        ['a brace expansion that adds a host option', "psql -X -h 127.0.0.1 -p 55432 -d {foo_test,-hdb.example.internal} -c 'DROP TABLE orders'"],
        ['psql -X variables from an expansion', "psql -X -h 127.0.0.1 -p 55432 -v $OPTS -c 'DROP TABLE orders'"],
        ["ANSI-C quoted SQL", "psql -X -h 127.0.0.1 -p 55432 -c $'\\x5cconnect host=db.example.internal' -c 'DROP TABLE orders'"],
        ['a \\connect in the SQL', "psql -X -h 127.0.0.1 -p 55432 -c '\\c host=db.example.internal' -c 'DROP TABLE orders'"],
        ['a shell escape in the SQL', "psql -X -h 127.0.0.1 -p 55432 -c '\\! psql -X -h db.example.internal -c \"DROP TABLE orders\"' -c 'DROP TABLE orders'"],
        ['a function named psql defined on the line', "psql() { cat /tmp/x; }; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a loop whose variable is PATH', "for PATH in /tmp/shim:/usr/bin; do psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'; done"],
        ['a subshell', "(psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders')"],
        ['an assignment inside an expansion', "echo ${PATH:=/tmp/shim}; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a write inside a backquote substitution', "echo `echo x > /tmp/embedded-pg/bin/psql`; /tmp/embedded-pg/bin/psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a write inside a process substitution', "cat <(echo x > /tmp/embedded-pg/bin/psql); /tmp/embedded-pg/bin/psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a second psql, whose shell escape can swap the listener first', "psql -X -h 127.0.0.1 -p 55432 -c 'select 1' ; psql -X -h 127.0.0.1 -p 55432 -d foo_test -c 'DROP TABLE orders'"],
        ['a neighbour run through a package runner', "npx -y cat /tmp/x; psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a write inside a command substitution', "echo $(echo x > /tmp/embedded-pg/bin/psql); /tmp/embedded-pg/bin/psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a write inside a heredoc substitution', "cat <<EOF\n$(echo x > /tmp/embedded-pg/bin/psql)\nEOF\n/tmp/embedded-pg/bin/psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['sudo', "sudo -u postgres psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a tunnel opened on the same line', "ssh -fNL 55432:db.example.internal:5432 jump.example.internal && psql -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
    ])('%s', (name, command) => {
        if (NAMES_A_REMOTE_HOST.has(name)) expect(verdict(command)).toBe('gate');
        else refusedToScratchPg(command);
    });

    test.each<[string, Record<string, string>]>([
        ['PGHOSTADDR', { PGHOSTADDR: '203.0.113.5' }],
        ['PGSERVICE', { PGSERVICE: 'scratch' }],
        ['PGSERVICEFILE', { PGSERVICEFILE: '/tmp/svc' }],
        ['POSIXLY_CORRECT', { POSIXLY_CORRECT: '1' }],
    ])('%s in the process environment', (_name, env) => {
        refusedToScratchPg(TCP, { ...scratch, env: { HOME: '/home/tester', ...env } });
    });

    test('without -X, psql runs startup files the guard cannot locate (one sits beside the psql binary)', () => {
        expect(verdict(TCP.replace('psql -X ', 'psql '))).not.toBe('allow');
    });

});

describe('one flag short of the exemption, the agent is told the flag instead of an approver being asked', () => {
    const withoutX = (command: string) => command.replace('psql -X ', 'psql ');
    const evaluate = (command: string, f: Fixture = scratch) => evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) });

    test.each([
        ['the unix socket under /tmp', SOCKET, '/tmp/embedded-pg/.s.PGSQL.55432 (postgres pid 4242, data /tmp/embedded-pg/data)'],
        ['TCP on 127.0.0.1', TCP, '127.0.0.1:55432 (postgres pid 4242, data /tmp/embedded-pg/data)'],
    ])('%s: refused with -X named, and the same command with -X runs', (_name, command, endpoint) => {
        const v = evaluate(withoutX(command));
        expect(v.action).toBe('block');
        expect(v.reason).toContain(`scratch Postgres at ${endpoint} runs without approval only with -X`);
        expect(v.reason).toContain('Run the same command again with -X added.');
        expect(evaluate(command).action).toBe('allow');
    });

    test.each<[string, string, Fixture]>([
        ['a forwarder holds the port', withoutX(TCP), { tcp: [['0100007F', PORT_HEX, '9101']], procs: { 5001: { comm: 'ssh', sockets: ['9101'] } } }],
        ['its data directory is outside /tmp', withoutX(SOCKET), { ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'], cwd: '/var/lib/postgresql/data' } } }],
        ['libpq is redirected by the environment', withoutX(TCP), { ...scratch, env: { HOME: '/home/tester', PGSERVICE: 'other' } }],
        ['another program runs on the line', `${withoutX(TCP)}; curl -s https://example.com`, scratch],
        ['no port is given', "psql -h 127.0.0.1 -c 'DROP TABLE orders'", scratch],
    ])('refused toward scratch-pg when -X alone would not exempt it: %s', (_name, command, f) => {
        refusedToScratchPg(command, f);
    });
});

describe('a connection string or localhost the guard does not resolve is answered with the form it does', () => {
    const evaluate = (command: string, f: Fixture = scratch) => evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) });
    const rewriteIn = (reason: string | undefined) => reason?.split('This runs without approval:\n')[1]?.split('\n')[0];
    // /proc/net/tcp6 prints each 32-bit word in host order, so ::1 reads as …01000000 on little-endian.
    const v6only: Fixture = { tcp6: [['0'.repeat(24) + '01000000', PORT_HEX, '9004']], procs: { 4301: { comm: 'postgres', sockets: ['9004'] } } };

    test.each<[string, string, string, Fixture]>([
        ['a URI with a password, as the first operand', "psql 'postgresql://tester:s3cret-example@localhost:55432/foo_test' -X -c 'DROP TABLE orders'", "psql foo_test -h 127.0.0.1 -p 55432 -U tester -X -c 'DROP TABLE orders'", scratch],
        ['a URI given to -d, without -X', "psql -d postgres://127.0.0.1:55432/foo_test -c 'DROP TABLE orders'", "psql -d foo_test -X -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'", scratch],
        ['a URI given to --dbname=', "psql -X --dbname='postgresql://localhost:55432/foo_test' -c 'DROP TABLE orders'", "psql -X --dbname=foo_test -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'", scratch],
        ['-h localhost, without -X', "psql -h localhost -p 55432 -c 'DROP TABLE orders'", "psql -h 127.0.0.1 -X -p 55432 -c 'DROP TABLE orders'", scratch],
        ['localhost when the scratch postgres listens only on ::1', "psql -X -h localhost -p 55432 -c 'DROP TABLE orders'", "psql -X -h ::1 -p 55432 -c 'DROP TABLE orders'", v6only],
        ['a [::1] URI', "psql 'postgresql://[::1]:55432/foo_test' -X -c 'DROP TABLE orders'", "psql foo_test -h ::1 -p 55432 -X -c 'DROP TABLE orders'", v6only],
    ])('%s: refused with the rewrite, and the rewrite runs', (_name, command, rewrite, f) => {
        const v = evaluate(command, f);
        expect(v.action).toBe('block');
        expect(rewriteIn(v.reason)).toBe(rewrite);
        expect(evaluate(rewrite, f).action).toBe('allow');
    });

    test('the password never appears in the refusal; the ~/.pgpass line names the rewritten host', () => {
        const v = evaluate("psql 'postgresql://tester:s3cret-example@localhost:55432/foo_test' -X -c 'DROP TABLE orders'");
        expect(v.reason).not.toContain('s3cret-example');
        expect(v.reason).toContain('add the line 127.0.0.1:55432:foo_test:tester:<password> to ~/.pgpass (mode 0600)');
    });

    // A URI to a host outside this container goes to an approver; the others are refused toward scratch-pg.
    test.each<[string, string, Fixture]>([
        ['a URI with a query string', "psql 'postgresql://localhost:55432/foo_test?sslmode=disable' -X -c 'DROP TABLE orders'", scratch],
        ['a URI without a port', "psql 'postgresql://localhost/foo_test' -X -c 'DROP TABLE orders'", scratch],
        ['a URI to another host', "psql 'postgresql://db.example.internal:55432/foo_test' -X -c 'DROP TABLE orders'", scratch],
        ['a URI written twice on the line', "echo postgresql://localhost:55432/foo_test; psql postgresql://localhost:55432/foo_test -X -c 'DROP TABLE orders'", scratch],
        ['a keyword connection string', "psql 'host=localhost port=55432 dbname=foo_test' -X -c 'DROP TABLE orders'", scratch],
        ['-h localhost without a port', "psql -X -h localhost -c 'DROP TABLE orders'", scratch],
        ['a forwarder behind the URI', "psql 'postgresql://localhost:55432/foo_test' -X -c 'DROP TABLE orders'", { tcp: [['0100007F', PORT_HEX, '9101']], procs: { 5001: { comm: 'ssh', sockets: ['9101'] } } }],
        ['a postgres whose data directory is outside /tmp', "psql -X -h localhost -p 55432 -c 'DROP TABLE orders'", { ...scratch, procs: { 4242: { comm: 'postgres', sockets: ['9001', '9002'], cwd: '/var/lib/postgresql/data' } } }],
        ['an environment prefix on psql', "PGPASSWORD=x psql 'postgresql://localhost:55432/foo_test' -X -c 'DROP TABLE orders'", scratch],
    ])('no rewrite passes the exemption: %s', (name, command, f) => {
        if (name === 'a URI to another host') expect(evaluate(command, f).action).toBe('gate');
        else refusedToScratchPg(command, f);
    });
});

describe('tier 1 is never exempted', () => {
    test('a hard-blocked step beside an exempt psql still blocks', () => {
        expect(verdict(`${SOCKET} && shred -u /tmp/embedded-pg/dump.sql`)).toBe('block');
    });
});

describe('a program the server runs is never exempted', () => {
    test('COPY … PROGRAM against the scratch postgres is blocked, not exempted', () => {
        expect(verdict(`psql -X -h 127.0.0.1 -p 55432 -d foo_test -c "COPY orders FROM PROGRAM 'true'"`)).toBe('block');
    });
});

describe('a psql or dropdb whose database the line does not name is refused toward scratch-pg', () => {
    const evaluate = (command: string, f: Fixture = scratch) => evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) });
    const SPG = '/app/skills/scratch-postgres/scratch-pg';

    test.each([
        ['a connection URL in a variable set on an earlier line', 'psql $L/postgres -qc "drop database orders_e2e_test"', `${SPG} psql postgres -c "drop database orders_e2e_test"`],
        ['no host at all', 'psql -d app_test -c "DROP TABLE orders"', `${SPG} psql app_test -c "DROP TABLE orders"`],
        ['a host from a variable', 'psql -h $DB_HOST -d app_test -c "DROP TABLE orders"', `${SPG} psql app_test -c "DROP TABLE orders"`],
        ['dropdb with no host', 'dropdb app_test', `${SPG} dropdb app_test`],
        ['dropdb on a URL in a variable', 'dropdb "$DATABASE_URL"', `${SPG} dropdb <db>`],
        ['a username before -d', "psql -U postgres -d app_test -c 'DROP TABLE orders'", `${SPG} psql app_test -c 'DROP TABLE orders'`],
        ['-d after a positional', "psql other_db -p 5432 -d app_test -c 'DROP TABLE orders'", `${SPG} psql app_test -c 'DROP TABLE orders'`],
        ['dropdb with a username and port', 'dropdb -U postgres -p 5432 app_test', `${SPG} dropdb app_test`],
    ])('%s: refused with the scratch-pg line', (_name, command, line) => {
        const v = evaluate(command);
        expect(v.action).toBe('block');
        expect(v.reason?.split('\n')).toContain(line);
    });

    test('the refusal for a URL in a variable never shows a password in a URL, and says where the password goes', () => {
        const v = evaluate('psql "$DATABASE_URL" -c "DROP TABLE orders"');
        expect(v.action).toBe('block');
        expect(v.reason).not.toMatch(/:\/\/[^\s@/]+:[^\s@/]+@/);
        expect(v.reason).toContain('keep the password out of it');
        expect(v.reason).toContain('~/.pgpass');
        expect(v.reason).toContain('PGPASSWORD="$VAR"');
    });

    test.each([
        ['-h', 'psql -h db.example.internal -d app -c "DROP TABLE orders"'],
        ['--host=', 'psql --host=db.example.internal -d app -c "DROP TABLE orders"'],
        ['a URL', 'psql postgresql://app@db.example.internal:5432/app -c "DROP TABLE orders"'],
        ['a URL whose password is a variable', 'psql "postgresql://app:$PW@203.0.113.7:5432/app?sslmode=require" -c "DROP TABLE orders"'],
        ['a multi-host URL with one remote host', 'psql postgresql://127.0.0.1:55432,db.example.internal:5432/app -c "DROP TABLE orders"'],
        ['host= in a connection string', 'psql "host=db.example.internal dbname=app" -c "DROP TABLE orders"'],
        ['hostaddr= in a connection string', 'psql "host=127.0.0.1 hostaddr=203.0.113.5 dbname=app" -c "DROP TABLE orders"'],
        ['a PGHOST prefix', 'PGHOST=db.example.internal psql -d app -c "DROP TABLE orders"'],
        ['the password from a variable', 'PGPASSWORD="$PW" psql -h db.example.internal -U app -d app -c "DROP TABLE orders"'],
        ['dropdb -h', 'dropdb -h db.example.internal -p 5432 app'],
        ['dropdb --maintenance-db naming a host', "dropdb -h 127.0.0.1 -p 55432 --maintenance-db='host=db.example.internal dbname=postgres' app_test"],
    ])('a host outside this container written out goes to an approver: %s', (_name, command) => {
        expect(evaluate(command).action).toBe('gate');
    });
});

describe('dropdb takes the scratch exemption the way psql does', () => {
    const evaluate = (command: string, f: Fixture = scratch) => evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) });

    test.each([
        ['TCP on 127.0.0.1', 'dropdb -h 127.0.0.1 -p 55432 app_test'],
        ['the unix socket under /tmp', 'dropdb --host=/tmp/embedded-pg --port=55432 --if-exists app_test'],
    ])('drops on the scratch postgres need no approval: %s', (_name, command) => {
        expect(evaluate(command).action).toBe('allow');
    });

    test.each<[string, string, Fixture]>([
        ['a forwarder on the port', 'dropdb -h 127.0.0.1 -p 55432 app_test', { tcp: [['0100007F', PORT_HEX, '9101']], procs: { 5001: { comm: 'ssh', sockets: ['9101'] } } }],
        ['no port', 'dropdb -h 127.0.0.1 app_test', scratch],
        ['two databases named', 'dropdb -h 127.0.0.1 -p 55432 app_test other_test', scratch],
    ])('not exempt, refused toward scratch-pg: %s', (_name, command, f) => {
        refusedToScratchPg(command, f);
    });

    test.each([['--help'], ['-?'], ['--version'], ['-V']])('dropdb %s as its first argument runs', (flag) => {
        expect(evaluate(`dropdb ${flag}`).action).toBe('allow');
    });

    test('a database named like a version flag is still dropped, so it still gates', () => {
        expect(evaluate('dropdb -h db.example.internal -- -V').action).toBe('gate');
    });
});

describe('SQL that reaches another server always goes to an approver, scratch or not', () => {
    test.each([
        ['dblink_exec', "SELECT dblink_exec('host=db.example.internal dbname=app', 'DROP TABLE orders')"],
        ['CREATE EXTENSION dblink', 'CREATE EXTENSION dblink'],
        ['postgres_fdw', 'CREATE EXTENSION postgres_fdw'],
        ['CREATE SERVER', "CREATE SERVER prod FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'db.example.internal')"],
        ['CREATE USER MAPPING', "CREATE USER MAPPING FOR CURRENT_USER SERVER prod OPTIONS (user 'app')"],
        ['IMPORT FOREIGN SCHEMA', 'IMPORT FOREIGN SCHEMA public FROM SERVER prod INTO stage'],
        ['CREATE FOREIGN TABLE', 'CREATE FOREIGN TABLE orders_remote (id int) SERVER prod'],
    ])('%s against the scratch postgres', (_name, sql) => {
        expect(verdict(`psql -X -h 127.0.0.1 -p 55432 -d foo_test -c "${sql}"`)).toBe('gate');
    });

    test('a plain drop on the scratch postgres still needs no approval', () => {
        expect(verdict("psql -X -h 127.0.0.1 -p 55432 -d foo_test -c 'DROP TABLE orders'")).toBe('allow');
    });
});
