# bootstrap

A portable agent environment for Claude Code and Codex. Install only the plugins built for the agent you are using.

Built for my own use, shared in case it's useful to others.

## Plugins

| Plugin | What it provides |
|--------|-----------------|
| `bootstrap-workflow` | Claude Code team workflow skills (brief → design → review → plan → build → qa → ship), safety/quality hooks, specialized agents |
| `bootstrap-workflow-agents` | Codex-native team workflow skills with Codex plugin metadata and no Claude team/hook dependencies |
| `bootstrap-domain` | Provider-agnostic domain expertise skills for software engineering, data, analytics, AI, and finance |
| `bootstrap-commands` | Codebase analysis commands that generate CLAUDE.md, project skills, and AI dev setup |
| `bootstrap-tools` | Provider-agnostic tool integration skills for CLI tools (Cortex Code, and more) |

## Install

### Claude Code

Add the marketplace, then install the plugins you want:

```
/plugin marketplace add davekim917/bootstrap
```

Install only what you need:
```
/plugin install bootstrap-workflow@davekim917-bootstrap     # team workflow + hooks + agents
/plugin install bootstrap-domain@davekim917-bootstrap       # domain skills only
/plugin install bootstrap-commands@davekim917-bootstrap     # bootstrap commands only
/plugin install bootstrap-tools@davekim917-bootstrap        # tool integration skills
```

### Codex

The Codex workflow lives in a separate plugin so Codex installs Codex-native skill bodies rather than the Claude workflow. The domain and tools plugins are provider-agnostic, so Codex installs those same plugin directories natively through their `.codex-plugin/plugin.json` manifests:

```
codex plugin marketplace add davekim917/bootstrap --ref main
```

For local development on a host that keeps this repo at `~/plugins/bootstrap`:

```
codex plugin marketplace add ~/plugins/bootstrap
```

Then install or enable the Codex-compatible plugins from that Codex marketplace.

```json
{
  "name": "davekim917-bootstrap",
  "interface": {
    "displayName": "Dave Kim Bootstrap for Codex"
  },
  "plugins": [
    {
      "name": "bootstrap-workflow-agents",
      "source": {
        "source": "local",
        "path": "./plugins/workflow-agents"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    },
    {
      "name": "bootstrap-domain",
      "source": {
        "source": "local",
        "path": "./plugins/domain"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    },
    {
      "name": "bootstrap-tools",
      "source": {
        "source": "local",
        "path": "./plugins/tools"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
```

This marketplace is checked in at `.agents/plugins/marketplace.json`. The workflow-only object is also kept at `plugins/workflow-agents/marketplace-entry.json` for copy/paste into another Codex marketplace.

The Codex marketplace uses the same marketplace name, `davekim917-bootstrap`, as the Claude marketplace. The platform-specific plugin entries are what enforce separation.

Codex workflow skills must be installed through the Codex plugin, not copied into `.agents/skills` as standalone mirrors. This keeps same-named skills such as `team-build` and `team-qa` unambiguous:

- Claude sees `plugins/workflow` through `.claude-plugin/marketplace.json`.
- Codex sees `plugins/workflow-agents` through `.agents/plugins/marketplace.json`.
- Host or container sync jobs should not mirror `plugins/workflow-agents/skills/*` into `~/.agents/skills` or `/home/node/.agents/skills`.

For NanoClaw container agents, install the Codex plugin in the host/per-group Codex home before starting the container. NanoClaw preserves Codex `[plugins.*]` config and mounts the Codex plugin cache into the container, so Codex primary and Codex peer sessions load the plugin natively instead of relying on copied workflow skills.

When NanoClaw manages `~/plugins/bootstrap`, its host checks pull the repo, refresh local Codex marketplace cache entries, and run Codex marketplace upgrades for Git-backed installs. That keeps version bumps visible to host Codex sessions and to containers that mount the Codex plugin cache.

Codex subagents are currently shipped as a managed TOML bundle under `plugins/workflow-agents/agents/` because Codex supports subagents but plugin manifests do not yet expose an `agents` component. The bundle is generated from `plugins/workflow/agents/*.md`:

```
node plugins/workflow-agents/scripts/sync-codex-agents.mjs
node plugins/workflow-agents/scripts/sync-codex-agents.mjs --check
node plugins/workflow-agents/scripts/sync-codex-agents.mjs --sync-home
```

The Codex workflow `SessionStart` hook syncs those managed TOML files into `CODEX_HOME/agents` or `~/.codex/agents`, overwriting only files already marked as managed by `bootstrap-workflow-agents agent-sync` or `nanoclaw codex-sync`. If the upstream Claude agent files change, run the generator and commit the updated TOML bundle so plugin upgrades carry the new agents.

### Prerequisites

