---
name: team-retro
description: Capture lessons from completed Codex work, including process failures, reusable project knowledge, and recommended updates to AGENTS.md or workflow artifacts.
---

# Team Retro

Use this skill after meaningful work ships, after a failed workflow, or when the user asks what should be learned.

Read `../shared/codex-workflow-primitives.md`, final artifacts, QA notes, and the relevant diff.

## Capture

Identify:

- What changed
- What went well
- What failed or caused rework
- Which assumptions were wrong
- Which tests or checks caught issues
- Which checks were missing
- Reusable project knowledge
- Suggested updates to `AGENTS.md`, docs, scripts, or future workflow steps

Do not update long-term memory unless the user explicitly asks for a memory update. Recommend concrete doc updates instead.

## Output

Write `docs/specs/<slug>/retro.md` or return inline:

- Timeline
- Decisions
- Incidents or near misses
- Action items
- Suggested instruction updates

Separate proven facts from recommendations.
