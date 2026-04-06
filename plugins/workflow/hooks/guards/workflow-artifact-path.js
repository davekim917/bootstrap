#!/usr/bin/env bun
// @bun

// guards/workflow-artifact-path.ts
import { readFileSync } from "fs";
import { basename, relative } from "path";
var ARTIFACT_PATTERNS = [
  /brief\.md$/i,
  /design\.md$/i,
  /plan\.md$/i,
  /decisions\.ya?ml$/i,
  /review\.md$/i,
  /qa-report\.md$/i,
  /drift.*\.md$/i,
  /build-state\.md$/i,
  /project-scope\.md$/i
];
var EMBEDDED_NAME_PATTERNS = [
  /-brief\.md$/i,
  /-design\.md$/i,
  /-plan\.md$/i,
  /-decisions\.ya?ml$/i,
  /-review\.md$/i,
  /-project-scope\.md$/i
];
function isCanonicalPath(filePath, cwd) {
  const rel = relative(cwd, filePath);
  if (rel.startsWith(".context/specs/"))
    return true;
  if (rel === ".claude/project-scope.md")
    return true;
  if (rel.startsWith(".claude/tmp/"))
    return true;
  return false;
}
function main() {
  try {
    const rawInput = readFileSync(0, "utf-8");
    const input = JSON.parse(rawInput);
    if (input.tool_name !== "Write") {
      process.exit(0);
    }
    const filePath = input.tool_input?.file_path;
    if (!filePath) {
      process.exit(0);
    }
    const cwd = input.cwd || process.cwd();
    const name = basename(filePath);
    const isArtifactName = ARTIFACT_PATTERNS.some((p) => p.test(name));
    const hasEmbeddedFeatureName = EMBEDDED_NAME_PATTERNS.some((p) => p.test(name));
    if (!isArtifactName && !hasEmbeddedFeatureName) {
      process.exit(0);
    }
    if (isCanonicalPath(filePath, cwd)) {
      process.exit(0);
    }
    const rel = relative(cwd, filePath);
    if (hasEmbeddedFeatureName) {
      console.error(`WARNING: You are writing "${rel}" which looks like a workflow artifact ` + `with a feature name embedded in the filename.

` + `The team workflow skills save artifacts to .context/specs/<feature>/<type>.md \u2014 ` + `not as flat files with the feature name in the filename.

` + `Did you invoke the skill via the Skill tool (e.g., Skill({ skill: "team-brief" }))? ` + `If not, you are approximating the skill from its description. ` + `Stop and invoke the actual skill instead.`);
    } else {
      console.error(`WARNING: You are writing "${rel}" which looks like a workflow artifact ` + `but is not under .context/specs/.

` + `The team workflow skills save artifacts to .context/specs/<feature>/<type>.md.

` + `Did you invoke the skill via the Skill tool? ` + `If not, you may be approximating the workflow. ` + `Consider invoking the actual skill (e.g., /team-brief, /team-design, /team-plan) instead.`);
    }
    process.exit(0);
  } catch (error) {
    process.exit(0);
  }
}
main();
