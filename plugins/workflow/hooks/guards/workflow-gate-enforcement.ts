#!/usr/bin/env bun
/**
 * PreToolUse hook: Workflow gate enforcement
 *
 * Enforces artifact-based gates for /team-build:
 * - Blocks TeamCreate when team name contains "build" and no passing
 *   pre-build drift report exists for that feature
 *
 * Gate logic (1.8.2):
 *   Team name format: "<feature-name>-build" (REQUIRED for build teams)
 *     - feature-name must match /^[a-z0-9][a-z0-9_-]{0,63}$/
 *   Required artifact: docs/specs/<feature-name>/pre-build-drift.md
 *   Passing condition: parsed_MISSING == 0 AND (parsed_DIVERGED - validAcks) == 0
 *
 *   Counts are derived from parsed `### [B<n>]` entries with `**Class:**` lines.
 *   The Summary table at the top of the report is NOT trusted — an agent
 *   producing the report could put `MISSING: 0` in the summary while listing
 *   real DIVERGED entries below. Only parsed entries count.
 *
 * Acknowledgments (1.8.2):
 *   docs/specs/<feature-name>/drift-acks.json may contain
 *   { "acknowledgments": [{ "id": "B1", "reason": "...", "expires_at": "YYYY-MM-DD" }] }
 *   Each ack must reference an existing [B<n>] entry in the drift report
 *   whose Class is DIVERGED, with a non-empty reason and (if expires_at
 *   is set) a future date in strict YYYY-MM-DD format. Acks for MISSING
 *   entries are NOT honored.
 *   Valid acks are subtracted from the DIVERGED count for gate purposes.
 *
 * Security model:
 *   - cwd is supplied by the harness via tool-input. The harness is the
 *     trust boundary — if the harness is compromised, the hook cannot help.
 *   - All paths derived from team_name go through a strict allowlist
 *     before being joined with cwd, preventing path traversal.
 *   - Code fences in drift reports are stripped before entry parsing,
 *     preventing example markdown from polluting entry detection.
 *   - The hook fails CLOSED on errors inside the gate decision path.
 *     The only fail-open is at the outermost frame for malformed hook
 *     stdin (so a hook bug never blocks legitimate work, but a malformed
 *     drift report DOES block).
 *
 * Exit code 2 blocks the tool (Claude Code semantics).
 * Message written to stderr is shown to Claude as the reason for the block.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolUseInput } from '../lib/types';

interface TeamCreateInput extends ToolUseInput {
    tool_input: {
        team_name?: string;
        description?: string;
        [key: string]: any;
    };
}

interface DriftEntry {
    id: string; // e.g., "B1"
    class: 'MISSING' | 'DIVERGED' | 'UNKNOWN';
}

interface Ack {
    id?: string;
    reason?: string;
    expires_at?: string;
}

interface AcksFile {
    acknowledgments?: unknown;
}

interface GateResult {
    passing: boolean;
    missing: number;
    divergedTotal: number;
    divergedAcked: number;
    divergedEffective: number;
    ackErrors: string[];
}

/**
 * Strict feature-name allowlist. Used to extract the feature from a build
 * team_name and prevent path traversal.
 *
 * Format: lowercase alphanumeric, hyphens, underscores. Must start with
 * alphanumeric. Length 1-64 chars (the leading char + up to 63 more).
 * No dots, no slashes, no whitespace — eliminates `..`, `/`, `\` traversal.
 */
const FEATURE_NAME_RE = /^([a-z0-9][a-z0-9_-]{0,63})-build$/;

/**
 * Strict ISO 8601 date format for expires_at. YYYY-MM-DD only.
 * Rejects partial dates ("2026-07"), locale strings ("4/8/2026"),
 * timestamps with time component, and numeric epoch seconds.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strip fenced code blocks (```...``` and ~~~...~~~) from markdown content.
 * Used before parsing drift entries so example markdown inside the report
 * (e.g., a sample `### [B1]` entry shown for documentation) cannot pollute
 * real entry detection.
 */
