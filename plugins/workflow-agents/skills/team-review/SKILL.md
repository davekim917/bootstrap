---
name: team-review
description: >
  Invoke after /team-design is approved. Produces a review report at docs/specs/<feature>/review.md.
  Do NOT write review docs manually — this skill spawns independent reviewers and has deduplication
  logic that only loads when invoked.
version: 2.3.0
---

# /team-review — Design Review (Architecture + Best Practice + Adversarial)

## What This Skill Does

Runs an approved design document through 3 independent reviewers, each with a different evidence
base and lens. Findings are deduplicated, fact-checked against the actual codebase, and classified
into MUST-FIX / SHOULD-FIX / WON'T-FIX. The design cannot proceed to `/team-plan` until MUST-FIX
items are resolved or explicitly waived.

**Key principle:** The reviewers complement each other along three axes.
- **Reviewer A (architecture-advisor role, host runtime)** judges *internal* fit — does this design work
  within the project's constraints, patterns, and existing code?
- **Reviewer B (best-practice-check)** judges *external* fit — does this approach match established
  industry patterns for this problem class, with rigorous source-tier discipline?
- **Reviewer C (adversarial)** judges *assumption robustness* — what assumptions is the
  design making that might be wrong, what simpler approach would solve the same problem, what
  would a skeptical senior engineer object to? Runs on a model different from the host runtime for cross-model diversity.

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

### Step 0: Cycle Cap Check

Before doing anything else, count how many review cycles have already run for this feature.

1. Read `docs/specs/<feature>/decisions.yaml`. Look for the `review_cycles` array.
2. Let `N` = number of entries in that array. Edge cases:
   - File missing or `review_cycles` array missing → `N = 0`.
   - File present but malformed YAML, or `review_cycles` is not an array → STOP. Tell the user
     the decision record is corrupt and ask whether to repair or treat as `N = 0`. Do not
     silently overwrite.
3. If `N >= 5`, **STOP** and emit this gate verbatim — do not run reviewers, do not write a new
   report:

   ```
   ---
   **Review cycle cap reached (5/5).**

   This design has been through 5 review cycles. The remaining MUST-FIX findings either need
   human judgment or indicate the design needs to be reworked from `/team-design`, not patched
   through another review pass.

   Options:
   1. **Waive remaining MUST-FIX** — explicitly accept each with a stated reason. They will be
      logged in `docs/specs/<feature>/decisions.yaml` under `waivers`.
   2. **Rework the design** — return to `/team-design` with the unresolved findings as new input.
   3. **Escalate** — the user (you) makes the call on each finding. State the call and the reason.
   4. **Simplify the design** — request a "cut to MVP" pass that supersedes earlier
      additions. Appropriate when cycle-2 fixes introduce new MUST-FIX in cycle 3; reset
      to the /team-design Step 6c MVP scope boundary. This is a /team-design re-entry,
      not a /team-review re-run.

   No 6th review cycle. Tell me which path you want.
   ---
   ```

4. If `N < 5`, proceed to Step 1. (You will append a new entry to `review_cycles` in Step 5.)

### Step 1: Setup

1. Get the design document. Check in order:
   - `docs/specs/<feature>/design.md` (standard location from `/team-design`)
   - Ask user to paste it if not found

2. Read `AGENTS.md/CLAUDE.md` — extract tech stack, conventions, critical guardrails, and relevant skill names.

3. Write the design to `.agents/tmp/bootstrap-workflow/review-input.md` so reviewers can read it from a stable path:
   ```bash
   mkdir -p .agents/tmp/bootstrap-workflow
   # Write design content to .agents/tmp/bootstrap-workflow/review-input.md
   ```

4. Identify the 2-3 project skills most relevant to this design. Start from `docs/project-scope.md`
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

