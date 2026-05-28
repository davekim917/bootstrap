#!/usr/bin/env node
// Codex plugin SessionStart + PostToolUse hook (node runtime, wired via
// workflow-hooks.json). Owns the non-guard responsibilities only:
//   - SessionStart: sync managed agent TOMLs into ~/.codex/agents
//   - PostToolUse:  track edited files (telemetry) + optional payload logging
//
// The destructive-command + file-protection GUARD is NOT here. It lives in the
// shared cross-runtime core (guards/block-destructive-core.ts +
// guards/file-protection-core.ts) behind the thin `codex-guard.ts` adapter,
// which workflow-hooks.json wires to PreToolUse (via bun). That is the single
// source of truth shared with the Claude and OpenCode guards — this file used
// to hand-roll a weaker parallel copy (string/token matching instead of the
// unbash AST, missing the gated-infra tier), which has been removed to keep the
// guard develop-once. EDIT_TOOLS / getFilePaths below are retained ONLY for
// edit telemetry (trackEditedFiles); they are not a protection surface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'MultiEdit', 'Write', 'edit', 'write_file', 'create_file']);
const MANAGED_MARKERS = [
  'managed by bootstrap-workflow-agents agent-sync',
  'managed by nanoclaw codex-sync',
];

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function maybeLogPayload(input) {
  const mode = process.env.BOOTSTRAP_CODEX_HOOK_LOG;
  if (!mode) return;

  const now = new Date();
  const logDir =
    process.env.BOOTSTRAP_CODEX_HOOK_LOG_DIR ||
    path.join(os.homedir(), '.codex', 'bootstrap-workflow', 'hook-payloads');
  const entry = {
    ts: now.toISOString(),
    hook_event_name: input.hook_event_name,
    tool_name: input.tool_name,
    cwd: input.cwd,
    top_level_keys: Object.keys(input || {}).sort(),
    tool_input_keys: input.tool_input && typeof input.tool_input === 'object'
      ? Object.keys(input.tool_input).sort()
      : [],
    tool_response_keys: input.tool_response && typeof input.tool_response === 'object'
      ? Object.keys(input.tool_response).sort()
      : [],
  };

  if (mode === 'full') {
    entry.payload = input;
  }

  appendJsonl(path.join(logDir, `${now.toISOString().slice(0, 10)}.jsonl`), entry);
}

function filePathsFromPatch(text) {
  if (typeof text !== 'string') return [];
  const paths = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

function getFilePaths(input) {
  const toolInput = input.tool_input || {};
  const paths = [];

  for (const key of ['file_path', 'path']) {
    if (typeof toolInput[key] === 'string') paths.push(toolInput[key]);
  }
  for (const key of ['paths', 'files']) {
    if (Array.isArray(toolInput[key])) {
      for (const value of toolInput[key]) if (typeof value === 'string') paths.push(value);
    }
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === 'string') paths.push(edit.file_path);
      if (edit && typeof edit.path === 'string') paths.push(edit.path);
    }
  }
  paths.push(...filePathsFromPatch(toolInput.patch || toolInput.diff || toolInput.input));

  return [...new Set(paths.filter(Boolean))];
}

function trackEditedFiles(input) {
  if (input.hook_event_name !== 'PostToolUse') return;
  if (!EDIT_TOOLS.has(input.tool_name)) return;

  const exitCode = input.tool_response?.exit_code ?? input.tool_output?.exit_code;
  if (exitCode !== undefined && exitCode !== 0) return;

  const paths = getFilePaths(input);
  if (paths.length === 0) return;

  const sessionId = input.session_id || 'default';
  const cwd = input.cwd || process.cwd();
  const cacheDir = path.join(os.homedir(), '.codex', 'bootstrap-workflow', 'sessions', sessionId);
  fs.mkdirSync(cacheDir, { recursive: true });

  const ts = Math.floor(Date.now() / 1000);
  const editedLog = path.join(cacheDir, 'edited-files.log');
  const affectedRepos = new Set();

  for (const filePath of paths) {
    fs.appendFileSync(editedLog, `${ts}\t${input.tool_name}\t${filePath}\n`);
    const relative = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
    const first = relative.split(/[\\/]/).filter(Boolean)[0] || 'root';
    affectedRepos.add(relative.includes(path.sep) || relative.includes('/') ? first : 'root');
  }

  fs.writeFileSync(path.join(cacheDir, 'affected-repos.txt'), `${[...affectedRepos].sort().join('\n')}\n`);
}

function syncManagedAgents() {
  if (process.env.BOOTSTRAP_CODEX_AGENT_SYNC === '0') return;

  const sourceDir = path.join(PLUGIN_ROOT, 'agents');
  if (!fs.existsSync(sourceDir)) return;

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const targetDir = process.env.BOOTSTRAP_CODEX_AGENT_TARGET || path.join(codexHome, 'agents');
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of fs.readdirSync(sourceDir).filter((name) => name.endsWith('.toml'))) {
    const sourcePath = path.join(sourceDir, file);
    const targetPath = path.join(targetDir, file);
    const next = fs.readFileSync(sourcePath, 'utf8');

    if (fs.existsSync(targetPath)) {
      const current = fs.readFileSync(targetPath, 'utf8');
      if (!MANAGED_MARKERS.some((marker) => current.includes(marker))) continue;
      if (current === next) continue;
    }

    fs.writeFileSync(targetPath, next);
  }
}

function main() {
  const input = readInput();
  maybeLogPayload(input);

  try {
    if (input.hook_event_name === 'SessionStart') syncManagedAgents();
    trackEditedFiles(input);
  } catch (error) {
    process.stderr.write(`[bootstrap-workflow-agents] hook error: ${error?.message || error}\n`);
  }
}

main();