function stripCodeFences(content: string): string {
    return content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

/**
 * Parse a drift report and extract DIVERGED/MISSING entries by ID.
 *
 * Recognized format (per drift-report-template.md):
 *   ### [B1] Brief description
 *   - **Class:** DIVERGED
 *
 * The header pattern is anchored to start-of-line so headers inside body
 * text or stripped fences are not matched. CRLF line endings are normalized.
 */
function parseDriftEntries(rawContent: string): DriftEntry[] {
    const content = stripCodeFences(rawContent.replace(/\r\n/g, '\n'));
    const entries: DriftEntry[] = [];
    // Anchor the header to start-of-line via (?:^|\n) so the regex doesn't
    // match `### [B1]` mid-line. The lookahead's `$` (without /m flag)
    // matches end-of-string, capturing the final entry's body cleanly.
    const blockRegex = /(?:^|\n)###\s*\[(B\d+)\][^\n]*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = blockRegex.exec(content)) !== null) {
        const id = m[1];
        const body = m[2];
        const classMatch = body.match(/\*\*Class:\*\*\s*(MISSING|DIVERGED)/i);
        const cls = (classMatch?.[1]?.toUpperCase() ?? 'UNKNOWN') as DriftEntry['class'];
        entries.push({ id, class: cls });
    }
    return entries;
}

/**
 * Load and validate the drift-acks.json file for a feature.
 * Returns the list of acks that pass all checks plus per-ack rejection reasons.
 *
 * Errors are returned, not thrown — the gate caller incorporates them into
 * the block message so users see why their acks were rejected.
 */
function loadAndValidateAcks(
    acksPath: string,
    entries: DriftEntry[]
): { valid: Ack[]; errors: string[] } {
    if (!existsSync(acksPath)) {
        return { valid: [], errors: [] };
    }

    let parsed: AcksFile;
    try {
        parsed = JSON.parse(readFileSync(acksPath, 'utf-8'));
    } catch (e) {
        return {
            valid: [],
            errors: [
                `drift-acks.json could not be parsed: ${
                    e instanceof Error ? e.message : String(e)
                }. Fix the JSON syntax — the gate ignores all acks until parsing succeeds.`,
            ],
        };
    }

    // Reject non-array acknowledgments instead of silently ignoring them —
    // a string or object would otherwise look like "no acks" with no error.
    if (parsed?.acknowledgments !== undefined && !Array.isArray(parsed.acknowledgments)) {
        return {
            valid: [],
            errors: [
                `drift-acks.json: "acknowledgments" must be an array, got ${typeof parsed.acknowledgments}. Wrap entries in [].`,
            ],
        };
    }

    const acks: Ack[] = Array.isArray(parsed?.acknowledgments)
        ? (parsed.acknowledgments as Ack[])
        : [];
    const valid: Ack[] = [];
    const errors: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const entryById = new Map<string, DriftEntry>();
    for (const e of entries) entryById.set(e.id, e);

    for (const ack of acks) {
        if (!ack || typeof ack !== 'object') {
            errors.push(`Ack entry is not an object: ${JSON.stringify(ack)}`);
            continue;
        }
        if (!ack.id || typeof ack.id !== 'string') {
            errors.push(`Ack missing required string field "id": ${JSON.stringify(ack)}`);
            continue;
        }
        const reason = typeof ack.reason === 'string' ? ack.reason.trim() : '';
        if (!reason) {
            errors.push(`Ack ${ack.id}: "reason" is missing or empty. Justification is required.`);
            continue;
        }
        const entry = entryById.get(ack.id);
        if (!entry) {
            errors.push(
                `Ack ${ack.id}: no matching [${ack.id}] entry in the drift report. Stale ack — remove it or update the id.`
            );
            continue;
        }
        if (entry.class !== 'DIVERGED') {
            errors.push(
                `Ack ${ack.id}: matching entry is ${entry.class}, not DIVERGED. Acks are only honored for DIVERGED entries.`
            );
            continue;
        }
        if (ack.expires_at !== undefined) {
            // Strict YYYY-MM-DD format. Rejects numbers, partial dates,
            // locale strings, and any non-string type.
            if (typeof ack.expires_at !== 'string' || !ISO_DATE_RE.test(ack.expires_at)) {
                errors.push(
                    `Ack ${ack.id}: "expires_at" must be a "YYYY-MM-DD" string, got ${JSON.stringify(ack.expires_at)}`
                );
                continue;
            }
            const expiry = new Date(`${ack.expires_at}T00:00:00Z`);
            if (Number.isNaN(expiry.getTime())) {
                errors.push(`Ack ${ack.id}: "expires_at" is not a valid calendar date: ${ack.expires_at}`);
                continue;
            }
            if (expiry < today) {
                errors.push(
                    `Ack ${ack.id}: expired on ${ack.expires_at}. Renew with a current justification or address the divergence.`
                );
                continue;
            }
        }
        valid.push(ack);
    }

    return { valid, errors };
}

