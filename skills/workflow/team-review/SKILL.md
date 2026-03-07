---
name: team-review
description: >
  Adversarial multi-model design review. Spawns 3 independent reviewers (Claude architecture-advisor,
  Codex, Gemini/Cursor) with separate contexts and complementary lenses. Deduplicates and
  fact-checks findings. Invoke after /team-design is approved and before /team-plan.
  BOUNDARY: Reviews design documents only, not implementation code. Output is a structured findings report.
version: 1.0.0
---

# /team-review — Adversarial Multi-Model Design Review

## What This Skill Does

Runs an approved design document through 3 independent reviewers, each using a different model and
lens. Findings are deduplicated, fact-checked against the actual codebase, and classified into
MUST-FIX / SHOULD-FIX / WON'T-FIX. The design cannot proceed to `/team-plan` until MUST-FIX items are
resolved or explicitly waived.

**Key principle:** "Audit the auditor" — the agent that writes cannot validate. Separate contexts,
separate models, no shared state between reviewers.

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
   - `.context/specs/<feature>/design.md` (standard location from architecture-advisor)
   - Ask user to paste it if not found

2. Read `CLAUDE.md` — extract tech stack, conventions, critical guardrails, and relevant skill names.

3. Write the design to `.claude/tmp/review-input.md` so CLI reviewers can access it:
   ```bash
   mkdir -p .claude/tmp
   # Write design content to .claude/tmp/review-input.md
   ```

4. Identify the 2-3 project skills most relevant to this design area (from CLAUDE.md Workflow Hints
   or skill names). Note them — each reviewer will be told to load them.

5. **Pre-fetch library documentation** for any library the design references. Include the
   pre-fetched docs in reviewer prompts so reviewers don't make wrong assumptions about
   library capabilities.

   Use the **Research Fallback Chain**:
   - **Context7 first** — `resolve-library-id` → `query-docs`. Fast, structured, high-signal.
   - **Exa fallback** — if Context7 has insufficient coverage:
     - `mcp__exa__get_code_context_exa` — real usage patterns in public repos
     - `mcp__exa__web_search_exa` — official docs, known pitfalls
     - `mcp__exa__crawling_exa` — fetch specific doc URLs directly
   - **WebSearch last resort** — if both Context7 and Exa fail

   For Reviewer B (Codex) and Reviewer C (Gemini): include pre-fetched docs as inline text in
   the prompt since they cannot call MCP tools. See `references/reviewer-prompts.md`.

### Step 1.5: Pre-Flight CLI Check

Before spawning reviewers, check external tool availability:

```bash
codex_available=$(command -v codex >/dev/null 2>&1 && echo "yes" || echo "no")
gemini_available=$(command -v gemini >/dev/null 2>&1 && echo "yes" || echo "no")
cursor_available=$(command -v agent >/dev/null 2>&1 && echo "yes" || echo "no")
```

Log availability to the user:
- If codex unavailable: `⚠ Codex CLI unavailable — Reviewer B falling back to Claude general-purpose. Cross-model diversity reduced.`
- If gemini AND cursor both unavailable: `⚠ Gemini and Cursor CLIs unavailable — Reviewer C falling back to Claude code-review-specialist. Cross-model diversity reduced.`

### Step 2: Spawn 3 Independent Reviewers in Parallel

Launch all three simultaneously. Do not wait for one to finish before starting the next.

**Fallback tracking:** Maintain a running count of Claude fallbacks as reviewers are spawned. If a reviewer falls back (unavailability or timeout), increment the count. Record which reviewer and why (unavailable / timeout). This count is used in the Step 5 gate message.

---

#### Reviewer A: Claude (architecture-advisor)

Use the Task tool with `subagent_type: architecture-advisor`.

**Prompt template:**
```
Review the design document at .claude/tmp/review-input.md as a critical architecture reviewer.

Your lens: STRUCTURAL INTEGRITY
- Is the design internally consistent? Do the constraints, options, and recommendation align?
- Does the recommended approach fit the project patterns in CLAUDE.md?
- Are there hidden coupling risks or dependency problems?
- Are the constraint classifications (HARD/SOFT) correct?
- What's missing that should be there?
- What risks are understated or unacknowledged?

Also load these relevant project skills: [skill names from Step 1]

For each finding, state:
- What the issue is (specific, not vague)
- Why it matters (consequence if ignored)
- Suggested resolution
- Your confidence: High / Medium / Low

End with a numbered list of findings. No prose summary needed.
```

---

#### Reviewer B: Codex (OpenAI model — adversarial perspective)

