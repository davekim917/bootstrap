---
name: team-review
description: >
  Invoke after /team-design is approved. Produces a review report at .context/specs/<feature>/review.md.
  Do NOT write review docs manually — this skill spawns independent reviewers and has deduplication
  logic that only loads when invoked.
version: 2.2.0
---

# /team-review — Design Review (Architecture + Best Practice + Adversarial)

## What This Skill Does

Runs an approved design document through 3 independent reviewers, each with a different evidence
base and lens. Findings are deduplicated, fact-checked against the actual codebase, and classified
into MUST-FIX / SHOULD-FIX / WON'T-FIX. The design cannot proceed to `/team-plan` until MUST-FIX
items are resolved or explicitly waived.

**Key principle:** The reviewers complement each other along three axes.
- **Reviewer A (architecture-advisor, Claude)** judges *internal* fit — does this design work
  within the project's constraints, patterns, and existing code?
- **Reviewer B (best-practice-check)** judges *external* fit — does this approach match established
  industry patterns for this problem class, with rigorous source-tier discipline?
- **Reviewer C (Codex adversarial, GPT)** judges *assumption robustness* — what assumptions is the
  design making that might be wrong, what simpler approach would solve the same problem, what
  would a skeptical senior engineer object to? Runs on a non-Claude model for cross-model diversity.

Together they answer: "Is this design self-consistent, aligned with how the world solves this
problem, AND robust to skeptical challenge?"

**Output:** Structured review report (see `references/review-report-template.md`)
**NOT output:** Revised design (that's the user's job, then re-run `/team-review`)

## Prerequisites

An approved design document — either from `/team-design` or user-provided.

**If no design exists:** Tell the user: "I need an approved design document to review. Run `/team-design`
first."

## When to Use

- After `/team-design` is approved and before `/team-plan`
- When re-reviewing a design that had MUST-FIX items addressed
- Do NOT auto-trigger — the user consciously enters this workflow by typing `/team-review`

---

## Process

### Step 1: Setup

1. Get the design document. Check in order:
   - `.context/specs/<feature>/design.md` (standard location from `/team-design`)
   - Ask user to paste it if not found

2. Read `CLAUDE.md` — extract tech stack, conventions, critical guardrails, and relevant skill names.

3. Write the design to `.claude/tmp/review-input.md` so reviewers can read it from a stable path:
   ```bash
   mkdir -p .claude/tmp
   # Write design content to .claude/tmp/review-input.md
   ```

4. Identify the 2-3 project skills most relevant to this design. Start from `.claude/project-scope.md`
   if it exists (`relevant_global_skills` field), then cross-reference the design content using this
   domain-to-skill mapping:

   | Design content signals | Skill to load |
   |---|---|
   | dbt models, SQL transforms, marts, staging, schema.yml | `analytics-engineering` |
   | LLM API calls, RAG, prompts, evals, token cost, structured output | `llm-engineering` |
   | Agent loops, MCP tools/servers, multi-agent, memory, HITL | `agentic-systems` |
   | Airflow/Dagster/Prefect DAGs, ETL pipelines, ingestion, CDC, streaming | `data-engineering` |
   | ML training, notebooks, feature engineering, MLflow, model evaluation | `data-science` |
   | GL models, ARR/MRR/NRR, revenue recognition, budget vs actuals, reconciliation | `financial-analytics` |
   | TypeScript/React, REST/GraphQL APIs, auth, Node.js, AWS/GCP services | `software-engineering` |

   Select the 2-3 skills whose signals appear most prominently. Note them — Reviewer A will be told to load them.

### Step 2: Spawn 3 Independent Reviewers in Parallel

Launch all three simultaneously via the Task tool. Do not wait for one to finish before starting
the next. Each reviewer runs in an isolated context — no shared state, no awareness of the other
reviewers' findings.

**Pre-flight check for Reviewer C (Codex):** Verify `command -v codex` succeeds and
`~/.codex/auth.json` exists. If either is missing, skip Reviewer C with a warning and continue
with A and B. Document the skip in the review report header so the reader knows cross-model
diversity was reduced.

---

#### Reviewer A: Architecture (architecture-advisor subagent)

Use the Task tool with `subagent_type: architecture-advisor`. See `references/reviewer-prompts.md`
for the full prompt template. Fill in `[LIST SKILL NAMES]` with the 2-3 skills identified in Step 1.

