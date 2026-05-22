---
name: team-review
description: Run an adversarial Codex review of a brief, design, plan, or code diff, producing accepted/rejected findings with concrete evidence and recommended fixes.
---

# Team Review

Use this skill before planning, before implementation, or when the user asks whether work is sound.

Read `../shared/codex-workflow-primitives.md` and the artifact or diff being reviewed.

## Review Standard

Treat reviewer comments as hypotheses, including your own first impression. Accept a finding only when you can point to:

- A concrete failure mode
- A violated requirement or invariant
- A source path, artifact line, test, log, or documented behavior

Reject or mark unproven anything that lacks evidence.

## Reviewer Lanes

For substantial reviews, use independent passes:

- Architecture and contract pass
- Security, permissions, and data exposure pass
- Testing, observability, and operations pass
- Product and UX pass when user-facing behavior changes
- Adversarial pass that looks for hidden assumptions and missing edge cases

## Parallel Reviewer Dispatch (DEFAULT for substantive reviews)

When the review covers >50 LOC of code OR a multi-file design OR a non-trivial brief, **dispatch reviewers IN PARALLEL** rather than running every pass yourself sequentially. Fire each as a background subagent and wait for all results before synthesizing.

Dispatch these specialists by name (they exist as named subagents in every runtime):

- `architecture-advisor` — design-level review, contract analysis
- `security-reviewer` — auth, validation, mounts, external input, data exposure
- `performance-analyzer` — hot paths, data access patterns, N+1
- `code-review-specialist` — general quality + correctness + style

Use the runtime's native parallel dispatch:
- **OpenCode**: `task({subagent_type: 'security-reviewer', description: 'Security review', prompt: '...', background: true})` — fire all in one tool turn; poll with `task_status` or block until completion.
- **Claude**: `Agent(subagent_type='security-reviewer', ...)` — Claude parallelizes Agent calls in one tool block automatically.
- **Codex**: parallel `spawn_task` calls in a single collab tool block.

The adversarial pass is the LEAD's job — run it yourself after specialist findings come in, looking for what they missed (hidden assumptions, cross-cutting risks).

**Solo review is appropriate ONLY for**: trivial diffs (single small file, <50 LOC), or when the user explicitly asks for a single-pass review. Default to dispatch; opt out only with cause.

Do not shell out to `codex` from Codex.

## Output

Write or return:

- Findings ordered by severity
- Evidence for each finding
- Accepted, rejected, or unproven status
- Minimal fix recommendation for accepted findings
- Residual risk and missing verification

If reviewing a design artifact, write `docs/specs/<slug>/review.md` unless the user asked for inline-only output.
