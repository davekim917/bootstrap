---
name: best-practice-check
description: Check a design, plan, or implementation against current best practices and official documentation before Codex commits to a risky approach.
---

# Best Practice Check

Use this skill when a choice depends on current framework, SDK, library, cloud, security, accessibility, or operational guidance.

Read `../shared/codex-workflow-primitives.md` when local workflow conventions matter.

## Source Priority

Use evidence in this order:

1. Project source and tests
2. Official docs for the exact library, SDK, API, or service
3. Maintainer migration guides or release notes
4. Standards documents
5. High-quality primary examples from the project ecosystem

Avoid blog posts and training-data memory when official docs are available. If current docs cannot be reached, state that the recommendation is unverified against current docs.

## Output

Return:

- Decision or recommendation
- Sources inspected
- Compatibility constraints
- Risks and failure modes
- Project-specific implications
- Minimal change needed

Keep recommendations tied to the actual codebase and version in front of you.