Reviewer A's lens: **STRUCTURAL INTEGRITY**
- Internal consistency of constraints, options, and recommendation
- Fit with project patterns in CLAUDE.md
- Hidden coupling risks and dependency problems
- Constraint classification correctness (HARD vs SOFT)
- What's missing or understated
- Risks not acknowledged

Reviewer A has direct access to Context7, Exa, Read, Grep, Glob, Bash. It can verify library
capabilities and read codebase files to ground its findings.

---

#### Reviewer B: Best Practices (forwarder for /bootstrap-workflow:best-practice-check)

Use the Task tool with `subagent_type: general-purpose`. The subagent's only job is to invoke
`/bootstrap-workflow:best-practice-check` via the Skill tool with the design document as scope,
then return the skill's full structured output. See `references/reviewer-prompts.md` for the
full prompt template.

Note: `best-practice-check` ships inside this same plugin (`bootstrap-workflow`), so the dependency
is closed — wherever `/team-review` is installed, `/bootstrap-workflow:best-practice-check` is
guaranteed to be available.

Reviewer B's lens: **EXTERNAL PATTERN VALIDATION**
- Does the approach match established industry patterns for this problem class?
- Are there better-known patterns that solve the same problem?
- Has the chosen pattern been superseded or deprecated?
- Is the design drifting from current best practices?
- Are there anti-patterns present?

Reviewer B is a forwarder — it MUST invoke `/bootstrap-workflow:best-practice-check` via the
Skill tool, NOT do its own pattern research. The Skill has rigorous research discipline
(T1/T2/T3 source tiers, 2-source corroboration, recency filters) that cannot be approximated.

---

#### Reviewer C: Adversarial (Codex, design-focused)

Use the Task tool with `subagent_type: general-purpose`. The subagent's only job is to run
`codex exec --yolo` with the verbatim adversarial design prompt at
`references/codex-adversarial-design-prompt.md`, substituting `{{TARGET_LABEL}}`, `{{USER_FOCUS}}`,
and `{{REVIEW_INPUT}}` before invoking Codex. Returns the findings verbatim for the lead to merge.

See `references/reviewer-prompts.md` for the full subagent prompt template.

Reviewer C's lens: **ASSUMPTION CHALLENGE & BLIND SPOTS**
- What assumptions is this design making that might be wrong?
- What simpler approach would solve the same problem?
- What would cause this design to fail in production?
- What's being optimized for that shouldn't be?
- What's NOT being optimized for that should be?
- What would a skeptical senior engineer object to?
- Where is the design silent when it should be explicit?

**Why it's on Codex (non-Claude model):** A and B both run on Claude. Running the adversarial
lens on a different model — same design doc, different underlying weights — catches blind spots
that Claude reviewers tend to share. This is the cross-model diversity check at design stage
(mirroring what `/team-qa` Validator E does at post-build stage for code diffs).

