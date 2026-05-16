---
name: review-swarm
description: Run a Codex-native review swarm with independent reviewer passes over a design, plan, or diff, then deduplicate and adjudicate findings by evidence.
---

# Review Swarm

Use this skill for high-risk reviews where one reviewer is not enough.

Read `../shared/codex-workflow-primitives.md` and the artifact or diff under review.

## Codex Swarm Model

Codex does not need the Claude team-agent API. Use independent Codex reviewer passes and parent adjudication:

- Architecture reviewer
- Security and data exposure reviewer
- Test and correctness reviewer
- Performance and operations reviewer
- Product or UX reviewer when user-facing behavior changes
- Adversarial reviewer focused on hidden assumptions

Use subagents when available and appropriate. Otherwise run the passes sequentially with separated notes so conclusions do not contaminate each other.

## Adjudication

The lead must:

- Deduplicate overlapping findings.
- Reject findings with no concrete failure mode.
- Check source paths before accepting implementation-level findings.
- Rank accepted findings by severity.
- Separate must-fix from nice-to-have.

## Output

Return:

- Accepted findings, severity ordered
- Rejected or unproven findings
- Evidence references
- Minimal fixes
- Remaining review gaps

Do not fabricate reviewer disagreement. If all passes found no issue, say that and list residual test gaps.
