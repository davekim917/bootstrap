import { existsSync } from 'fs';
import { dirname, join } from 'path';

/** Find the nearest project root carrying a .claude directory. */
export function findProjectRoot(startDir: string): string | null {
    let dir = startDir;
    while (dir !== '/' && dir !== '.') {
        if (existsSync(join(dir, '.claude'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** Resolve the project root from Claude's explicit value, then cwd. */
export function getProjectDir(input: { cwd?: string }): string {
    if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
    const startDir = input.cwd || process.cwd();
    return findProjectRoot(startDir) ?? startDir;
}
