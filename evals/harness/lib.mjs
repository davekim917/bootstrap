/** Shared adapter helpers. */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Root of the bootstrap plugins tree (skills + agent defs live here). Resolved from
 * THIS file's location (evals/harness/lib.mjs → ../../plugins = <repo>/plugins), so the
 * harness works in any checkout (CI, /workspace/bootstrap, …), not just a ~/plugins/
 * home layout. Override with BOOTSTRAP_PLUGINS_DIR if the harness is relocated.
 */
export const PLUGINS =
  process.env.BOOTSTRAP_PLUGINS_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');

/**
 * Resolve a skill dir from the bootstrap plugins tree, STRICTLY within the requested
 * family — no cross-family fallback. `prefer` selects the family:
 *   'workflow-codex' → the augmented codex/opencode port (the thing under test)
 *   'workflow'       → the original Claude skill (parity baseline)
 * Strict on purpose: a silent fallback to the other family would let a Claude baseline
 * (prefer='workflow') evaluate the PORT instead of the original, masking a parity
 * regression — the baseline would "agree" with the port because it IS the port. A skill
 * missing from the requested family returns null; callers surface it as a provisioning
 * error rather than quietly comparing a port against itself.
 */
export function resolveSkillDir(name, prefer = 'workflow-codex') {
  const family = prefer === 'workflow' ? 'workflow/skills' : 'workflow-codex/skills';
  const d = path.join(PLUGINS, family, name);
  return fs.existsSync(path.join(d, 'SKILL.md')) ? d : null;
}

/**
 * Is `cmd` an executable on PATH? Used by adapter preflights so a missing agent CLI surfaces as
 * an ENV_ERROR up front, rather than passing preflight and failing mid-run (which would be
 * misattributed as an execution/result failure). `command -v` is the POSIX builtin for this.
 */
export function hasBinary(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a process, capture stdout/stderr, enforce a timeout.
 *
 * stdin:'ignore' is LOAD-BEARING for headless agent CLIs: both `opencode run`
 * and `codex exec` block reading stdin if it's an open pipe ("Reading additional
 * input from stdin..."), hanging to the timeout. Closing stdin lets them run.
 *
 * @returns {Promise<{code:number|null, out:string, err:string, timedOut:boolean}>}
 */
export function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          p.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, timedOut: killed });
    });
    p.on('error', () => resolve({ code: -1, out, err, timedOut: killed }));
  });
}

/** Query a sqlite db with `sqlite3 -json`; returns parsed rows ([] if empty). */
export function sqliteJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

/** Execute a non-query sqlite statement (DELETE/PRAGMA/…); best-effort, swallows errors. */
export function sqliteExec(dbPath, sql) {
  try {
    execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}
