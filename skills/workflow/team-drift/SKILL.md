---
name: team-drift
description: >
  Mechanized drift detection between two documents. Extracts all claims from a source-of-truth,
  verifies each claim against a target using up to three independent agents (Claude, Codex, Gemini),
  classifies mismatches by severity. Use after /team-build (plan vs implementation), between workflow
  stages (design vs brief), or whenever a document claims to reflect another. BOUNDARY: Only the
  two documents under comparison — no external context, no CLAUDE.md, no project skills.
version: 1.0.0
---

# /team-drift — Mechanized Drift Detection

## What This Skill Does

Compares two documents by extracting every claim from the source-of-truth (SOT) and verifying
each claim against the target. Up to three independent agents (Claude, Codex, Gemini) do the
extraction and verification separately; the team lead merges results, resolves disagreements,
and classifies mismatches.

**The standard:** Every claim in the SOT either exists in the target (CONFIRMED), partially exists
(PARTIAL), contradicts the target (DIVERGED), or is absent entirely (MISSING).

**Output:** A drift report classifying all claims (see `references/drift-report-template.md`)
**NOT output:** Fixes, revisions, or updated documents

## Common Uses

| SOT | Target | Question answered |
|-----|--------|-------------------|
| Approved brief | Design document | Does the design address every requirement? |
| Approved design | Plan | Does the plan implement every design decision? |
| Approved plan | Implementation | Does the built code satisfy every acceptance criterion? |
| Original code | Refactored code | Does the refactor preserve all original behavior? |

## Prerequisites

Two documents: a source-of-truth and a target.

**If only one document is provided:** Ask which is the SOT and what the target is.

## When to Use

- After `/team-build` completes — check implementation against plan before `/team-qa`
- After any stage produces a document — verify the next stage reflects it faithfully
- Anytime the user suspects "did we drift from X?"
- Do NOT auto-trigger — the user types `/team-drift` to invoke

---

## Process

### Step 1: Identify the Two Documents

Confirm with the user:
- **Source-of-truth (SOT):** The authoritative document. Claims extracted from here.
- **Target:** The document being checked. Claims verified against here.

If the target is an implementation (source code), confirm which files are in scope — do not
assume the entire codebase.

Write both to `.claude/tmp/` for agent access:
```bash
mkdir -p .claude/tmp
# Write SOT to .claude/tmp/drift-sot.md
# Write target to .claude/tmp/drift-target.md
# OR note exact file paths if they already exist on disk
```

### Step 1.5: Pre-Flight CLI Check

Before spawning agents, check CLI availability:

```bash
codex_available=$(command -v codex >/dev/null 2>&1 && echo "yes" || echo "no")
gemini_available=$(command -v gemini >/dev/null 2>&1 && echo "yes" || echo "no")
```

If `codex_available` is "no":
- Agent B will use Claude (general-purpose subagent, model: sonnet) instead of Codex
- Log to the user: `⚠ Codex CLI unavailable — Agent B falling back to Claude Sonnet. Cross-model diversity reduced for this run.`

If `gemini_available` is "no":
- Agent C will be skipped entirely (2-agent mode: Claude + Codex only)
- Log to the user: `⚠ Gemini CLI unavailable — running 2-agent mode (Claude + Codex only).`
- No Claude fallback for Agent C — drift already has 2 families; a 3rd Claude adds noise, not diversity.

### Step 2: Spawn Up to Three Independent Claim Extractors in Parallel

Launch all available agents simultaneously — Agent A via Task tool (Claude Sonnet), Agent B via
Bash (`codex exec -s read-only`), Agent C via Bash (`gemini -p`) if available.

**Context discipline:** Give each agent ONLY the two documents. No CLAUDE.md. No project skills.
No other files. The accuracy of drift detection degrades with additional context — extra context
biases the agent toward confirming what "should" be true rather than what IS true.

**Codex sandbox note:** Agent B (Codex) runs in a read-only sandbox and can only access files
written to `.claude/tmp/`. The SOT and target must be written to disk in Step 1 before spawning
Agent B.

---

#### Agent A prompt:

```
You are performing a drift analysis between two documents.

SOURCE OF TRUTH (SOT): [path to .claude/tmp/drift-sot.md or paste content]
TARGET: [path to .claude/tmp/drift-target.md or paste content]

Your job has two parts:

PART 1 — EXTRACT ALL CLAIMS FROM THE SOT
A "claim" is any statement in the SOT that implies something must be true in the target.
Extract every claim. Do not summarize or group — one claim per line.

Claim types to look for:
- REQUIREMENT: Something that must be implemented or present
- DECISION: A choice made that the target must reflect
- CONSTRAINT: A limit that must be respected
- ACCEPTANCE: A named acceptance criterion that must pass
- BEHAVIOR: A specific behavior that must exist

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (note the contradiction)
  MISSING   — Target has no corresponding content for this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or "no evidence found"] | [Gap if PARTIAL/DIVERGED]

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing.
```