Claude workflow:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Bun](https://bun.sh/) runtime (for TypeScript hooks — workflow plugin only)
- `jq` (for shell hooks — `brew install jq` on macOS)

Codex workflow:

- Codex plugin support
- No Claude team-agent API or Claude hook runtime required

## bootstrap-workflow

Claude workflow: team-* skills, 6 agents, safety/quality hooks.

## bootstrap-workflow-agents

Codex workflow: Codex-native versions of the workflow skills with shared conventions under `plugins/workflow-agents/skills/shared/`.

The Codex plugin wires a Codex-specific hook set for safe surfaces only: payload-shape logging, destructive command blocking, protected-file blocking, post-edit tracking, and managed subagent sync. It intentionally does not port Claude-only `TeamCreate` or `AskUserQuestion` gates.

Enable hook payload logging only when debugging hook shape:

```
BOOTSTRAP_CODEX_HOOK_LOG=summary codex
BOOTSTRAP_CODEX_HOOK_LOG=full codex
```

### Workflow Skills

The Claude and Codex workflow plugins share the core workflow names. Codex installs the Codex-native bodies from `plugins/workflow-agents`; Claude installs the Claude-native bodies from `plugins/workflow`.

| Skill | Purpose |
|-------|---------|
| `/team-brief` | Extract structured requirements from fuzzy ideas |
| `/team-design` | First-principles design with constraint analysis |
| `/team-review` | Adversarial design or code review |
| `/team-plan` | Atomic task decomposition with exact file paths and test cases |
| `/team-build` | Implementation with coordinated builder agents when useful |
| `/team-qa` | 5-check validation pipeline (denoise, style, docs, security, perf) |
| `/team-ship` | Branch lifecycle and merge/PR options |
| `/team-tdd` | Test-driven development enforcement |
| `/team-debug` | Root-cause-first debugging methodology |
| `/team-drift` | Mechanized drift detection between any two documents |
| `/team-retro` | Post-ship learning capture |
| `/team-auto` | End-to-end autonomous workflow loop |
| `/team-verification-before-completion` | Evidence-based completion claims |
| `/team-receiving-review-feedback` | Protocol for processing review findings |
| `review-swarm` | Independent review swarm and adjudication |
| `best-practice-check` | Current-docs best-practice validation |
| `workflow-routing` | Route fuzzy workflow requests to the right skill |

### Claude Agents

Specialized subagents invoked by workflow skills:

- `architecture-advisor` — architectural review and design feedback
- `code-review-specialist` — code quality and convention review
- `cpo-advisor` — product strategy and prioritization
- `cto-advisor` — strategic technical decisions
- `performance-analyzer` — performance issue detection
- `security-reviewer` — security vulnerability review

### Claude Hooks

**Safety** (PreToolUse):
- Block destructive bash commands (rm on protected paths, eval, shred, unlink)
- Block edits to protected files (.env, .git/, lock files, terraform)
- Workflow gate enforcement (blocks build without passing drift check)

**Quality** (PostToolUse):
- TypeScript type checking after file edits
- Prettier formatting after file edits
- Edited file tracking for session-end review

**Lifecycle** (SessionStart):
- Session timestamp injection
- Cloud MCP connector management

### Usage

For a non-trivial feature:

```
/team-brief → /team-design → /team-review → /team-plan → /team-build → /team-qa → /team-ship
```

For smaller work with clear requirements, skip to `/team-design` → `/team-plan` → `/team-build`.

For trivial fixes, skip the workflow entirely.

## bootstrap-domain

8 domain expertise skills — loaded contextually based on your project:

- `software-engineering` — TypeScript, React, Node.js, APIs, testing
- `analytics-engineering` — dbt, SQL modeling, data transformation
- `analytics` — dashboards, metrics, BI tools
- `data-engineering` — pipelines, orchestration, data quality
- `data-science` — notebooks, ML, feature engineering
- `llm-engineering` — LLM APIs, prompt engineering, RAG, evals
- `agentic-systems` — agent loops, multi-agent systems, MCP, tools
- `financial-analytics` — GL modeling, reconciliation, regulatory reporting

## bootstrap-commands

7 commands for bootstrapping AI-assisted development in any codebase:

| Command | Purpose |
|---------|---------|
| `/bootstrap` | Orchestrator — guides you through the full sequence |
| `/bootstrap-discovery` | Stage 1: Analyze codebase patterns and architecture |
| `/bootstrap-config` | Stage 2: Generate CLAUDE.md and AGENTS.md |
| `/bootstrap-skills` | Stage 3: Generate project-specific skills |
| `/bootstrap-domain` | Stage 4: Generate domain-specific skills |
| `/bootstrap-audit` | Stage 5: Audit and reconcile all artifacts |
| `/bootstrap-complete` | Stage 6: Final cleanup and validation |

Also includes the `skill-developer` utility skill for creating new skills.

## Structure

```
bootstrap/
├── .agents/plugins/marketplace.json
├── .claude-plugin/marketplace.json
├── plugins/
│   ├── workflow/               # bootstrap-workflow plugin
│   │   ├── .claude-plugin/plugin.json
│   │   ├── skills/             # 13 team-* skills
│   │   ├── hooks/              # safety, quality, lifecycle hooks
│   │   ├── agents/             # 6 specialized subagents
│   │   └── tests/              # workflow validation specs
│   ├── workflow-agents/         # bootstrap-workflow-agents plugin
│   │   ├── .codex-plugin/plugin.json
│   │   ├── agents/             # generated Codex subagent TOML bundle
│   │   ├── hooks/              # Codex-specific hook manifest and hook runner
│   │   ├── scripts/            # agent sync/generation tooling
│   │   └── skills/             # Codex-native workflow skills
│   ├── domain/                 # bootstrap-domain plugin
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .codex-plugin/plugin.json
│   │   └── skills/             # 8 domain expertise skills
│   ├── tools/                  # bootstrap-tools plugin
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .codex-plugin/plugin.json
│   │   └── skills/             # tool integration skills
│   └── bootstrap-commands/     # bootstrap-commands plugin
│       ├── .claude-plugin/plugin.json
│       ├── commands/           # 7 bootstrap commands
│       ├── skills/             # skill-developer
│       └── scripts/            # helper scripts
```

## Customization

### Adding Domain Skills

Create a new skill in `plugins/domain/skills/your-domain/SKILL.md`.

### Disabling Hooks

Individual hooks can be disabled in Claude Code settings without removing the plugin. Environment variable bypasses are available:
- `SKIP_FILE_PROTECTION=1` — bypass file protection guard
- `SKIP_ERROR_REMINDER=1` — bypass error handling reminder

### Extending the Workflow

The team-* skills are designed to be used together but each works independently. You can invoke any skill directly without running the full sequence.

## License

MIT
