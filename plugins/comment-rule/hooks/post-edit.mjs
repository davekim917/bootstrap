#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = path.join(os.tmpdir(), 'comment-rule-feedback');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function loadReported(file) {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).map(([key, texts]) => [key, new Set(texts)]));
  } catch {
    return new Map();
  }
}

function saveReported(file, reported) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...reported].map(([key, texts]) => [key, [...texts]]))));
  } catch {}
}

/** Feedback only: every failure path exits 0 with no output, so a broken checker never stalls an edit. */
async function main() {
  const input = readStdin();
  if (!input) return;
  const { editedFiles, feedbackMessage } = await import('../lib/feedback.mjs');
  const files = editedFiles(input.tool_input, input.cwd || process.cwd());
  if (files.length === 0) return;
  try {
    module.enableCompileCache?.(path.join(os.tmpdir(), 'comment-rule-compile-cache'));
  } catch {}
  const { checkFileAgainstHead } = await import('../lib/check.mjs');
  const results = files.map((file) => {
    try {
      return checkFileAgainstHead(file);
    } catch {
      return null;
    }
  });
  const session = crypto.createHash('sha256').update(String(input.session_id ?? 'none')).digest('hex').slice(0, 24);
  const stateFile = path.join(STATE_DIR, `${session}.json`);
  const reported = loadReported(stateFile);
  const message = feedbackMessage(results, reported);
  if (!message) return;
  saveReported(stateFile, reported);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } }),
  );
}

main().catch(() => {});
