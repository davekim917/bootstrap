---
name: team-design
description: >
  Transform an approved brief into a grounded, first-principles design with constraint analysis
  and evaluated options. Invoke after /team-brief is approved and before planning or implementation.
  BOUNDARY: Does not implement code, does not decompose into tasks. Output is a design document only.
version: 1.0.0
---

# /team-design — First-Principles Design Skill

## What This Skill Does

Transforms an approved requirements brief into a grounded design document through codebase research, constraint analysis, and option evaluation.

**Output:** A structured design document (see `references/design-template.md`)
**NOT output:** Implementation code, task lists, file changes

## Prerequisites

An approved brief — either from `/team-brief` or user-provided.

**If no brief exists:** Tell the user: "I need a requirements brief before designing. Run `/team-brief` first, or paste the requirements directly."

## When to Use

- After `/team-brief` is approved and before writing any code
- When a feature touches >3 files or introduces new patterns
- When multiple valid architectural approaches exist
- Do NOT auto-trigger — the user consciously enters this workflow by typing `/team-design`

---

## Process

### Step 1: Read Brief and Project Context

1. Read the approved brief. Check in order:
   - `.context/specs/<feature>/brief.md` (standard location from `/team-brief`)
   - Ask user to paste it if not found at the standard location
2. Read `CLAUDE.md` — extract:
   - Tech stack (what libraries/frameworks are available)
   - Code conventions (patterns to follow)
   - Workflow hints (what skills are most relevant)
   - Critical guardrails (non-negotiables)
3. Read `.claude/project-scope.md` if it exists — extract `domains`, `relevant_global_skills`, `quality_gates`, `security_surface`. This determines which domain skills to load in Step 3.
4. Note any relevant behavioral rules that constrain the design

### Step 2: Constraint Analysis

For EACH constraint in the brief, classify it:

| Constraint | Type | Source | Status |
|-----------|------|--------|--------|
| [constraint] | HARD/SOFT | Brief/CLAUDE.md/Implicit | Validated/Flagged |

**Classification:**
- **HARD:** Must be true. Non-negotiable. Violating it makes the design invalid.
- **SOFT:** Preferred but negotiable. Can be overridden with justification.

**Flag these:**
- Soft constraints the brief treats as hard (common mistake — flag explicitly)
- Implicit constraints not in the brief but evident from CLAUDE.md patterns
- Contradictions between constraints

**Upstream [HARD] labels:** Constraints pre-labeled `[HARD]` by the brief (e.g., from a Step 2b layout feasibility check) are treated as authoritative — carry them forward as HARD without reclassification. The "flag soft constraints the brief treats as hard" heuristic does not apply to constraints validated through code inspection upstream.

See `references/constraint-analysis.md` for detailed classification guidance.

### Step 3: Targeted Research

Load ONLY what's relevant to this specific design:

1. **Project skills:** Load the skills listed in `relevant_global_skills` from `.claude/project-scope.md` (read in Step 1). If `relevant_global_skills` is empty, use `quality_gates` and `description` from the scope file to frame constraints. If no scope file exists, run the 6-file discovery scan inline (see `/team-brief` Step 1b) before proceeding — do not write a scope file from here; that belongs to `/team-brief`.
2. **Source files:** Read files directly related to the change area. Scope to ~5-10 files max. Do NOT read the entire codebase.
3. **Library documentation:** Use the **Research Fallback Chain** (see below) for any library the design will use. Check live docs, not assumptions.
4. **Web search:** Included in the Research Fallback Chain — use `mcp__exa__web_search_exa` or WebSearch for unfamiliar patterns and known pitfalls.

**Context discipline:** Every file you read here should be directly load-bearing for the design decision. If you're unsure whether to read something, don't.

### Step 4: First-Principles Reconstruction

Ignore conventional wisdom. Starting from ONLY:
- Validated constraints (from Step 2)
- Researched facts (from Step 3)
- Project patterns confirmed in CLAUDE.md/skills

