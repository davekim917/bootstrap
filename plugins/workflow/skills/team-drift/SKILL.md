---
name: team-drift
description: >
  Mechanized drift detection between two documents. Extracts all claims from a source-of-truth,
  verifies each claim against a target using two independent agents (Claude, Codex),
  classifies mismatches by severity. Use after /team-build (plan vs implementation), between workflow
  stages (design vs brief), or whenever a document claims to reflect another. BOUNDARY: Only the
  two documents under comparison — no external context, no CLAUDE.md, no project skills.
version: 1.0.0
---

# /team-drift — Mechanized Drift Detection

## What This Skill Does

Compares two documents by extracting every claim from the source-of-truth (SOT) and verifying
each claim against the target. Two independent agents (Claude, Codex) do the extraction and
verification separately; the team lead merges results, resolves disagreements, and classifies
mismatches.

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
```

If `codex_available` is "no":
- Agent B will use Claude (general-purpose subagent, model: sonnet) instead of Codex
- Log to the user: `⚠ Codex CLI unavailable — Agent B falling back to Claude Sonnet. Cross-model diversity reduced for this run.`

### Step 2: Spawn Two Independent Claim Extractors in Parallel

Launch both agents simultaneously — Agent A via Task tool (Claude Sonnet), Agent B via
Bash (`codex exec -s read-only`).

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
- REJECTION: Something explicitly excluded or forbidden (rejected alternatives, "must not" statements)

For REJECTION claims: the target must NOT contain the rejected thing. Absence is the expected state.

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim (for REJECTION claims: the rejected thing is absent)
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (for REJECTION claims: the rejected thing IS present)
  MISSING   — Target has no corresponding content for this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or "no evidence found"] | [Gap if PARTIAL/DIVERGED]

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing.
```

---

#### Agent B — Codex (cross-model extractor):

If `codex_available` is "yes", launch via Bash:
```bash
# Drift extraction is a deep analytical task — exhaustive claim extraction
# and verdict assignment benefit from maximum reasoning. Default to xhigh.
# Only drop to "high" or "medium" if the user explicitly asked for a faster
# cheaper run on a small/simple document pair.
codex exec -s read-only --config model_reasoning_effort="xhigh" "$(cat <<'PROMPT'
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
- REJECTION: Something explicitly excluded or forbidden (rejected alternatives, "must not" statements)

For REJECTION claims: the target must NOT contain the rejected thing. Absence is the expected state.

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim (for REJECTION claims: the rejected thing is absent)
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (for REJECTION claims: the rejected thing IS present)
  MISSING   — Target has no correspondence in this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or "no evidence found"] | [Gap if PARTIAL/DIVERGED]

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing.
PROMPT
)" </dev/null
```

**CRITICAL: the `</dev/null` redirect is not optional.** `codex exec` inspects its own stdin
and, if the pipe is open (which it is when spawned from a harness Bash tool), treats stdin as
an "append additional input to the prompt" stream and blocks reading it forever. The prompt
passed as the command argument is NOT enough on its own — codex will still wait on stdin and
hang indefinitely, emitting only `Reading additional input from stdin...` to its output file.
Confirmed failure mode from NanoClaw session `6379a5d8-99ca-4e7e-a2c0-f17adf26f1cc` at
2026-04-08T12:07:23Z — codex hung 16 minutes before being force-killed. `</dev/null` fixes it.

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
- REJECTION: Something explicitly excluded or forbidden (rejected alternatives, 'must not' statements)

For REJECTION claims: the target must NOT contain the rejected thing. Absence is the expected state.

Format each claim as:
  Claim #N | Type | [Exact quote or precise paraphrase from SOT] | Source: [section/line]

PART 2 — VERIFY EACH CLAIM AGAINST THE TARGET
For each claim you extracted, look for evidence in the target document.

