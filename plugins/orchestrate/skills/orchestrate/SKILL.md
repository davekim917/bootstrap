---
name: orchestrate
description: Delegate a task to one sub-agent of the model and effort you name, in one continuous thread, while you coordinate and test. Invoke-only — "/orchestrate", "use a <model> subagent with <effort> effort", "delegate this to <model>". Nothing loads this on its own.
---
Fill these from the request. Ask only if one is missing and cannot be inferred.
- {model}        the sub-agent's model, as this runtime names it (fable, opus, astra, sol, or a full id). Default: this session's model.
- {effort_level} low | medium | high | xhigh | max. Default: this session's effort.
- {rounds}       coordinate→delegate cycles before stopping. Default: 3.
- {done}         the completion signal. Default: the sub-agent says the work is complete.

Then do exactly this:

Use a {model} sub-agent with {effort_level} effort to do all implementation work in one continuous thread. You coordinate, test the result (browser, CLI, whatever the product needs), and pass findings plus the latest screenshot or artifact back to the sub-agent. Instruct it not to test or review its work — stop after implementation. Each of your prompts to it is minimal: the original brief, the evidence from your test, no technical opinions or details. Tell it to work toward the goal and fix issues it finds, then recap very briefly. Stop after {rounds} rounds, or when {done}.

Dispatch on this runtime:
- Claude Code: Agent tool, subagent_type "bootstrap-orchestrate:delegate-{effort_level}", model {model}, a fixed name; every later round is SendMessage to that name. Never spawn a second agent for a follow-up.
- Codex: spawn_agent with model {model} and reasoning_effort {effort_level}; keep the agent id and send every round to it.
- OpenCode: task tool with agent "delegate-{effort_level}"; the sub-agent runs the parent's model.
