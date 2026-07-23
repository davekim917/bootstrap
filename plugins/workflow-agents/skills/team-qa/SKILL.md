---
name: team-qa
description: >
  Invoke after /team-build is approved. Runs validation checks on changed files (denoise + parallel
  validators: style, docs, code review swarm, independent adversarial review). Do NOT run QA checks
  manually — this skill has validator isolation, finding classification, and selective re-run logic
  that only load when invoked.
---

# /team-qa — Post-Build Validation Pipeline

## What This Skill Does

Runs the built implementation through a structured validation pipeline. Five checks in two phases:
denoise first (sequential), then style + doc + code review swarm + an adversarial worker (parallel).
Scoped validators (style, doc) get only changed files + one relevant skill. The code review
swarm delegates to `/review-swarm` for rich, research-backed code review — covering security,
performance, architecture, domain idioms, and adversarial correctness dynamically based on the diff.
The adversarial worker attacks the git diff with framing focused on auth/data-loss/race-condition failure modes.

**Key principle:** Scoped validators (A, B) stay tight — changed files + one skill — to minimize
false positives. The code review swarm (CD) deliberately gets the full diff + AGENTS.md/CLAUDE.md + research
tools because its job is the broad correctness check that scoped validators can't do.

**Adversarial isolation:** Validators A, B, and CD run on the host runtime. Validator E runs in an
independent worker context by default. When an authenticated different-family model is explicitly
available, the runtime may use it for additional diversity; otherwise it records that cross-model
diversity was reduced rather than weakening safety controls or recursively invoking the host CLI.

**Output:** QA report classifying all findings (see `references/qa-report-template.md`)
**NOT output:** The fixes themselves — findings go back to the user or loop to a fix pass

## Prerequisites

A completed build — either from `/team-build` or an implementation the user wants to validate.

**If no changed files are identifiable:** Ask the user to specify which files to validate.

## When to Use

- After `/team-build` is approved and before shipping/merging
- When validating any implementation against project standards
- Enter after explicit build approval, or as the QA stage inside a user-invoked `/team-auto` run.

## Selective Re-run (`--only`)

After fixing one finding, you don't need to re-run the entire pipeline. Use `--only` to target a single validator:

```
/team-qa --only denoise      # Phase 1 only
/team-qa --only style        # Validator A only
/team-qa --only docs         # Validator B only
/team-qa --only swarm        # Validator CD only (code review swarm)
/team-qa --only adversarial  # Validator E only (`codex` remains a compatibility alias)
```

When `--only` is present: **skip to the named validator directly** (still read the changed files list from Step 1 first). All other validators are skipped for this run.

`--only swarm` is a **full re-invocation** of review-swarm — it spawns fresh reviewers and re-runs the research protocol from scratch. There is no delta mode. Use it after fixing a swarm-flagged finding to confirm the finding is gone, accepting that other findings (and reviewer selection) may change between runs as the swarm re-discovers the diff.

Use `--only` after fixing a specific MUST-FIX finding to confirm it's resolved without re-running the entire pipeline.

---

## Process

### Step 1: Identify Changed Files

Get the definitive list of files to validate. Check in order:

1. **From `/team-build` plan** — the plan's file ownership map is the authoritative list of what changed
2. **From git** if no plan is available:
   ```bash
   git diff --name-only <BASE_BRANCH>...HEAD
   ```
3. **From user** if neither is available — ask explicitly

Resolve `<BASE_BRANCH>` once from the approved build metadata, an explicit user scope, or the
repository's default-branch metadata (`refs/remotes/origin/HEAD` / hosting provider). Do not assume
`main`, and do not silently shrink a multi-commit feature to `HEAD~1`.

