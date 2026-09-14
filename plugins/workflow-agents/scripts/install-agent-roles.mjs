#!/usr/bin/env node
/**
 * Install this plugin's Codex named roles into `~/.codex/agents/`.
 *
 * Why a script and not plugin packaging: a Codex plugin can ship skills, MCP
 * servers, browser extensions and hooks — not agents. Codex reads named roles
 * only from `<CODEX_HOME>/agents/<name>.toml`, so a plugin that wants to offer
 * a worker role has to place the file there itself.
 *
 * Ownership is explicit and fail-closed. Every file this writes carries
 * OWNERSHIP_MARKER on line 1. An existing target is overwritten ONLY if it
 * carries that same marker. A file with a different manager's marker (NanoClaw's
 * `# managed by nanoclaw codex-sync` owns this exact filename on a NanoClaw
 * host) or with no marker at all is a refusal, never a clobber: report it and
 * let a human decide. Refusals are reported together and exit 1, so a partial
 * install is visible rather than silent.
 *
 * Usage:
 *   node plugins/workflow-agents/scripts/install-agent-roles.mjs           # dry run
 *   node plugins/workflow-agents/scripts/install-agent-roles.mjs --apply
 *   node plugins/workflow-agents/scripts/install-agent-roles.mjs --apply --codex-home ~/.codex-sibling
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OWNERSHIP_MARKER, managerOf } from './ownership.mjs';

export { OWNERSHIP_MARKER, managerOf } from './ownership.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROLES_DIR = path.resolve(HERE, '..', 'agents');

/**
 * Decide what to do with one role file. Pure: takes the desired content and the
 * current bytes (null when absent), returns an action plus the reason.
 */
export function planOne({ name, desired, current }) {
  if (current === null) return { name, action: 'create' };
  if (current === desired) return { name, action: 'unchanged' };
  const manager = managerOf(current);
  if (manager === OWNERSHIP_MARKER) return { name, action: 'update' };
  return {
    name,
    action: 'refuse',
    reason: manager
      ? `owned by another manager (${manager})`
      : 'hand-written (no "# managed by" marker on line 1)',
  };
}

export function plan({ rolesDir = ROLES_DIR, codexHome } = {}) {
  const home = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const target = path.join(home, 'agents');
  const files = fs.existsSync(rolesDir)
    ? fs.readdirSync(rolesDir).filter((f) => f.endsWith('.toml')).sort()
    : [];
  const items = files.map((file) => {
    const destination = path.join(target, file);
    const desired = fs.readFileSync(path.join(rolesDir, file), 'utf8');
    // ONLY ENOENT means absent. Treating every read failure as absence turns an
    // unreadable foreign file (EACCES, or EISDIR for a directory in its place)
    // into a `create`, and --apply then truncates exactly the file this script
    // exists to protect. Anything that is not ENOENT is a refusal.
    let current = null;
    try {
      current = fs.readFileSync(destination, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return {
          name: file,
          action: 'refuse',
          reason: `cannot be read (${error.code ?? error.message}) — refusing to assume it is absent`,
          source: path.join(rolesDir, file),
          destination,
        };
      }
    }
    return {
      ...planOne({ name: file, desired, current }),
      source: path.join(rolesDir, file),
      destination,
    };
  });
  return { target, items };
}

/**
 * Write one planned item, re-deciding ownership at write time.
 *
 * A plan is a snapshot, and the gap before apply is real: NanoClaw's
 * `syncCodexSubagents` (its watcher, or the one-shot CLI) writes its own
 * `# managed by nanoclaw codex-sync` role at this exact filename, and first
 * setup is precisely when both run. A plain `writeFileSync` on a planned
 * `create` would truncate that file — the never-clobber guarantee gone, and
 * NanoClaw's marker with it, so its later syncs would skip the role too.
 *
 * So `create` writes exclusively (`wx`) and, if the file appeared meanwhile,
 * re-decides from the bytes now on disk. `update` re-reads and re-checks the
 * marker immediately before swapping the file in by rename, which also means a
 * reader never sees a half-written role.
 *
 * The rename is atomic; the re-check before it is not a lock, so a writer that
 * lands in the microseconds between them still wins. Closing that fully needs
 * file locking neither manager has. What this removes is the wide, reliably-hit
 * window, not the theoretical one.
 */
