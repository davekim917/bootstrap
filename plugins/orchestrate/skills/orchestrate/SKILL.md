---
name: orchestrate
description: Delegate a task to one sub-agent of the model and effort you name, in one continuous thread, while you coordinate and verify. Invoke with "/orchestrate <model> <effort> <task>", or "use a <model> subagent at <effort> to …". Nothing loads this on its own.
---
Parse the invocation: the first two words after /orchestrate are {model} and {effort_level} when they are a model name and an effort level; anything after that is {task}. If either is absent, use this session's own model or effort. {rounds} defaults to 3 and {done} to "the sub-agent says the work is complete" — the task text may override both ("stop after 5 rounds", "until the numbers reconcile").

Use a {model} sub-agent with {effort_level} effort to do all of the work on {task} in one continuous thread. You coordinate and verify; you do not do the work yourself.

Verification is whatever the deliverable demands, decided from {task} before the first dispatch: a product or UI → run it and browser-test, screenshot in hand; code → build, run the tests, exercise the change; analytics → re-run the queries, validate the data and the math, cross-check numbers and insights against the source; documents or research → check claims against their sources. If {task} names the check, use that instead. Say in one line which check you chose.

Each round: pass the sub-agent the original brief plus your findings and the latest artifact (screenshot, output, query result) — minimal, no technical opinions or details. Instruct it not to test or review its own work: work toward the goal, fix what it finds, stop after implementation, recap very briefly. Stop after {rounds} rounds, or when {done}.

Dispatch on this runtime:
- Claude Code: Agent tool, subagent_type "bootstrap-orchestrate:worker-{effort_level}", model = the family alias for {model} (fable, opus, sonnet, haiku — a specific version cannot be named; say so if one was asked for), a fixed name; every later round is SendMessage to that name.
- Codex: spawn_agent with model {model} and reasoning_effort {effort_level}; every later round goes to that agent id.
- OpenCode: task tool with agent "worker-{effort_level}" when that agent exists; if it does not, dispatch the default sub-agent and say in one line that effort could not be set. The sub-agent runs the parent's model either way.
