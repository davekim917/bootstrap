#!/usr/bin/env bun
// @bun

// guards/workflow-gate-enforcement.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
var FEATURE_NAME_RE = /^([a-z0-9][a-z0-9_-]{0,63})-build$/;
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function stripCodeFences(content) {
  return content.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}
function parseDriftEntries(rawContent) {
  const content = stripCodeFences(rawContent.replace(/\r\n/g, `
`));
  const entries = [];
  const blockRegex = /(?:^|\n)###\s*\[(B\d+)\][^\n]*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/g;
  let m;
  while ((m = blockRegex.exec(content)) !== null) {
    const id = m[1];
    const body = m[2];
    const classMatch = body.match(/\*\*Class:\*\*\s*(MISSING|DIVERGED)/i);
    const cls = classMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
    entries.push({ id, class: cls });
  }
  return entries;
}
function loadAndValidateAcks(acksPath, entries) {
  if (!existsSync(acksPath)) {
    return { valid: [], errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(acksPath, "utf-8"));
  } catch (e) {
    return {
      valid: [],
      errors: [
        `drift-acks.json could not be parsed: ${e instanceof Error ? e.message : String(e)}. Fix the JSON syntax \u2014 the gate ignores all acks until parsing succeeds.`
      ]
    };
  }
  if (parsed?.acknowledgments !== undefined && !Array.isArray(parsed.acknowledgments)) {
    return {
      valid: [],
      errors: [
        `drift-acks.json: "acknowledgments" must be an array, got ${typeof parsed.acknowledgments}. Wrap entries in [].`
      ]
    };
  }
  const acks = Array.isArray(parsed?.acknowledgments) ? parsed.acknowledgments : [];
  const valid = [];
  const errors = [];
  const today = new Date;
  today.setUTCHours(0, 0, 0, 0);
  const entryById = new Map;
  for (const e of entries)
    entryById.set(e.id, e);
  for (const ack of acks) {
    if (!ack || typeof ack !== "object") {
      errors.push(`Ack entry is not an object: ${JSON.stringify(ack)}`);
      continue;
    }
    if (!ack.id || typeof ack.id !== "string") {
      errors.push(`Ack missing required string field "id": ${JSON.stringify(ack)}`);
      continue;
    }
    const reason = typeof ack.reason === "string" ? ack.reason.trim() : "";
    if (!reason) {
      errors.push(`Ack ${ack.id}: "reason" is missing or empty. Justification is required.`);
      continue;
    }
    const entry = entryById.get(ack.id);
    if (!entry) {
      errors.push(`Ack ${ack.id}: no matching [${ack.id}] entry in the drift report. Stale ack \u2014 remove it or update the id.`);
      continue;
    }
    if (entry.class !== "DIVERGED") {
      errors.push(`Ack ${ack.id}: matching entry is ${entry.class}, not DIVERGED. Acks are only honored for DIVERGED entries.`);
      continue;
    }
    if (ack.expires_at !== undefined) {
      if (typeof ack.expires_at !== "string" || !ISO_DATE_RE.test(ack.expires_at)) {
        errors.push(`Ack ${ack.id}: "expires_at" must be a "YYYY-MM-DD" string, got ${JSON.stringify(ack.expires_at)}`);
        continue;
      }
      const expiry = new Date(`${ack.expires_at}T00:00:00Z`);
      if (Number.isNaN(expiry.getTime())) {
        errors.push(`Ack ${ack.id}: "expires_at" is not a valid calendar date: ${ack.expires_at}`);
        continue;
      }
      if (expiry < today) {
        errors.push(`Ack ${ack.id}: expired on ${ack.expires_at}. Renew with a current justification or address the divergence.`);
        continue;
      }
    }
    valid.push(ack);
  }
  return { valid, errors };
}
function evaluateGate(reportPath, acksPath) {
  if (!existsSync(reportPath)) {
    return null;
  }
  let content;
  try {
    content = readFileSync(reportPath, "utf-8");
  } catch {
    return null;
  }
  const entries = parseDriftEntries(content);
  let missing = 0;
  let divergedTotal = 0;
  for (const e of entries) {
    if (e.class === "MISSING")
      missing++;
    else if (e.class === "DIVERGED")
      divergedTotal++;
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
    ackErrors
  };
}
function extractFeatureName(teamName) {
  const match = teamName.match(FEATURE_NAME_RE);
  return match ? match[1] : null;
}
function formatBlockMessage(teamName, featureName, result) {
  const lines = [];
  lines.push(`BLOCKED: Cannot create build team "${teamName}" \u2014 pre-build drift check not passed.`);
  lines.push("");
  if (!featureName) {
    lines.push(`Build teams must use the naming convention "<feature-name>-build" where feature-name matches /^[a-z0-9][a-z0-9_-]{0,63}$/. Got: "${teamName}"`);
    lines.push("");
    lines.push(`Rename the team to follow the convention, then re-run the gate. The convention enables feature-specific drift report lookup and prevents path traversal in the gate hook.`);
    return lines.join(`
`);
  }
  if (!result) {
    lines.push(`Drift report missing or unparseable: .context/specs/${featureName}/pre-build-drift.md`);
    lines.push("");
    lines.push(`Run /team-drift with the design as SOT and plan as target first, as specified in /team-build Step 2.`);
    return lines.join(`
`);
  }
  lines.push(`Drift report: .context/specs/${featureName}/pre-build-drift.md`);
  lines.push(`  MISSING:  ${result.missing} (parsed from [B<n>] entries with Class: MISSING)`);
  lines.push(`  DIVERGED: ${result.divergedTotal} total, ${result.divergedAcked} acked, ${result.divergedEffective} effective`);
  lines.push("");
  if (result.missing > 0) {
    lines.push(`MISSING entries are not eligible for acknowledgment \u2014 they indicate the plan is incomplete relative to the design. Address them in the plan and re-run /team-drift.`);
  }
  if (result.divergedEffective > 0) {
    lines.push(`DIVERGED entries that are intentional and justified can be acknowledged in ` + `.context/specs/${featureName}/drift-acks.json:`);
    lines.push("");
    lines.push("  {");
    lines.push('    "acknowledgments": [');
    lines.push('      { "id": "B1", "reason": "<non-empty justification>", "expires_at": "<YYYY-MM-DD, optional>" }');
    lines.push("    ]");
    lines.push("  }");
    lines.push("");
    lines.push(`Do NOT revert valid changes to make the gate pass. Acknowledge them with a justification instead. See team-drift/references/drift-acks-template.json for the full schema and a worked example.`);
  }
  if (result.ackErrors.length > 0) {
    lines.push("");
    lines.push("Ack file rejected:");
    for (const err of result.ackErrors) {
      lines.push(`  - ${err}`);
    }
  }
  return lines.join(`
`);
}
function main() {
  let input;
  try {
    const rawInput = readFileSync(0, "utf-8");
    input = JSON.parse(rawInput);
  } catch (error) {
    console.error("[workflow-gate] Hook input parse error (non-blocking):", error instanceof Error ? error.message : error);
    process.exit(0);
  }
  if (input.tool_name !== "TeamCreate") {
    process.exit(0);
  }
  const teamName = (input.tool_input?.team_name || "").toLowerCase();
  const description = (input.tool_input?.description || "").toLowerCase();
  const isBuildTeam = teamName.includes("build") || description.includes("build");
  if (!isBuildTeam) {
    process.exit(0);
  }
  const cwd = input.cwd || process.cwd();
  const featureName = extractFeatureName(teamName);
  if (!featureName) {
    console.error(formatBlockMessage(teamName, null, null));
    process.exit(2);
  }
  const featureDir = join(cwd, ".context", "specs", featureName);
  const reportPath = join(featureDir, "pre-build-drift.md");
  const acksPath = join(featureDir, "drift-acks.json");
  let result;
  try {
    result = evaluateGate(reportPath, acksPath);
  } catch (error) {
    console.error(`BLOCKED: gate evaluation threw an unexpected error for "${teamName}":`, error instanceof Error ? error.message : error);
    process.exit(2);
  }
  if (!result || !result.passing) {
    console.error(formatBlockMessage(teamName, featureName, result));
    process.exit(2);
  }
  process.exit(0);
}
main();
