# Codex Workflow Primitives

Use this reference from Codex workflow skills when local context is ambiguous.

## Project Instructions

Resolve project instructions in this order:

1. Read the nearest `AGENTS.md` that applies to the working directory.
2. If no `AGENTS.md` exists, read `CLAUDE.md` as compatibility context and translate Claude-specific directions to Codex equivalents.
3. Read nearby project docs that are explicitly relevant, such as `README.md`, package scripts, test docs, or existing spec artifacts.

Never claim a workflow rule exists until the file containing it has been read.

## Artifact Paths

Use durable project artifacts for workflow outputs:

- Project scope: `docs/project-scope.md`
- Feature artifacts: `docs/specs/<slug>/`
- Temporary scratch: `docs/specs/<slug>/.tmp/`
- Cross-feature scratch only when no feature slug exists: `.agents/tmp/bootstrap-workflow/`

Prefer artifact-local `.tmp` folders over global hidden state so resumed agents can find context.

## Codex Subagents

Use subagents only when the user invoked a workflow that clearly implies delegation, review, QA, swarm work, or parallel build work. Keep delegation bounded:

- Give each worker a disjoint write scope.
- Tell workers they are not alone in the codebase and must not revert others' work.
- Delegate sidecar work that can run while the lead continues useful local work.
- Do not delegate the next blocking step when the lead needs the result immediately.
- The lead owns integration, final validation, and the user-facing completion claim.

Do not shell out to `codex` from inside Codex just to simulate a second reviewer. Use an independent subagent prompt, an inline adversarial pass, or an explicitly available external model only when the user asks for cross-model review.

## Verification

Before saying work is complete, report:

- Commands, tests, builds, logs, or inspections that were actually run.
- Edge cases or alternate paths checked beyond the happy path.
- Anything that could not be verified and why.

If no verification was possible, say that directly.