Spawn all three reviewers **in parallel, as independent worker passes** — see **§ Dispatch by
Runtime** for the exact primitive on your runtime. Do not wait for one to finish before starting
the next. Each reviewer runs in an isolated context — no shared state, no awareness of the other
reviewers' findings. The reviewer roles, lenses, and prompts below are runtime-agnostic; only the
spawn mechanism differs.

**Pre-flight second-model check for Reviewer C (adversarial):** Reviewer C is the cross-model
lens — it must run on a model *different from the host runtime* so its blind spots don't overlap
A and B's. Before spawning, determine whether a different model is reachable (see **§ Dispatch by
Runtime** for the exact detection command on your runtime — e.g. probing for a non-host model's
CLI on `PATH`). Two outcomes:

- **A different model is available** → run Reviewer C there (true cross-model diversity).
- **No different model is available** → fall back to a **same-runtime adversarial pass** (a native
  worker on the host runtime, in an isolated context) and **log `⚠ Cross-model diversity reduced —
  no second model available; Reviewer C ran a same-runtime adversarial pass.`** Document the
  reduced diversity in the review report header so the reader knows. If the host runtime cannot run
  even a same-runtime adversarial pass, skip Reviewer C and continue with A and B, noting the skip.

---

#### Reviewer A: Architecture (architecture-advisor role)

Spawn this reviewer as an independent worker with the architecture-advisor role (the role is defined
by its prompt — see § Dispatch by Runtime for the per-runtime worker primitive). See
`references/reviewer-prompts.md` for the full prompt template. Fill in `[LIST SKILL NAMES]` with the
2-3 skills identified in Step 1.

Reviewer A's lens: **STRUCTURAL INTEGRITY**
- Internal consistency of constraints, options, and recommendation
- Fit with project patterns in AGENTS.md/CLAUDE.md
- Hidden coupling risks and dependency problems
- Constraint classification correctness (HARD vs SOFT)
- What's missing or understated
- Risks not acknowledged

Reviewer A has direct access to Context7, Exa, Read, Grep, Glob, Bash. It can verify library
capabilities and read codebase files to ground its findings.

---

#### Reviewer B: Best Practices (forwarder for /bootstrap-workflow:best-practice-check)

Spawn this reviewer as an independent worker (a generic worker — no specialized role; see § Dispatch
by Runtime for the per-runtime worker primitive). The worker's only job is to invoke
`/bootstrap-workflow:best-practice-check` via your runtime's skill/command invocation with the design
document as scope, then return the skill's full structured output. See `references/reviewer-prompts.md`
for the full prompt template.

Note: `best-practice-check` ships inside this same plugin (`bootstrap-workflow`), so the dependency
is closed — wherever `/team-review` is installed, `/bootstrap-workflow:best-practice-check` is
guaranteed to be available.

Reviewer B's lens: **EXTERNAL PATTERN VALIDATION**
- Does the approach match established industry patterns for this problem class?
- Are there better-known patterns that solve the same problem?
- Has the chosen pattern been superseded or deprecated?
- Is the design drifting from current best practices?
- Are there anti-patterns present?

Reviewer B is a forwarder — it MUST invoke `/bootstrap-workflow:best-practice-check` via your
runtime's skill/command invocation, NOT do its own pattern research. That skill has rigorous research
discipline (T1/T2/T3 source tiers, 2-source corroboration, recency filters) that cannot be approximated.

---

#### Reviewer C: Adversarial (cross-model, design-focused)

