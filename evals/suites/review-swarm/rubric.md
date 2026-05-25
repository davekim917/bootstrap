# review-swarm — scoring rubric

Inherits the default metrics and thresholds from `evals/README.md`. Overrides and
skill-specific details below.

## Static lint anchors (Gate 1)

The augmented `review-swarm/SKILL.md` must contain all of these runtime-neutral
substance markers (their absence means the skill was gutted, not translated):

- `Detect the domain` (Step 1 domain detection)
- `adversarial-reviewer` and `domain-reviewer` (required reviewers)
- the dynamic-reviewer selection table (`Select When`)
- `context7`, `deepwiki`, `Exa (mandatory` (research protocol)
- `Rationalization Resistance`
- `[BUG/SUGGESTION] file:line` (output contract)
- `## Dispatch by Runtime` naming both `Codex` and `OpenCode`

Required reference files: `references/review-criteria.md`, `references/reviewer-prompt-template.md`.

## Behavioral thresholds (Gate 2)

Defaults from README apply. Skill-specific notes:

- **Reviewer selection sanity**: the swarm must spawn the `expected_reviewers_include`
  set for the fixture (or clearly-equivalent roles), and must NOT spawn all reviewers
  for a small single-file diff. Spawning 0 reviewers (solo review) fails the process gate.
- **Security / data-correctness recall = 1.00, at BUG severity**: on fixtures 01 and 02,
  every `must_catch` finding tagged `security` or `data-correctness` must be caught AND
  reported as a `[BUG]`. Missing one — or downgrading it to `[SUGGESTION]` — is an automatic
  fixture FAIL regardless of other metrics (a downgraded security/data bug may ship).
- **Performance/style severity is advisory**: BUG-vs-SUGGESTION for non-security/data
  findings (e.g. N+1, unbounded fetch) is a debatable judgment call and does NOT gate
  pass/fail. It is reported for human read.
- **Benign precision (fixture 03)**: exactly 0 BUG findings. Any BUG = FAIL.

## Per-fixture pass summary

| Fixture | Must-catch | Hard gate |
|---------|-----------|-----------|
| 01-ts-api | sql-injection, idor-missing-authz, n-plus-one | security recall = 1.00 (injection + IDOR) |
| 02-dbt-model | payment-fanout-inflates-revenue, inner-join-drops-unpaid-orders | data-correctness recall = 1.00 |
| 03-benign-refactor | (none) | 0 BUG findings |

## Judge instructions

The LLM judge receives: the fixture `input.md`, the `truth.json`, and the agent's final
review report (+ transcript for process behavior). It must:

1. Match each reported finding to a truth finding by `where`/`rationale` semantics (not
   string equality). A reported finding matches at most one truth finding.
2. Compute recall (must-catch), false-BUG rate, severity accuracy, format compliance,
   process behavior — per README definitions.
3. Apply the hard gates above.
4. Emit a verdict object: `{ fixture, runtime, metrics:{...}, hard_gates:{...}, verdict: "PASS"|"FAIL", notes }`.
5. Apply the README false-BUG definition exactly: a reported BUG is "false" only if it
   hits a `false_positive_trap` or is affirmatively incorrect/duplicative — NOT merely
   because it is absent from the truth set. Surfacing an additional *real, code-grounded*
   issue is thoroughness, not imprecision; padding with vague/duplicative/incorrect BUGs is
   what fails precision. (On the benign fixture 03 there are no real issues, so any reported
   BUG is incorrect by definition → fails.)
