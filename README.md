# bootstrap

A portable agent environment for Claude Code. Team workflow skills, domain expertise, safety hooks, quality hooks, and project bootstrap commands — all in one plugin.

Built for my own use, shared in case it's useful to others.

## What This Is

A Claude Code plugin that provides:

- **Team workflow** — a structured sequence for building features: brief → design → review → plan → build → qa → ship
- **Domain skills** — patterns for software engineering, data engineering, analytics, data science, AI/LLM integration, and financial analytics
- **Safety hooks** — blocks destructive commands (`rm` on protected paths), protects sensitive files (.env, .git, lock files)
- **Quality hooks** — auto-runs TypeScript checks after edits, formats with Prettier, tracks edited files, suggests relevant skills based on your prompt
- **Bootstrap commands** — analyze any codebase and generate a complete AI-assisted development setup (CLAUDE.md, project skills, conventions)

## Install

From the Claude Code plugin manager:

```
/plugin marketplace add davekim917/bootstrap
/plugin install bootstrap@davekim917/bootstrap
```

Or clone and load locally:

```bash
git clone https://github.com/davekim917/bootstrap.git
claude --plugin-dir ./bootstrap
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Bun](https://bun.sh/) runtime (for TypeScript hooks)
- `jq` (for shell hooks — `brew install jq` on macOS)

## What's Included

### Skills

**Workflow** (13 skills) — the team-* sequence:

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

**Domain** (8 skills) — loaded contextually based on your project:

- `software-engineering` — TypeScript, React, Node.js, APIs, testing
- `analytics-engineering` — dbt, SQL modeling, data transformation
- `analytics` — dashboards, metrics, BI tools
- `data-engineering` — pipelines, orchestration, data quality
- `data-science` — notebooks, ML, feature engineering
- `ai-integration` — LLM APIs, prompt engineering, RAG, agents
- `financial-analytics` — GL modeling, reconciliation, regulatory reporting
- `jony-ive` — premium UI/UX design audit and refinement

**Utility** (1 skill):

- `skill-developer` — create and manage Claude Code skills

### Commands

| Command | Purpose |
|---------|---------|
| `/bootstrap` | Orchestrator — guides you through the full sequence |
| `/bootstrap-discovery` | Stage 1: Analyze codebase patterns and architecture |
| `/bootstrap-config` | Stage 2: Generate CLAUDE.md and AGENTS.md |
| `/bootstrap-skills` | Stage 3: Generate project-specific skills |
| `/bootstrap-domain` | Stage 4: Generate domain-specific skills |
| `/bootstrap-audit` | Stage 5: Audit and reconcile all artifacts |
| `/bootstrap-complete` | Stage 6: Final cleanup and validation |

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

**Quality** (PostToolUse):
- TypeScript type checking after file edits
- Prettier formatting after file edits
- Edited file tracking for session-end review

**Workflow** (UserPromptSubmit):
- Skill suggestion based on prompt keywords

**Lifecycle** (SessionStart):
- Session timestamp injection
- Cloud MCP connector management

## Usage

### Bootstrap a Project

For an existing codebase that doesn't have Claude Code configuration:

```bash
cd /path/to/your-project
```

Then in Claude Code:

```
/bootstrap
```

This guides you through analyzing your codebase and generating:
- `CLAUDE.md` — always-on guardrails and conventions
- `.claude/skills/` — project-specific skills
- `.claude/project-scope.md` — project domain context

### Use the Team Workflow

For a non-trivial feature:

```
/team-brief
```
↓ requirements approved
```
/team-design
```
↓ design approved
```
/team-review
```
↓ findings addressed
```
/team-plan
```
↓ plan approved
```
/team-build
```
↓ build approved
```
/team-qa
```
↓ QA clear
```
/team-ship
```

For smaller work with clear requirements, skip to `/team-design` → `/team-plan` → `/team-build`.

For trivial fixes, skip the workflow entirely.

## Structure

```
bootstrap/
├── .claude-plugin/plugin.json
├── skills/
│   ├── workflow/          # 13 team-* skills
│   ├── domain/            # 7 domain expertise skills
│   └── utility/           # skill-developer
├── commands/              # 7 bootstrap commands
├── agents/                # 6 specialized subagents
├── hooks/
│   ├── guards/            # Safety: block destructive commands + file protection
│   ├── lifecycle/         # Session start hooks
│   ├── quality/           # TSC, Prettier, error handling reminder
│   ├── skills/            # Prompt-based skill suggestions
│   ├── tracking/          # Edit tracking
│   └── lib/               # Shared TypeScript utilities
└── scripts/               # Bootstrap helper scripts
```

## Customization

### Adding Domain Skills

Create a new skill in `skills/domain/your-domain/SKILL.md`. The plugin's skill discovery hook picks it up automatically from the frontmatter description.

### Disabling Hooks

Individual hooks can be disabled in Claude Code settings without removing the plugin. Environment variable bypasses are available:
- `SKIP_FILE_PROTECTION=1` — bypass file protection guard
- `SKIP_ERROR_REMINDER=1` — bypass error handling reminder

### Extending the Workflow

The team-* skills are designed to be used together but each works independently. You can invoke any skill directly without running the full sequence.

## License

MIT