If `codex_available` is "yes", run via Bash:
```bash
# If the user specified a reasoning effort (medium/high/xhigh), append:
#   --config model_reasoning_effort="<effort>"
# If omitted, Codex uses its own default reasoning effort.
codex exec -s read-only "$(cat <<'PROMPT'
You are performing an adversarial design review. Your job is to find flaws, not validate.

Read the design document: cat .claude/tmp/review-input.md
Read the project context: cat CLAUDE.md

Your lens: ASSUMPTION CHALLENGE & BLIND SPOTS
- What assumptions is this design making that might be wrong?
- What simpler approach would solve the same problem?
- What would cause this design to fail in production?
- What's being optimized for that shouldn't be?
- What's NOT being optimized for that should be?
- What would a skeptical senior engineer object to?

Do NOT validate — find problems. Be specific: cite the section of the design you're critiquing.

For each finding, state:
- What the assumption or problem is
- Why it could be wrong or risky
- What a better alternative might look like

End with a numbered list of findings. No prose summary needed.
PROMPT
)"
```

If `codex_available` is "no", use the Task tool instead:
```
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: [Reviewer B Fallback Prompt from references/reviewer-prompts.md]
)
```

---

#### Reviewer C: Gemini / Cursor (implementation feasibility)

**Priority order:** Gemini (primary) → Cursor (secondary) → Claude code-review-specialist (fallback).

If `gemini_available` is "yes", run via Bash:
```bash
# If the user specified a Gemini model, add: --model <model>
# If omitted, Gemini CLI uses its own default model.
gemini -p "$(cat <<'PROMPT'
You are reviewing a design document for implementation feasibility.

Read the design document: cat .claude/tmp/review-input.md
Read the project context: cat CLAUDE.md

Your lens: IMPLEMENTATION RISK & UNDERSPECIFICATION
- Where will builders have to guess? (underspecified areas)
- What will be genuinely hard to implement as described?
- What edge cases aren't handled by the design?
- What integration risks exist between this design and the existing codebase?
- Where does the design contradict what's actually in the codebase?
- What's missing from the Assumptions Log that should be there?
- Are there [RENDER-CHECK NEEDED] flags on visual decisions (color combinations, layout structure, spacing, typography)? If visual decisions appear in the design without a render-check flag, note it as an underspecification risk.

Be concrete: cite the specific section or line of the design you're flagging.

For each finding, state:
- What is underspecified or risky
- What a builder would have to guess or discover on their own
- What should be added to the design to resolve it

End with a numbered list of findings. No prose summary needed.
PROMPT
)"
```

Else if `cursor_available` is "yes", run via Bash:
```bash
# If the user specified a Cursor model, add: --model <model>
# If omitted, Cursor CLI uses its own default model.
agent -p "$(cat <<'PROMPT'
You are reviewing a design document for implementation feasibility.

Read the design document: cat .claude/tmp/review-input.md
Read the project context: cat CLAUDE.md

Your lens: IMPLEMENTATION RISK & UNDERSPECIFICATION
- Where will builders have to guess? (underspecified areas)
- What will be genuinely hard to implement as described?
- What edge cases aren't handled by the design?
- What integration risks exist between this design and the existing codebase?
- Where does the design contradict what's actually in the codebase?
- What's missing from the Assumptions Log that should be there?
- Are there [RENDER-CHECK NEEDED] flags on visual decisions (color combinations, layout structure, spacing, typography)? If visual decisions appear in the design without a render-check flag, note it as an underspecification risk.

Be concrete: cite the specific section or line of the design you're flagging.

For each finding, state:
- What is underspecified or risky
- What a builder would have to guess or discover on their own
- What should be added to the design to resolve it

End with a numbered list of findings. No prose summary needed.
PROMPT
)"
```

If neither is available, use the Task tool instead:
```
Task(
  subagent_type: "code-review-specialist",
  prompt: [Reviewer C Fallback Prompt from references/reviewer-prompts.md]
)
```

---

#### Reviewer Timeout Handling

If any CLI reviewer (Codex, Gemini, Cursor) times out (exits non-zero, produces stderr output, or exceeds 120 seconds wall-clock), or produces an error:

1. **Fall back** using the same Task call defined in the unavailability fallback for that reviewer in Step 2 (the `If ... unavailable` block for Reviewer B or C respectively). The subagent_type, prompt reference, and lens are identical.
2. **Document the fallback** in the review report header: "Reviewer [B/C]: [tool] timed out — fell back to Claude [subagent_type]."
3. **Do not retry** the same CLI tool with a different model — fall back immediately to preserve review throughput.

