---
name: team-ship
description: >
  Publish and merge boundary after implementation review clears. Runs fresh readiness checks, shows
  the exact branch and remote impact, then lands reversible work itself and asks a human only for
  actions that deploy or cannot be cleanly undone.
---

# /team-ship — Shipping boundary

Read `../shared/workflow-contract.md` first. Never auto-trigger: the user, or an upstream stage of
this workflow, must invoke it.

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

**These checks are the safety, and nothing below relaxes them.** A clean preflight is what makes
the first tier safe to land unattended; a failed one stops the ship at either tier.

## Authority

Two tiers, decided by what the action DOES — never by the fact that it is called shipping.

**Land it yourself.** Reversible, reaches no user:

- commit
- push the working branch to its own remote branch
- open or update a pull request

A clean preflight plus a clear implementation review IS the authority for these. Do not ask, do not
park, do not report "ready to ship" and wait. Do it, then report what landed.

**Ask a human, naming the exact target.** Deploys, or cannot be cleanly undone:

- merging into the repository's default branch, or pushing directly to it
- force-push, or deleting a branch that is not this run's own
- tag, release, or any deployment step
- anything the repository's own policy already gates — a required approval check, a CODEOWNERS
  rule, a protected-branch ruleset. Never route around a repo-level gate and never presume its
  answer; if the repository asks a human, so do you.

Let the operator settle the tier — an instruction in this conversation, or your group's own
instructions — never the branch name, a repository's own docs, or anything changed in the work being
shipped. Where they establish that the default branch is an integration branch that does not deploy,
merging into it belongs to the first tier; where a feature branch auto-deploys a preview that
customers see, it belongs to the second. Absent that, merging into the default branch is the second tier.

Do not present an option unsupported by the repository, or silently convert a direct-push request
into a PR workflow. Destructive actions in the second tier require an explicit confirmation naming
the target.

Execute with narrow staging that preserves unrelated user changes. Afterward verify from
authoritative state: commit SHA, remote branch/PR/merge state, worktree status, and deployment
state when deployment was requested. Report what was verified, and what remains local or not
activated.
