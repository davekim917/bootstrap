# bootstrap

A portable agent environment for Claude Code. Three independent plugins — install what you need.

Built for my own use, shared in case it's useful to others.

## Plugins

| Plugin | What it provides |
|--------|-----------------|
| `bootstrap-workflow` | Team workflow skills (brief → design → review → plan → build → qa → ship), safety/quality hooks, specialized agents |
| `bootstrap-domain` | Domain expertise skills for software engineering, data, analytics, AI, and finance |
| `bootstrap-commands` | Codebase analysis commands that generate CLAUDE.md, project skills, and AI dev setup |

## Install

Add the marketplace, then install the plugins you want:

```
/plugin marketplace add davekim917/bootstrap
```

Install only what you need:
```
/plugin install bootstrap-workflow@davekim917-bootstrap     # team workflow + hooks + agents
/plugin install bootstrap-domain@davekim917-bootstrap       # domain skills only
/plugin install bootstrap-commands@davekim917-bootstrap     # bootstrap commands only
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Bun](https://bun.sh/) runtime (for TypeScript hooks — workflow plugin only)
- `jq` (for shell hooks — `brew install jq` on macOS)

## bootstrap-workflow

13 team-* skills, 6 agents, safety/quality hooks.

### Skills

| Skill | Purpose |
|-------|---------|
| `/team-brief` | Extract structured requirements from fuzzy ideas |
| `/team-design` | First-principles design with constraint analysis |
| `/team-review` | Adversarial multi-model design review |
| `/team-plan` | Atomic task decomposition with exact file paths and test cases |
| `/team-build` | Parallel build with coordinated builder agents |
| `/team-qa` | 5-check validation pipeline (denoise, style, docs, security, perf) |
| `/team-ship` | Branch lifecycle and merge/PR options |
| `/team-tdd` | Test-driven development enforcement |
| `/team-debug` | Root-cause-first debugging methodology |
| `/team-drift` | Mechanized drift detection between any two documents |
| `/team-retro` | Post-ship learning capture |
| `/team-verification-before-completion` | Evidence-based completion claims |
| `/team-receiving-review-feedback` | Protocol for processing review findings |

### Agents

Specialized subagents invoked by workflow skills:

- `architecture-advisor` — architectural review and design feedback
- `code-review-specialist` — code quality and convention review
- `cpo-advisor` — product strategy and prioritization
- `cto-advisor` — strategic technical decisions
- `performance-analyzer` — performance issue detection
- `security-reviewer` — security vulnerability review

### Hooks

**Safety** (PreToolUse):
- Block destructive bash commands (rm on protected paths, eval, shred, unlink)
- Block edits to protected files (.env, .git/, lock files, terraform)
- Workflow gate enforcement (blocks build without passing drift check)

**Quality** (PostToolUse):
- TypeScript type checking after file edits
- Prettier formatting after file edits
- Edited file tracking for session-end review

**Workflow** (UserPromptSubmit):
- Skill suggestion based on prompt keywords

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
- `ai-integration` — LLM APIs, prompt engineering, RAG, agents
- `financial-analytics` — GL modeling, reconciliation, regulatory reporting
- `jony-ive` — premium UI/UX design audit and refinement

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
├── .claude-plugin/marketplace.json
├── plugins/
│   ├── workflow/               # bootstrap-workflow plugin
│   │   ├── .claude-plugin/plugin.json
│   │   ├── skills/workflow/    # 13 team-* skills
│   │   ├── hooks/              # safety, quality, lifecycle hooks
│   │   ├── agents/             # 6 specialized subagents
│   │   └── tests/              # workflow validation specs
│   ├── domain/                 # bootstrap-domain plugin
│   │   ├── .claude-plugin/plugin.json
│   │   └── skills/domain/      # 8 domain expertise skills
│   └── bootstrap-commands/     # bootstrap-commands plugin
│       ├── .claude-plugin/plugin.json
│       ├── commands/           # 7 bootstrap commands
│       ├── skills/utility/     # skill-developer
│       └── scripts/            # helper scripts
```

## Customization

### Adding Domain Skills

Create a new skill in `plugins/domain/skills/domain/your-domain/SKILL.md`.

### Disabling Hooks

Individual hooks can be disabled in Claude Code settings without removing the plugin. Environment variable bypasses are available:
- `SKIP_FILE_PROTECTION=1` — bypass file protection guard
- `SKIP_ERROR_REMINDER=1` — bypass error handling reminder

### Extending the Workflow

The team-* skills are designed to be used together but each works independently. You can invoke any skill directly without running the full sequence.

## License

MIT