Note: a reviewer returning zero findings is not a timeout — legitimate "no findings" results should not trigger this fallback.

---

### Step 3: Collect All Findings

Wait for all three reviewers to complete. Compile their raw findings into a working list. At this
stage, do not classify or deduplicate — just enumerate everything found.

### Step 4: Team Lead — Deduplicate, Fact-Check, Classify

This is the most important step. Work through each finding:

**Fallback note:** If Reviewer B or C fell back to a Claude subagent (due to unavailable CLI tools or timeout), note this in the report header. The classification and deduplication process is unchanged — but the reader should know cross-model diversity was reduced.

**Deduplication:**
- Same finding from multiple reviewers = stronger signal; merge and note which reviewers raised it
- Near-duplicate findings = merge with a note (e.g., "Reviewer A and B both flag X but with
  different framings — treating as one finding")
- Genuinely different findings = keep separate

**Fact-checking:**
For each finding, verify it against the actual codebase:
- Read the relevant source files (scoped — only what's needed to validate the finding)
- If a reviewer says "the project uses X pattern" — verify it exists
- If a reviewer says "this conflicts with Y" — read Y and confirm the conflict
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
- Pattern misalignment that creates technical debt → SHOULD-FIX
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
   - Format: see `skills/workflow/shared/decision-record-schema.md`

Include the save path in the gate message so downstream skills (`/team-plan`) know where to find it.

Then STOP. Display exactly this gate:

```
---
**Review complete.**

MUST-FIX: [N] findings
SHOULD-FIX: [N] findings
WON'T-FIX: [N] findings (logged)

[If MUST-FIX > 0:]
The design has [N] blocking issues. Address them in the design document, then re-run `/team-review`.
Or explicitly waive any finding with a stated reason — waived findings are logged, not dropped.

[If MUST-FIX == 0:]
No blocking issues. Say "approved" to proceed to `/team-plan`.
[If 2 or more reviewers ran as Claude fallbacks:]
Note: cross-model diversity was reduced ([N] of 3 reviewers ran as Claude fallbacks).
---
```

<!-- GATE: review-clearance — All MUST-FIX resolved or waived before /team-plan -->
**Loop:** If the user revises the design to address MUST-FIX items, re-run from Step 1.
**Exit:** When no MUST-FIX items remain (all addressed or explicitly waived with reason).

---

## Reviewer Lenses (Summary)

| Reviewer | Model | Lens | Tools |
|----------|-------|------|-------|
| A: architecture-advisor | Claude Opus | Structural integrity, pattern alignment | Read, Grep, Glob, Bash, Exa, Serena |
| B: Codex | OpenAI (o-series, default reasoning effort) | Adversarial — challenge assumptions, blind spots | Filesystem (read-only sandbox) |
| B: fallback | Claude Sonnet (general-purpose) | Same adversarial lens, if Codex unavailable | All Claude tools |
| C: Gemini (primary) | Google (Gemini CLI default, or user-specified) | Implementation feasibility, underspecification | Filesystem |
| C: Cursor (secondary) | Cursor default model (or user-specified) | Same feasibility lens, if Gemini unavailable | Filesystem |
| C: fallback | Claude (code-review-specialist) | Same feasibility lens, if both Gemini and Cursor unavailable | Read, Grep, Glob, Bash |

Each reviewer gets: design document + CLAUDE.md + relevant project skills
Each reviewer works in isolation: no shared state, no awareness of other reviewers' findings

---

## Anti-Patterns (Do Not Do These)

- **Don't let reviewers see each other's output.** Independent contexts are the point. Cross-contamination defeats the adversarial model.
- **Don't skip fact-checking.** A finding that contradicts the actual codebase is a false positive that wastes the user's time.
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
| "Reviewer already caught the important stuff" | Each reviewer has blind spots. Find what they missed. |

---

## Rollback

Review does not accept rollbacks. If the design changes after review, re-run `/team-review` on the revised design.

The review report is a point-in-time assessment. A changed design requires a fresh assessment, not a patched one.

---

## Context Discipline

**Read (for setup):**
- `.context/specs/<feature>/design.md` — the subject of the review
- `CLAUDE.md` — project context and conventions

**Read (for fact-checking in Step 4):**
- Scoped source files relevant to each finding — only what's needed to validate

**Write:**
- `.context/specs/<feature>/review.md` — the completed review report (Step 5)
- `.context/specs/<feature>/decisions.yaml` — updated decision record with waivers (Step 5)

**Do NOT read:**
- Entire codebase
- Files unrelated to the findings being fact-checked
- Other specs or designs not referenced in this one
