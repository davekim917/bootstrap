import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

const CWD = '/srv/example-repo';
const verdict = (command: string) => evaluateBashCommand(command, { cwd: CWD }).action;

describe('a dd that only writes to stdout here passes', () => {
    test.each([
        ['dd if=x.js bs=1 skip=10 count=20'],
        ['dd if=x.js bs=1 skip=10 count=20 2>/dev/null'],
        ['dd if=x.js bs=1 count=20 > /dev/null'],
        ['dd if=x.js bs=1 count=20 > out.bin'],
        ['dd if=x.js bs=1 count=20 >> build/out.bin'],
    ])('%s', (command) => {
        expect(verdict(command)).toBe('allow');
    });
});

describe('a dd that can overwrite a device or a file elsewhere is held', () => {
    test.each([
        ['dd if=x of=/dev/sda'],
        ['dd if=x of=out.bin'],
        ['dd if=x > /dev/sda'],
        ['dd if=x >> /dev/nvme0n1'],
        ['dd if=x | tee /dev/sda'],
        ['dd if=x | sudo tee /dev/sda'],
        ['dd if=x | head -c 10'],
        ['dd if=x > /tmp/out.bin'],
        ['dd if=x > ../out.bin'],
        ['dd if=x > ~/out.bin'],
        ['dd if=x > "$TARGET"'],
        ['dd if=x $EXTRA'],
        ['cd /dev && dd if=x > sda'],
        ['env -C /dev dd if=x > sda'],
        ['echo $(dd if=x > out.bin)'],
    ])('%s', (command) => {
        expect(verdict(command)).toBe('gate');
    });
});
