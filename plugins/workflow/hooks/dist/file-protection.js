#!/usr/bin/env bun
// @bun

// guards/file-protection.ts
import { readFileSync } from "fs";
var ALLOWED_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".gitignore",
  ".dockerignore"
];
var PROTECTED_SEGMENTS = [
  ".git/",
  ".git\\",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development"
];
var PROTECTED_GLOBS = [
  /^infra\/terraform\//,
  /^terraform\//
];
function isProtected(path) {
  if (!path)
    return false;
  for (const allowed of ALLOWED_FILES) {
    if (path.endsWith(allowed)) {
      return false;
    }
  }
  for (const segment of PROTECTED_SEGMENTS) {
    if (path.includes(segment)) {
      return true;
    }
  }
  for (const pattern of PROTECTED_GLOBS) {
    if (pattern.test(path)) {
      return true;
    }
  }
  return false;
}
function getFilePaths(input) {
  const toolInput = input.tool_input || {};
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => e?.file_path).filter((p) => typeof p === "string");
  }
  return toolInput.file_path ? [toolInput.file_path] : [];
}
function main() {
  try {
    if (process.env.SKIP_FILE_PROTECTION === "1") {
      console.error("[file-protection] Bypassed via SKIP_FILE_PROTECTION");
      process.exit(0);
    }
    const rawInput = readFileSync(0, "utf-8");
    const input = JSON.parse(rawInput);
    if (!["Edit", "MultiEdit", "Write"].includes(input.tool_name)) {
      process.exit(0);
    }
    const paths = getFilePaths(input);
    for (const path of paths) {
      if (isProtected(path)) {
        console.error(`
\u26A0\uFE0F BLOCKED: File protection guard
Path: ${path}
Reason: This path is protected from automated edits.
Bypass: export SKIP_FILE_PROTECTION=1 (temporary)
`);
        process.exit(2);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error("[file-protection] Hook error (non-blocking):", error instanceof Error ? error.message : error);
    process.exit(0);
  }
}
main();