Spawn this reviewer as an independent worker (a generic worker — no specialized role; see § Dispatch
by Runtime for the per-runtime worker primitive). The worker's only job is to run the adversarial
lens **on a model different from the host runtime** (cross-model diversity), using the verbatim
adversarial design prompt at `references/codex-adversarial-design-prompt.md`, substituting
`{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, and `{{REVIEW_INPUT}}` before invoking it. Returns the findings
verbatim for the lead to merge. The concrete launch — which model to target, and the
`codex exec --yolo` invocation when the different model is Codex — is in **§ Dispatch by Runtime**,
along with the same-runtime fallback when no second model is reachable.

See `references/reviewer-prompts.md` for the full worker prompt template.

Reviewer C's lens: **ASSUMPTION CHALLENGE & BLIND SPOTS**
- What assumptions is this design making that might be wrong?
- What simpler approach would solve the same problem?
- What would cause this design to fail in production?
- What's being optimized for that shouldn't be?
- What's NOT being optimized for that should be?
- What would a skeptical senior engineer object to?
- Where is the design silent when it should be explicit?

**Why a different model from the host runtime:** Reviewers A and B run on the host runtime (the
model you're running on). Running the adversarial lens on a *different* model — same design doc,
different underlying weights — catches blind spots that same-model reviewers tend to share. The
target model must therefore be chosen to differ from the host: when the host is Codex, target a
non-Codex model (e.g. `claude -p`); when the host is OpenCode, target a different model. This is
the cross-model diversity check at design stage (mirroring what `/team-qa` Validator E does at
post-build stage for code diffs). When no different model is reachable, Reviewer C falls back to a
same-runtime adversarial pass with a logged "cross-model diversity reduced" note (Step 2 pre-flight).

**Why a design-specific prompt, not the code-diff prompt from `/team-qa`:** The codex plugin
ships a code-focused adversarial prompt whose attack surface enumerates code-level concerns
(auth, race conditions, schema drift, line-level grounding). Those don't apply to a design
document — a design doesn't have line numbers to ground against. The prompt at
`references/codex-adversarial-design-prompt.md` is purpose-built for design-time review, with
an assumption-challenge lens and relaxed structured-output requirements (free-form numbered
findings instead of schema-validated JSON, because design findings don't have line ranges).

**Why `--yolo` (when the cross-model target is Codex):** Same reason as Validator E — Codex's inner
bwrap sandbox can't create nested user namespaces inside Docker. `--yolo` is the documented short
alias for `--dangerously-bypass-approvals-and-sandbox`, explicitly intended for externally-sandboxed
environments like our container.

---

#### Why three reviewers

Three lenses, three evidence bases, ideally two models where available:
- Reviewer A: internal fit — evidence from the codebase (host runtime)
- Reviewer B: external fit — evidence from industry pattern research (host runtime reading external sources)
- Reviewer C: assumption robustness — evidence from skeptical challenge (a different model from the host)

The three are complementary because each catches things the others miss:
- A misses patterns the project hasn't adopted yet
- B misses project-specific constraints that invalidate the "best practice"
- C misses concrete codebase fit but surfaces hidden assumptions

A design that survives all three is meaningfully more defensible than one reviewed by any two.

---

### Step 3: Collect All Findings

Wait for all three reviewers to complete (or two, if Reviewer C was skipped via the pre-flight check at Step 2). Compile their raw findings into a working list. At this stage, do not classify or deduplicate — just enumerate everything found.

### Step 4: Team Lead — Deduplicate, Fact-Check, Classify

This is the most important step. Work through each finding:

**Deduplication:**
- Same finding from two or more reviewers = stronger signal; merge and note which reviewers raised it
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
2. `mkdir -p docs/specs/<feature>/`
3. Write the report to `docs/specs/<feature>/review.md`
4. Update the decision record at `docs/specs/<feature>/decisions.yaml`:
   - Append each waived MUST-FIX finding with its stated reason and risk level
   - Append a new `review_cycles` entry with `iteration` = N+1 (where N is the cycle count from Step 0), the MUST-FIX / SHOULD-FIX / WON'T-FIX counts from this run, and `completed_at` = current ISO 8601 timestamp
   - Format: see `skills/shared/decision-record-schema.md`

Include the save path in the gate message so downstream skills (`/team-plan`) know where to find it.

**Cycle-5 close gate — `[NEEDS SPEC]` tags:** On cycle 5 / cap-reached, any reviewer recommendation not promoted to concrete design spec becomes `[NEEDS SPEC: <one-line summary>]` in review.md under a final "Carry-forward to /team-plan" section.

Then STOP. Display exactly this gate:

```
---
**Review complete.** (Cycle [N+1]/5)