Group changed files by type for targeted routing:
- **API/backend:** routes, controllers, services, middleware
- **Frontend:** components, pages, hooks, styles
- **Data layer:** migrations, schemas, ORM models, raw SQL queries
- **dbt / SQL models:** staging, intermediate, mart, metric models (.sql in models/)
- **Pipelines / DAGs:** Airflow DAGs, Dagster jobs, Prefect flows, orchestration YAML
- **Notebooks:** Jupyter notebooks (.ipynb), analysis scripts
- **ML / feature code:** model training, feature engineering, evaluation scripts
- **Metrics / dashboards:** LookML, metric YAML definitions, dashboard configs
- **Config:** env files, build config, package changes
- **Tests:** new or modified test files
- **Docs:** README, API docs, changelogs
- **LLM integration:** `*_client.py`, `anthropic*.py`, `openai*.py`, prompt template files, `evals/`, `*.eval.py`, evaluation harnesses — route to `llm-engineering`
- **Agentic systems:** agent loop files, `mcp_server.py`, MCP tool definitions, orchestrator/worker patterns, multi-agent config YAML — route to `agentic-systems`
- **Financial models:** GL tables, chart-of-accounts models, reconciliation scripts, period-close queries, regulatory report outputs, billing models
- **Mobile screens/components:** `.tsx` files in `app/`, `screens/`, `components/` with React Native imports
- **Native modules:** `*.podspec`, Android bridge files, native module wrappers
- **Mobile config:** `app.json`, `app.config.js/ts`, `eas.json`

This grouping determines which validators are relevant. A pure frontend change skips DB performance checks. A pure config change skips most validators.

### Step 2: Load Baseline Checklists

Validators use the baseline checklists in this skill's `references/` directory and the
conventions encoded in `AGENTS.md/CLAUDE.md`. There are no project-specific gate skills to discover —
project-specific rules belong in `AGENTS.md/CLAUDE.md` (where every validator reads them) and the
file-type routing table at [`references/qa-validator-routing.md`](references/qa-validator-routing.md).

### Project Scope Routing

1. Read `docs/project-scope.md` if it exists. team-qa is a **read-only consumer** of this
   file — do NOT write it. The file is created by `/team-brief` Step 1b (primary) or
   `/team-design` Step 1 (second-layer fallback when brief was skipped).
2. If the file is present: load all skills in `relevant_global_skills`. If
   `relevant_global_skills` is empty, calibrate validators using `quality_gates` and
   `security_surface` fields (not free-form description alone). Each validator receives the
   relevant fields as its domain context.
3. If the file is missing: skip scope-based routing. Validators rely on the file-type routing
   table in [`references/qa-validator-routing.md`](references/qa-validator-routing.md) plus `AGENTS.md/CLAUDE.md`. Note "scope file absent" in the QA report so it's auditable.

### Multi-Domain File-Type Resolution

When multiple installed skills are loaded:
- The scope file determines which skills to load (the candidate set).
- The file-type routing table in [`references/qa-validator-routing.md`](references/qa-validator-routing.md) determines which
  loaded skill applies to each specific file.
- A `.py` API handler uses only loaded skills whose declared scope covers API/backend code.
- A `.ipynb` notebook uses only loaded skills whose declared scope covers notebooks or analysis.
- Skills not in the loaded set never apply, even if a file-type pattern matches.

Doc Freshness (B) applies universally — check for stale model descriptions (dbt `schema.yml`),
missing docstrings, outdated metric definitions, missing source freshness metadata.

Denoise applies to all file types with domain-specific additions (see denoise checklist).

### Phase 1: Denoise (Sequential — Run First)

**Run before all other validators.** Checking style or security on noisy code wastes effort.

Read every changed file directly. Apply `references/denoise-checklist.md`. Flag:

- **Unused imports** — imported but never referenced in the file
- **Dead code** — functions, variables, or exports declared but never called within scope
- **Debug artifacts** — `console.log`, `print`, `debugger`, `breakpoint()`, `binding.pry`, etc.
- **Hardcoded test values** — magic strings/numbers that look like test data (`"test@example.com"`, `userId: 123`, `password: "password"`)
- **Commented-out code blocks** — large blocks of commented code (not doc comments)
- **TODO/FIXME without owner** — `// TODO` with no name or ticket reference
- **Temp files** — `.tmp`, `scratch.*`, `test2.ts`, anything that looks like iteration debris
- **Hardcoded dates/limits in SQL** — `WHERE date >= '2024-01-01'`, `LIMIT 10` left in production queries
- **Notebook debris** — uncleared cell outputs, hardcoded file paths (`/Users/.../data/`), scratch cells
- **Pipeline test values** — dev connection strings, test schedule intervals, disabled tasks
- **Hardcoded fiscal year cutoffs in financial SQL** — `WHERE fiscal_year = 2024` or similar absolute fiscal year references in GL models, reconciliation scripts, or period-close queries

