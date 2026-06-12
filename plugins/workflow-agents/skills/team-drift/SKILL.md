---
name: team-drift
description: >
  Mechanized drift detection between two documents, for Codex and OpenCode runtimes. Extracts all
  claims from a source-of-truth, verifies each claim against a target using two independent agents on
  different models for cross-model diversity, classifies mismatches by severity. Use after /team-build
  (plan vs implementation), between workflow stages (design vs brief), or whenever a document claims to
  reflect another. BOUNDARY: Only the two documents under comparison — no external context, no
  AGENTS.md/CLAUDE.md, no project skills.
version: 1.0.0
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
each claim against the target. **Two independent agents on different models** do the extraction
and verification separately; the team lead merges results, resolves disagreements, and classifies
mismatches. Cross-model diversity is the point — two agents from the same model family share
systematic blind spots, so one is backed by the primary runtime and the other by a different
model where one is available (see **§ Dispatch by Runtime**).

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

Write both to `.agents/tmp/bootstrap-workflow/` for agent access:
```bash
mkdir -p .agents/tmp/bootstrap-workflow
# Write SOT to .agents/tmp/bootstrap-workflow/drift-sot.md
# Write target to .agents/tmp/bootstrap-workflow/drift-target.md
# OR note exact file paths if they already exist on disk
```

### Step 1.5: Pre-Flight Second-Model Check

Before spawning agents, determine whether a **second, different model** is available to back
Agent B. The goal is cross-model diversity: Agent A runs on your runtime's native subagent;
Agent B should run on a *different* model family so the two extractors don't share blind spots.

Check for the second-model path your runtime uses — see **§ Dispatch by Runtime** for the exact
detection command (e.g. probing for a different model's CLI on your `PATH`).

If no second model is available:
- Agent B falls back to a **same-runtime second pass** (a second native subagent), kept in an
  isolated context so its conclusions don't contaminate Agent A's.
- Log to the user: `⚠ No second model available — Agent B falling back to a same-runtime second pass. Cross-model diversity reduced for this run.`

### Step 2: Spawn Two Independent Claim Extractors in Parallel

Launch both agents simultaneously — **Agent A** on your runtime's native subagent, **Agent B** on
a *different* model where one is available (else a same-runtime second pass, per Step 1.5). The
exact spawn primitive for each runtime is in **§ Dispatch by Runtime**; the two agent prompts below
(the claim-extraction method) are identical regardless of which runtime or model backs each agent.

**Context discipline:** Give each agent ONLY the two documents. No AGENTS.md/CLAUDE.md. No project skills.
No other files. The accuracy of drift detection degrades with additional context — extra context
biases the agent toward confirming what "should" be true rather than what IS true.

**Sandbox note:** A read-only-sandboxed Agent B (e.g. a `codex exec -s read-only` second model) can
only access files written to `.agents/tmp/bootstrap-workflow/`. The SOT and target must be written
to disk in Step 1 before spawning Agent B.

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

#### Agent B prompt (cross-model extractor):

Agent B runs the same two-part method as Agent A, on a *different* model for cross-model
diversity (or a same-runtime second pass when no second model is available, per Step 1.5). The
concrete launch primitive — including the read-only-sandbox `codex exec` invocation, its
mandatory `</dev/null` redirect, and the same-runtime fallback — is in **§ Dispatch by Runtime**.
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

When Agent B runs as a same-runtime fallback (no second model available), prepend to its prompt:
`⚠ Running as a same-runtime second pass (no second model available). Cross-model diversity reduced.`

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
| Agent B (extractor) | A *different* model where available (e.g. `codex exec -s read-only`; read-only sandbox, max reasoning effort) | Same-runtime second pass (if no second model is available) | Mechanical extraction + different training data, different blind spots |

---

## Dispatch by Runtime

The drift-detection substance above is runtime-agnostic. The orchestration primitives below are
the **only** runtime-specific part: how the two extractor agents are spawned, and which model
backs each. The two agent prompts (the claim-extraction method) and all context discipline stay
exactly as written above on every runtime.

> **This is a CROSS-MODEL skill by design.** The two extractors exist to cancel out each model
> family's systematic blind spots — Agent A on the primary runtime, Agent B on a *different*
> model. When no second model is reachable, fall back to a same-runtime second pass in an
> isolated context and log that cross-model diversity is reduced (Step 1.5). Either way, give
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
- **Agent B (different model)** — shell out to a different model for cross-model diversity, e.g.
  `claude -p "<Agent B prompt>"` if the Claude CLI is on `PATH`, or any other available
  non-Codex model CLI. Detect availability in Step 1.5 with, e.g.,
  `command -v claude >/dev/null 2>&1 && echo yes || echo no`.
- **Agent B fallback (same-runtime second pass)** — if no second model is reachable, run a second
  independent Codex subagent in an isolated context, prepend the reduced-diversity warning to its
  prompt (Step 1.5), and log the reduced-diversity notice to the user.
- **Sandbox + stdin gotcha** — if Agent B is itself a `codex exec` second model, launch it
  read-only and redirect stdin from `/dev/null`:

  ```bash
  # Drift extraction is a deep analytical task — exhaustive claim extraction
  # and verdict assignment benefit from maximum reasoning. Default to xhigh.
  # Only drop to "high" or "medium" if the user explicitly asked for a faster
  # cheaper run on a small/simple document pair.
  codex exec -s read-only --config model_reasoning_effort="xhigh" "$(cat <<'PROMPT'
  <Agent B prompt from Step 2 — reads .agents/tmp/bootstrap-workflow/drift-sot.md and drift-target.md>
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
  A read-only-sandboxed Agent B can only read files written to `.agents/tmp/bootstrap-workflow/`,
  so Step 1 must write the SOT and target to disk first.

### OpenCode

- **Agent A** — issue one `task({ subagent_type: 'general', description, prompt })` call for the
  Agent A prompt. OpenCode's general worker is named `general` (NOT `general-purpose`). Pass ONLY
  the two documents in the prompt.
- **Agent B (different model)** — where a different model is reachable (a non-default OpenCode
  model, or a shell-out to another model's CLI), run Agent B there for cross-model diversity.
  Detect availability in Step 1.5 (e.g. probe for the second CLI on `PATH`). Both extractor
  `task` calls can be issued **in one tool turn** so they run in parallel.
- **Agent B fallback (same-runtime second pass)** — if no second model is reachable, run a second
  `task({ subagent_type: 'general', ... })` pass in an isolated context, prepend the
  reduced-diversity warning to its prompt (Step 1.5), and log the reduced-diversity notice.

### Claude (reference — for parity, not used on this runtime)

On Claude this skill spawns **Agent A** via the Task tool —
`Task(subagent_type: "general-purpose", prompt: "<Agent A prompt>")` (no `model` override — inherits the session model) — and
**Agent B** via Bash as a cross-model Codex extractor (`codex exec -s read-only --config
model_reasoning_effort="xhigh" "<Agent B prompt>" </dev/null`). If `codex` is unavailable, Agent B
falls back to a same-runtime Task subagent:
`Task(subagent_type: "general-purpose", prompt: "<Agent B prompt + reduced-diversity note>")`.
The Codex/OpenCode mapping above is the near-parity equivalent: same two-extractor cross-model
design, same isolated contexts, same fallback-with-logging when only one model is available.
