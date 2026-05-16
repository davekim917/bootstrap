---
name: team-receiving-review-feedback
description: Process code review, PR review, QA, or peer-agent feedback in Codex by accepting only evidence-backed findings and implementing narrow verified fixes.
---

# Team Receiving Review Feedback

Use this skill when the user gives review comments, QA findings, PR comments, or peer-agent feedback.

Read `../shared/codex-workflow-primitives.md`, the feedback, the current code, and any tests or artifacts that define the contract.

## Protocol

For each finding:

1. Restate the claimed issue in testable terms.
2. Trace the relevant source path.
3. Decide: accepted, rejected, duplicate, already fixed, or needs user decision.
4. Give evidence for the decision.
5. Implement accepted mechanical fixes immediately when they are local and low-risk.
6. Run focused verification.

Do not implement a reviewer suggestion just because multiple agents agreed. Reviewer count is not evidence.

## Output

Return a table or concise list:

- Finding
- Status
- Evidence
- Fix made or reason not made
- Verification

If a finding changes product behavior or public contract, ask before implementing unless the user already approved that behavior change.