**Why a design-specific prompt, not the code-diff prompt from `/team-qa`:** The codex plugin
ships a code-focused adversarial prompt whose attack surface enumerates code-level concerns
(auth, race conditions, schema drift, line-level grounding). Those don't apply to a design
document — a design doesn't have line numbers to ground against. The prompt at
`references/codex-adversarial-design-prompt.md` is purpose-built for design-time review, with
an assumption-challenge lens and relaxed structured-output requirements (free-form numbered
findings instead of schema-validated JSON, because design findings don't have line ranges).

**Why `--yolo`:** Same reason as Validator E — Codex's inner bwrap sandbox can't create nested
user namespaces inside Docker. `--yolo` is the documented short alias for
`--dangerously-bypass-approvals-and-sandbox`, explicitly intended for externally-sandboxed
environments like our container.

---

#### Why three reviewers

Three lenses, three evidence bases, ideally three models where available:
- Reviewer A: internal fit — evidence from the codebase (Claude)
- Reviewer B: external fit — evidence from industry pattern research (Claude reading external sources)
- Reviewer C: assumption robustness — evidence from skeptical challenge (Codex/GPT)

The three are complementary because each catches things the others miss:
- A misses patterns the project hasn't adopted yet
- B misses project-specific constraints that invalidate the "best practice"
- C misses concrete codebase fit but surfaces hidden assumptions

A design that survives all three is meaningfully more defensible than one reviewed by any two.

---

### Step 3: Collect All Findings

Wait for both reviewers to complete. Compile their raw findings into a working list. At this
stage, do not classify or deduplicate — just enumerate everything found.

### Step 4: Team Lead — Deduplicate, Fact-Check, Classify

This is the most important step. Work through each finding:

**Deduplication:**
- Same finding from both reviewers = stronger signal; merge and note both raised it
- Near-duplicate findings = merge with a note (e.g., "Reviewer A flags structural coupling that
  Reviewer B classifies as drift from the layered-architecture pattern — treating as one finding")
- Genuinely different findings = keep separate

**Fact-checking:**
For each finding, verify it against the actual codebase:
- Read the relevant source files (scoped — only what's needed to validate the finding)
- If a reviewer says "the project uses X pattern" — verify it exists
- If a reviewer says "this conflicts with Y" — read Y and confirm the conflict
- If Reviewer B cites a best-practice source, sanity-check that the source tier (T1/T2) is justified
- Mark each finding as: Verified / Unverified / Contradicted (reviewer was wrong)

Drop findings that are contradicted by the codebase. Do not include false positives in the report.

**Cost/Benefit Framing:**

For each finding, assign two dimensions before classifying:

| Dimension | Low | Medium | High |
|-----------|-----|--------|------|
| **Effort to Fix** | 1-line change or clarification | Requires design revision | Requires significant rework or spike |
| **Impact if Ignored** | Style/preference, no correctness risk | Technical debt, production risk | System breaks, hard constraint violated |

**Classification:** derives from the two dimensions above:

| Class | Definition | Effort → Impact pattern |
|-------|-----------|------------------------|
| **MUST-FIX** | Design cannot proceed as written; would cause failures, violate hard constraints, or produce a system that can't be built as described | Any Effort + High Impact |
| **SHOULD-FIX** | Significant risk or quality issue; strongly recommend addressing before `/team-plan` but not blocking if user accepts the risk | Any Effort + Medium Impact |
| **WON'T-FIX** | Valid observation but cost > benefit; explicitly logged with reasoning so it's not forgotten | High Effort + Low Impact |

**Classification heuristics:**
- Contradicts a HARD constraint → MUST-FIX
- Would cause builder to make a wrong guess that affects correctness → MUST-FIX
- Significant unacknowledged risk with no mitigation → MUST-FIX
- Pattern superseded by current best practice (Reviewer B with T1/T2 sources) → MUST-FIX or SHOULD-FIX depending on impact
- Pattern misalignment that creates technical debt → SHOULD-FIX
- Drift from best practice but pattern is still valid → SHOULD-FIX
- Missing but recoverable during implementation → SHOULD-FIX
- Style/preference with no correctness impact → WON'T-FIX
- Valid but out of scope for this design → WON'T-FIX

### Step 5: STOP — Present Report and Gate

Write the complete review report using `references/review-report-template.md`.

Save the review report to disk:
1. Derive the feature name from the design document title (kebab-case, e.g., "User Authentication" → "user-authentication")
2. `mkdir -p .context/specs/<feature>/`
3. Write the report to `.context/specs/<feature>/review.md`
4. Update the decision record at `.context/specs/<feature>/decisions.yaml`:
   - Append each waived MUST-FIX finding with its stated reason and risk level
   - Format: see `skills/shared/decision-record-schema.md`

Include the save path in the gate message so downstream skills (`/team-plan`) know where to find it.

Then STOP. Display exactly this gate:

```
---
**Review complete.**

Reviewers run: A (architecture) · B (best-practice) · C (codex adversarial)
[If C was skipped: replace "C (codex adversarial)" with "C: skipped — <reason>"]

MUST-FIX: [N] findings
SHOULD-FIX: [N] findings
WON'T-FIX: [N] findings (logged)

[If MUST-FIX > 0:]
The design has [N] blocking issues. Address them in the design document, then re-run `/team-review`.
Or explicitly waive any finding with a stated reason — waived findings are logged, not dropped.

[If MUST-FIX == 0:]
No blocking issues. Say "approved" to proceed to `/team-plan`.

[If Reviewer C was skipped:]
⚠ Cross-model diversity reduced — Codex unavailable, only Claude reviewers ran. Consider
re-running with Codex once available if the design touches high-stakes areas.
---
```

<!-- GATE: review-clearance — All MUST-FIX resolved or waived before /team-plan -->
**Loop:** If the user revises the design to address MUST-FIX items, re-run from Step 1.
**Exit:** When no MUST-FIX items remain (all addressed or explicitly waived with reason).

---

## Reviewer Lenses (Summary)

| Reviewer | Model | Implementation | Lens | Evidence base |
|----------|-------|---------------|------|---------------|
| A: architecture-advisor | Claude | Task subagent | Structural integrity, internal pattern fit | Codebase + CLAUDE.md + Context7/Exa for library verification |
| B: bootstrap-workflow:best-practice-check | Claude | Task subagent forwarder → Skill tool | External pattern validation, drift from established practice | Mandatory external research via Exa/Context7/DeepWiki with T1/T2/T3 source tiers |
| C: codex-adversarial-design | Codex (GPT) | Task subagent runs `codex exec --yolo` with verbatim prompt from `references/codex-adversarial-design-prompt.md` | Assumption challenge, blind spots, simpler-approach alternatives | Design document only — no codebase access, no external research |

Each reviewer gets: design document at `.claude/tmp/review-input.md` + CLAUDE.md
Each reviewer works in isolation: no shared state, no awareness of the other reviewers' findings

---

## Anti-Patterns (Do Not Do These)

- **Don't let reviewers see each other's output.** Independent contexts are the point. Cross-contamination defeats the multi-lens model.
- **Don't approximate /bootstrap-workflow:best-practice-check.** Reviewer B MUST invoke the skill via the Skill tool. Doing your own pattern research instead skips the source-tier discipline that makes the skill credible.
- **Don't approximate Reviewer C.** Use the verbatim prompt from `references/codex-adversarial-design-prompt.md`. Do NOT write your own adversarial prompt for Codex. The verbatim prompt has calibrated grounding rules (no inventing design claims) and a specific lens tuned for design-stage review. Claude running an "adversarial lens" on the design is a fallback only when Codex is unavailable — and when that happens, it should be clearly labeled as a Claude fallback, not a true cross-model check.
- **Don't skip fact-checking.** A finding that contradicts the actual codebase is a false positive that wastes the user's time. This applies to all three reviewers — verify claims against the code before propagating them. For Reviewer C specifically, verify its "what about X simpler approach?" suggestions against actual project constraints before propagating.
- **Don't inflate MUST-FIX.** If everything is MUST-FIX, nothing is. Reserve it for genuine blockers.
- **Don't silently drop WON'T-FIX items.** Log them. They may become important later.
- **Don't let users waive MUST-FIX without a stated reason.** The reason is auditable context for the next reviewer.
- **Don't skip the loop.** A revised design can introduce new issues. Re-review after significant changes.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "It looks fine" | "Looks fine" is not a finding. State what you checked and concluded. |
| "Not worth raising" | If you noticed it, log it. Classify WON'T-FIX if cost outweighs benefit. |
| "I trust the design" | Trust is not verification. Check claims against the actual implementation. |
| "Minor issue" | Classify ADVISORY and log. Minor issues accumulate into major debt. |
| "bootstrap-workflow:best-practice-check is slow, I'll skip it" | The whole point of Reviewer B is the external research discipline. Skipping it removes the skill's value. |
| "I'll just do the research myself instead of invoking the skill" | Approximation. The skill has tier classification, corroboration rules, and recency filters. You cannot replicate them in an ad-hoc Exa search. |
| "Codex is slow, I'll run Claude with the adversarial lens instead" | Running an adversarial lens on Claude when two other Claude reviewers (A, B) already ran removes the cross-model diversity that was the whole point of Reviewer C. That's not a substitute — that's three Claude reviewers with a blind spot in common. Report C as skipped and let the user decide whether to proceed. |
| "I'll write my own adversarial prompt for Codex instead of using the verbatim one" | Approximation. The verbatim prompt at `references/codex-adversarial-design-prompt.md` has calibrated grounding rules (no inventing design claims) and a specific assumption-challenge lens tuned for design-stage review. A hand-rolled prompt loses both. |

---

## Rollback

Review does not accept rollbacks. If the design changes after review, re-run `/team-review` on the revised design.

The review report is a point-in-time assessment. A changed design requires a fresh assessment, not a patched one.

---

## Context Discipline

**Read (for setup):**
- `.context/specs/<feature>/design.md` — the subject of the review
- `CLAUDE.md` — project context and conventions
- `references/codex-adversarial-design-prompt.md` — the verbatim prompt Reviewer C's subagent uses

**Read (for fact-checking in Step 4):**
- Scoped source files relevant to each finding — only what's needed to validate

**Write:**
- `.claude/tmp/review-input.md` — design content for reviewers (Step 1)
- `/tmp/codex-design-prompt.md` — Reviewer C's substituted prompt (temporary)
- `.context/specs/<feature>/review.md` — the completed review report (Step 5)
- `.context/specs/<feature>/decisions.yaml` — updated decision record with waivers (Step 5)

**Do NOT read:**
- Entire codebase
- Files unrelated to the findings being fact-checked
- Other specs or designs not referenced in this one
