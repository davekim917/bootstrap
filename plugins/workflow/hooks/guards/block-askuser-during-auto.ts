#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks AskUserQuestion while /team-auto is active.
 *
 * /team-auto runs autonomously from an approved plan through review. This
 * guard prevents an active run from silently turning into an interactive one.
 *
 * Activation:
 *   A sentinel file `docs/specs/<feature>/.team-auto-active` (mtime within
 *   the last two hours) means /team-auto is in flight. The skill refreshes
 *   the sentinel at stage transitions and around long-running commands.
 *
 * Behavior:
 *   - tool_name === "AskUserQuestion" and a fresh sentinel exists → block
 *     with exit code 2 and the single recovery path.
 *   - Stale sentinel (mtime > 2 hours) → ignored; this prevents a crashed
 *     /team-auto from permanently disabling AskUserQuestion.
 *   - SKIP_TEAM_AUTO_ASKBLOCK=1 → bypass (debug only).
 *
 * Fail-open for the hook itself: any error in our logic exits 0 (the hook
 * never blocks legitimate AskUserQuestion calls due to a hook bug).
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolUseInput } from '../lib/types';
import { getProjectDir } from '../lib/project-detection';

const SENTINEL_NAME = '.team-auto-active';
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function findFreshSentinel(projectDir: string, nowMs = Date.now()): string | null {
    const specsRoot = join(projectDir, 'docs', 'specs');
    if (!existsSync(specsRoot)) return null;

    let entries: string[];
    try {
        entries = readdirSync(specsRoot);
    } catch {
        return null;
    }

    for (const entry of entries) {
        const sentinel = join(specsRoot, entry, SENTINEL_NAME);
        try {
            const st = statSync(sentinel);
            if (!st.isFile()) continue;
            if (nowMs - st.mtimeMs <= STALE_AFTER_MS) {
                return sentinel;
            }
        } catch {
            // sentinel doesn't exist in this feature dir, keep looking
        }
    }
    return null;
}

function main(): void {
    try {
        if (process.env.SKIP_TEAM_AUTO_ASKBLOCK === '1') {
            process.exit(0);
        }

        const rawInput = readFileSync(0, 'utf-8');
        const input: ToolUseInput = JSON.parse(rawInput);

        if (input.tool_name !== 'AskUserQuestion') {
            process.exit(0);
        }

        const projectDir = getProjectDir(input);
        const sentinel = findFreshSentinel(projectDir);
        if (!sentinel) {
            process.exit(0);
        }

        console.error(`
BLOCKED: AskUserQuestion during /team-auto

/team-auto is in flight (sentinel: ${sentinel}).
AskUserQuestion is forbidden inside the autonomous flow — it defeats the
purpose of the workflow.

Remove the sentinel, record one evidenced blocker in
docs/specs/<feature>/run.md, and stop.

Bypass for legitimate debugging only: SKIP_TEAM_AUTO_ASKBLOCK=1
`);
        process.exit(2);
    } catch (error) {
        console.error(
            '[block-askuser-during-auto] Hook error (non-blocking):',
            error instanceof Error ? error.message : error
        );
        process.exit(0);
    }
}

if (import.meta.main) main();
