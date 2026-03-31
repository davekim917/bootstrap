#!/usr/bin/env bun
// @bun

// guards/workflow-gate-enforcement.ts
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
function isDriftReportPassing(reportPath) {
  if (!existsSync(reportPath))
    return false;
  try {
    const content = readFileSync(reportPath, "utf-8");
    const missingMatch = content.match(/MISSING\s*[:|]\s*(\d+)/i);
    const divergedMatch = content.match(/DIVERGED\s*[:|]\s*(\d+)/i);
    if (!missingMatch || !divergedMatch)
      return false;
    return parseInt(missingMatch[1], 10) === 0 && parseInt(divergedMatch[1], 10) === 0;
  } catch {
    return false;
  }
}
function extractFeatureName(teamName) {
  const match = teamName.match(/^(.+)-build$/);
  return match ? match[1] : null;
}
function main() {
  try {
    const rawInput = readFileSync(0, "utf-8");
    const input = JSON.parse(rawInput);
    const cwd = input.cwd || process.cwd();
    if (input.tool_name !== "TeamCreate") {
      process.exit(0);
    }
    const teamName = (input.tool_input?.team_name || "").toLowerCase();
    const description = (input.tool_input?.description || "").toLowerCase();
    const isBuildTeam = teamName.includes("build") || description.includes("build");
    if (!isBuildTeam) {
      process.exit(0);
    }
    const featureName = extractFeatureName(teamName);
    if (featureName) {
      const reportPath = join(cwd, ".context", "specs", featureName, "pre-build-drift.md");
      if (!isDriftReportPassing(reportPath)) {
        console.error(`BLOCKED: Cannot create build team "${teamName}" \u2014 pre-build drift check not passed.

` + `Expected a passing drift report at: .context/specs/${featureName}/pre-build-drift.md
` + `(MISSING: 0 and DIVERGED: 0 required)

` + `Run /team-drift with the design as SOT and plan as target first, as specified in /team-build Step 2.`);
        process.exit(2);
      }
    } else {
      const specsDir = join(cwd, ".context", "specs");
      if (!existsSync(specsDir)) {
        console.error(`BLOCKED: Cannot create build team \u2014 no .context/specs/ directory found.

` + `Run /team-drift (design vs. plan) first, as specified in /team-build Step 2.
` + `Tip: use the naming convention "<feature-name>-build" for build teams to enable ` + `feature-specific gate enforcement.`);
        process.exit(2);
      }
      try {
        const features = readdirSync(specsDir, { withFileTypes: true });
        const hasPassingReport = features.some((f) => {
          if (!f.isDirectory())
            return false;
          return isDriftReportPassing(join(specsDir, f.name, "pre-build-drift.md"));
        });
        if (!hasPassingReport) {
          console.error(`BLOCKED: Cannot create build team \u2014 no passing pre-build drift report found.

` + `Searched .context/specs/*/pre-build-drift.md \u2014 none found with MISSING: 0, DIVERGED: 0.

` + `Run /team-drift (design vs. plan) first, as specified in /team-build Step 2.`);
          process.exit(2);
        }
      } catch {
        process.exit(0);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error("[workflow-gate] Hook error (non-blocking):", error instanceof Error ? error.message : error);
    process.exit(0);
  }
}
main();
