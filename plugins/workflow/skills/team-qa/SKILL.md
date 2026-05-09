---
name: team-qa
description: >
  Invoke after /team-build is approved. Runs validation checks on changed files (denoise + parallel
  validators: style, docs, code review swarm, Codex adversarial cross-model). Do NOT run QA checks
  manually — this skill has validator isolation, finding classification, and selective re-run logic
  that only load when invoked.
version: 2.3.0
---

# /team-qa — Post-Build Validation Pipeline

## What This Skill Does

Runs the built implementation through a structured validation pipeline. Five checks in two phases:
denoise first (sequential), then style + doc + code review swarm + Codex adversarial (parallel).
Scoped Claude validators (style, doc) get only changed files + one relevant skill. The code review
swarm delegates to `/review-swarm` for rich, research-backed code review — covering security,
performance, architecture, domain idioms, and adversarial correctness dynamically based on the diff.
Codex attacks the git diff with cross-model framing focused on auth/data-loss/race-condition failure modes.

**Key principle:** Scoped validators (A, B) stay tight — changed files + one skill — to minimize
false positives. The code review swarm (CD) deliberately gets the full diff + CLAUDE.md + research
tools because its job is the broad correctness check that scoped validators can't do.

**Cross-model coverage:** Validators A, B, CD run on Claude. Validator E runs on Codex (OpenAI). The
adversarial cross-model pass catches failure modes Claude validators tend to miss (or rationalize away).

**Output:** QA report classifying all findings (see `references/qa-report-template.md`)
**NOT output:** The fixes themselves — findings go back to the user or loop to a fix pass

## Prerequisites

A completed build — either from `/team-build` or an implementation the user wants to validate.

**If no changed files are identifiable:** Ask the user to specify which files to validate.

## When to Use

- After `/team-build` is approved and before shipping/merging
- When validating any implementation against project standards
- Do NOT auto-trigger — the user types `/team-qa` to invoke

## Selective Re-run (`--only`)

After fixing one finding, you don't need to re-run the entire pipeline. Use `--only` to target a single validator:

```
/team-qa --only denoise      # Phase 1 only
/team-qa --only style        # Validator A only
/team-qa --only docs         # Validator B only
/team-qa --only swarm        # Validator CD only (code review swarm)
/team-qa --only codex        # Validator E only (Codex adversarial)
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
   git diff --name-only main...HEAD   # all changes on this branch vs main
   # or
   git diff --name-only HEAD~1        # just the last commit
   ```
3. **From user** if neither is available — ask explicitly

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
conventions encoded in `CLAUDE.md`. There are no project-specific gate skills to discover —
project-specific rules belong in `CLAUDE.md` (where every validator reads them) and the
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
   table in [`references/qa-validator-routing.md`](references/qa-validator-routing.md) plus `CLAUDE.md`. Note "scope file absent" in the QA report so it's auditable.

### Multi-Domain File-Type Resolution

When multiple domain skills are loaded (e.g., software-engineering + data-science):
- The scope file determines which skills to load (the candidate set).
- The file-type routing table in [`references/qa-validator-routing.md`](references/qa-validator-routing.md) determines which
  loaded skill applies to each specific file.
- A `.py` API handler file: software-engineering checks apply; data-science checks do not.
- A `.ipynb` notebook: data-science checks apply; software-engineering checks do not.
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

Present findings as a list with file:line. For each:
- **Auto-safe removals** (unused imports, debug logs, temp files): propose removing immediately
- **Judgment calls** (dead code, commented blocks): show the code, ask user to confirm removal

Wait for user to approve/deny each item before proceeding to Phase 2.

**Gate:** Denoise must complete before Phase 2 starts. A clean codebase produces cleaner validator output.

### Phase 2: Parallel Validators

Launch all applicable validators simultaneously (A, B, CD, E — four validators in parallel).
Skip Validator CD only if the diff is pure docs/config with no code changes. Skip Validator E
(Codex) only if Codex is unavailable or the diff has no code changes.

---

#### Validator A: Style Audit

