---
name: orchestrate
description: >
  Delegation playbook for top-level agent sessions. Load at the start of ANY multi-step task —
  implementation, debugging, research, refactor, audit — before reading files or running searches,
  and whenever about to do bulk work inline (reading several files, grep sweeps, running tests,
  executing a planned code change). Not for subagents/workers, who execute directly and never
  re-delegate.
---

# /orchestrate — delegate execution, keep judgment

Plan, specify, delegate, review — and keep your own context for judgment.
Delegate work whose OUTPUT would flood that context: broad sweeps, log triage,
long test runs, implementation you would not read line by line. Below that bar
— a small edit, a file you already have open, something you can finish in a few
calls — do it yourself. A worker costs a spawn and starts without what you
already know, so delegating small work is slower AND worse.

## Why this saves money (measured)

Not tier pricing — context re-billing. Every token a tool result adds to your
context is re-billed as a cache read on every remaining turn of the session. A
50k-token grep dump at turn 100 of a 500-turn session is a ~5M-token decision.
Measured on this stack (2026-08): a heavy-delegation session held ~200k
context/turn and spent $90; comparable non-delegating ones held 400-500k/turn
and spent $263-$1,280, cache reads dominating. A worker's bulk tokens bill once
in its short-lived context; yours bill again every turn. This holds for every
top-level model tier — Sonnet mains re-bill context the same way.

## Delegate (anything whose cost is volume, not judgment)

- Information gathering: greps, file sweeps, log triage, reading >2 files
- Executing a change you have already specified
- Running tests/builds, reproducing failures
- Anything returning more than a few thousand tokens of raw output

Tiers — your discretion. Use the worker roster registered in your
environment. Claude stacks (`.claude/agents/*.md`): `worker-fast` (Haiku)
for mechanical bulk with unambiguous acceptance criteria, `worker` (Sonnet)
as default, `worker-high` (Opus) when reasoning is the bottleneck or a
worker failed, `worker-frontier` (Fable 5.1) only after worker-high has
failed or the task is clearly frontier-hard — never the routine choice, it's
the priciest rung per token — `worker-codex` for an independent cross-model
second opinion. Codex stacks (roles from `$CODEX_HOME/agents/*.toml`): the
worker-fast role (gpt-5.6-luna) for mechanical bulk, the worker role
(gpt-5.6-terra) as default, a high-reasoning role (Sol) when reasoning is the
bottleneck, and the worker-frontier role (Sol at max reasoning) under the
same escalation-only rule. Read your own roster; dispatch independent work
in parallel — state "dispatch IN PARALLEL" explicitly.

**Reviews never go to the cheap tiers (operator rule).** Review, verification,
delta checks, receipts and gap analyses of another agent's work go only to
`worker-high`, `worker-frontier` or `worker-codex` — never `worker` (Sonnet) or
`worker-fast` (Haiku). On Codex stacks, the Sol roles only.

## Keep for yourself

- Deciding what the change is; writing the brief
- Reviewing what comes back — against evidence in the report, not confidence
- Targeted scouting needed to write a good brief (one grep, one file — not a sweep)
- Talking to the user

## The brief is the product

A worker round-trip on a vague brief costs more than doing it yourself. Every
brief carries: exact scope (files/functions), the decision already made (they
execute, not design), acceptance criteria, and what evidence to report back
(test output, diffs, line numbers). Verify claims against that evidence;
spot-check anything consequential.

## Don't bother

One-line edit in a file already in context; end-of-session work with little
remaining context to protect; anything where the round trip exceeds the task.
Delegation is an optimization, not a ritual.

## Stopping a worker that writes shared state

A stop order is a message racing the work, and delivery can lag minutes —
never rely on a message alone to prevent a write (2026-08-29: a stop order
lost the race with a live-runbook write; the work landed anyway).

- Brief any worker that will WRITE a shared live file (runbook, board, live
  config) to write atomically (tmp+rename) under the file's agreed lock, and
  to check for `<target>.stop` INSIDE that lock — flag present means abort
  without writing.
- To stop such a worker: create the stop-flag first, then send the message.
  The flag is the fence; the message is the courtesy.
- After any stop, verify the artifact. A worker's silence and your own stop
  order are both unverified claims until the file says otherwise.