/**
 * Evaluate the gate for a given feature directory.
 * Returns null if the report is missing or unparseable (caller treats null
 * as block — fail closed).
 *
 * Counts are derived from parsed [B<n>] entries with **Class:** lines, NOT
 * from the Summary table at the top of the report. An agent producing the
 * report could put `MISSING: 0` in the summary while listing real DIVERGED
 * entries below — only parsed entries count.
 */
function evaluateGate(reportPath: string, acksPath: string): GateResult | null {
    if (!existsSync(reportPath)) {
        return null;
    }

    let content: string;
    try {
        content = readFileSync(reportPath, 'utf-8');
    } catch {
        return null;
    }

    const entries = parseDriftEntries(content);
    let missing = 0;
    let divergedTotal = 0;
    for (const e of entries) {
        if (e.class === 'MISSING') missing++;
        else if (e.class === 'DIVERGED') divergedTotal++;
    }

    const { valid: validAcks, errors: ackErrors } = loadAndValidateAcks(acksPath, entries);
    const divergedAcked = validAcks.length;
    const divergedEffective = Math.max(0, divergedTotal - divergedAcked);

    return {
        passing: missing === 0 && divergedEffective === 0,
        missing,
        divergedTotal,
        divergedAcked,
        divergedEffective,
        ackErrors,
    };
}

/**
 * Extract the feature name from a build team name with strict allowlist.
 * Returns null if the team_name doesn't match the convention exactly.
 *
 * The allowlist excludes `.`, `/`, `\`, and whitespace, eliminating any
 * possibility of path traversal when the result is later joined with cwd.
 */
function extractFeatureName(teamName: string): string | null {
    const match = teamName.match(FEATURE_NAME_RE);
    return match ? match[1] : null;
}

