---
name: team-drift
description: >
  Mechanized drift detection between two documents, for Codex and OpenCode runtimes. Extracts all
  claims from a source-of-truth, verifies each claim against a target using two independent agents,
  and classifies mismatches by severity. Uses a different model when one is safely available. Use after /team-build
  (plan vs implementation), between workflow stages (design vs brief), or whenever a document claims to
  reflect another. BOUNDARY: Only the two documents under comparison — no external context, no
  AGENTS.md/CLAUDE.md, no project skills.
---

# /team-drift — Mechanized Drift Detection

> Runtime parity note: this is the Codex/OpenCode variant of the Claude `team-drift` skill.
> The drift-detection *substance* — claim extraction, two-document comparison, verdict
> reconciliation, severity classification, the DIVERGED-ack escape hatch, anti-patterns —
> is identical to the Claude version. Only the orchestration primitives differ (how the two
> extractor agents are spawned and which models back them), and those are isolated in
> **§ Dispatch by Runtime** at the end. Read that section once for your runtime, then follow
> the process below.

## What This Skill Does

Compares two documents by extracting every claim from the source-of-truth (SOT) and verifying
each claim against the target. **Two independent agents** do the extraction and verification
separately; the team lead merges results, resolves disagreements, and classifies mismatches.
Context isolation is required. A different-family model adds useful diversity when explicitly and
safely available (see **§ Dispatch by Runtime**), but is not required for the second pass.

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
- Direct use is user-invoked. It also runs as an internal validation lane inside approved workflow
  stages such as `/team-build` and `/team-auto`; do not route unrelated work here automatically.

---

## Process

### Step 1: Identify the Two Documents

Confirm with the user:
- **Source-of-truth (SOT):** The authoritative document. Claims extracted from here.
- **Target:** The document being checked. Claims verified against here.

If the target is an implementation (source code), confirm which files are in scope — do not
assume the entire codebase.

Write both to `.agents/tmp/bootstrap-workflow/` for agent access:
```bash
mkdir -p .agents/tmp/bootstrap-workflow
# Write SOT to .agents/tmp/bootstrap-workflow/drift-sot.md
# Write target to .agents/tmp/bootstrap-workflow/drift-target.md
# OR note exact file paths if they already exist on disk
```

### Step 1.5: Pre-Flight Second-Context Check

Before spawning agents, confirm the runtime can create two isolated worker contexts. Then determine
whether an explicitly configured **different-family model** is safely available to back Agent B.

See **§ Dispatch by Runtime** for the native worker path and any optional external-model adapter.

If no different-family model is available:
- Agent B uses a **same-runtime second pass** (a second native subagent), kept in an
  isolated context so its conclusions don't contaminate Agent A's.
- Log to the user: `⚠ No different-family model configured — Agent B is a same-runtime isolated pass. Cross-model diversity reduced for this run.`

### Step 2: Spawn Two Independent Claim Extractors in Parallel

Launch both agents simultaneously — **Agent A** and **Agent B** in separate native contexts, using
a different model for Agent B only where one is safely available (per Step 1.5). The
exact spawn primitive for each runtime is in **§ Dispatch by Runtime**; the two agent prompts below
(the claim-extraction method) are identical regardless of which runtime or model backs each agent.

**Context discipline:** Give each agent ONLY the two documents. No AGENTS.md/CLAUDE.md. No project skills.
No other files. The accuracy of drift detection degrades with additional context — extra context
biases the agent toward confirming what "should" be true rather than what IS true.

**Sandbox note:** Both native workers are read-only for the compared artifacts. If an explicitly
configured second-model CLI is used, invoke its documented read-only mode; model diversity never
authorizes disabling approvals or sandboxing.

---

#### Agent A prompt:

```
You are performing a drift analysis between two documents.

SOURCE OF TRUTH (SOT): [path to .agents/tmp/bootstrap-workflow/drift-sot.md or paste content]
TARGET: [path to .agents/tmp/bootstrap-workflow/drift-target.md or paste content]

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

#### Agent B prompt (independent extractor):

Agent B runs the same two-part method as Agent A in an isolated context. A safely available
different-family model may back it; otherwise it is a second native worker (per Step 1.5). The
concrete launch primitive and fallback are in **§ Dispatch by Runtime**.
The prompt Agent B receives is:

```
You are performing an independent drift analysis between two documents.

