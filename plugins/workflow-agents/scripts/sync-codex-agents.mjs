#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'plugins', 'workflow', 'agents');
const DEFAULT_BUNDLE_DIR = path.join(PLUGIN_ROOT, 'agents');

const MODEL_TO_REASONING = new Map([
  ['opus', 'high'],
  ['sonnet', 'medium'],
  ['haiku', 'low'],
]);

function parseArgs(argv) {
  const args = {
    check: false,
    syncHome: false,
    force: false,
    sourceDir: DEFAULT_SOURCE_DIR,
    bundleDir: DEFAULT_BUNDLE_DIR,
    targetDir: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--sync-home') args.syncHome = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--source') args.sourceDir = path.resolve(argv[++i]);
    else if (arg === '--bundle') args.bundleDir = path.resolve(argv[++i]);
    else if (arg === '--target') args.targetDir = path.resolve(argv[++i]);
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node plugins/workflow-agents/scripts/sync-codex-agents.mjs [options]

Generate and sync Codex agent TOML from plugins/workflow/agents/*.md.

Options:
  --check             Fail if generated bundle files are stale
  --sync-home         Copy bundled TOML into CODEX_HOME/agents or ~/.codex/agents
  --force             Overwrite unmanaged target agents during --sync-home
  --source <dir>      Source Claude agent markdown directory
  --bundle <dir>      Codex agent TOML bundle directory
  --target <dir>      Target Codex agents directory for --sync-home
`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseFrontmatter(source, filePath) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`);
  const frontmatter = match[1];
  const body = match[2].trim();

  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const descriptionRaw = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const model = frontmatter.match(/^model:\s*(.+)$/m)?.[1]?.trim();

  if (!name) throw new Error(`${filePath}: missing name`);
  if (!descriptionRaw) throw new Error(`${filePath}: missing description`);

  return {
    name: unquote(name),
    description: unquote(descriptionRaw),
    model: model ? unquote(model) : undefined,
    body,
  };
}

function unquote(value) {
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1);
  }
  return value;
}

function tomlMultiline(value) {
  if (value.includes("'''")) {
    return `"""${value.replaceAll('"""', '\\"\\"\\"')}"""`;
  }
  return `'''${value}'''`;
}

function renderAgentToml(agent, sourceRelativePath, sourceHash) {
  const codexInstructions = `## Codex Runtime Adapter

You are running as a Codex subagent. Use Codex tools and tool names. If inherited source text mentions Claude-only tools or paths, translate them to the equivalent Codex operation.

Project instruction lookup order:
1. Read the nearest applicable AGENTS.md.
2. If no AGENTS.md exists, read CLAUDE.md as compatibility context.
3. Do not assume either file exists until you have checked.

`;
  const lines = [
    '# managed by bootstrap-workflow-agents agent-sync',
    `# source: ${sourceRelativePath}`,
    `# source_sha256: ${sourceHash}`,
    '',
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${tomlMultiline(agent.description)}`,
  ];

  const reasoning = MODEL_TO_REASONING.get(agent.model || '');
  if (reasoning) lines.push(`model_reasoning_effort = ${JSON.stringify(reasoning)}`);

  lines.push(`developer_instructions = ${tomlMultiline(codexInstructions + agent.body)}`, '');
  return lines.join('\n');
}

function generateBundle(sourceDir, bundleDir) {
  if (!fs.existsSync(sourceDir)) throw new Error(`Source agents directory not found: ${sourceDir}`);
  const outputs = new Map();

  for (const file of fs.readdirSync(sourceDir).filter((name) => name.endsWith('.md')).sort()) {
    const sourcePath = path.join(sourceDir, file);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const agent = parseFrontmatter(source, sourcePath);
    const sourceRelativePath = path.relative(REPO_ROOT, sourcePath).replaceAll(path.sep, '/');
    const sourceHash = sha256(source);
    outputs.set(`${agent.name}.toml`, renderAgentToml(agent, sourceRelativePath, sourceHash));
  }

  if (outputs.size === 0) throw new Error(`No agent markdown files found in ${sourceDir}`);
  return outputs;
}

function writeBundle(outputs, bundleDir, check) {
  const stale = [];
  if (!check) fs.mkdirSync(bundleDir, { recursive: true });

  for (const [file, content] of outputs) {
    const target = path.join(bundleDir, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== content) {
      stale.push(file);
      if (!check) fs.writeFileSync(target, content);
    }
  }

  const expected = new Set(outputs.keys());
  if (fs.existsSync(bundleDir)) {
    for (const file of fs.readdirSync(bundleDir).filter((name) => name.endsWith('.toml'))) {
      if (!expected.has(file)) {
        stale.push(file);
        if (!check) fs.unlinkSync(path.join(bundleDir, file));
      }
    }
  }

  return stale;
}

function isManaged(content) {
  return content.includes('managed by bootstrap-workflow-agents agent-sync') ||
    content.includes('managed by nanoclaw codex-sync');
}

function syncHome(bundleDir, targetDir, force) {
  if (!fs.existsSync(bundleDir)) throw new Error(`Bundle directory not found: ${bundleDir}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const written = [];
  const skipped = [];

  for (const file of fs.readdirSync(bundleDir).filter((name) => name.endsWith('.toml')).sort()) {
    const sourcePath = path.join(bundleDir, file);
    const targetPath = path.join(targetDir, file);
    const next = fs.readFileSync(sourcePath, 'utf8');

    if (fs.existsSync(targetPath)) {
      const current = fs.readFileSync(targetPath, 'utf8');
      if (current === next) continue;
      if (!force && !isManaged(current)) {
        skipped.push(file);
        continue;
      }
    }

    fs.writeFileSync(targetPath, next);
    written.push(file);
  }

  return { written, skipped };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputs = generateBundle(args.sourceDir, args.bundleDir);
  const stale = writeBundle(outputs, args.bundleDir, args.check);

  if (args.check && stale.length > 0) {
    console.error(`Codex agent bundle is stale: ${stale.join(', ')}`);
    process.exit(1);
  }

  if (args.syncHome) {
    const result = syncHome(args.bundleDir, args.targetDir, args.force);
    if (result.written.length > 0) console.log(`Updated Codex agents: ${result.written.join(', ')}`);
    if (result.skipped.length > 0) console.log(`Skipped unmanaged Codex agents: ${result.skipped.join(', ')}`);
  } else if (!args.check) {
    console.log(`Generated ${outputs.size} Codex agent bundle files in ${path.relative(REPO_ROOT, args.bundleDir)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