---

#### Agent B — Codex (cross-model extractor):

If `codex_available` is "yes", launch via Bash:
```bash
# If the user specified a reasoning effort (medium/high/xhigh), append:
#   --config model_reasoning_effort="<effort>"
# If omitted, Codex uses its own default reasoning effort.
codex exec -s read-only "$(cat <<'PROMPT'
You are performing an independent drift analysis between two documents.

Read the source of truth: cat .claude/tmp/drift-sot.md
Read the target: cat .claude/tmp/drift-target.md

Your job has two parts:

PART 1 — EXTRACT ALL CLAIMS FROM THE SOT
A "claim" is any statement in the SOT that implies something must be true in the target.
Work independently. Do not try to match another agent's numbering.

Claim types to look for:
- REQUIREMENT: Something that must be implemented or present
- DECISION: A choice made that the target must reflect
- CONSTRAINT: A limit that must be respected
- ACCEPTANCE: A named acceptance criterion that must pass
- BEHAVIOR: A specific behavior that must exist

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (note the contradiction)
  MISSING   — Target has no correspondence in this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or "no evidence found"] | [Gap if PARTIAL/DIVERGED]

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing.
PROMPT
)"
```

If `codex_available` is "no", use the Task tool instead:
```
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: "You are performing an independent drift analysis between two documents.

Read the source of truth using the Read tool: .claude/tmp/drift-sot.md
Read the target using the Read tool: .claude/tmp/drift-target.md

Your job has two parts:

PART 1 — EXTRACT ALL CLAIMS FROM THE SOT
A 'claim' is any statement in the SOT that implies something must be true in the target.
Work independently. Do not try to match Agent A's numbering.

Claim types to look for:
- REQUIREMENT: Something that must be implemented or present
- DECISION: A choice made that the target must reflect
- CONSTRAINT: A limit that must be respected
- ACCEPTANCE: A named acceptance criterion that must pass
- BEHAVIOR: A specific behavior that must exist

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (note the contradiction)
  MISSING   — Target has no correspondence in this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or 'no evidence found'] | [Gap if PARTIAL/DIVERGED]

Note at the start: '⚠ Running as Claude general-purpose fallback (Codex CLI unavailable). Cross-model diversity reduced.'

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing."
)
```

---

#### Agent C — Gemini (cross-model extractor):

If `gemini_available` is "yes", launch via Bash:
```bash
# If the user specified a Gemini model, add: --model <model>
# If omitted, Gemini CLI uses its own default model.
gemini -p "$(cat <<'PROMPT'
You are performing an independent drift analysis between two documents.

Read the source of truth: cat .claude/tmp/drift-sot.md
Read the target: cat .claude/tmp/drift-target.md

Your job has two parts:

PART 1 — EXTRACT ALL CLAIMS FROM THE SOT
A "claim" is any statement in the SOT that implies something must be true in the target.
Work independently. Do not try to match another agent's numbering.

Claim types to look for:
- REQUIREMENT: Something that must be implemented or present
- DECISION: A choice made that the target must reflect
- CONSTRAINT: A limit that must be respected
- ACCEPTANCE: A named acceptance criterion that must pass
- BEHAVIOR: A specific behavior that must exist

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (note the contradiction)
  MISSING   — Target has no correspondence in this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or "no evidence found"] | [Gap if PARTIAL/DIVERGED]

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing.
PROMPT
)"
```

If `gemini_available` is "no": Skip Agent C entirely. Do not use a Claude fallback — the 2-agent
mode (Agent A + Agent B) already provides cross-model diversity. A third Claude agent adds noise,
not signal.

---

### Step 3: Merge Claim Lists

Combine Agent A, Agent B, and Agent C's extracted claims into one unified list (or Agent A + B
only if Gemini was unavailable):

