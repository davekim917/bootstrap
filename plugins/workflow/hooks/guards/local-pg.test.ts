import { describe, expect, spyOn, test } from 'bun:test';

import { evaluateBashCommand, type LocalPgHost } from './block-destructive-core';

/**
 * LOCAL SCRATCH POSTGRES EXEMPTION. Destructive psql skips approval only when its
 * target is a literal loopback address or /tmp socket directory, nothing on the
 * command line or in the environment can point libpq elsewhere, and procfs shows
 * every listener at that address and port is held by postgres. A forwarder on the
 * port, a target the guard can't read literally, or a host it can't inspect holds.
 *
 * The host is a fixture: procfs tables, process fds and comm names, /etc files and
 * the environment are all supplied, so nothing here reads the machine running it.
 */

const PORT_HEX = 'D888'; // 55432
const LISTEN_UNIX = '00010000';

type Proc = { comm: string; sockets: string[] };

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
        '/etc/nsswitch.conf': 'passwd: files\nhosts: files dns\n',
        '/etc/hosts': '127.0.0.1 localhost\n::1 localhost ip6-localhost\n',
        ...Object.fromEntries(Object.entries(procs).map(([pid, p]) => [`/proc/${pid}/comm`, `${p.comm}\n`])),
        ...f.files,
    };
    const env = f.env ?? { HOME: '/home/tester' };
    const dirs: Record<string, string[]> = {
        '/proc': ['1', 'self', ...Object.keys(procs)],
        ...Object.fromEntries(Object.entries(procs).map(([pid, p]) => [`/proc/${pid}/fd`, ['0', '1', ...p.sockets.map((_, i) => String(i + 3))]])),
        ...(env.HOME ? { [env.HOME]: f.home ?? ['.bashrc', '.profile'] } : {}),
    };
    const links: Record<string, string> = {};
    for (const [pid, p] of Object.entries(procs)) {
        links[`/proc/${pid}/fd/0`] = '/dev/null';
        links[`/proc/${pid}/fd/1`] = 'pipe:[77]';
        p.sockets.forEach((inode, i) => { links[`/proc/${pid}/fd/${i + 3}`] = `socket:[${inode}]`; });
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

const TCP = "psql -h 127.0.0.1 -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'";
const SOCKET = "psql -h /tmp/embedded-pg -p 55432 -d foo_test -c 'DROP TABLE orders'";

describe('destructive psql against a scratch postgres in this container skips approval', () => {
    test.each([
        ['TCP on 127.0.0.1', TCP],
        ['the unix socket under /tmp', SOCKET],
        ['clustered flags, a long option and a pipe into tail', "psql -XAtq --host=127.0.0.1 -p55432 -d foo_test -c 'DROP SCHEMA tmp CASCADE' 2>&1 | tail -3"],
        ['a URI naming the same address', "psql 'postgresql://tester@127.0.0.1:55432/foo_test?sslmode=disable' -c 'TRUNCATE orders'"],
        ['a key=value string naming the socket directory', "psql 'host=/tmp/embedded-pg port=55432 dbname=foo_test' -c 'DROP TABLE orders'"],
        ['localhost, which /etc/hosts maps to loopback', "cd /tmp && psql -h localhost -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['psql by path, under timeout', "timeout 60 /tmp/embedded-pg/bin/psql -h /tmp/embedded-pg -p 55432 -c 'DROP TABLE orders'"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });

    test('a scratch postgres on the default port needs no -p', () => {
        const f: Fixture = { tcp: [['0100007F', '1538', '9003']], procs: { 4300: { comm: 'postgres', sockets: ['9003'] } } };
        expect(verdict("psql -h 127.0.0.1 -c 'DROP TABLE orders'", f)).toBe('allow');
    });

    test('a scratch postgres listening on every address over IPv6 counts for ::1', () => {
        const f: Fixture = { tcp6: [['0'.repeat(32), PORT_HEX, '9004']], procs: { 4301: { comm: 'postgres', sockets: ['9004'] } } };
        expect(verdict("psql -h ::1 -p 55432 -c 'DROP TABLE orders'", f)).toBe('allow');
    });

    test('the allow is logged on stderr', () => {
        const err = spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(verdict(TCP)).toBe('allow');
            expect(err.mock.calls.map(c => String(c[0]))).toContain('local-pg: allowed psql against 127.0.0.1:55432 (postgres pid 4242)');
        } finally {
            err.mockRestore();
        }
    });
});

describe('a forwarder or an unproven listener holds', () => {
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
        ['postgres only on another port', TCP, { tcp: [['0100007F', '1538', '9001']], procs: { 4242: { comm: 'postgres', sockets: ['9001'] } } }],
        ['a listener whose holder this process cannot see', TCP, { tcp: [['0100007F', PORT_HEX, '9106']] }],
        ['the socket path only as an accepted connection, not a listener', SOCKET, {
            unix: [['00000000', '9107', '/tmp/embedded-pg/.s.PGSQL.55432']], procs: { 4242: { comm: 'postgres', sockets: ['9107'] } },
        }],
        ['no /proc', TCP, { ...scratch, noProc: true }],
        ['a host that is not Linux', TCP, { ...scratch, platform: 'darwin' }],
    ])('%s', (_name, command, f) => {
        expect(verdict(command, f)).toBe('gate');
    });
});

describe('a target the guard cannot read literally, or one libpq could be redirected from, holds', () => {
    test.each([
        ['a non-local host', "psql -h db.example.internal -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['no host at all', "psql -p 55432 -d foo_test -c 'DROP DATABASE scratch_db'"],
        ['a URI to a non-local host', "psql postgresql://tester@db.example.internal:5432/foo_test -c 'DROP TABLE orders'"],
        ['a local -h overridden by a remote URI in -d', "psql -h 127.0.0.1 -p 55432 -d postgresql://db.example.internal/foo_test -c 'DROP TABLE orders'"],
        ['two different hosts', "psql -h 127.0.0.1 -h db.example.internal -p 55432 -c 'DROP TABLE orders'"],
        ['a multi-host URI', "psql postgresql://127.0.0.1:55432,db.example.internal:5432/foo_test -c 'DROP TABLE orders'"],
        ['PGHOSTADDR on the command', "PGHOSTADDR=203.0.113.5 psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['PGHOSTADDR exported earlier', "export PGHOSTADDR=203.0.113.5; psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['hostaddr= in a connection string', "psql 'host=127.0.0.1 hostaddr=203.0.113.5 port=55432' -c 'DROP TABLE orders'"],
        ['service= in a connection string', "psql 'service=scratch' -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['service= in a URI', "psql 'postgresql://127.0.0.1:55432/foo_test?service=scratch' -c 'DROP TABLE orders'"],
        ['PGSERVICEFILE on the command', "PGSERVICEFILE=/tmp/svc psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a sourced env file', ". /tmp/pg.env; psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['an assignment anywhere in the command', "X=1; psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a variable host', "psql -h $PGH -p 55432 -c 'DROP TABLE orders'"],
        ['a substituted host', "psql -h \"$(cat /tmp/pg-host)\" -p 55432 -c 'DROP TABLE orders'"],
        ['a dbname held in a variable, which could expand to a connection string', "psql -h 127.0.0.1 -p 55432 -d \"$DSN\" -c 'DROP TABLE orders'"],
        ['a variable port',"psql -h 127.0.0.1 -p ${PORT} -c 'DROP TABLE orders'"],
        ['a globbed socket directory', "psql -h /tmp/embedded-p* -p 55432 -c 'DROP TABLE orders'"],
        ['a socket directory outside /tmp', "psql -h /var/run/postgresql -p 55432 -c 'DROP TABLE orders'"],
        ['a socket directory that climbs out of /tmp', "psql -h /tmp/../var/run/postgresql -p 55432 -c 'DROP TABLE orders'"],
        ['a \\connect in the SQL', "psql -h 127.0.0.1 -p 55432 -c '\\c host=db.example.internal' -c 'DROP TABLE orders'"],
        ['an option the guard does not place', "psql -h 127.0.0.1 -p 55432 --log-file=/tmp/l -c 'DROP TABLE orders'"],
        ['sudo', "sudo -u postgres psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
        ['a tunnel opened on the same line', "ssh -fNL 55432:db.example.internal:5432 jump.example.internal && psql -h 127.0.0.1 -p 55432 -c 'DROP TABLE orders'"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('gate');
    });

    test.each<[string, Record<string, string>]>([
        ['PGHOSTADDR', { PGHOSTADDR: '203.0.113.5' }],
        ['PGSERVICE', { PGSERVICE: 'scratch' }],
        ['PGSERVICEFILE', { PGSERVICEFILE: '/tmp/svc' }],
        ['PSQLRC', { PSQLRC: '/tmp/rc' }],
    ])('%s in the process environment', (_name, env) => {
        expect(verdict(TCP, { ...scratch, env: { HOME: '/home/tester', ...env } })).toBe('gate');
    });

    test('PGPORT in the process environment when the command names no port', () => {
        const f: Fixture = { tcp: [['0100007F', '1538', '9003']], procs: { 4300: { comm: 'postgres', sockets: ['9003'] } }, env: { HOME: '/home/tester', PGPORT: '55432' } };
        expect(verdict("psql -h 127.0.0.1 -c 'DROP TABLE orders'", f)).toBe('gate');
    });

    test('a psqlrc in HOME, which could reconnect, holds unless -X skips it', () => {
        const f: Fixture = { ...scratch, home: ['.bashrc', '.psqlrc'] };
        expect(verdict(TCP, f)).toBe('gate');
        expect(verdict(TCP.replace('psql ', 'psql -X '), f)).toBe('allow');
    });

    test('localhost when /etc/hosts maps it off loopback', () => {
        const f: Fixture = { ...scratch, files: { '/etc/hosts': '203.0.113.5 localhost\n' } };
        expect(verdict("psql -h localhost -p 55432 -c 'DROP TABLE orders'", f)).toBe('gate');
    });

    test('localhost when DNS is asked before /etc/hosts', () => {
        const f: Fixture = { ...scratch, files: { '/etc/nsswitch.conf': 'hosts: dns files\n' } };
        expect(verdict("psql -h localhost -p 55432 -c 'DROP TABLE orders'", f)).toBe('gate');
    });

    test('an exempt step does not hide a gated one', () => {
        expect(verdict(`${TCP} && psql -h db.example.internal -c 'DROP TABLE orders'`)).toBe('gate');
    });
});

describe('tier 1 is never exempted', () => {
    test('a hard-blocked step beside an exempt psql still blocks', () => {
        expect(verdict(`${SOCKET} && shred -u /tmp/embedded-pg/dump.sql`)).toBe('block');
    });
});