Reviewers run: A (architecture) · B (best-practice) · C (cross-model adversarial)
[If C ran as a same-runtime fallback: replace "C (cross-model adversarial)" with "C (same-runtime adversarial — cross-model diversity reduced)"]
[If C was skipped entirely: replace "C (cross-model adversarial)" with "C: skipped — <reason>"]

MUST-FIX: [N] findings
SHOULD-FIX: [N] findings
WON'T-FIX: [N] findings (logged)

[If MUST-FIX > 0 and cycle < 5:]
The design has [N] blocking issues. Address them in the design document, then re-run `/team-review`.
Or explicitly waive any finding with a stated reason — waived findings are logged, not dropped.
Cycles remaining: [5 - (N+1)].

[If MUST-FIX > 0 and cycle == 5:]
⚠ Final review cycle (5/5). The next `/team-review` invocation will refuse to run another cycle.
Either waive remaining MUST-FIX with stated reasons, or return to `/team-design` to rework.

[If MUST-FIX == 0:]
No blocking issues. Say "approved" to proceed to `/team-plan`.

[If Reviewer C ran as a same-runtime fallback or was skipped:]
⚠ Cross-model diversity reduced — no model different from the host runtime was available, so
Reviewer C ran a same-runtime adversarial pass (or was skipped). Consider re-running with a
different model available if the design touches high-stakes areas.
---
```

<!-- GATE: review-clearance — All MUST-FIX resolved or waived before /team-plan -->
**Loop:** If the user revises the design to address MUST-FIX items, re-run from Step 0.
**Exit:** When no MUST-FIX items remain (all addressed or explicitly waived with reason),
OR when the 5-cycle cap is reached (see Step 0 — escalation required).

---

## Reviewer Lenses (Summary)

| Reviewer | Model | Implementation | Lens | Evidence base |
|----------|-------|---------------|------|---------------|
| A: architecture-advisor role | Host runtime | Worker pass (architecture-advisor role) | Structural integrity, internal pattern fit | Codebase + AGENTS.md/CLAUDE.md + Context7/Exa for library verification |
| B: bootstrap-workflow:best-practice-check | Host runtime | Worker pass forwarding to `/bootstrap-workflow:best-practice-check` | External pattern validation, drift from established practice | Mandatory external research via Exa/Context7/DeepWiki with T1/T2/T3 source tiers |
| C: adversarial-design | A model *different from the host* (e.g. `claude -p` when host is Codex); else same-runtime fallback with logged reduced-diversity note | Worker pass runs the verbatim prompt from `references/codex-adversarial-design-prompt.md` (`codex exec --yolo` when the different model is Codex) | Assumption challenge, blind spots, simpler-approach alternatives | Design document only — no codebase access, no external research |

Each reviewer gets: design document at `.agents/tmp/bootstrap-workflow/review-input.md` + AGENTS.md/CLAUDE.md
Each reviewer works in isolation: no shared state, no awareness of the other reviewers' findings

---

## Anti-Patterns

Each pattern below states the *why* first — what fails when the pattern slips — and ends with the rule. Read these as load-bearing reasoning, not commandments.

- **Independent contexts are the entire value proposition of multi-lens review.** When reviewers see each other's output, all three lenses converge on whoever spoke first; you've paid for three reviews and gotten one. Keep each reviewer in isolation — no shared scratchpads, no relayed findings, no peeking.
- **Reviewer B's credibility comes from the source-tier discipline inside `bootstrap-workflow:best-practice-check`** — T1/T2/T3 corroboration, recency filters, mandatory external research. Hand-rolling pattern research approximates the appearance without any of the discipline, and produces findings the user can't trust. Invoke the skill via your runtime's skill/command invocation; don't do your own pattern research instead.
- **The verbatim adversarial prompt at `references/codex-adversarial-design-prompt.md` is calibrated** — grounding rules that block invented design claims, and an assumption-challenge lens specifically tuned for design-stage review. A hand-written adversarial prompt loses both calibration points. Use the verbatim prompt; if no model different from the host is available, label the fallback explicitly as a same-runtime pass — running the "adversarial lens" on the same model as Reviewers A and B is three same-model reviewers with shared blind spots, not a true cross-model check.
- **A finding that contradicts the actual codebase is a false positive that costs the user time and erodes trust** — including the simpler-approach suggestions Reviewer C surfaces. Fact-check every finding against the code (and against project constraints, for C's suggestions) before propagating it.
- **MUST-FIX inflation cheapens the signal** — if everything is MUST-FIX, the user can no longer tell what's actually blocking. Reserve MUST-FIX for genuine blockers; route the rest to SHOULD-FIX or WON'T-FIX per the classification table above.
- **WON'T-FIX items dropped silently become invisible context for the next reviewer** — they may turn out to matter when the design changes. Log every WON'T-FIX with its reasoning, even when you're confident it's the right call now.
- **Waivers without stated reasons are unfalsifiable later** — a future reviewer can't tell whether the original judgment was sound or careless. Require a stated reason for every MUST-FIX waiver; the reason is the audit trail.
- **A revised design can reintroduce issues the previous round resolved or surface new ones from the changes themselves** — single-shot review on a moving target misses both. Re-run the full loop after significant revisions.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "It looks fine" | "Looks fine" is not a finding. State what you checked and concluded. |
| "Not worth raising" | If you noticed it, log it. Classify WON'T-FIX if cost outweighs benefit. |
| "I trust the design" | Trust is not verification. Check claims against the actual implementation. |
| "Minor issue" | Classify SHOULD-FIX or WON'T-FIX with stated reason and log. Minor issues accumulate into major debt. |
| "bootstrap-workflow:best-practice-check is slow, I'll skip it" | The whole point of Reviewer B is the external research discipline. Skipping it removes the skill's value. |
| "I'll just do the research myself instead of invoking the skill" | Approximation. The skill has tier classification, corroboration rules, and recency filters. You cannot replicate them in an ad-hoc Exa search. |
| "The different model is slow, I'll run the adversarial lens on the host runtime instead" | Running the adversarial lens on the host runtime when Reviewers A and B already ran there removes the cross-model diversity that was the whole point of Reviewer C. That's not a substitute — that's three same-model reviewers with a blind spot in common. If no different model is reachable, run the same-runtime fallback and report the reduced diversity (or report C as skipped); let the user decide whether to proceed. |
| "I'll write my own adversarial prompt instead of using the verbatim one" | Approximation. The verbatim prompt at `references/codex-adversarial-design-prompt.md` has calibrated grounding rules (no inventing design claims) and a specific assumption-challenge lens tuned for design-stage review. A hand-rolled prompt loses both. |

---

## Rollback

Review does not accept rollbacks. If the design changes after review, re-run `/team-review` on the revised design.

The review report is a point-in-time assessment. A changed design requires a fresh assessment, not a patched one.

---

## Context Discipline

**Read (for setup):**
- `docs/specs/<feature>/design.md` — the subject of the review
- `AGENTS.md/CLAUDE.md` — project context and conventions
- `references/codex-adversarial-design-prompt.md` — the verbatim prompt Reviewer C's cross-model worker uses

**Read (for fact-checking in Step 4):**
- Scoped source files relevant to each finding — only what's needed to validate

**Write:**
- `.agents/tmp/bootstrap-workflow/review-input.md` — design content for reviewers (Step 1)
- `/tmp/codex-design-prompt.md` — Reviewer C's substituted prompt (temporary)
- `docs/specs/<feature>/review.md` — the completed review report (Step 5)
- `docs/specs/<feature>/decisions.yaml` — updated decision record with waivers (Step 5)

**Do NOT read:**
- Entire codebase
- Files unrelated to the findings being fact-checked
- Other specs or designs not referenced in this one

---

## Dispatch by Runtime

The review substance above is runtime-agnostic — the three reviewer lenses (A architecture, B
best-practice forwarder, C cross-model adversarial), their prompts, the dedup/fact-check/classify
logic, and the cycle-cap gate. The orchestration primitives below are the **only** runtime-specific
part: how the reviewers are spawned, and **which model backs Reviewer C** (it must differ from the
host runtime). Implement these four primitives for your runtime; everything else stays the same.

| Primitive | What it does |
|-----------|--------------|
| `spawn_reviewers` | Fan out the three reviewers (A, B, C) in parallel, each in an isolated context, each with its constructed prompt from `references/reviewer-prompts.md`. A and B run on the host runtime; **Reviewer C runs on a model different from the host** (cross-model diversity), falling back to a same-runtime adversarial pass with a logged reduced-diversity note when no second model is reachable, or skipped entirely if even that is impossible. |
| `collect_findings` | Gather each reviewer's raw findings back to the lead (two reviewers if C was skipped) |
| `cross_check` | Step 4 convergence — **lead-mediated**: the lead dedups, fact-checks against the codebase, and classifies. The three reviewers run in isolation with no awareness of each other; convergence is the lead's job, not a peer round. |
| `teardown` | Reclaim worker sessions after the report ships |

> Reviewer identity is defined by the **prompt** (role + lens + criteria), not by a registered
> agent type. Reviewer A's "architecture-advisor" label, and Reviewers B and C as generic
> forwarders, are just role labels — each reviewer is an independent worker given its role and the
> relevant prompt from `references/reviewer-prompts.md`. This mirrors the Claude version, which
> spawns them as prompt-defined subagents.
>
> **Reviewer C is the CROSS-MODEL lens by design.** It exists to cancel out the host model's
> systematic blind spots, so it must run on a model *different from the host runtime* — when the
> host is Codex, target a non-Codex model (e.g. `claude -p`); when the host is OpenCode, target a
> different model. When no different model is reachable, fall back to a same-runtime adversarial
> pass in an isolated context and log that cross-model diversity is reduced (Step 2 pre-flight).
> Detect the second model in the pre-flight, before spawning.
>
> Use your runtime's **native, in-session subagent delegation** (plus a shell-out to a different
> model's CLI for Reviewer C) — workers that report their findings back to the lead. Do **NOT** use
> cross-agent or cross-container dispatch primitives (e.g. NanoClaw's `spawn_task` MCP, available
> only to container agents): those launch *separate agent sessions* that can't return findings to
> this lead for the dedup/classify pass, which defeats the entire review. Stay in-session.

### Codex

Codex delegates to subagents out of the box. Run each of the three reviewers as an independent
Codex subagent — in parallel where your Codex environment supports it — following the
bounded-delegation rules in [`../shared/codex-workflow-primitives.md`](../shared/codex-workflow-primitives.md) (§ Codex Subagents):

- `spawn_reviewers`:
  - **Reviewers A and B** — delegate one independent Codex subagent each, with the corresponding
    template from `references/reviewer-prompts.md` (A with `[LIST SKILL NAMES]` filled in; B as the
    `/bootstrap-workflow:best-practice-check` forwarder). Write scope is naturally disjoint —
    reviewers produce findings, they don't edit.
  - **Reviewer C (different model — NOT Codex)** — the host is Codex, so running C on `codex exec`
    would be same-model, not cross-model. Instead shell out to a non-Codex model for the adversarial
    pass, e.g. `claude -p "<Reviewer C prompt>"` if the Claude CLI is on `PATH`, or any other
    available non-Codex model CLI. Detect availability in the Step 2 pre-flight with, e.g.,
    `command -v claude >/dev/null 2>&1 && echo yes || echo no`. Feed it the substituted verbatim
    prompt from `references/codex-adversarial-design-prompt.md`.
  - **Reviewer C fallback (same-runtime adversarial pass)** — if no different model is reachable, run
    a second independent Codex subagent with the verbatim adversarial prompt (`codex exec --yolo`
    when invoking Codex directly — `--yolo` because bwrap can't nest in Docker), in an isolated
    context, prepend the reduced-diversity warning to its prompt, and log the reduced-diversity
    notice (Step 2 pre-flight). If even that is impossible, skip C and note it in the report header.
  - If your environment can't run subagents in parallel, run the passes sequentially with
    **separated notes** so their conclusions don't contaminate each other.
- `collect_findings`: each subagent returns its raw findings to the lead.
- `cross_check`: **lead-mediated** — Codex subagents report to the lead, not to one another. The
  lead performs Step 4 (dedup, fact-check against the codebase, classify). Re-delegate a single
  targeted follow-up only when a specific finding needs a second look.
- `teardown`: subagents complete and return — the lead owns the dedup/classify pass and the final report.

### OpenCode

- `spawn_reviewers`:
  - **Reviewers A and B** — issue parallel `task({ subagent_type: 'general', description, prompt, background: true })` calls, one per reviewer. OpenCode's general worker is named `general` (NOT `general-purpose`). Convey each reviewer's prompt from `references/reviewer-prompts.md` in the `prompt` (A with `[LIST SKILL NAMES]` filled in; B the best-practice-check forwarder). `background: true` is the parallel key — without it the calls serialize.
  - **Reviewer C (different model)** — run the adversarial pass on a model *different from the host*: a non-default OpenCode model, or a shell-out to another model's CLI (e.g. `codex exec --yolo` since Codex differs from OpenCode's model, or `claude -p`). Detect availability in the Step 2 pre-flight (probe for the second CLI on `PATH`). Feed it the substituted verbatim prompt from `references/codex-adversarial-design-prompt.md`. All three reviewer calls can be issued **in one tool turn** so they run in parallel.
  - **Reviewer C fallback (same-runtime adversarial pass)** — if no different model is reachable, run a second `task({ subagent_type: 'general', ... })` adversarial pass in an isolated context, prepend the reduced-diversity warning to its prompt, and log the reduced-diversity notice. If even that is impossible, skip C and note it on failure.
- `collect_findings`: await each background task's completion and read its result.
- `cross_check`: **lead-mediated**, same as Codex — OpenCode `task` workers are fire-and-return with no peer channel. The lead performs Step 4 and re-dispatches one targeted `task` only for a specific disputed finding.
- `teardown`: background tasks self-complete; no explicit shutdown needed.

### Claude (reference — for parity, not used on this runtime)

On Claude this skill spawns the three reviewers via the Task tool — `Task(subagent_type: bootstrap-workflow:architecture-advisor)` for Reviewer A and `Task(subagent_type: general-purpose)` for the Reviewer B and C forwarders — all launched in one parallel turn. There the host is Claude, so the cross-model lens (Reviewer C) shells out to **Codex** as the different model (`codex exec --yolo` with the verbatim adversarial-design prompt), falling back to a same-runtime Claude `Task(subagent_type: general-purpose)` adversarial pass with a reduced-diversity note when Codex is unavailable. There is no `TeamCreate`/`SendMessage`/`TeamDelete` here: the reviewers are isolated fire-and-return subagents with no peer channel by design, so `cross_check` is already lead-mediated on Claude too (the lead's Step 4 dedup/fact-check/classify pass). The Codex/OpenCode dispatch above is a direct parity match — same isolation, same lead-mediated convergence, same cross-model-C-with-same-runtime-fallback design; only the host model (and therefore which model backs C) and the spawn primitive differ.
