---
name: team-ship
description: >
  Separate human-controlled publish and merge boundary after implementation review clears. Runs
  fresh readiness checks, shows the exact branch and remote impact, and performs only the user's
  explicitly selected ship action.
---

# /team-ship — Human-controlled shipping boundary

Read `../shared/workflow-contract.md` first. Never auto-trigger and never infer ship authority from
plan approval, `/team-auto`, or a clean review.

## Preflight

1. Read `plan.md` and `run.md`; require a current `/team-review --implementation` result with no
   unresolved `MUST-FIX`, or explicit user waivers.
2. Run fresh required checks against the exact current tree and inspect the final diff.
3. Resolve the current branch, canonical default branch, tracking remote, uncommitted changes,
   unpushed commits, and divergence. Do not guess the default branch.
4. Report the exact intended effect: commit scope, merge target, push target, PR behavior, branch
   deletion, deployment, or other irreversible consequence.

If the tree changed after review, checks fail, coverage is degraded without the user's explicit
acceptance, or the target is ambiguous, stop.

## Authority gate

Ask the user to choose the concrete ship action. Examples include commit only, commit and push,
open a PR, merge an existing branch/PR, keep the branch, or discard it. Destructive actions require
an explicit confirmation naming the target. Do not present an option unsupported by the repository
or silently convert a direct-push request into a PR workflow.

Execute only the selected action, using narrow staging that preserves unrelated user changes.
Afterward verify the result from authoritative state: commit SHA, remote branch/PR/merge state,
worktree status, and deployment state when deployment was requested. Report what was verified and
what remains local or not activated.
