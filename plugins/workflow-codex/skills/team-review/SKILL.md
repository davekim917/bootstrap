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

## Codex Reviewer Lanes

For substantial reviews, use independent passes:

- Architecture and contract pass
- Security, permissions, and data exposure pass
- Testing, observability, and operations pass
- Product and UX pass when user-facing behavior changes
- Adversarial pass that looks for hidden assumptions and missing edge cases

Use Codex subagents when the request explicitly calls for a review swarm or when independent parallel review materially improves coverage. Do not shell out to `codex` from Codex.

## Output

Write or return:

- Findings ordered by severity
- Evidence for each finding
- Accepted, rejected, or unproven status
- Minimal fix recommendation for accepted findings
- Residual risk and missing verification

If reviewing a design artifact, write `docs/specs/<slug>/review.md` unless the user asked for inline-only output.