Present findings as a list with file:line and carry them into the final QA classification. This
stage is diagnostic: do not edit files or pause for per-item approval. Classify debug artifacts,
credential/PII exposure, or behavior-changing debris by impact; ordinary unused imports and
commented code are SHOULD-FIX/ADVISORY. Phase 2 runs against the same diff so later validators can
corroborate or contradict the findings.

**Gate:** Every changed file has been denoise-checked and findings recorded before Phase 2 starts.

### Phase 2: Parallel Validators

Launch all applicable validators simultaneously (A, B, CD, E — four validators in parallel).
Skip Validator CD only if the diff is pure docs/config with no code changes. Skip Validator E only
if the diff has no code changes, or the runtime cannot create an isolated worker and no explicitly
configured safe external adversary is available.

---

#### Validator A: Style Audit

**Context:** Changed files + `AGENTS.md/CLAUDE.md` conventions + language defaults
**Spawn:** an isolated style-audit worker (no model override — inherits the session model) with the **verbatim** prompt at [`references/qa-validator-prompts.md`](references/qa-validator-prompts.md#validator-a-style-audit-prompt) — see **§ Dispatch by Runtime** for the spawn primitive on your runtime. The prompt encodes the pre-existing-vs-introduced classification that the lead's Step 3 classification step depends on — don't paraphrase.

---

#### Validator B: Doc Freshness

**Context:** Changed files only (no project skill needed — this is structural)

Run inline (Claude reads files directly):

1. For each changed file, identify:
   - Exported functions, classes, or types with changed signatures
   - Changed API endpoints (new routes, modified params/responses)
   - Changed configuration options or environment variables
   - Changed CLI commands or public interfaces

2. For each identified change, check:
   - Is there a corresponding doc comment / JSDoc / docstring on the changed symbol?
   - Is there a README section that references this? Is it current?
   - Is there a CHANGELOG entry (if the project uses one)?
   - Is there API documentation (OpenAPI, Swagger, etc.) that needs updating?

3. Report stale docs with: what changed | where the stale doc lives | what needs updating

---

#### Validator CD: Code Review Swarm

**Context:** Full branch diff — delegated to `/review-swarm`, which does its own file reading,
AGENTS.md/CLAUDE.md parsing, domain detection, and research.

**Purpose:** The broad code-review lane. Covers correctness, project conventions, security,
performance, architecture, and domain-specific idioms through dynamic reviewer selection. Unlike
scoped validators A and B, this validator receives the full diff + AGENTS.md/CLAUDE.md + available live research tools so
its reviewers can check current best practices and converge on their
findings before reporting. Replaces the previous isolated C (security) and D (performance)
validators.

**When to skip:** Pure docs or pure config diffs with no code changes. Otherwise always run. Any other CD skip reason (context budget, time pressure, validator overlap, "Codex E covers it") MUST be user-approved before /team-qa. Lead may NOT skip CD on judgment grounds.

**Research capability:** Review-swarm uses project/repository evidence for concrete findings and
whichever live documentation or web capability the runtime exposes for current-library claims.
Absence of a specific MCP provider is not a skip condition. If no live research is reachable,
reviewers omit unverified external-pattern claims and continue with code-grounded review.

**Invocation:** Invoke the `review-swarm` skill (via your runtime's skill/command invocation —
see **§ Dispatch by Runtime**) with the branch scope and domain hints from Step 2. Review-swarm
does its own Step 1 discovery — team-qa passes only the git scope and the `<DOMAIN_HINTS>` block,
then waits for the combined report. Pass the following verbatim arguments:

```
Review the branch diff against <BASE_BRANCH>.

CRITICAL diff scope override: Use exactly this command for your Step 1 diff
gathering, instead of your default 'git diff HEAD':
    git diff <BASE_BRANCH>...HEAD

Standalone invocation from team-qa post-build validation. Do your own Step 1
discovery against the diff above.

<DOMAIN_HINTS>
[see §'Domain Hints to Forward to Swarm' — lead inserts the built block here]
</DOMAIN_HINTS>

Return the combined review report with BUG and SUGGESTION findings classified
per your standard format.
```

Replace `<BASE_BRANCH>` with the project's base branch (same as Step 1).

**Timeout:** Review-swarm has its own per-reviewer 3min+1min timeout discipline, but the swarm
as a whole (collaboration rounds + research) can run 10+ minutes. Team-qa's Phase 2 lead is
blocked on whichever validator is slowest, so cap CD at **15 minutes wall-clock**. If the swarm
hasn't returned a final report by 15 minutes after invocation, treat CD as failed (see "If
review-swarm fails" below) and continue. Do not retry mid-run.

**Mapping review-swarm output to team-qa classification:**

| Review-swarm class | team-qa class |
|--------------------|---------------|
| BUG                | MUST-FIX      |
| SUGGESTION         | SHOULD-FIX    |

No ADVISORY tier for swarm findings — review-swarm's collaboration step filters noise upstream.

**Ensure cleanup:** Review-swarm reclaims its own reviewer workers in its Step 6 teardown after
reporting, but that is best-effort and may be skipped if the swarm crashes mid-run. Explicitly
verify the swarm's workers are reclaimed and reclaim any that leaked — the exact teardown
primitive depends on your runtime (see **§ Dispatch by Runtime**); on runtimes whose workers are
fire-and-return this is usually a no-op, but verify it. A leaked worker session can wedge the next
`/team-qa` run.

**If review-swarm fails (research tools down, swarm timeout > 15min, mid-run error):** Log
"Code review swarm failed — Validator CD skipped this run" in the report, run the cleanup
above, and continue. Do not retry mid-run. Codex (Validator E) still covers a subset of the
same ground.

---

#### Validator E: Independent Adversarial Review

**Context:** Git diff (the actual code changes — not files in isolation)

**Purpose:** An isolated adversarial pass attacks the implementation for failure modes the lead may
miss or rationalize: auth/permission boundaries, data loss, race conditions, rollback safety,
idempotency gaps, schema drift, and observability gaps. Isolation is required; model-family diversity
is optional.

**Pre-flight:** Confirm the runtime can create an independent worker. Use that native worker by
default and log `cross-model diversity reduced`. If an authenticated different-family model is
explicitly configured, it may replace the native worker using that runtime's documented read-only
mode. A missing external model is never a reason to skip a reachable native worker, disable a
sandbox, disable approvals, or recursively shell into the host CLI.

**Invocation:** Spawn a generic worker (no model override — inherits the session model) with the verbatim adversarial prompt at [`references/qa-validator-prompts.md`](references/qa-validator-prompts.md#validator-e-adversarial-worker-prompt) — see **§ Dispatch by Runtime**. On Codex this is a native independent subagent by default. Use an external second-model CLI only when it is explicitly available and authenticated; never disable that CLI's approvals or sandbox merely to preserve model diversity.

Fill in `<BASE_BRANCH>` and `<REPO_ROOT>` for the project before spawning.

**Run-scoped override:** If the user asked for a specific external model or reasoning effort, honor
that request using the selected runtime's documented flags. Otherwise inherit runtime configuration;
do not pin a model slug in this workflow.

**Lead-side parsing:** The subagent returns a JSON document matching
`references/codex-review-output.schema.json`:

```json
{
  "verdict": "approve" | "needs-attention",
  "summary": "...",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "...",
      "body": "...",
      "file": "...",
      "line_start": 42,
      "line_end": 58,
      "confidence": 0.85,
      "recommendation": "..."
    }
  ],
  "next_steps": ["..."]
}
```

**Mapping adversarial severity to team-qa classification:**

| Codex severity × confidence | team-qa class |
|---|---|
| `critical` or `high` + confidence ≥ 0.6 | MUST-FIX |
| `critical` or `high` + confidence < 0.6 | SHOULD-FIX |
| `medium` + confidence ≥ 0.6 | SHOULD-FIX |
| `medium` + confidence < 0.6 | ADVISORY |
| `low` (any confidence) | ADVISORY |
| Verdict `approve` with no findings | No findings — note in report |

**If the adversarial worker returns errors or times out:** Log "Adversarial review
failed — Validator E skipped this run" in the report and continue. Do not retry mid-run.

The adversarial prompt and output schema are byte-identical upstream mirrors tracked in
[`references/CODEX-SOURCES.md`](references/CODEX-SOURCES.md). Keep both runtime copies synchronized,
validate the four-placeholder/schema contract in this repo, and do not invoke another review skill
from Validator E.

---

### Step 3: Collect and Classify All Findings

Wait for all Phase 2 validators to complete. Compile findings into one unified list.

Classify each finding:

| Class | Definition | Blocking? |
|-------|-----------|-----------|
| **MUST-FIX** | Security vulnerability, broken functionality, or critical convention violation | Yes |
| **SHOULD-FIX** | Quality issue, performance risk, or stale docs on public API | Review |
| **ADVISORY** | Minor style issue, preference, or low-impact suggestion | No |

**Classification heuristics:**
- Review-swarm BUG → MUST-FIX
- Review-swarm SUGGESTION → SHOULD-FIX
- Stale docs on a changed public API → SHOULD-FIX
- Convention violation (naming, imports, structure, signatures, error handling, doc style), INTRODUCED (in diff's added lines) → SHOULD-FIX
- Convention violation, PRE-EXISTING (in unchanged lines) → ADVISORY
- Stale docs on internal function → ADVISORY
- Style preference (no convention backing) → ADVISORY
- SQL style preference (no convention backing) → ADVISORY
- Missing model/column description in schema.yml → ADVISORY

**Deferral discipline:** Immediately re-scope any validator finding tagged "out of scope, defer to follow-up" to MUST-FIX if it would block the feature's primary acceptance path. The lead applies this stricter rule across review-swarm, Codex, and future deferral mechanisms.

The substantive categories previously classified here (security, performance, data leakage,
credential leaks, PII in outputs, dbt test coverage, materialization sizing, source freshness)
are now classified inside review-swarm and surface as BUG or SUGGESTION — the lead translates
those per the table above.

### Step 4: STOP — Present QA Report and Gate

Write the complete report using `references/qa-report-template.md`.

Then STOP. Display exactly this gate:

```
---
**QA complete.**

Denoise:        [N findings — N MUST-FIX, N SHOULD-FIX, N ADVISORY]
Style:          [N violations — N MUST-FIX, N SHOULD-FIX, N ADVISORY (M introduced, P pre-existing)]
Doc freshness:  [N stale items]
Code review (swarm): [N findings — N MUST-FIX (BUG), N SHOULD-FIX (SUGGESTION)]   [or: skipped — no code changes | failed — swarm error]
Adversarial:     [N findings — N MUST-FIX, N SHOULD-FIX, N ADVISORY]   [or: skipped — no isolated target | native worker — cross-model diversity reduced]

[If CD or E was skipped/failed:]
⚠ COVERAGE DEGRADED: [code review swarm | adversarial worker] unavailable this run.
   MUST-FIX total below excludes findings that lane would produce.
   Re-run `/team-qa --only [swarm|adversarial]` once tools recover.

MUST-FIX total: [N]

<!-- GATE: qa-clearance — All MUST-FIX fixed or waived before /team-ship -->
[If MUST-FIX > 0:]
[N] blocking findings must be addressed before shipping.
Fix them and re-run `/team-qa`, or explicitly waive each with a stated reason.

[If MUST-FIX == 0 and SHOULD-FIX > 0 and no degradation banners above:]
No blockers. [N] SHOULD-FIX items for your review — address, accept, or waive each.

[If MUST-FIX == 0 and SHOULD-FIX == 0 and no degradation banners above:]
QA pipeline clear. Ready to ship.

[If all checks ran cleanly OR with documented degradation:]
[For "ready to ship" the user must explicitly acknowledge any degradation banner above.]
---
```

**Note:** The `(M introduced, P pre-existing)` breakdown appears only on the Style line. Validator CD (code review swarm) reports findings by BUG/SUGGESTION class only — it does not classify by introduced-vs-pre-existing origin, so origin breakdowns do not appear in its line.

**Loop:** Fix MUST-FIX items → re-run `/team-qa` on the changed files → until clear.

**Processing findings:** When the user (or `/team-auto`) acts on QA findings, apply the cross-cutting `team-receiving-review-feedback` protocol — verify each finding, evaluate (correct? necessary? complete? in scope?), then fix. Validator output is input, not instruction.

**Claiming a fix:** Apply the cross-cutting `team-verification-before-completion` protocol — re-run the affected validator with `--only` and read its actual output, don't claim "should be fixed."

---

## Validator Routing and Domain Hints

The full validator-routing-by-file-type table, the Codex E routing rule, and the verbatim file-type-concerns block forwarded to review-swarm in `<DOMAIN_HINTS>` all live in [`references/qa-validator-routing.md`](references/qa-validator-routing.md). Read that file when building Step 2's routing decisions and the `<DOMAIN_HINTS>` block for Validator CD.

The short version of the rule of thumb:
- Code changes get all four validators (denoise, style, doc, code review swarm) plus Codex.
- Pure docs/config diffs skip the code review swarm and Codex.
- Style is loaded with the right domain skill per file type (see the table for which skill applies).

`AGENTS.md/CLAUDE.md` is read directly by review-swarm's reviewers and Validator A — project conventions don't need a separate hint block.

---

## Anti-Patterns

Each pattern below leads with the failure mode the rule is preventing. Read these as the cost of the shortcut.

- **Full-codebase sweeps drown real findings in pre-existing noise** — the validator surfaces hundreds of style violations that have nothing to do with this change, and the MUST-FIX signal disappears. Restrict every validator to the changed files only.
- **Style and security checks on noisy code flag things that would disappear after cleanup** — the validator wastes context arguing about a debug log or commented-out block that's about to be deleted. Run denoise first; validate clean code.
- **Unstated waivers on security findings are unfalsifiable later** — a future reviewer can't tell whether the call was sound or careless. Every waived security finding requires a stated reason; that reason is the audit trail.
- **Mixing advisory findings into the MUST-FIX list cheapens the blocker signal** — operators stop reading carefully when 80% of the list is advisory. Keep MUST-FIX, SHOULD-FIX, and ADVISORY in separate lists with separate counts.
- **A finding that keeps reappearing across QA loops is a design issue, not a QA issue** — looping endlessly on the same files burns tokens and buys nothing. After 2-3 cycles on the same finding, escalate to the user; the design or plan needs to change.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "Checks pass so it's fine" | Checks verify what they check. QA validates what automated checks don't: conventions, security, performance, documentation. |
| "Just style/convention issues" | Consistent conventions reduce cognitive load across the team. Classify and log, don't dismiss. |
| "Ship it, fix later" | "Later" is never. MUST-FIX now; SHOULD-FIX is user's call. |
| "Security/validation check is overkill" | Security is not proportional to your confidence. Run the check. |
| "Performance doesn't matter at this scale" | Patterns established now persist. Check for inefficient queries, missing indexes, unbounded operations, unnecessary recomputation. |

---

## Retro Handoff

When QA clears with no MUST-FIX items remaining, add to the "all clear" gate message:

> After shipping, consider running `/team-retro` to capture learnings from this feature's workflow.

---

## Model Tier

| Role | Tier | Rationale |
|------|------|-----------|
| Lead (current session, orchestrates) | Current session model | Denoise runs inline, finding classification requires judgment, gate decisions need care |
| Validator A: Style Audit | Inherited (session model) | Mechanical: convention matching against a loaded skill — no pin; runs on whatever the session runs |
| Validator CD: Code Review Swarm | `/review-swarm` (reviewer workers, model per reviewer) | Delegated to review-swarm's own model selection. Covers correctness, security, performance, architecture, and domain idioms with research backing and reviewer convergence. Replaces the former isolated specialist passes. |
| Validator E: Adversarial | Independent native worker by default; an authenticated different-family model when explicitly available. | Adversarial pass using the repository prompt. Log "cross-model diversity reduced" when the native host model is used. |

Keep denoise (inline), finding classification, and the final gate judgment on the lead — that is the judgment-heavy work.

**Token cost:** Validator CD is ~5-15× the old C+D per run (reviewer workers read full files, run
research tools, exchange convergence findings). Worth it post-build; skip for trivial
changes via `--only` flags.

---

## Dispatch by Runtime

The validation substance above is runtime-agnostic. The orchestration primitives below are the
only runtime-specific part — how the validators are spawned and how the pipeline phasing is held.

**Phasing is load-bearing, not an implementation detail.** Phase 1 (denoise) runs **inline and
sequentially first** — it is the lead reading every changed file directly against
`references/denoise-checklist.md`, with no worker spawned, and it must complete (gate) before any
Phase 2 worker starts. Phase 2 then runs the validators **in parallel**: Validator A (style audit)
and Validator E (independent adversarial) are spawned workers; Validator B (doc freshness) runs **inline**
on the lead (no spawn); Validator CD is **not a worker at all** — it is a full invocation of the
`review-swarm` sub-skill, which does its own internal dispatch (and its own teardown) per its own
**§ Dispatch by Runtime**. Do not flatten denoise into the parallel phase, and do not collapse the
inline checks (denoise, Validator B) into spawned workers.

Two of the Phase 2 lanes are special:

- **Validator CD is a sub-skill, not an in-session subagent.** You invoke the `review-swarm` skill
  (via your runtime's skill/command invocation) and wait for its combined report. Review-swarm
  fans out and reconciles its own reviewers; team-qa does not spawn those reviewers directly.
- **Validator E is an independent adversarial context.** On Codex it runs as a native subagent by
  default, which keeps the plugin self-contained and safe. If the environment explicitly exposes
  an authenticated different-family model, it may be used instead. Model diversity is useful but
  never justifies shelling back into the host model or bypassing another CLI's safety controls.

> Use your runtime's native, in-session subagent delegation — workers that report back to the lead.
> Do NOT use cross-agent/cross-container dispatch (e.g. NanoClaw's `spawn_task` MCP): those launch
> separate sessions that can't converge their findings back into the lead's QA report. Stay
> in-session. This applies to the Validator A and Validator E workers. Only a runtime-specific,
> explicitly configured external-model adapter may leave the host model, and it must remain read-only.

### Codex

Codex delegates to subagents out of the box. Run the spawned Phase 2 validators as independent
Codex subagents, in parallel where supported, following
[`../shared/codex-workflow-primitives.md`](../shared/codex-workflow-primitives.md) (§ Codex
Subagents). Lead-mediated convergence (workers report to the lead; the lead reconciles and classifies):

- **Phase 1 (denoise):** no subagent — the lead reads the changed files inline and gates before Phase 2.
- **Validator A (style):** one Codex subagent carrying the **verbatim** prompt at
  `references/qa-validator-prompts.md#validator-a-style-audit-prompt` (no model override — host session model).
- **Validator B (doc freshness):** inline on the lead — no subagent.
- **Validator CD (code review swarm):** invoke the `review-swarm` skill (the §-CD arguments block);
  review-swarm runs its own Codex subagents and teardown. Team-qa waits up to the 15-minute cap.
- **Validator E (adversarial):** one Codex subagent carrying the verbatim adversarial prompt. Log
  "cross-model diversity reduced" unless an explicitly configured different-family model actually
  ran. Never shell out to `codex exec` from Codex to simulate diversity. Re-delegate a failed worker
  once; the lead owns finding integration, classification, and the final gate.

### OpenCode

Issue parallel `task({ subagent_type: 'general', description, prompt, background: true })` calls in
ONE tool turn — one per *spawned* Phase 2 validator (A and E). `background: true` is the parallel
key. OpenCode's worker is `general` (NOT `general-purpose`). Lead-mediated convergence, same as Codex:

- **Phase 1 (denoise):** inline on the lead — no `task` call. Gate before Phase 2.
- **Validator A (style):** one `task(...)` with the verbatim style-audit prompt in its `prompt`.
- **Validator B (doc freshness):** inline on the lead — no `task` call.
- **Validator CD (code review swarm):** invoke the `review-swarm` skill via OpenCode's skill/command
  invocation (not a `task` call) — review-swarm issues its own background `task` reviewers and
  reclaims them. Team-qa waits up to the 15-minute cap.
- **Validator E (adversarial):** one `task(...)` whose prompt is the repository adversarial prompt.
  Use a different-family model only when explicitly configured and authenticated; otherwise run a
  same-runtime pass and prepend the "cross-model diversity reduced" note. Re-dispatch
  a failed task once; the lead classifies and gates. Background tasks self-complete — no explicit teardown.

### Claude (reference — for parity, not used on this runtime)

On Claude this pipeline spawns Validator A and Validator E via `Task(...)` (`subagent_type: general-purpose`,
no `model` override — they inherit the session model), Validator CD via the `Skill` tool invoking `bootstrap-workflow:review-swarm`, and
Validators B + denoise inline. **Validator E's cross-model target on Claude is genuinely Codex** —
the Claude-hosted worker may shell out to ephemeral read-only `codex exec` (OpenAI) when available;
the Codex/OpenCode subsections above invert that choice precisely because shelling to codex from a
Codex host would be same-model. Review-swarm's own reviewers run as native agent-team teammates with
live `SendMessage` convergence rounds and receive shutdown requests when done; the session-scoped
team needs no explicit creation or deletion. The Codex/OpenCode lead-mediated convergence and
runtime-native teardown above are the near-parity equivalents — same gates, same classification,
same 15-minute CD cap — achieved with fire-and-return workers that reclaim themselves.