Verdict options:
  CONFIRMED — Target clearly satisfies this claim (for REJECTION claims: the rejected thing is absent)
  PARTIAL   — Target partially addresses this claim (note what's missing)
  DIVERGED  — Target contradicts this claim (for REJECTION claims: the rejected thing IS present)
  MISSING   — Target has no correspondence in this claim

Format each verdict as:
  Claim #N | VERDICT | [Evidence from target, or 'no evidence found'] | [Gap if PARTIAL/DIVERGED]

Note at the start: '⚠ Running as Claude general-purpose fallback (Codex CLI unavailable). Cross-model diversity reduced.'

Be exhaustive. Missing a claim is a false negative. Flag uncertainty rather than guessing."
)
```

---

### Step 3: Merge Claim Lists

Combine Agent A and Agent B's extracted claims into one unified list:

1. **Deduplicate:** Claims covering the same SOT statement → merge into one canonical claim
2. **Union:** Claims found by only one agent → keep (one agent's miss is still a claim)
3. **Note disagreements:** Same SOT statement extracted differently by A and B → keep both
   framings and flag for review

Number the unified claims sequentially (C1, C2, C3...).

### Step 4: Reconcile Verdicts

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
DIVERGED: [N] — blocking ([M] acked, [N-M] effective if drift-acks.json is in use)
PARTIAL:  [N] — review required
CONFIRMED:[N]

[If MISSING > 0 or effective DIVERGED > 0:]
[N] blocking mismatches found. The target must be updated to resolve them before proceeding.
DIVERGED entries that are intentional and justified can be acknowledged in
docs/specs/<feature>/drift-acks.json (see "DIVERGED Acknowledgments" below).
MISSING entries cannot be acked — address them in the target document.

[If MISSING == 0 and effective DIVERGED == 0 and PARTIAL == 0:]
No drift detected. The target faithfully reflects the SOT. Proceed.

[If MISSING == 0 and effective DIVERGED == 0 and PARTIAL > 0:]
No blocking drift. [N] partial matches need your review — address, accept, or log each.
---
```

### DIVERGED Acknowledgments — Justifying Intentional Divergences

**The problem this solves:** A drift report with `DIVERGED > 0` blocks `/team-build`. But sometimes a divergence is **intentional and correct** — for example, a Stage-3 review finding required removing a feature from the plan that was in the design. The plan correctly diverges from the design. The gate cannot evaluate justifications, and historically agents have **reverted valid review findings** just to make the gate pass. That's the gate working against good work.

**The escape hatch:** Each DIVERGED entry in the drift report can be acknowledged in a per-feature `drift-acks.json` file. Acknowledged entries are subtracted from the effective DIVERGED count. The gate passes when `MISSING == 0 && effective_DIVERGED == 0`.

**Schema** (see `references/drift-acks-template.json` for a worked example):

```json
{
  "acknowledgments": [
    {
      "id": "B1",
      "reason": "Why this divergence is correct (required, non-empty, specific)",
      "expires_at": "2026-07-01"
    }
  ]
}
```

**Validation rules** (enforced by the `workflow-gate-enforcement` hook):

1. `id` must match a `[B<n>]` entry header in the same feature's `pre-build-drift.md`
2. The matching entry's `**Class:**` line must be `DIVERGED` (acks for MISSING entries are NOT honored)
3. `reason` must be a non-empty string
4. `expires_at`, if present, must be a valid ISO 8601 date in the future

**Stale acks** (id no longer present in the report) are **reported as errors** in the gate's block message — the gate ignores them for ack-counting purposes but tells you which entries are stale so you can clean them up.

> **ID-shift footgun:** Entry IDs (`B1`, `B2`, ...) are **positional** — they are reassigned sequentially when the drift report is regenerated. If a new claim appears or claim ordering changes, an existing ack for `B2` may now refer to a completely different finding. **Always cross-check each ack's `reason` against the current report's entry text** before committing the acks file. The gate cannot detect this — it only checks that the id exists and the class is DIVERGED.

**Anti-pattern (forbidden):** Reverting valid changes from the plan or target document **to make the gate pass**. If a DIVERGED entry exists because the plan correctly fixed a design issue, **acknowledge it** — do not unwind the fix. Reverting good work to satisfy a binary gate is the failure mode this escape hatch exists to prevent.

**Why per-entry, not per-run:** A run-level waiver would auto-accept new DIVERGED entries that appear after the waiver is written, hiding regressions. Per-entry acks fail closed on new divergences — exactly what you want.

**Why MISSING is not eligible:** `MISSING` means the SOT requires something the target does not have. That's an incomplete plan or implementation, not a justified disagreement. Address it in the target.

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
- **Don't ignore rejected alternatives.** If the SOT explicitly rejected an approach, that rejection is a REJECTION claim. The target must not reintroduce the rejected approach. Check the decision record (`docs/specs/<feature>/decisions.yaml`) for `rejected` entries if it exists.
- **Don't skip the multi-agent step.** Single-agent extraction has systematic blind spots. The second agent catches what the first missed — especially implicit claims. Cross-model extraction (Claude + Codex) catches claims that same-family models may both miss systematically.
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
