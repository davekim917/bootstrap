/**
 * Project detection utilities for global hooks
 * Handles finding the project root directory reliably even when
 * Claude Code changes the working directory to a subdirectory
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Traverse up from startDir to find a directory containing .claude/
 * Returns null if no .claude directory is found before reaching root
 */
export function findProjectRoot(startDir: string): string | null {
    let dir = startDir;
    while (dir !== '/' && dir !== '.') {
        if (existsSync(join(dir, '.claude'))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break; // Root reached on any platform (handles Windows C:\)
        dir = parent;
    }
    return null;
}

/**
 * Get the project directory using the most reliable method available:
 * 1. CLAUDE_PROJECT_DIR env var (set by Claude Code, always points to project root)
 * 2. Traverse up from cwd to find .claude directory
 * 3. Fallback to cwd if nothing else works
 */
export function getProjectDir(input: { cwd?: string }): string {
    // 1. CLAUDE_PROJECT_DIR is most reliable (set by Claude Code)
    if (process.env.CLAUDE_PROJECT_DIR) {
        return process.env.CLAUDE_PROJECT_DIR;
    }
    // 2. Traverse up from cwd to find .claude directory
    const startDir = input.cwd || process.cwd();
    const found = findProjectRoot(startDir);
    if (found) {
        return found;
    }
    // 3. Fallback to cwd
    return startDir;
}

/**
 * Get the path to skill-rules.json if it exists in the project
 * Returns null if the project has no skill system configured
 */
export function getSkillRulesPath(projectDir: string): string | null {
    const rulesPath = join(projectDir, '.claude', 'skills', 'skill-rules.json');
    return existsSync(rulesPath) ? rulesPath : null;
}

/**
 * Check if a project has the skill system configured
 */
export function hasSkillSystem(projectDir: string): boolean {
    return getSkillRulesPath(projectDir) !== null;
}

/**
 * Get the path to global skill-rules.json if it exists
 * Returns null if no global skill system is configured
 */
export function getGlobalSkillRulesPath(): string | null {
    const globalRulesPath = join(process.env.HOME || '/root', '.claude', 'skills', 'skill-rules.json');
    return existsSync(globalRulesPath) ? globalRulesPath : null;
}