function formatBlockMessage(
    teamName: string,
    featureName: string | null,
    result: GateResult | null
): string {
    const lines: string[] = [];
    lines.push(`BLOCKED: Cannot create build team "${teamName}" — pre-build drift check not passed.`);
    lines.push('');

    if (!featureName) {
        lines.push(
            `Build teams must use the naming convention "<feature-name>-build" where feature-name matches /^[a-z0-9][a-z0-9_-]{0,63}$/. Got: "${teamName}"`
        );
        lines.push('');
        lines.push(
            `Rename the team to follow the convention, then re-run the gate. The convention enables feature-specific drift report lookup and prevents path traversal in the gate hook.`
        );
        return lines.join('\n');
    }

    if (!result) {
        lines.push(`Drift report missing or unparseable: docs/specs/${featureName}/pre-build-drift.md`);
        lines.push('');
        lines.push(
            `Run /team-drift with the design as SOT and plan as target first, as specified in /team-build Step 2.`
        );
        return lines.join('\n');
    }

    lines.push(`Drift report: docs/specs/${featureName}/pre-build-drift.md`);
    lines.push(`  MISSING:  ${result.missing} (parsed from [B<n>] entries with Class: MISSING)`);
    lines.push(
        `  DIVERGED: ${result.divergedTotal} total, ${result.divergedAcked} acked, ${result.divergedEffective} effective`
    );
    lines.push('');
    if (result.missing > 0) {
        lines.push(
            `MISSING entries are not eligible for acknowledgment — they indicate the plan is incomplete relative to the design. Address them in the plan and re-run /team-drift.`
        );
    }
    if (result.divergedEffective > 0) {
        lines.push(
            `DIVERGED entries that are intentional and justified can be acknowledged in ` +
                `docs/specs/${featureName}/drift-acks.json:`
        );
        lines.push('');
        lines.push('  {');
        lines.push('    "acknowledgments": [');
        lines.push(
            '      { "id": "B1", "reason": "<non-empty justification>", "expires_at": "<YYYY-MM-DD, optional>" }'
        );
        lines.push('    ]');
        lines.push('  }');
        lines.push('');
        lines.push(
            `Do NOT revert valid changes to make the gate pass. Acknowledge them with a justification instead. See team-drift/references/drift-acks-template.json for the full schema and a worked example.`
        );
    }
    if (result.ackErrors.length > 0) {
        lines.push('');
        lines.push('Ack file rejected:');
        for (const err of result.ackErrors) {
            lines.push(`  - ${err}`);
        }
    }
    return lines.join('\n');
}

function main(): void {
    // Outermost frame: ONLY catches malformed stdin (hook input). This is
    // the only fail-open path — a broken harness must not block legitimate
    // work due to a hook bug parsing JSON. Everything inside the gate
    // decision below fails CLOSED.
    let input: TeamCreateInput;
    try {
        const rawInput = readFileSync(0, 'utf-8');
        input = JSON.parse(rawInput);
    } catch (error) {
        console.error(
            '[workflow-gate] Hook input parse error (non-blocking):',
            error instanceof Error ? error.message : error
        );
        process.exit(0);
    }

    if (input.tool_name !== 'TeamCreate') {
        process.exit(0);
    }

    const teamName = (input.tool_input?.team_name || '').toLowerCase();
    const description = (input.tool_input?.description || '').toLowerCase();

    // Detect build teams. We honor the description-based detection so a
    // team with `description: "build the X feature"` is also gated, but
    // we ALWAYS require the team_name to match the convention. The
    // previous behavior (description-only fallback that scanned all
    // features for any passing report) was a bypass: a passing report
    // for X authorized arbitrary teams Y. Fail closed instead.
    const isBuildTeam = teamName.includes('build') || description.includes('build');
    if (!isBuildTeam) {
        process.exit(0);
    }

    const cwd = input.cwd || process.cwd();
    const featureName = extractFeatureName(teamName);

    if (!featureName) {
        console.error(formatBlockMessage(teamName, null, null));
        process.exit(2);
    }

    // The allowlist guarantees featureName cannot escape via `..` or `/`,
    // but the join below is still the only place where featureName meets
    // the filesystem.
    const featureDir = join(cwd, 'docs', 'specs', featureName);
    const reportPath = join(featureDir, 'pre-build-drift.md');
    const acksPath = join(featureDir, 'drift-acks.json');

    let result: GateResult | null;
    try {
        result = evaluateGate(reportPath, acksPath);
    } catch (error) {
        // Fail CLOSED on unexpected errors inside the gate decision path.
        // Anything that throws here is either a corrupt report, an unreadable
        // acks file, or a hook bug — none of which should authorize a build.
        console.error(
            `BLOCKED: gate evaluation threw an unexpected error for "${teamName}":`,
            error instanceof Error ? error.message : error
        );
        process.exit(2);
    }

    if (!result || !result.passing) {
        console.error(formatBlockMessage(teamName, featureName, result));
        process.exit(2);
    }

    process.exit(0);
}

main();