1. **Deduplicate:** Claims covering the same SOT statement → merge into one canonical claim
2. **Union:** Claims found by only one agent → keep (one agent's miss is still a claim)
3. **Note disagreements:** Same SOT statement extracted differently by A, B, and/or C → keep all
   framings and flag for review

Number the unified claims sequentially (C1, C2, C3...).

### Step 4: Reconcile Verdicts

**3-way reconciliation** (when all three agents ran):

For each unified claim, compare verdicts from Agent A, Agent B, and Agent C:

| Pattern | Resolution |
|---------|------------|
| All three agree | Use that verdict |
| 2 agree, 1 disagrees | Use majority verdict (note the dissent) |
| All three disagree | Flag as DISPUTED — team lead reads the target and rules |
| Any agent says DIVERGED | Use DIVERGED (conservative — contradictions take priority) |

**2-way reconciliation** (when Gemini was skipped — existing behavior):

For each unified claim, compare Agent A's verdict with Agent B's verdict:

| A verdict | B verdict | Resolution |
|-----------|-----------|------------|
| Same | Same | Use that verdict |
| CONFIRMED | PARTIAL | Use PARTIAL (conservative) |
| CONFIRMED | MISSING | Flag as DISPUTED — re-examine the target yourself |
| PARTIAL | MISSING | Use MISSING (conservative) |
| DIVERGED | anything | Use DIVERGED |
| Any disagreement | — | Team lead reads the target section and rules |

**For DISPUTED verdicts:** Read the relevant section of the target directly and make the call.
Do not leave a claim as DISPUTED in the final report.

### Step 5: Classify Severity

| Class | Definition | Blocking? |
|-------|-----------|-----------|
| **MISSING** | SOT claim has no corresponding content in target | Yes |
| **DIVERGED** | Target contradicts the SOT claim | Yes |
| **PARTIAL** | SOT claim partially addressed; specific gap identified | Review |
| **CONFIRMED** | SOT claim fully satisfied in target | No |

**Blocking = must be resolved before the workflow can continue.**
PARTIAL = user decides whether to address or accept the gap.

### Step 6: STOP — Present Drift Report and Gate

Write the complete report using `references/drift-report-template.md`.

Then STOP. Display exactly this gate:

```
---
**Drift check complete.**

SOT: [document name]
Target: [document name]

MISSING:  [N] — blocking
DIVERGED: [N] — blocking
PARTIAL:  [N] — review required
CONFIRMED:[N]

[If blocking > 0:]
[N] blocking mismatches found. The target must be updated to resolve them before proceeding.
Or explicitly accept each with a stated reason — accepted mismatches are logged, not dropped.

[If blocking == 0 and PARTIAL == 0:]
No drift detected. The target faithfully reflects the SOT. Proceed.

[If blocking == 0 and PARTIAL > 0:]
No blocking drift. [N] partial matches need your review — address, accept, or log each.
---
```

---

## The Minimal Context Principle

This is the most important design constraint for drift detection:

**Only the two documents under comparison enter the agents' context.**

No CLAUDE.md. No project skills. No other specs. No conversation history beyond the documents.

**Why:** Drift detection accuracy depends on literal fidelity to the SOT. External context
introduces "what should be true" bias — the agent starts confirming claims it infers rather than
claims it finds. The question is not "does this seem right given the project?" but "does the
target say what the SOT says?" Those are different questions.

**Exception — implementation targets:** When the target is source code rather than a document,
agents may need to read specific files to verify claims. Scope strictly to files named in the
claims. Do not read unrelated files.

---

## Anti-Patterns (Do Not Do These)

- **Don't load CLAUDE.md or project skills.** This is the one skill where they actively hurt accuracy.
- **Don't summarize claims.** "The plan specifies auth requirements" is not a claim. "Task A2 creates `src/auth/middleware/requireAuth.ts` with three exports" is a claim.
- **Don't skip the multi-agent step.** Single-agent extraction has systematic blind spots. Additional agents catch what others missed — especially implicit claims. Cross-model extraction (Claude + Codex + Gemini) catches claims that same-family models may both miss systematically.
- **Don't leave DISPUTED verdicts.** The team lead reads the source and rules. Every claim gets a final verdict.
- **Don't silently drop PARTIAL findings.** Log them. The user decides whether to address them.
- **Don't conflate "not mentioned" with "contradicted."** MISSING ≠ DIVERGED. Be precise.

---

## Model Tier

| Role | Tier | Fallback | Rationale |
|------|------|----------|-----------|
| Team lead (merge + verdict) | Opus (current session) | N/A | Judgment-heavy: resolving DISPUTED verdicts, classifying severity, making the final call |
| Agent A (extractor) | Sonnet (general-purpose) | N/A | Mechanical extraction + Claude perspective |
| Agent B (extractor) | Codex (OpenAI, read-only sandbox; default reasoning effort) | Claude Sonnet general-purpose (if `codex` unavailable) | Mechanical extraction + different training data, different blind spots |
| Agent C (extractor) | Gemini (Google, CLI default or user-specified) | Skipped if unavailable (2-agent mode) | Google training data perspective — adds a third extraction lens when available |
