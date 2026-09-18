#!/usr/bin/env node
// Suggest a sub-agent model + effort for a task brief from references/dispatch-rubric.json.
//
//   echo "<task brief>" | node pick-dispatch.mjs --runtime claude|codex [--actual "<model> <effort>"]
//
// Prints one JSON object and always exits 0: a missing key, a network error or a
// bad answer yields decision "unavailable", and the caller carries on exactly as
// it would without this script. Each run is logged next to what was dispatched.
import fs from 'node:fs';

import { logDispatch, pick } from './dispatch-lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const runtime = arg('runtime') === 'codex' ? 'codex' : 'claude';
const actual = arg('actual') ?? null;
const task = fs.readFileSync(0, 'utf8').trim();
const out = { ...(await pick(task, runtime)), actual };
process.stdout.write(JSON.stringify(out) + '\n');
logDispatch({ source: 'skill', task: task.slice(0, 2000), ...out });