What is the optimal approach? Generate 2-3 distinct options. Options must be genuinely different (not minor variations). If only one valid approach exists, say so and explain why.

**For UI layout and visual component designs** (page layouts, component structure, visual hierarchy): Detail at least 2 structural alternatives with pros/cons before recommending. "Option A is clearly best" without exploring alternatives is a design smell — the better layout may only emerge from comparison. This does not apply to API design, data models, or backend architecture decisions.

### Step 5: Evaluate Options

For each option:
- **Approach:** 2-3 sentence description
- **Pros:** concrete benefits
- **Cons:** concrete tradeoffs
- **Pattern alignment:** how it fits project conventions — cite the specific CLAUDE.md section or skill
- **Confidence:** High / Medium / Low
  - High: all assumptions validated, clear precedent in codebase
  - Medium: some assumptions unvalidated, or pattern is new to this codebase
  - Low: significant unknowns; recommend a spike before committing
- **Assumptions:** what must be true for this option to work

### Step 6: Recommend One Option

State your recommendation with justification.

**If confidence is Medium or Low:** Say so explicitly. Explain what would raise it (e.g., "spike to validate X", "confirm with user that Y is true"). Do not present Medium/Low confidence as High.

### Step 6b: Render-Check for Visual Decisions

**When the design specifies visual choices** (color combinations, layout structure, spacing, typography pairings):

1. Identify visual decisions that meet the flag threshold: deviations from the established design system (unexpected tokens, overriding system defaults, combining values not specified in globals.css or the design system), or choices requiring contrast/legibility judgment. Standard spacing, established token pairings, and design-system-compliant choices do not require a flag.
2. Flag qualifying decisions as **[RENDER-CHECK NEEDED]** in the design document.
3. Note explicitly: "These visual decisions were validated analytically. Verify by rendering before finalizing — color token math is necessary but not sufficient."

If no decisions meet the threshold, Step 6b produces no output — skip it entirely. If flags were added, the design proceeds to review with them; Reviewer C will check for their presence. The checks themselves happen during build (dev server, Storybook, or browser tools).

Note: if a visual decision was the **primary axis of comparison** between options in Step 5 — i.e., options explicitly differed on this choice and it was directly evaluated as such — do not re-flag it. If the decision appeared incidentally in both options without being the axis of comparison (e.g., the same token combination used in all options without discussion), it is not exempt — flag it.

### Step 7: STOP — Present Design and Iterate Until Approved

Using `references/design-template.md`, write the complete design document.

