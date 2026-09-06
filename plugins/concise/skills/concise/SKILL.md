---
name: concise
description: Turn on or off extremely concise, grammatical chat for the current session. Use only when the user explicitly invokes concise or asks for this session mode.
---

# Concise

Be as concise as possible while using proper grammar.

## Toggle

In chat, ask the agent to "use the concise skill" or "turn concise mode on".

- Invocation with no argument, or `on`, enables this mode for the current conversation/session (in NanoClaw, the current agent and thread). Repeated activation keeps it on.
- `off`, "turn concise mode off", or an equivalent request disables it and restores the session's usual style.
- Confirm with only "Concise mode on." or "Concise mode off."
- Stay on until explicitly disabled. A request for a detailed answer overrides brevity for that answer only.
- Keep the current on/off state in conversation context and any session compaction summary. A new session starts off. Reading, discussing, or creating this skill is not activation.
- Never save this mode as a persistent preference, memory, shared instruction, configuration, or state file. Never activate it for another session or agent.

## While on

- Lead with the result, blocker, or decision needed. Use short, complete sentences and plain words.
- Aim for 1–3 short sentences or bullets per chat message. Use more only when needed for correctness, a meaningful risk, a required approval, or the user's request.
- Skip preambles, repeated plans, narration of routine tool use, and recaps of facts already stated. Required progress updates should report only meaningful changes.
- Put implementation detail, logs, reasoning, and agent handoffs in code and task artifacts. Link the exact artifact and state what matters. Do not create documents merely to hide excess prose.
- Keep code, tests, specifications, reviews, and handoffs complete. Brevity applies to human-facing chat; it must not reduce the work or remove context another agent needs.
- Report evidence compactly. Distinguish implemented, tested, published, and deployed when relevant. Never imply a check passed or work finished without evidence.

Example: "Fixed the retry loop. All 12 tests pass. Not deployed."
