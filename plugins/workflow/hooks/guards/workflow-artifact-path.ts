#!/usr/bin/env bun
/**
 * PreToolUse hook: Workflow artifact path enforcement
 *
 * Catches the "approximation" anti-pattern: writing workflow artifacts
 * (briefs, designs, plans, decisions, drift reports) outside the canonical
 * .context/specs/<feature>/ directory structure.
 *
 * This fires when the agent writes a file whose name matches workflow artifact
 * patterns but whose path is NOT under .context/specs/. It does NOT block the
 * write (exit 0) — it prints a warning to stderr that Claude sees, prompting
 * it to check whether it actually invoked the skill or is approximating.
 *
 * Exit code 0 always (warn, never block) — the routing instruction and skill
 * invocation rules are the primary enforcement; this is a safety net.
 */
import { readFileSync } from 'fs';
import { basename, relative } from 'path';
import type { ToolUseInput } from '../lib/types';

/** Filename patterns that indicate workflow artifacts */
const ARTIFACT_PATTERNS = [
    /brief\.md$/i,
    /design\.md$/i,
    /plan\.md$/i,
    /decisions\.ya?ml$/i,
    /review\.md$/i,
    /qa-report\.md$/i,
    /drift.*\.md$/i,
    /build-state\.md$/i,
    /project-scope\.md$/i,
];

/** Filename patterns for files that embed a feature name (e.g. "multi-surface-sessions-brief.md") */
const EMBEDDED_NAME_PATTERNS = [
    /-brief\.md$/i,
    /-design\.md$/i,
    /-plan\.md$/i,
    /-decisions\.ya?ml$/i,
    /-review\.md$/i,
    /-project-scope\.md$/i,
];

/** Paths where artifacts are expected */
function isCanonicalPath(filePath: string, cwd: string): boolean {
    const rel = relative(cwd, filePath);
    // .context/specs/<feature>/<artifact> is the canonical location
    if (rel.startsWith('.context/specs/')) return true;
    // .claude/project-scope.md is written by /team-brief
    if (rel === '.claude/project-scope.md') return true;
    // .claude/tmp/ is scratch space used by /team-review and /team-drift
    if (rel.startsWith('.claude/tmp/')) return true;
    return false;
}

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: ToolUseInput = JSON.parse(rawInput);

        if (input.tool_name !== 'Write') {
            process.exit(0);
        }

        const filePath = input.tool_input?.file_path;
        if (!filePath) {
            process.exit(0);
        }

        const cwd = input.cwd || process.cwd();
        const name = basename(filePath);

        // Check if filename matches a workflow artifact pattern
        const isArtifactName = ARTIFACT_PATTERNS.some(p => p.test(name));
        const hasEmbeddedFeatureName = EMBEDDED_NAME_PATTERNS.some(p => p.test(name));

        if (!isArtifactName && !hasEmbeddedFeatureName) {
            process.exit(0);
        }

        // If it's going to a canonical location, all good
        if (isCanonicalPath(filePath, cwd)) {
            process.exit(0);
        }

        // Warn — this looks like an approximated workflow artifact
        const rel = relative(cwd, filePath);
        if (hasEmbeddedFeatureName) {
            console.error(
                `WARNING: You are writing "${rel}" which looks like a workflow artifact ` +
                `with a feature name embedded in the filename.\n\n` +
                `The team workflow skills save artifacts to .context/specs/<feature>/<type>.md — ` +
                `not as flat files with the feature name in the filename.\n\n` +
                `Did you invoke the skill via the Skill tool (e.g., Skill({ skill: "team-brief" }))? ` +
                `If not, you are approximating the skill from its description. ` +
                `Stop and invoke the actual skill instead.`
            );
        } else {
            console.error(
                `WARNING: You are writing "${rel}" which looks like a workflow artifact ` +
                `but is not under .context/specs/.\n\n` +
                `The team workflow skills save artifacts to .context/specs/<feature>/<type>.md.\n\n` +
                `Did you invoke the skill via the Skill tool? ` +
                `If not, you may be approximating the workflow. ` +
                `Consider invoking the actual skill (e.g., /team-brief, /team-design, /team-plan) instead.`
            );
        }

        // Always exit 0 — warn only, never block writes
        process.exit(0);
    } catch (error) {
        // Fail-open
        process.exit(0);
    }
}

main();