Save the design to disk:
1. Derive the feature name from the design title (kebab-case, matching the brief's feature name)
2. `mkdir -p .context/specs/<feature>/`
3. Write the design to `.context/specs/<feature>/design.md`
4. Update the decision record at `.context/specs/<feature>/decisions.yaml`:
   - Append the chosen option with rationale, citing constraint refs
   - Append each rejected option with its rejection reason (these become REJECTION claims in drift detection)
   - Append HARD/SOFT constraint classifications from Step 2 (if new constraints were identified beyond the brief's)
   - Append all `[ASSUMPTION]` items from the Assumptions Log with validation method
   - Format: see `skills/workflow/shared/decision-record-schema.md`

Then STOP. Display exactly this gate:

```
---
**Design ready for review.**

**Saved to:** `.context/specs/<feature>/design.md`

If this looks right, say "approved" to proceed to `/team-review`.
If anything needs adjusting, tell me what to change and I'll revise.
---
```

Iterate with user feedback until they explicitly say "approved."

<!-- GATE: design-approval — Design approved, options evaluated before /team-review -->
**Do not proceed to planning, task decomposition, or implementation until the user explicitly approves this design.**

---

## Grounding Rules

Every claim in the design must be grounded:

| Claim type | Required grounding |
|------------|-------------------|
| Pattern recommendation | Cite CLAUDE.md section or project skill by name |
| Library recommendation | Verified against Context7 docs or web search (include source) |
| Codebase assumption | Cite the specific file and line number you read |
| Unknown | Mark as ASSUMPTION explicitly |

**Red flags in your own writing:**
- "I believe..." → replace with a citation or mark as ASSUMPTION
- "Typically..." → replace with a project-specific reference
- "Usually..." → same
- "Should work..." → ungrounded — research it or mark as assumption

If you cannot ground a claim, write:
```
[ASSUMPTION: {claim} — needs validation: {how to validate}]
```

---

## Anti-Patterns (Do Not Do These)

- **Don't skip constraint analysis.** Unanalyzed constraints are design landmines.
- **Don't propose one option.** Single-option designs hide the tradeoffs. Always 2-3.
- **Don't inflate confidence.** Medium confidence presented as High leads to rework.
- **Don't read the entire codebase.** Scope to relevant files. More context = more noise.
- **Don't speculate about libraries.** Check Context7 or web search. Live docs over assumptions.
- **Don't skip the gate.** The design is worthless if you immediately start implementing. The gate is the point.
- **Don't start without a brief.** Designing without requirements is architecture by vibes.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Obviously only one approach" | If obvious, documenting two alternatives takes 3 minutes and proves it. |
| "Brief already specifies the design" | Brief specifies requirements, not architecture. Different documents. |
| "Skip options, build the obvious one" | The "obvious" option matches your first instinct, not necessarily the best. |
| "I already know the right approach/tool" | Verify against live docs. "I know" is preamble to "I assumed wrong." |
| "Standard pattern, no design needed" | Standard patterns (CRUD, ETL, fact tables, classifiers) in non-standard codebases still need constraint analysis. |
| "User wants speed, not options" | Options take 10 minutes. Rebuilding after wrong pick takes hours. |

---

## Rollback

Accepts rollback from `/team-review` (MUST-FIX requiring design revision) and `/team-build` (invalidated assumption).

**Re-entry point:** Step 4 (First-Principles Reconstruction) — not from scratch. Constraint analysis and research from Steps 2-3 are still valid unless the rollback specifically invalidates them.

**Trigger:** Lead or reviewer identifies that the design assumption is wrong, not just that the implementation needs adjustment.

---

## Context Discipline

**Read:**
- `CLAUDE.md` — always (project context, conventions, guardrails)
- `.context/specs/<feature>/brief.md` — the approved brief (Step 1)
- `.context/specs/<feature>/decisions.yaml` — existing decision record from brief (Step 1)
- `.claude/project-scope.md` — if it exists; determines which domain skills to load (Step 1)
- Relevant project skills — loaded from `relevant_global_skills` in scope file (Step 3)
- ~5-10 source files — scoped to the change area
- Context7 docs — for libraries involved in the design
- Web search — for unfamiliar patterns and known pitfalls

**Write:**
- `.context/specs/<feature>/design.md` — the completed design document (Step 7)
- `.context/specs/<feature>/decisions.yaml` — updated decision record (Step 7)

**Do NOT read:**
- Every file in the codebase
- Unrelated skills
- Old migration files or historical artifacts unrelated to the design

**Rationale:** Context is noise. Scoped research produces better designs than broad sweeps. Fewer files = less distraction = clearer thinking.

---

## Research Fallback Chain

When verifying a library, pattern, or technical claim:

1. **Context7 first** — `resolve-library-id` → `query-docs`. Fast, structured, high-signal.
2. **Exa fallback** — if Context7 returns no results or insufficient coverage:
   - `mcp__exa__get_code_context_exa` — real usage patterns in public repos
   - `mcp__exa__web_search_exa` — official docs, blog posts, known pitfalls
   - `mcp__exa__crawling_exa` — fetch specific documentation URLs directly
3. **WebSearch last resort** — built-in web search if both Context7 and Exa fail.

Never skip straight to assumptions. Exhaust the chain first.

---

## Model Tier

**Tier:** Opus (current session)
**Rationale:** First-principles design requires nuanced judgment — constraint classification, option evaluation, confidence calibration. Opus-level reasoning ensures designs are grounded rather than assumed.
