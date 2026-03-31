#!/usr/bin/env bun
// @bun

// quality/tsc-check.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync as existsSync2, readdirSync, statSync, rmSync } from "fs";
import { join as join2, basename } from "path";
import { execSync } from "child_process";

// lib/project-detection.ts
import { existsSync } from "fs";
import { dirname, join } from "path";
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== "/" && dir !== ".") {
    if (existsSync(join(dir, ".claude"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}
function getProjectDir(input) {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  const startDir = input.cwd || process.cwd();
  const found = findProjectRoot(startDir);
  if (found) {
    return found;
  }
  return startDir;
}

// quality/tsc-check.ts
var TS_EXTENSIONS = /\.(ts|tsx|js|jsx)$/;
var CACHE_DIR = join2(process.env.HOME || "/root", ".claude", "tsc-cache");
function getCacheDir(sessionId) {
  const dir = join2(CACHE_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function getFilePaths(input) {
  const toolInput = input.tool_input || {};
  if (input.tool_name === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => e?.file_path).filter((p) => typeof p === "string");
  }
  return toolInput.file_path ? [toolInput.file_path] : [];
}
function hasTsConfig(projectDir) {
  return existsSync2(join2(projectDir, "tsconfig.json"));
}
function runTscCheck(projectDir) {
  try {
    const output = execSync("npx tsc --noEmit 2>&1", {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 60000
    });
    return { success: true, output, errorCount: 0 };
  } catch (error) {
    const output = error.stdout || error.message || "";
    const errorCount = (output.match(/error TS/g) || []).length;
    return { success: false, output, errorCount };
  }
}
function cleanOldCache() {
  try {
    if (!existsSync2(CACHE_DIR))
      return;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const entries = readdirSync(CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = join2(CACHE_DIR, entry.name);
        const stats = statSync(dirPath);
        if (stats.mtimeMs < sevenDaysAgo) {
          rmSync(dirPath, { recursive: true, force: true });
        }
      }
    }
  } catch {}
}
async function main() {
  try {
    const rawInput = readFileSync(0, "utf-8");
    const input = JSON.parse(rawInput);
    if (!["Write", "Edit", "MultiEdit"].includes(input.tool_name)) {
      process.exit(0);
    }
    const filePaths = getFilePaths(input);
    const tsFilesModified = filePaths.filter((p) => TS_EXTENSIONS.test(p));
    if (tsFilesModified.length === 0) {
      process.exit(0);
    }
    const projectDir = getProjectDir(input);
    if (!hasTsConfig(projectDir)) {
      process.exit(0);
    }
    console.error("\u26A1 Running TypeScript check...");
    const { success, output, errorCount } = runTscCheck(projectDir);
    if (!success || errorCount > 0) {
      const sessionId = input.session_id || "default";
      const cacheDir = getCacheDir(sessionId);
      const projectName = basename(projectDir);
      writeFileSync(join2(cacheDir, "last-errors.txt"), output);
      writeFileSync(join2(cacheDir, "affected-repos.txt"), projectName);
      writeFileSync(join2(cacheDir, "tsc-commands.txt"), `# TSC Command
${projectName}: npx tsc --noEmit`);
      console.error("\u274C TypeScript errors found");
      console.error("");
      console.error("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
      console.error(`\uD83D\uDEA8 TypeScript validation failed - ${errorCount} error(s) found`);
      console.error("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
      console.error("");
      console.error("\uD83D\uDCDD Error preview (first 10):");
      const errorLines = output.split(`
`).filter((line) => line.includes("error TS"));
      errorLines.slice(0, 10).forEach((line) => console.error(line));
      if (errorCount > 10) {
        console.error(`... and ${errorCount - 10} more error(s)`);
      }
      console.error("");
      console.error(`\uD83D\uDCA1 Full error details saved to: ${cacheDir}/last-errors.txt`);
      console.error("\uD83D\uDD27 Run 'npx tsc --noEmit' to see full output");
      console.error("");
      console.error("\u26A0\uFE0F  WE DO NOT LEAVE A MESS BEHIND");
      process.exit(1);
    } else {
      console.error("\u2705 TypeScript check passed");
    }
    cleanOldCache();
    process.exit(0);
  } catch (error) {
    console.error("[tsc-check] Hook error (non-blocking):", error instanceof Error ? error.message : error);
    process.exit(0);
  }
}
main();