**Context:** Changed files + `CLAUDE.md` conventions + language defaults
**Spawn:** Task tool (`model: "sonnet"`) with the verbatim prompt at [`references/qa-validator-prompts.md`](references/qa-validator-prompts.md#validator-a-style-audit-prompt). The prompt encodes the pre-existing-vs-introduced classification that the lead's Step 3 classification step depends on — don't paraphrase.

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
CLAUDE.md parsing, domain detection, and research.

**Purpose:** The broad code-review lane. Covers correctness, project conventions, security,
performance, architecture, and domain-specific idioms through dynamic reviewer selection. Unlike
scoped validators A and B, this validator receives the full diff + CLAUDE.md + research tools so
its reviewers can check current best practices (context7, deepwiki, Exa) and collaborate
(SendMessage) before reporting. Replaces the previous isolated C (security) and D (performance)
validators.

**When to skip:** Pure docs or pure config diffs with no code changes. Otherwise always run. Any other CD skip reason (context budget, time pressure, validator overlap, "Codex E covers it") MUST be user-approved before /team-qa. Lead may NOT skip CD on judgment grounds.

**Pre-flight check:** Verify at least one `mcp__exa__*` tool is in the session's tool list.
Review-swarm hard-fails without Exa (`review-swarm/SKILL.md:107`). If none present, **skip
this validator** with the warning:

> ⚠ Code review swarm research tools unavailable (no mcp__exa__* present) — Validator CD skipped. Code review coverage reduced.

**Invocation:** Skill-invoke `bootstrap-workflow:review-swarm` with the branch scope and
domain hints from Step 2. Review-swarm does its own Step 1 discovery — team-qa passes only the
git scope and the `<DOMAIN_HINTS>` block, then waits for the combined report.

```
Skill(
  skill: "bootstrap-workflow:review-swarm",
  args: "Review the branch diff against <BASE_BRANCH>.

         CRITICAL diff scope override: Use exactly this command for your Step 1 diff
         gathering, instead of your default 'git diff HEAD':
             git diff <BASE_BRANCH>...HEAD

         Standalone invocation from team-qa post-build validation. Do your own Step 1
         discovery against the diff above.

         <DOMAIN_HINTS>
         [see §'Domain Hints to Forward to Swarm' — lead inserts the built block here]
         </DOMAIN_HINTS>

         Return the combined review report with BUG and SUGGESTION findings classified
         per your standard format."
)
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

**Ensure cleanup:** Review-swarm's Step 6 deletes its team (`TeamDelete`) after reporting, but
this is best-effort and may be skipped if the swarm crashes mid-run. Explicitly verify and
clean up:

```
TeamList()    # check whether team "code-review" still exists
# If the team is still present after review-swarm reported its findings:
TeamDelete(team_name: "code-review")
```

A leaked team causes TeamCreate failures on the next `/team-qa` run.

**If review-swarm fails (research tools down, swarm timeout > 15min, mid-run error):** Log
"Code review swarm failed — Validator CD skipped this run" in the report, run the cleanup
above, and continue. Do not retry mid-run. Codex (Validator E) still covers a subset of the
same ground.

---

#### Validator E: Codex Adversarial Review (Cross-Model)

**Context:** Git diff (the actual code changes — not files in isolation)

**Purpose:** Cross-model adversarial pass on the implementation. Codex (OpenAI) attacks the diff
with framing focused on the failure modes Claude tends to miss or rationalize: auth/permission
boundaries, data loss, race conditions, rollback safety, idempotency gaps, schema drift,
observability gaps. This is the only validator that runs on a non-Claude model.

**Pre-flight check:** Verify Codex is available and authenticated. If `command -v codex` fails,
**skip this validator** with a warning and continue with Validators A, B, and CD:

> ⚠ Codex CLI unavailable — Validator E (cross-model adversarial) skipped. Cross-model coverage reduced.

If the codex binary is present but auth is missing (no `~/.codex/auth.json`), skip with:

> ⚠ Codex authenticated session not available — Validator E skipped. Run `codex login` on the host.

Do not block QA on Codex unavailability.

**Invocation:** Spawn a Task subagent (`subagent_type: general-purpose`, `model: sonnet`) with the verbatim subagent prompt at [`references/qa-validator-prompts.md`](references/qa-validator-prompts.md#validator-e-codex-adversarial-subagent-prompt). The subagent shells out to `codex exec --yolo`, captures the JSON output, and returns it verbatim — it does not do its own adversarial reasoning. The reference file documents the indirection (why direct CLI, not the slash command; why `--yolo`) and the four-step procedure.

Fill in `<BASE_BRANCH>` and `<REPO_ROOT>` for the project before spawning.

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

**Mapping Codex severity to team-qa classification:**

| Codex severity × confidence | team-qa class |
|---|---|
| `critical` or `high` + confidence ≥ 0.6 | MUST-FIX |
| `critical` or `high` + confidence < 0.6 | SHOULD-FIX |
| `medium` + confidence ≥ 0.6 | SHOULD-FIX |
| `medium` + confidence < 0.6 | ADVISORY |
| `low` (any confidence) | ADVISORY |
| Verdict `approve` with no findings | No findings — note in report |

**If Codex returns errors or times out:** Log "Codex adversarial review failed — Validator E
skipped this run" in the report and continue. Do not retry mid-run.

**Resyncing the verbatim prompt:** If upstream `@openai/codex-plugin-cc` updates their
adversarial prompt or output schema, refresh the copies in `references/` per the instructions
in `references/CODEX-SOURCES.md`.

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

Denoise:        [N fixed, N waived]
Style:          [N violations — N MUST-FIX, N SHOULD-FIX, N ADVISORY (M introduced, P pre-existing)]
Doc freshness:  [N stale items]
Code review (swarm): [N findings — N MUST-FIX (BUG), N SHOULD-FIX (SUGGESTION)]   [or: skipped — no code changes | skipped — Exa unavailable | failed — swarm error]
Codex (cross-model): [N findings — N MUST-FIX, N SHOULD-FIX, N ADVISORY]   [or: skipped — Codex unavailable]

[If CD or E was skipped/failed:]
⚠ COVERAGE DEGRADED: [code review swarm | cross-model adversarial] unavailable this run.
   MUST-FIX total below excludes findings that lane would produce.
   Re-run `/team-qa --only [swarm|codex]` once tools recover.

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

`CLAUDE.md` is read directly by review-swarm's reviewers and Validator A — project conventions don't need a separate hint block.

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
| Lead (current session, orchestrates) | Opus (current session) | Denoise runs inline, finding classification requires judgment, gate decisions need care |
| Validator A: Style Audit | Sonnet | Mechanical: convention matching against a loaded skill |
| Validator CD: Code Review Swarm | `/review-swarm` (team agents, model per reviewer) | Delegated to review-swarm's own model selection. Covers correctness, security, performance, architecture, and domain idioms with research backing and reviewer collaboration. Replaces the isolated specialist subagents (security-reviewer, performance-analyzer) previously used as Validators C and D. |
| Validator E: Codex Adversarial | Codex (OpenAI) | Cross-model adversarial pass — runs via `codex exec --yolo` with the verbatim prompt from `references/codex-adversarial-prompt.md` |

Reserve Opus for denoise (inline), finding classification, and the final gate judgment.

**Token cost:** Validator CD is ~5-15× the old C+D per run (team agents read full files, run
research tools, exchange collaboration messages). Worth it post-build; skip for trivial
changes via `--only` flags.
