import { describe, expect, spyOn, test } from 'bun:test';

import { evaluateBashCommand, type LocalPgHost } from './block-destructive-core';

// The host is a fixture: procfs is supplied, so nothing here reads this machine.

const PORT_HEX = '18F6'; // 6390
const LOOPBACK4 = '0100007F';
const ANY4 = '00000000';

type Proc = { exe: string; cwd: string; sockets: string[] };

interface Fixture {
    tcp?: Array<[string, string, string]>; // [address hex, port hex, inode]
    tcp6?: Array<[string, string, string]>;
    procs: Record<string, Proc>;
}

const tcpTable = (rows: Array<[string, string, string]>) => [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    ...rows.map(([addr, port, inode], i) => `   ${i}: ${addr}:${port} ${'0'.repeat(addr.length)}:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`),
].join('\n');

function fixtureHost(f: Fixture): LocalPgHost {
    const links: Record<string, string> = {};
    const dirs: Record<string, string[]> = { '/proc': ['self', 'net', ...Object.keys(f.procs)] };
    for (const [pid, p] of Object.entries(f.procs)) {
        links[`/proc/${pid}/exe`] = p.exe;
        links[`/proc/${pid}/cwd`] = p.cwd;
        dirs[`/proc/${pid}/fd`] = p.sockets.map((_, i) => String(i + 3));
        p.sockets.forEach((inode, i) => { links[`/proc/${pid}/fd/${i + 3}`] = `socket:[${inode}]`; });
    }
    const files: Record<string, string> = { '/proc/net/tcp': tcpTable(f.tcp ?? []), '/proc/net/tcp6': tcpTable(f.tcp6 ?? []) };
    return {
        platform: 'linux',
        env: { HOME: '/home/tester' },
        readFile: (p) => files[p] ?? null,
        readDir: (p) => dirs[p] ?? null,
        readLink: (p) => links[p] ?? null,
    };
}

// A throwaway redis-server (pid 4400) on 127.0.0.1:6390, saving under /tmp.
const sandbox: Fixture = {
    tcp: [[LOOPBACK4, PORT_HEX, '9301']],
    procs: { 4400: { exe: '/usr/bin/redis-check-rdb', cwd: '/tmp/walk-redis', sockets: ['9301'] } },
};

const FLUSH = 'redis-cli -p 6390 flushall';
const verdict = (command: string, f: Fixture = sandbox) =>
    evaluateBashCommand(command, { cwd: '/tmp', localPg: fixtureHost(f) }).action;

describe('a flush of a scratch redis in this container skips approval', () => {
    test.each([
        ['the sandbox reset', FLUSH],
        ['with -h 127.0.0.1, a database and FLUSHDB ASYNC', 'redis-cli -h 127.0.0.1 -p 6390 -n 2 FLUSHDB ASYNC'],
        ['output discarded', `${FLUSH} >/dev/null`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toBe('allow');
    });

    test('the allow is logged on stderr', () => {
        const err = spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(verdict(FLUSH)).toBe('allow');
            expect(err.mock.calls.map(c => String(c[0]))).toContain('local-redis: allowed redis-cli against 127.0.0.1:6390 (redis pid 4400, data /tmp/walk-redis)');
        } finally {
            err.mockRestore();
        }
    });
});

describe('any other redis, listener or line still goes to approval', () => {
    test.each<[string, Fixture]>([
        ['an ssh tunnel holding the loopback port', { tcp: [[LOOPBACK4, PORT_HEX, '9302']], procs: { 5100: { exe: '/usr/bin/ssh', cwd: '/tmp/walk-redis', sockets: ['9302'] } } }],
        ['socat renamed redis-server under /tmp', { tcp: [[LOOPBACK4, PORT_HEX, '9303']], procs: { 5101: { exe: '/tmp/bin/redis-server', cwd: '/tmp/walk-redis', sockets: ['9303'] } } }],
        ['a redis whose data directory is a mounted workspace', { ...sandbox, procs: { 4400: { ...sandbox.procs[4400], cwd: '/workspace/agent' } } }],
        ['a redis listening on every address', { tcp: [[ANY4, PORT_HEX, '9304']], procs: { 4400: { ...sandbox.procs[4400], sockets: ['9304'] } } }],
        ['a tunnel on the IPv6 wildcard beside the sandbox redis', {
            tcp: [[LOOPBACK4, PORT_HEX, '9301']], tcp6: [['0'.repeat(32), PORT_HEX, '9305']],
            procs: { 4400: sandbox.procs[4400], 5102: { exe: '/usr/bin/ssh', cwd: '/tmp', sockets: ['9305'] } },
        }],
        ['nothing listening on the port', { procs: {} }],
    ])('%s', (_name, f) => {
        expect(verdict(FLUSH, f)).not.toBe('allow');
    });

    test.each([
        ['a remote host', 'redis-cli -h 203.0.113.7 -p 6390 flushall'],
        ['localhost, which the guard does not resolve', 'redis-cli -h localhost -p 6390 flushall'],
        ['a connection URI', 'redis-cli -u redis://127.0.0.1:6390 flushall'],
        ['a unix socket', 'redis-cli -s /tmp/walk-redis/redis.sock flushall'],
        ['cluster mode, which follows redirects to other nodes', 'redis-cli -c -p 6390 flushall'],
        ['no port given', 'redis-cli flushall'],
        ['a variable in redis-cli\'s own arguments', 'P=6390; redis-cli -p $P flushall'],
        ['an expansion elsewhere on the line', 'echo $HOME; redis-cli -p 6390 flushall'],
        ['another command first on the line', 'createdb walk && redis-cli -p 6390 flushall'],
        ['a second command after the flush', 'redis-cli -p 6390 flushall && redis-cli -p 6390 flushall'],
    ])('%s', (_name, command) => {
        expect(verdict(command)).not.toBe('allow');
    });
});
