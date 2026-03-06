---
name: bootstrap
description: "Bootstrap a project for AI-assisted development. Shows the full sequence and guides through each stage."
---

# Bootstrap — Project Setup for AI-Assisted Development

You are guiding the user through bootstrapping their project. This is the orchestrator
command that explains the process and runs each stage.

## Prerequisites

- The project repo must exist and have code in it (or at least a directory structure)
- `bun` or `bash` available for running discovery scripts

## The Bootstrap Sequence

Present this to the user:

```
Bootstrap stages:

  Stage 0: Ground truth collection (shell script, ~5 sec)
  Stage 1: /bootstrap-discovery — Analyze codebase patterns and architecture
  Stage 2: /bootstrap-config — Generate CLAUDE.md and AGENTS.md
  Stage 3: /bootstrap-skills — Generate project-specific skills
  Stage 4: /bootstrap-domain — Generate domain-specific skills (optional)
  Stage 5: /bootstrap-audit — Audit and reconcile all generated artifacts
  Stage 6: /bootstrap-complete — Final cleanup and validation

Run stages sequentially. Review output between each stage.
```

## Stage 0: Ground Truth

Run the discovery script to collect raw data:

```bash
mkdir -p .claude/discovery
bash "${CLAUDE_PLUGIN_ROOT}/scripts/discovery-commands.sh" > .claude/discovery/raw_data.txt
```

If `CLAUDE_PLUGIN_ROOT` is not set, ask the user for the path to the bootstrap plugin directory.

After Stage 0 completes, tell the user to run `/bootstrap-discovery` for Stage 1.

## Validation

After all stages complete, run the validation script:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/validate-v2.sh"
```

Expected output: validation passes with no errors.

## Post-Bootstrap

After validation:
1. Review generated files: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`
2. Commit: `git add CLAUDE.md AGENTS.md .claude/ .agents/ && git commit -m "Add AI engineering bootstrap"`
3. Start using the team workflow: `/team-brief` for your first feature
