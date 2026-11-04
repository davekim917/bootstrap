import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

const evaluate = (command: string) => evaluateBashCommand(command, { cwd: '/srv/example-repo' });

describe('a command line that can write to a disk device is held', () => {
    test.each([
        ['cat disk.img > /dev/sda'],
        ['cat disk.img >> /dev/nvme0n1'],
        ['printf x > /dev/xvda'],
        ['cat disk.img > /dev/vda'],
        ['echo x 2> /dev/sda'],
        ['cat disk.img 1<>/dev/sdb'],
        ['echo x | tee /dev/sdb'],
        ['echo x | sudo tee /dev/disk/by-id/example-disk'],
        ['cp disk.img /dev/mapper/vg-root'],
        ['mv disk.img /dev/sdc'],
        ['install -m 644 disk.img /dev/sda'],
        ['rsync disk.img /dev/sda'],
        ['{ echo x; } > /dev/sda'],
        ['(echo x) > /dev/sda'],
        ['exec > /dev/sda; echo x'],
        ['target=/dev/sda; cat disk.img > "$target"'],
        ['cat disk.img > "/dev/sd"a'],
        ['cat disk.img > /dev/mmcblk0'],
    ])('%s', (command) => {
        const result = evaluate(command);
        expect(result.action).toBe('gate');
        expect(result.reason).toMatch(/disk device/);
    });
});

describe('writes to the standard streams, and reads of a device, pass', () => {
    test.each([
        ['echo x > /dev/null'],
        ['echo x > /dev/stdout'],
        ['echo x 2> /dev/stderr'],
        ['echo x 2>/dev/null >/dev/null'],
        ['cat notes.txt > out.txt'],
        ['echo x | tee out.txt'],
        ['lsblk /dev/sda'],
        ['blkid /dev/nvme0n1p1'],
        ['ls -l /dev/disk/by-id/'],
        ['df -h /dev/mapper/vg-root'],
        ['ls /dev/sda 2>/dev/null'],
    ])('%s', (command) => {
        expect(evaluate(command).action).toBe('allow');
    });
});
