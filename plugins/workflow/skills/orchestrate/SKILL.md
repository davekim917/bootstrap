---
name: orchestrate
description: Coordinate a retained frontier owner for substantial work; execute simple tasks directly.
---

# /orchestrate — One technical owner

Read `../shared/workflow-contract.md` first.

For the one-week trial, the cheap coordinator handles logistics, status, existing authorization,
and evidence collection. One `worker-frontier` owns investigation, technical design,
implementation, tests, and fixes in the same retained session. Do not pre-solve the technical
problem in the coordinator or hand each stage to a fresh builder.

The worker profile is Claude Fable 5.1 (`claude-fable-5-1`) or Codex GPT-6 Astra
(`gpt-6-astra`), default medium effort. Use only an installed, verified runtime profile.
Prefer native dispatch when the runtime exposes the requested effort field. For a supported
explicit-effort/resume fallback use `../../scripts/frontier-worker.mjs` in the foreground, with
runtime, cwd and effort specified and the returned session id retained for resume. The helper uses
exact models and native configuration, with no build permission bypass or ephemeral build session.
Claude's native Agent input has no effort field; the helper scopes `CLAUDE_CODE_EFFORT_LEVEL` to
that child process. Codex native dispatch uses its exposed effort override when available.
An explicit effort override must be validated and applied through supported runtime configuration
or dispatch options; prose such as "think harder" is not an effort setting. Record requested and
actual runtime settings; if a requested setting is unsupported, report it instead of pretending.

Give the owner the desired outcome, scope, constraints, existing approval, source locations,
observable acceptance criteria, and evidence to return. The owner can read, search, test, and fix
directly. Resume that same owner for corrections. Simple tasks can execute directly without a
mandatory spawn. There is no worker tier ladder or mandatory escalation sequence.

Review is a separate fresh context selected relative to the artifact author's model family,
not the coordinator's. Follow `../shared/cross-model-review.md` for risk and transport.
Do not dispatch extra builders by default; any necessary independent work needs explicit ownership
and a concrete reason, while the retained owner remains responsible for integration.

## Shared-state stop fence

For a worker authorized to write a shared live file, require atomic tmp+rename under the agreed
lock and a check for `<target>.stop` inside that lock. To stop it, create the flag before sending
the stop message, then inspect the artifact. A message or silence alone is not proof of a stop.
Workers execute their own tools and do not re-delegate.
