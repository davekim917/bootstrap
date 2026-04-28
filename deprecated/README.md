# Deprecated

Plugins and code that are no longer active but preserved for reference.

## bootstrap-commands

Stage-based command pipeline for codebase analysis and AI development setup
(`/bootstrap`, `/bootstrap-discovery`, `/bootstrap-config`, `/bootstrap-skills`,
`/bootstrap-domain`, `/bootstrap-audit`, `/bootstrap-complete`).

Replaced by writing project conventions directly into `CLAUDE.md` and using the
team workflow (`bootstrap-workflow`) plus global domain skills (`bootstrap-domain`)
without a discovery/scaffold step.

Removed from `.claude-plugin/marketplace.json` so Claude Code does not load it.
The files remain here for reference and rollback.

## jony-ive

UI/UX design audit skill modeled on Jony Ive / Steve Jobs sensibilities. Was part
of `bootstrap-domain`. Moved out because it isn't part of the active workflow
anymore. Bootstrap-domain's plugin description was updated to drop the "UI/UX
design" mention.

The files remain here for reference and rollback. To re-enable, move the folder
back to `plugins/domain/skills/jony-ive/` — `bootstrap-domain` auto-discovers
skills under `skills/`.