Read the source of truth: .agents/tmp/bootstrap-workflow/drift-sot.md
Read the target: .agents/tmp/bootstrap-workflow/drift-target.md

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
```

When Agent B runs as a same-runtime pass, prepend to its prompt:
`⚠ Running as a same-runtime isolated second pass. Cross-model diversity reduced.`

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

No AGENTS.md/CLAUDE.md. No project skills. No other specs. No conversation history beyond the documents.

**Why:** Drift detection accuracy depends on literal fidelity to the SOT. External context
introduces "what should be true" bias — the agent starts confirming claims it infers rather than
claims it finds. The question is not "does this seem right given the project?" but "does the
target say what the SOT says?" Those are different questions.

**Exception — implementation targets:** When the target is source code rather than a document,
agents may need to read specific files to verify claims. Scope strictly to files named in the
claims. Do not read unrelated files.

---

## Anti-Patterns (Do Not Do These)

- **Don't load AGENTS.md/CLAUDE.md or project skills.** This is the one skill where they actively hurt accuracy.
- **Don't summarize claims.** "The plan specifies auth requirements" is not a claim. "Task A2 creates `src/auth/middleware/requireAuth.ts` with three exports" is a claim.
- **Don't ignore rejected alternatives.** If the SOT explicitly rejected an approach, that rejection is a REJECTION claim. The target must not reintroduce the rejected approach. Check the decision record (`docs/specs/<feature>/decisions.yaml`) for `rejected` entries if it exists.
- **Don't skip the multi-agent step.** Single-agent extraction has systematic blind spots. The second agent catches what the first missed — especially implicit claims. Cross-model extraction (two different model families) catches claims that same-family models may both miss systematically.
- **Don't leave DISPUTED verdicts.** The team lead reads the source and rules. Every claim gets a final verdict.
- **Don't silently drop PARTIAL findings.** Log them. The user decides whether to address them.
- **Don't conflate "not mentioned" with "contradicted."** MISSING ≠ DIVERGED. Be precise.

---

## Model Tier

| Role | Tier | Fallback | Rationale |
|------|------|----------|-----------|
| Team lead (merge + verdict) | Current session (the runtime you're running on) | N/A | Judgment-heavy: resolving DISPUTED verdicts, classifying severity, making the final call |
| Agent A (extractor) | Native subagent on the primary runtime | N/A | Mechanical extraction + the primary runtime's model perspective |
| Agent B (extractor) | A different model when explicitly available; otherwise a second isolated native subagent | Same-runtime second pass | Mechanical extraction from an independent context; cross-model diversity when available |

---

## Dispatch by Runtime

The drift-detection substance above is runtime-agnostic. The orchestration primitives below are
the **only** runtime-specific part: how the two extractor agents are spawned, and which model
backs each. The two agent prompts (the claim-extraction method) and all context discipline stay
exactly as written above on every runtime.

> **This is an independent-context skill by design.** The two extractors exist to catch omissions
> through separate passes. Agent A uses the primary runtime; Agent B uses a second isolated native
> worker by default or a safely configured different-family model. When both workers share a model
> family, log that cross-model diversity is reduced (Step 1.5). Either way, give
> each agent ONLY the two documents — no AGENTS.md/CLAUDE.md, no project skills (that discipline
> from the body is non-negotiable).
>
> Use your runtime's **native, in-session subagent delegation** (or a shell-out to a second
> model's CLI for Agent B). Do **NOT** use cross-agent or cross-container dispatch primitives
> (e.g. NanoClaw's `spawn_task` MCP): those launch separate agent sessions that can't return
> their extraction to the lead for merge + reconcile, defeating the purpose.

### Codex

- **Agent A** — delegate one independent Codex subagent following the bounded-delegation rules in
  [`../shared/codex-workflow-primitives.md`](../shared/codex-workflow-primitives.md)
  (§ Codex Subagents). Give it the Agent A prompt verbatim and ONLY the two documents.
- **Agent B** — delegate a second independent Codex subagent with the Agent B prompt and only the
  two comparison documents. This is the default self-contained path. Log the reduced-diversity
  warning because both workers share a model family.
- **Optional different model** — use one only when the environment explicitly exposes an
  authenticated second-model capability with a documented read-only mode. Never shell out to
  `codex exec` from Codex to simulate a second model, and never bypass another CLI's safety controls.

### OpenCode

- **Agent A** — issue one `task({ subagent_type: 'general', description, prompt })` call for the
  Agent A prompt. OpenCode's general worker is named `general` (NOT `general-purpose`). Pass ONLY
  the two documents in the prompt.
- **Agent B (different model)** — use a different model only when it is explicitly configured and
  supports safe read-only invocation. Otherwise run a second
  `task({ subagent_type: 'general', ... })` pass in an isolated context, prepend the
  reduced-diversity warning to its prompt (Step 1.5), and log the reduced-diversity notice.

### Claude (reference — for parity, not used on this runtime)

On Claude this skill spawns **Agent A** via the Task tool —
`Task(subagent_type: "general-purpose", prompt: "<Agent A prompt>")` (no `model` override — inherits the session model) — and
**Agent B** via Bash as a cross-model Codex extractor (`codex exec --ephemeral --sandbox read-only
"<Agent B prompt>" </dev/null`). If `codex` is unavailable or `codex login status` fails, Agent B
falls back to a same-runtime Task subagent:
`Task(subagent_type: "general-purpose", prompt: "<Agent B prompt + reduced-diversity note>")`.
The Codex/OpenCode mapping above is the near-parity equivalent: the same two-extractor design,
the same isolated contexts, and the same optional diversity with a logged native fallback.
