---
name: orchestrate
description: Hand one task to a retained frontier sub-agent that owns investigation, design, implementation, tests and fixes in a single continuous thread, while you coordinate logistics. Use ONLY when asked — "/orchestrate", "use a frontier sub-agent for this", "delegate this to a frontier worker in one continuous thread", "hand this to a frontier owner", "spin up a frontier worker and keep it on the task". Not a default: nothing instructs a session to load this, and working directly is the normal mode.
---

# /orchestrate — One technical owner

**Invoke-only.** This skill is loaded because someone asked for a retained frontier owner on this
task. There is no standing directive telling a session to reach for it, and nothing gates a
session from reading source, running checks or implementing directly — working directly is the
normal mode. Everything below governs HOW to delegate once delegation has been asked for; none of
it is a reason to delegate work nobody asked you to hand off.

Read `../shared/workflow-contract.md` first.

Specialized QA/release technical owners retain their explicit judgment, independence and
sole-verdict authority until separately migrated; ordinary-coordinator instructions do not
replace those contracts or downgrade those roles.

When this skill is invoked, you are the coordinator for the delegated task. Ordinary coordinators
are Sonnet/xhigh or Terra/xhigh; keep your own direct work to brief logistical or mechanical
actions — routing, status, existing authorization, and evidence collection — and give the
substantive design, implementation, research/synthesis, debugging, technical planning and
judgment-heavy review to the frontier owner. There is no file-count or cheap-first hurdle within a
delegated task; a short task is not by itself a reason to downgrade the worker.

One `worker-frontier` owns investigation, technical design, implementation, tests, and fixes in
the same retained session. Its approved worker floor is Claude Fable 5.1 or Opus 5, and Codex
GPT-6 Astra or GPT-5.6 Sol. Opus/Sol are the default worker at `high` effort; Fable/Astra are the
escalation, selected on explicit human request or judgment-heavy task shape (ambiguity, novel
design, visual taste, security, concurrency, high-consequence judgment), and run at the default
medium there unless reasoning depth is also needed. Escalating the model does not also escalate
the effort. Choose the model once at task start from
that floor based on user direction, task/model fit, observed trial results, or provider
availability; record the actual model, effort, reason, and checks. Never choose a worker below
that floor for substantive delegated work, including discovery, implementation, checks, fixes,
scheduled tasks, or review. In particular, do not substitute Sonnet, Terra, Luna, or a routine
cheap subagent for the technical owner. Do not pre-solve the technical problem in the coordinator
or hand each stage to a fresh builder — a cheap-worker ladder defeats the point of asking for a
frontier owner.

Having been asked to delegate, dispatch before doing the technical exploration yourself. Identify
the request, repository, worktree, claim, authorization and existing evidence, then hand over:
reading implementation to diagnose it, querying live systems to explain a failure,
selecting/running a technical check, and reaching a correctness conclusion all belong to the
owner. Do not turn a short scheduled wake, a familiar codebase, or a likely one-line fix into an
exception once the task has been handed to this skill.

Keep one worker role, with no automatic retry or model ladder. If no approved worker is available,
report the limitation and obtain a recovery decision; never silently downgrade.

The `bootstrap-workflow` plugin ships that role, so it exists on a bare install alongside this one.
**Resolving the worker by name:** on
Claude, use `bootstrap-workflow:worker-frontier` whenever it is offered, and the bare
`worker-frontier` only when it is not. Claude Code namespaces plugin agents, so the qualified name
is the plugin's own copy — the one a plugin update refreshes. A bare `worker-frontier` comes from
user scope (`~/.claude/agents/`, which is what a NanoClaw container mounts); it is a separate file
that nothing in the plugin updates, so preferring it would silently pin an installation to whatever
version was copied there. Both names denote the same role: never dispatch to both or treat the
qualified one as a second worker. On Codex the name is always bare `worker-frontier` — Codex has no
plugin-agent mechanism, so the role is installed into `<CODEX_HOME>/agents/` by
`plugins/workflow-agents/scripts/install-agent-roles.mjs`.

The native worker profile defaults to Claude Opus 5 (`claude-opus-5[1m]`) or Codex GPT-5.6 Sol
(`gpt-5.6-sol`), `high` effort; Fable 5.1 / Astra 6 are reached with an explicit `--model` on the
same worker role, not a second role. Select only `low`, `medium`, `high`, `xhigh`, or `max` for an
autonomous worker, using the shared contract's task-shape rubric. Do not select `ultra` from that
roster. When the current human explicitly directs an ultra worker, record the wording and call the
Codex helper with `--effort ultra --human-directed-ultra true`; never infer this from task shape.
Use only an installed, verified runtime profile.
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
node scripts/frontier-worker.mjs --runtime codex --cwd /absolute/worktree --effort high < task.txt
node scripts/frontier-worker.mjs --runtime codex --cwd /absolute/worktree --effort low --resume CLI_SESSION_UUID < followup.txt
```

Use `--runtime claude` for Opus or Fable and `--runtime codex` for Sol or Astra. Replace
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
