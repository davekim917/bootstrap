import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { devLoginTestHooks } from '../guards/block-destructive-core';

/**
 * Stand in for a container, where every program on PATH and the staged Snowflake config sit on read-only mounts: the
 * two checks that read those mounts answer yes, and HOME is a fresh directory holding the config files snow reads and
 * no curlrc. Tests of those checks set their own answers. Returns the HOME it made and a function that undoes all of it.
 */
export function useLockedHost(): { home: string; restore: () => void } {
    const saved = { HOME: process.env.HOME, hooks: { ...devLoginTestHooks } };
    const home = mkdtempSync(join(tmpdir(), 'locked-host-'));
    mkdirSync(join(home, '.snowflake'));
    for (const f of ['connections.toml', 'config.toml']) writeFileSync(join(home, '.snowflake', f), '');
    process.env.HOME = home;
    devLoginTestHooks.configLocked = () => true;
    devLoginTestHooks.programLocked = () => true;
    return {
        home,
        restore: () => {
            Object.assign(devLoginTestHooks, saved.hooks);
            if (saved.HOME === undefined) delete process.env.HOME;
            else process.env.HOME = saved.HOME;
            rmSync(home, { recursive: true, force: true });
        },
    };
}
