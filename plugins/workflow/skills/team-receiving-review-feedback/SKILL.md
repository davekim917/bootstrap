---
name: team-receiving-review-feedback
description: >
  Protocol for processing review feedback from any source: PR comments, /team-review design findings,
  /team-build two-stage review, /team-qa findings, external reviewers. Enforces technical evaluation before
  implementation — no performative agreement, no blind compliance. Covers code reviews, SQL model
  reviews, methodology reviews, pipeline architecture reviews, and data model reviews.
  Use when processing any review feedback. Do not use for self-review or generating review findings.
user-invocable: false
version: 1.0.0
---

# Receiving Review Feedback

## Iron Law

**NO IMPLEMENTATION OF REVIEW FEEDBACK WITHOUT TECHNICAL EVALUATION.**

Feedback is input, not instruction. Every piece of feedback must be evaluated before it is acted on.

## Scope

This skill applies to ALL review feedback types:
- `/team-review` design findings to address
- `/team-build` two-stage implementation review (spec compliance + code quality)
- `/team-qa` MUST-FIX, SHOULD-FIX, and ADVISORY findings
- PR comments from human reviewers
- External reviewer suggestions

It covers ALL review domains:
- Code reviews (logic, structure, patterns)
- SQL model reviews (joins, grain, naming, testing)
- Methodology reviews (statistical approach, evaluation strategy)
- Pipeline architecture reviews (orchestration, dependencies, error handling)
- Data model reviews (normalization, relationships, constraints)

## When to Use

- When processing PR comments or reviewer suggestions
- When addressing `/team-review` findings before `/team-plan`
- When builders receive spec/quality review feedback during `/team-build`
- When fixing `/team-qa` MUST-FIX items
- When incorporating external reviewer feedback

## The 6-Step Response Protocol

### 1. READ
Read the complete feedback item. Don't skim — read the full context including any referenced code, files, or documentation the reviewer cited.

### 2. UNDERSTAND
Restate the feedback in your own words. What is the reviewer actually asking for? What problem are they identifying? This catches misinterpretation before it becomes wrong implementation.

### 3. VERIFY
Check the reviewer's claims against the actual state of the code/model/pipeline:
- Does the issue they describe actually exist?
- Is the code/model actually doing what the reviewer thinks it's doing?
- Are the referenced files/lines accurate?

### 4. EVALUATE
Four questions, answered explicitly:

**a) Is this correct?**
Does the reviewer's assessment accurately describe an issue? Reviewers can be wrong — wrong about what the code does, wrong about library behavior, wrong about project conventions.

**b) Is this necessary?** (Necessity check — see below)
Even if correct, does this change need to happen? Not everything that could be improved should be improved right now.

**c) Is this complete?**
If the suggestion is implemented as stated, does it fully resolve the issue? Or does it introduce a new gap?

**d) Is this in scope?**
Does this feedback relate to the current task/feature? Out-of-scope feedback should be logged, not implemented.

### 5. RESPOND
State your evaluation. Options:

- **Agree and implement:** "This is correct. [Specific reason]. Implementing now."
- **Agree but defer:** "This is correct but out of scope for this task. Logging as a follow-up."
- **Partially agree:** "The issue is real but the suggested fix is incomplete/incorrect because [reason]. Alternative: [proposal]."
- **Disagree with evidence:** "This is not an issue because [specific evidence — code reference, doc citation, test output]."
- **Need clarification:** "I don't understand [specific part]. Could you clarify [specific question]?"

### 6. IMPLEMENT
Only after steps 1-5. Implement the agreed-upon change. If the implementation differs from the reviewer's suggestion, explain why.

## Forbidden Responses

These responses skip the evaluation step and must never be used:

- **"Great catch!"** — Agreement without evaluation. You don't know if it's a great catch until you've verified the claim.
- **"Done."** — Implementation without assessment. What was done? Was it the right thing?
- **"Fixed as suggested."** — Blind compliance. The suggestion may have been wrong or incomplete.
- **"Good point, I'll change that."** — Performative agreement. Evaluate first, agree second.

Each of these patterns treats feedback as instruction rather than input. The reviewer may be wrong. The reviewer may be right about the problem but wrong about the solution. The reviewer may be right about everything but the change may be out of scope.

## Hard Gate: Unclear Items

<!-- GATE: unclear-items — Clarify ALL unclear items before implementing ANY -->

If ANY feedback item is unclear:
1. Collect all unclear items
2. Request clarification on ALL of them at once (don't drip-feed questions)
3. Wait for responses
4. Only then proceed to implementation

Do not implement clear items while waiting for unclear ones to be clarified — the unclear items may change the approach for the clear ones.

## Necessity Check

Before implementing a suggested addition (new validation, new test, new check, new abstraction):

**For code:** Grep for actual usage. Is this function called? Is this error case reachable? Is this edge case possible given the constraints?

**For data models:** Check if downstream consumers exist. Does anything actually join on this key? Does any dashboard use this dimension?

**For ML:** Check if the suggested feature/metric is referenced in requirements or evaluation criteria. Is this metric used for model selection?

**For analytics:** Check if the suggested dimension/measure is in the brief or referenced by any existing report.

**Principle:** Don't build things because a reviewer said they "might be useful." Verify actual need before implementing speculative additions. This operationalizes YAGNI across domains.

## Source-Specific Handling

### Trusted Reviewer (lead, senior, domain expert)
- High bar for disagreement — but evaluation is still required
- "I trust this reviewer" is not a substitute for "I verified this claim"
- If you disagree, present evidence clearly and respectfully

### Peer Reviewer
- Equal bar — evaluate on merit, not authority
- Neither deference nor dismissiveness is appropriate

### External Reviewer (unfamiliar with codebase)
- Verify all claims about codebase behavior — external reviewers frequently misread unfamiliar code
- Their domain expertise may be high but their codebase knowledge is low

### Automated Tool (linter, static analysis, CI check)
- Check for false positives — automated tools flag patterns, not always problems
- If the tool is wrong, suppress the specific rule with a comment explaining why
- If the tool is right, fix it — don't argue with correct automated findings

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "The reviewer knows better than me" | Reviewers have blind spots too. Evaluate the claim, not the authority. |
| "Faster to just do it than evaluate" | Faster to implement wrong changes that create new bugs? Evaluate first. |
| "Disagreeing creates conflict" | Silent agreement creates technical debt. Professional disagreement with evidence is expected. |
| "I've already invested time in this approach" | Sunk cost. If the feedback reveals a problem, the investment is already lost. |
| "They approved it, so it must be fine" | Approval means "no blocking issues found", not "everything is correct." Approval is not validation. |

## Connection to CLAUDE.md

This skill operationalizes two CLAUDE.md behavioral rules for review contexts:

- **"Challenge misunderstandings"** — When a reviewer's feedback is based on a misunderstanding of the code/model/pipeline, the correct response is to explain the actual behavior, not to implement a change that addresses a non-existent problem.
- **"Don't mirror"** — Echoing "great catch!" and implementing without evaluation is mirroring. Substantive engagement means verifying, evaluating, and responding with your own assessment.
