#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks AskUserQuestion while /team-auto is active.
 *
 * /team-auto is supposed to run autonomously between Stage A and Stage E.
 * In practice the model drifts toward AskUserQuestion mid-flight ("two
 * options...", "should we fix the must-fix only?", etc.) — exactly the kind
 * of pause /team-auto is designed to avoid. The skill text says don't do it;
 * this hook enforces it.
 *
 * Activation:
 *   A sentinel file `docs/specs/<feature>/.team-auto-active` (mtime within
 *   the last 30 minutes) means /team-auto is in flight. The skill writes
 *   the sentinel at Stage A start, touches it at every stage transition,
 *   and deletes it at Stage E success or as Step 0 of escalation.
 *
 * Behavior:
 *   - tool_name === "AskUserQuestion" and a fresh sentinel exists → block
 *     with exit code 2 and a stderr message explaining the two valid paths:
 *     apply judgment per Principle 3, or escalate via auto-pause.md.
 *   - Stale sentinel (mtime > 30 min) → ignored; this prevents a crashed
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
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

function findFreshSentinel(projectDir: string): string | null {
    const specsRoot = join(projectDir, 'docs', 'specs');
    if (!existsSync(specsRoot)) return null;

    let entries: string[];
    try {
        entries = readdirSync(specsRoot);
    } catch {
        return null;
    }

    const now = Date.now();
    for (const entry of entries) {
        const sentinel = join(specsRoot, entry, SENTINEL_NAME);
        try {
            const st = statSync(sentinel);
            if (!st.isFile()) continue;
            if (now - st.mtimeMs <= STALE_AFTER_MS) {
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

You have exactly two valid paths:

  1. Apply judgment per Principle 3 (team-auto/SKILL.md). Cite grounding
     (file:line, design.md excerpt, or named convention with >=2 code refs),
     run the negative scope check, apply the change, record under
     auto_judgments in decisions.yaml, and continue iterating.

  2. Escalate. Delete the sentinel, write docs/specs/<feature>/auto-pause.md
     with a category from the Escalation Protocol table, display the pause
     gate, and exit. The user then drives.

If you reached for AskUserQuestion because findings present "two options"
or a "design call", that is precisely the bail-out the Stage D rules
forbid. Re-read Stage D in team-auto/SKILL.md, pick the option consistent
with the existing design, and iterate.

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

main();
