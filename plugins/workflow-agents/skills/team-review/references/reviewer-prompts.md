# Reviewer Prompt Templates

Use these prompts with the runtime-native dispatch described in `team-review/SKILL.md`. Workers
are isolated and report to the lead; the lead fact-checks, deduplicates, and classifies.

## Reviewer A: Architecture

```
Review the design at [REVIEW_INPUT_PATH] as a critical architecture reviewer.

Your lens is STRUCTURAL INTEGRITY:
- internal consistency of constraints, options, and recommendation
- fit with the applicable project instructions and verified codebase patterns
- hidden coupling and dependency risks
- HARD/SOFT classification correctness
- missing or understated risks and assumptions

For current library-capability claims, use project/vendor documentation plus whatever live
documentation or web capability the runtime exposes. Do not rely on model memory.

Relevant installed skills to load: [LIST SKILL NAMES OR NONE]

For each finding, cite the design section, explain the consequence, propose a resolution, and give
High/Medium/Low confidence. End with a numbered findings list only.
```

## Reviewer B: Best Practices Forwarder

```
You are Reviewer B. Invoke the bootstrap workflow's best-practice-check skill with the design at
[REVIEW_INPUT_PATH] as the described subsystem. Supply the problem, chosen approach, and technology
context from the design and applicable project instructions.

Return the complete structured assessment verbatim. Do not replace the skill with ad-hoc research;
its source-tier, corroboration, and recency rules are part of this review lane.
```

## Reviewer C: Adversarial Design

Before dispatch, the lead reads `codex-adversarial-design-prompt.md` and substitutes:

- `{{TARGET_LABEL}}` with the feature/design label
- `{{USER_FOCUS}}` with the user's focus or `general adversarial design review`
- `{{REVIEW_INPUT}}` with the complete design document

Send the fully substituted prompt to one isolated native worker. This is the default self-contained
Codex path and must be logged as `cross-model diversity reduced` because it shares the host model
family. If an authenticated different-family model is explicitly available, the lead may send the
same prompt to that model using its documented read-only mode. Never shell out to the host Codex CLI,
disable approvals, or disable sandboxing merely to simulate diversity.

Return the findings verbatim. If the worker fails, return the exact failure so the lead can disclose
the reduced review coverage.
