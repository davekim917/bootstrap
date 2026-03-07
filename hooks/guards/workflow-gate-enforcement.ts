#!/usr/bin/env bun
/**
 * PreToolUse hook: Workflow gate enforcement
 *
 * Enforces artifact-based gates for /team-build:
 * - Blocks TeamCreate when team name contains "build" and no passing
 *   pre-build drift report exists for that feature
 *
 * Gate logic:
 *   Team name format: "<feature-name>-build"
 *   Required artifact: .context/specs/<feature-name>/pre-build-drift.md
 *   Passing condition: MISSING: 0 and DIVERGED: 0 in the report
 *
 * Exit code 2 blocks the tool (Claude Code semantics)
 * Message written to stderr is shown to Claude as the reason for the block
 *
 * Fail-open on parse errors (exit 0) — avoids blocking legitimate work due to hook bugs.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ToolUseInput } from '../lib/types';

interface TeamCreateInput extends ToolUseInput {
    tool_input: {
        team_name?: string;
        description?: string;
        [key: string]: any;
    };
}

/**
 * Check if a drift report at the given path passes (MISSING: 0, DIVERGED: 0).
 */
function isDriftReportPassing(reportPath: string): boolean {
    if (!existsSync(reportPath)) return false;

    try {
        const content = readFileSync(reportPath, 'utf-8');
        const missingMatch = content.match(/MISSING\s*[:|]\s*(\d+)/i);
        const divergedMatch = content.match(/DIVERGED\s*[:|]\s*(\d+)/i);

        if (!missingMatch || !divergedMatch) return false;

        return parseInt(missingMatch[1], 10) === 0 && parseInt(divergedMatch[1], 10) === 0;
    } catch {
        return false;
    }
}

/**
 * Extract the feature name from a build team name.
 * Convention: "<feature-name>-build" → "<feature-name>"
 */
function extractFeatureName(teamName: string): string | null {
    const match = teamName.match(/^(.+)-build$/);
    return match ? match[1] : null;
}

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: TeamCreateInput = JSON.parse(rawInput);
        const cwd = input.cwd || process.cwd();

        if (input.tool_name !== 'TeamCreate') {
            process.exit(0);
        }

        const teamName = (input.tool_input?.team_name || '').toLowerCase();
        const description = (input.tool_input?.description || '').toLowerCase();

        // Only enforce on build teams
        const isBuildTeam = teamName.includes('build') || description.includes('build');
        if (!isBuildTeam) {
            process.exit(0);
        }

        // Try to match feature name from team name convention
        const featureName = extractFeatureName(teamName);

        if (featureName) {
            // Check the specific feature's drift report
            const reportPath = join(cwd, '.context', 'specs', featureName, 'pre-build-drift.md');
            if (!isDriftReportPassing(reportPath)) {
                console.error(
                    `BLOCKED: Cannot create build team "${teamName}" — pre-build drift check not passed.\n\n` +
                    `Expected a passing drift report at: .context/specs/${featureName}/pre-build-drift.md\n` +
                    `(MISSING: 0 and DIVERGED: 0 required)\n\n` +
                    `Run /team-drift with the design as SOT and plan as target first, as specified in /team-build Step 2.`
                );
                process.exit(2);
            }
        } else {
            // Team name doesn't follow convention — check if ANY feature has a passing report
            // This is a weaker check but still catches the common case
            const specsDir = join(cwd, '.context', 'specs');
            if (!existsSync(specsDir)) {
                console.error(
                    `BLOCKED: Cannot create build team — no .context/specs/ directory found.\n\n` +
                    `Run /team-drift (design vs. plan) first, as specified in /team-build Step 2.\n` +
                    `Tip: use the naming convention "<feature-name>-build" for build teams to enable ` +
                    `feature-specific gate enforcement.`
                );
                process.exit(2);
            }

            // Scan for any passing drift report
            try {
                const features = readdirSync(specsDir, { withFileTypes: true });
                const hasPassingReport = features.some((f: any) => {
                    if (!f.isDirectory()) return false;
                    return isDriftReportPassing(join(specsDir, f.name, 'pre-build-drift.md'));
                });

                if (!hasPassingReport) {
                    console.error(
                        `BLOCKED: Cannot create build team — no passing pre-build drift report found.\n\n` +
                        `Searched .context/specs/*/pre-build-drift.md — none found with MISSING: 0, DIVERGED: 0.\n\n` +
                        `Run /team-drift (design vs. plan) first, as specified in /team-build Step 2.`
                    );
                    process.exit(2);
                }
            } catch {
                // Can't read specs dir — fail open
                process.exit(0);
            }
        }

        process.exit(0);
    } catch (error) {
        // Fail-open: don't block on hook errors
        console.error('[workflow-gate] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
