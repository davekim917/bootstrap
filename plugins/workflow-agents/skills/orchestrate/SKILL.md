---
name: orchestrate
description: Delegate substantive work to one retained frontier owner; coordinate logistics.
---

# /orchestrate — One technical owner

Read `../shared/workflow-contract.md` first.

Specialized QA/release technical owners retain their explicit judgment, independence and
sole-verdict authority until separately migrated; ordinary-coordinator instructions do not
replace those contracts or downgrade those roles.

For the one-week trial, ordinary coordinators are Sonnet/xhigh or Terra/xhigh. Their direct work
is limited to brief logistical or mechanical actions: routing, status, existing authorization,
and evidence collection. Delegate substantive design, implementation, research/synthesis,
debugging, technical planning and judgment-heavy review to frontier models by default. There is
no file-count or cheap-first hurdle; a short task is not by itself a reason to downgrade.

One `worker-frontier` owns investigation, technical design, implementation, tests, and fixes in
the same retained session. Its approved worker floor is Claude Fable 5.1 or Opus 5, and Codex
GPT-6 Astra or GPT-5.6 Sol. Fable/Astra remain the default medium-effort workers; Opus/Sol are
first-class dynamic worker selections, not fallbacks. Choose the model once at task start from
that floor based on user direction, task/model fit, observed trial results, or provider
availability; record the actual model, effort, reason, and checks. Never choose a worker below
that floor for substantive delegated work, including discovery, implementation, checks, fixes,
scheduled tasks, or review. In particular, do not substitute Sonnet, Terra, Luna, or a routine
cheap subagent for the technical owner. Do not pre-solve the technical problem in the coordinator
or hand each stage to a fresh builder. The trial evaluates quality and total observed use, not a
cheap-worker ladder.

At task start, make the dispatch-first decision visible before doing technical exploration. The
coordinator may identify the request, repository, worktree, claim, authorization and existing
evidence. It must dispatch before reading implementation to diagnose it, querying live systems to
explain a failure, selecting/running a technical check, or reaching a correctness conclusion. Do
not turn a short scheduled wake, a familiar codebase, or a likely one-line fix into an exception.

Keep one worker role, with no automatic retry or model ladder. If no approved worker is available,
report the limitation and obtain a recovery decision; never silently downgrade.

The native worker profile defaults to Claude Fable 5.1 (`claude-fable-5-1`) or Codex GPT-6 Astra
(`gpt-6-astra`), medium effort. Use only an installed, verified runtime profile.
Choose native dispatch or the CLI helper at task start, then retain that transport's session.
The native Codex worker is model-pinned; select Opus/Sol or another approved floor model with the
helper from the start using explicit `--model`, not a prompt asking the native worker to become
another model.
Native child handles belong to the spawning parent; resume them through that parent's native
follow-up tool. Native effort overrides apply at spawn only. Follow-ups preserve the existing
effort unless the runtime explicitly supports updating it.

If mid-task effort changes or CLI resume are needed, start the owner with
`../../scripts/frontier-worker.mjs` in the foreground. Its `--resume` accepts only the exact UUID
returned by its own CLI session, with the same runtime and runtime home. A native child UUID is
not a CLI resume handle, even if it has the same shape. Transport handles are not interchangeable.
For example, from the installed plugin root:

```sh
node scripts/frontier-worker.mjs --runtime codex --cwd /absolute/worktree --effort medium < task.txt
node scripts/frontier-worker.mjs --runtime codex --cwd /absolute/worktree --effort low --resume CLI_SESSION_UUID < followup.txt
```

Use `--runtime claude` for Fable or Opus and `--runtime codex` for Astra or Sol. Replace
`CLI_SESSION_UUID` with the recorded CLI UUID; use the second command only for that helper-started
session. The helper accepts only this four-model worker floor and uses exact models and native
configuration, with no build permission bypass or ephemeral build session. Claude's native Agent
input has no effort field; the helper scopes `CLAUDE_CODE_EFFORT_LEVEL` to that child process.

An explicit effort override must be validated and applied through supported runtime configuration
or dispatch options; prose such as "think harder" is not an effort setting. Record saved defaults,
requested settings, actual runtime metadata and session provenance separately. Saved configuration
is not evidence of an active child's effort; if actual metadata is unavailable, mark it unverified.
If a setting or cross-transport resume fails, report it. Do not silently restart, replay the task,
or switch transports; preserve the artifact and obtain an explicit recovery decision before
creating a replacement owner.

Give the owner the desired outcome, scope, constraints, existing approval, source locations,
observable acceptance criteria, and evidence to return. The owner can read, search, test, and fix
directly. Resume that same owner for corrections. Brief logistical or mechanical actions can execute directly without a
mandatory spawn; substantive work retains the frontier default even when short. There is no worker tier ladder or mandatory escalation sequence.

Review is a separate fresh context selected relative to the artifact author's model family,
not the coordinator's. Follow `../shared/cross-model-review.md` for risk and transport.
Do not dispatch extra builders by default; any necessary independent work needs explicit ownership
and a concrete reason, while the retained owner remains responsible for integration.

## Shared-state stop fence

For a worker authorized to write a shared live file, require atomic tmp+rename under the agreed
lock and a check for `<target>.stop` inside that lock. To stop it, create the flag before sending
the stop message, then inspect the artifact. A message or silence alone is not proof of a stop.
Workers execute their own tools and do not re-delegate.
