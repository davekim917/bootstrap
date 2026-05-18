#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_TOOLS = new Set(['exec_command', 'local_shell_call', 'shell', 'Bash']);
const EDIT_TOOLS = new Set(['apply_patch', 'Edit', 'MultiEdit', 'Write', 'edit', 'write_file', 'create_file']);
const MANAGED_MARKERS = [
  'managed by bootstrap-workflow-codex agent-sync',
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

function commandFromInput(toolInput = {}) {
  if (typeof toolInput.command === 'string') return toolInput.command;
  if (Array.isArray(toolInput.command)) return toolInput.command.join(' ');
  if (typeof toolInput.cmd === 'string') return toolInput.cmd;
  if (Array.isArray(toolInput.cmd)) return toolInput.cmd.join(' ');
  return '';
}

function shellWords(segment) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) words.push(current);
  return words;
}

function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === ';' || ch === '|' || (ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i += 1;
      continue;
    }
    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function stripWrappers(tokens) {
  const wrappers = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'nice']);
  let index = 0;
  while (index < tokens.length && wrappers.has(tokens[index])) index += 1;
  if (tokens[index] === 'env') {
    index += 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  }
  return tokens.slice(index);
}

function isSafeRmTarget(target) {
  return [
    /(^|\/)tmp(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.next(\/|$)/,
    /(^|\/)dist(\/|$)/,
    /(^|\/)build(\/|$)/,
    /(^|\/)\.cache(\/|$)/,
    /(^|\/)coverage(\/|$)/,
    /(^|\/)__pycache__(\/|$)/,
    /(^|\/)\.pytest_cache(\/|$)/,
  ].some((rx) => rx.test(target));
}

function isProtectedRmTarget(target) {
  if (!target) return false;
  if (target === '/' || target === '~' || target === '$HOME' || target === os.homedir()) return true;
  return /(^|\/)(\.git|\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.claude|\.codex|\.agents)(\/|$)/.test(target) ||
    /(^|\/)(Documents|Desktop|Downloads|Library|Pictures|Music|Movies)(\/|$)/.test(target);
}

function block(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function checkDestructiveCommand(input) {
  if (!SHELL_TOOLS.has(input.tool_name)) return;
  if (process.env.SKIP_BOOTSTRAP_DESTRUCTIVE_GUARD === '1') return;

  const command = commandFromInput(input.tool_input || {});
  if (!command) return;

  if (/\b(eval|unlink|shred|truncate)\b/.test(command)) {
    block('BLOCKED: bootstrap-workflow-codex destructive command guard blocked eval/unlink/shred/truncate.');
  }
  if (/\bfind\b[\s\S]*\s(?:-delete|-exec\s+rm\b)/.test(command)) {
    block('BLOCKED: bootstrap-workflow-codex destructive command guard blocked find deletion.');
  }
  if (/\bxargs\b[\s\S]*\brm\b/.test(command)) {
    block('BLOCKED: bootstrap-workflow-codex destructive command guard blocked xargs rm.');
  }
  if (/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*[fd])\b/.test(command)) {
    block('BLOCKED: bootstrap-workflow-codex destructive command guard blocked destructive git cleanup.');
  }

  for (const segment of splitSegments(command)) {
    const tokens = stripWrappers(shellWords(segment));
    if (tokens[0] !== 'rm') continue;

    const targets = tokens.slice(1).filter((token) => !token.startsWith('-'));
    if (targets.length === 0) continue;
    if (targets.every(isSafeRmTarget)) continue;

    const protectedTarget = targets.find(isProtectedRmTarget);
    if (protectedTarget) {
      block(`BLOCKED: bootstrap-workflow-codex destructive command guard blocked rm targeting protected path: ${protectedTarget}`);
    }

    block('BLOCKED: bootstrap-workflow-codex destructive command guard blocks rm outside ephemeral directories. Use a recoverable trash command or ask the user.');
  }
}

const ALLOWED_FILES = ['.env.example', '.env.sample', '.env.template', '.gitignore', '.dockerignore'];
const PROTECTED_SEGMENTS = [
  '.git/',
  '.git\\',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
];
const PROTECTED_GLOBS = [/^infra\/terraform\//, /^terraform\//];

function isProtectedPath(filePath) {
  if (!filePath) return false;
  if (ALLOWED_FILES.some((allowed) => filePath.endsWith(allowed))) return false;
  if (PROTECTED_SEGMENTS.some((segment) => filePath.includes(segment))) return true;
  return PROTECTED_GLOBS.some((rx) => rx.test(filePath));
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

function checkFileProtection(input) {
  if (process.env.SKIP_BOOTSTRAP_FILE_PROTECTION === '1') return;
  if (!EDIT_TOOLS.has(input.tool_name)) return;

  for (const filePath of getFilePaths(input)) {
    if (isProtectedPath(filePath)) {
      block(`BLOCKED: bootstrap-workflow-codex file protection guard blocked protected path: ${filePath}`);
    }
  }
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
    if (input.hook_event_name === 'PreToolUse') {
      checkDestructiveCommand(input);
      checkFileProtection(input);
    }
    trackEditedFiles(input);
  } catch (error) {
    if (input.hook_event_name === 'PreToolUse') {
      process.stderr.write(`[bootstrap-workflow-codex] hook error; failing open: ${error?.message || error}\n`);
    }
  }
}

main();
