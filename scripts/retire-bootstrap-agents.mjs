#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNERSHIP_MARKER = '# managed by bootstrap-workflow-agents agent-sync';
export const RETIRED_AGENT_NAMES = Object.freeze([
  'architecture-advisor',
  'code-review-specialist',
  'cpo-advisor',
  'cto-advisor',
  'performance-analyzer',
  'security-reviewer',
]);

const RETIRED = new Set(RETIRED_AGENT_NAMES);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hasExactMarker(content) {
  return content.split(/\n/).some((line) => line.replace(/\r$/, '') === OWNERSHIP_MARKER);
}

function existingDirectories(candidates) {
  return candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

export function activeAgentDirectories(home) {
  const candidates = [
    path.join(home, '.claude', 'agents'),
    path.join(home, '.config', 'opencode', 'agent'),
  ];

  for (const parent of [home, path.join(home, '.local', 'share')]) {
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (parent === home && entry.name.startsWith('.codex')) {
        candidates.push(path.join(parent, entry.name, 'agents'));
      }
      if (parent !== home && entry.name.startsWith('opencode')) {
        candidates.push(path.join(parent, entry.name, 'agent'));
      }
    }
  }

  return [...new Set(existingDirectories(candidates).map((entry) => path.resolve(entry)))].sort();
}

export function discoverRetiredAgents({ home = os.homedir() } = {}) {
  const resolvedHome = path.resolve(home);
  const targets = [];
  const unmanagedCollisions = [];

  for (const directory of activeAgentDirectories(resolvedHome)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const agentName = path.parse(entry.name).name;
      if (!RETIRED.has(agentName)) continue;

      const source = path.join(directory, entry.name);
      const content = fs.readFileSync(source);
      const record = {
        name: agentName,
        source,
        homeRelativePath: path.relative(resolvedHome, source),
        sha256: sha256(content),
      };
      if (hasExactMarker(content.toString('utf8'))) targets.push(record);
      else unmanagedCollisions.push(record);
    }
  }

  return {
    home: resolvedHome,
    targets: targets.sort((a, b) => a.source.localeCompare(b.source)),
    unmanagedCollisions: unmanagedCollisions.sort((a, b) => a.source.localeCompare(b.source)),
  };
}

function timestampedQuarantineRoot(stateRoot, now) {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  let candidate = path.join(stateRoot, stamp);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(stateRoot, `${stamp}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function validateActiveTarget(target) {
  let current;
  try {
    const stat = fs.lstatSync(target.source);
    if (!stat.isFile()) throw new Error('source is no longer a regular file');
    current = fs.readFileSync(target.source);
  } catch (error) {
    throw new Error(`Refusing to remove changed target ${target.source}: ${error.message}`);
  }
  if (sha256(current) !== target.sha256 || !hasExactMarker(current.toString('utf8'))) {
    throw new Error(`Refusing to remove changed target ${target.source}: content or ownership marker changed`);
  }
}

export function runRetirement({
  home = os.homedir(),
  stateRoot,
  apply = false,
  now = () => new Date(),
  beforeRemove,
} = {}) {
  const discovery = discoverRetiredAgents({ home });
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    ...discovery,
    quarantineRoot: null,
    manifestPath: null,
    removed: [],
  };

  if (!apply || discovery.targets.length === 0) return result;

  const resolvedStateRoot = path.resolve(
    stateRoot ?? path.join(discovery.home, '.bootstrap-workflow-agent-quarantine'),
  );
  const quarantineRoot = timestampedQuarantineRoot(resolvedStateRoot, now);
  const manifestPath = path.join(quarantineRoot, 'manifest.json');

  for (const target of discovery.targets) {
    if (target.homeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(target.homeRelativePath)) {
      throw new Error(`Refusing to quarantine path outside home: ${target.source}`);
    }
  }

  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const manifest = {
    createdAt: now().toISOString(),
    home: discovery.home,
    files: discovery.targets.map((target) => ({
      source: target.source,
      sha256: target.sha256,
      quarantineRelativePath: target.homeRelativePath,
    })),
  };

  // Complete and record the recoverable copy before removing any active definition.
  for (const target of discovery.targets) {
    const destination = path.join(quarantineRoot, target.homeRelativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(target.source, destination, fs.constants.COPYFILE_EXCL);
    const copiedHash = sha256(fs.readFileSync(destination));
    if (copiedHash !== target.sha256) {
      throw new Error(`Quarantine verification failed for ${target.source}`);
    }
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });

  if (beforeRemove) beforeRemove({ quarantineRoot, manifestPath, targets: discovery.targets });

  // The active files may be rewritten by a runtime sync watcher while quarantine is being
  // prepared. Revalidate the whole removal set before deleting any file so a changed
  // customization is preserved and the operation fails without a partial removal.
  for (const target of discovery.targets) {
    validateActiveTarget(target);
  }

  for (const target of discovery.targets) {
    // Narrow the remaining watcher race: check the exact file once more immediately before
    // unlink. The full pass above is still load-bearing because it prevents a pre-existing
    // change in a later target from causing partial cleanup.
    validateActiveTarget(target);
    fs.unlinkSync(target.source);
    result.removed.push(target.source);
  }

  result.quarantineRoot = quarantineRoot;
  result.manifestPath = manifestPath;
  return result;
}

function parseArgs(argv) {
  const options = { apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--home' || arg === '--state-root') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options[arg === '--home' ? 'home' : 'stateRoot'] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printResult(result) {
  console.log(`Bootstrap retired-agent cleanup (${result.mode})`);
  for (const target of result.targets) console.log(`TARGET ${target.source}`);
  for (const collision of result.unmanagedCollisions) {
    console.log(`PRESERVE unmanaged collision ${collision.source}`);
  }
  if (result.mode === 'dry-run') {
    console.log(`Would remove ${result.targets.length} marker-owned retired agent definition(s).`);
  } else {
    console.log(`Removed ${result.removed.length} marker-owned retired agent definition(s).`);
    if (result.manifestPath) console.log(`Quarantine manifest: ${result.manifestPath}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runRetirement(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printResult(result);
  } catch (error) {
    console.error(`retire-bootstrap-agents: ${error.message}`);
    process.exit(1);
  }
}