function applyOne(item) {
  const content = fs.readFileSync(item.source, 'utf8');
  const dir = path.dirname(item.destination);
  fs.mkdirSync(dir, { recursive: true });

  // Bounded: each pass either writes, refuses, or observes the file flipping
  // between present and absent. A concurrent manager creating and deleting the
  // role forever is not a case worth spinning on — report rather than hang.
  let target = item;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (target.action === 'create') {
      try {
        fs.writeFileSync(target.destination, content, { flag: 'wx' });
        return target;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // It appeared between plan and write. Re-decide from the bytes now on
        // disk: not ours (or unreadable) refuses; ours but stale becomes the
        // atomic update below; vanished again retries the exclusive create.
        target = reread(target, content);
        if (target.action !== 'update' && target.action !== 'create') return target;
        continue;
      }
    }

    const rechecked = reread(target, content);
    if (rechecked.action === 'create') {
      target = rechecked; // deleted under us — go back around and create it
      continue;
    }
    if (rechecked.action !== 'update') return rechecked;

    const tmp = path.join(dir, `.${target.name}.${process.pid}.${Date.now().toString(36)}.tmp`);
    try {
      fs.writeFileSync(tmp, content, { flag: 'wx' });
      fs.renameSync(tmp, target.destination);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    return target;
  }
  return { ...target, action: 'refuse', reason: 'another manager kept changing this file while installing' };
}

/** Re-decide an item from the bytes currently on disk. */
function reread(item, desired) {
  let current;
  try {
    current = fs.readFileSync(item.destination, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ...item, action: 'create' };
    return {
      ...item,
      action: 'refuse',
      reason: `cannot be read before writing (${error.code ?? error.message}) — refusing to overwrite blind`,
    };
  }
  const decided = planOne({ name: item.name, desired, current });
  return { ...item, action: decided.action, reason: decided.reason };
}

/** Apply an existing plan. Separate from `plan` so the gap between them is testable. */
export function applyPlan(result) {
  return {
    ...result,
    items: result.items.map((item) =>
      item.action === 'create' || item.action === 'update' ? applyOne(item) : item,
    ),
  };
}

export function install({ rolesDir = ROLES_DIR, codexHome, apply = false } = {}) {
  const result = plan({ rolesDir, codexHome });
  return apply ? applyPlan(result) : result;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const homeFlag = argv.indexOf('--codex-home');
  const codexHome = homeFlag >= 0 ? argv[homeFlag + 1] : undefined;
  if (homeFlag >= 0 && !codexHome) {
    console.error('install-agent-roles: --codex-home needs a directory');
    process.exit(2);
  }

  const { target, items } = install({ codexHome, apply });
  if (items.length === 0) {
    console.error(`install-agent-roles: no role TOMLs in ${ROLES_DIR}`);
    process.exit(2);
  }
  console.log(`install-agent-roles: ${apply ? 'installing into' : 'dry run against'} ${target}`);
  for (const item of items) {
    const suffix = item.reason ? ` — ${item.reason}` : '';
    console.log(`  ${item.action.padEnd(9)} ${item.name}${suffix}`);
  }
  const refused = items.filter((i) => i.action === 'refuse');
  if (refused.length) {
    console.error(
      `\ninstall-agent-roles: refusing to overwrite ${refused.length} file(s) this plugin does not own. ` +
        'Resolve each by hand — remove the file, or keep the other manager and skip this role.',
    );
    process.exit(1);
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to write.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
