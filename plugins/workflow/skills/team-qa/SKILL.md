---
name: team-qa
description: >
  Invoke after /team-build is approved. Runs validation checks on changed files (denoise + parallel
  validators: style, docs, code review swarm, Codex adversarial cross-model). Do NOT run QA checks
  manually — this skill has validator isolation, finding classification, and selective re-run logic
  that only load when invoked.
version: 2.2.0
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

### Step 2: Load Project Skills

Identify which project-level QA skills exist. Check:
```bash
ls .claude/skills/
```

Look for:
- `code-conventions` — project style and convention rules (load this into Validator A; also forwarded to Validator CD's domain-reviewer via Domain Hints)
- `review-gates` — general quality gates
- `security-review-gates` — project-specific security rules (forwarded to Validator CD's security-reviewer via Domain Hints)
- `performance-review-gates` — project-specific performance rules (forwarded to Validator CD's performance-reviewer via Domain Hints)

Note which exist and which are missing. For missing skills, fall back to the baseline checklists
in this skill's `references/` directory. **Record which gate skills exist** — Validator CD's
invocation will forward their paths to the swarm via the `<DOMAIN_HINTS>` block (see "Domain
Hints to Forward to Swarm" subsection below the routing table). Bootstrapped repos get their
project-specific rules into the swarm; non-bootstrapped repos still get the file-type
annotations that team-qa bakes in regardless.

### Project Scope Routing

1. Read `.claude/project-scope.md` if it exists.
   - If not found: run the 6-file discovery scan inline (see `/team-brief` Step 1b).
     Write scope file for future use.
2. Load all skills in `relevant_global_skills`.
3. If `relevant_global_skills` is empty: calibrate validators using `quality_gates`
   and `security_surface` fields from scope file (not free-form description alone).
   Each validator receives the relevant fields as its domain context.

### Multi-Domain File-Type Resolution

When multiple domain skills are loaded (e.g., software-engineering + data-science):
- The scope file determines which skills to load (the candidate set).
- The file-type routing table (Validator Routing by File Type, below) determines which
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

**Context:** Changed files + `code-conventions` project skill (or equivalent)

Spawn via Task tool (`model: "sonnet"`):

```
You are performing a style audit on recently changed files.

Load the project conventions skill: .claude/skills/code-conventions/SKILL.md
(If it doesn't exist, apply general conventions for the project's primary language)

Changed files to audit: [list from Step 1]

IMPORTANT — Pre-existing vs. introduced classification:
For files that were MODIFIED (not newly created), run `git diff main...HEAD -- <file>` to get
the diff (replace `main` with the project's actual base branch if different, e.g., `staging`).
Only classify a finding as INTRODUCED if the violating code appears in the diff's added lines
(lines starting with +). If the violation exists in unchanged lines, classify it as PRE-EXISTING.
Report both categories separately.
For newly created files, classify all violations as INTRODUCED.
If git is unavailable in this context, classify all findings from MODIFIED files as PRE-EXISTING
(conservative fallback — do not penalize for issues that may predate this change) and note that diff was unavailable.

Check each file against the loaded conventions/domain skill for:
- Naming conventions (variables, functions, models, columns, metrics — per loaded skill)
- Import / dependency ordering (imports, ref/source calls, macro usage)
- File and model structure conventions
- Function, method, and model signature patterns
- Documentation style (doc comments, model descriptions, column descriptions, metric definitions)
- Error handling and data validation patterns
- Any project-specific or domain-specific rules in the loaded skill

For each violation: file:line | convention violated | what's there | what it should be | INTRODUCED or PRE-EXISTING
For each pass: do not list — only report violations.
End with a count: [N] violations found ([M] introduced, [P] pre-existing).
```

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

**When to skip:** Pure docs or pure config diffs with no code changes. Otherwise always run.

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

**Invocation:** Spawn a Task subagent (`subagent_type: general-purpose`, `model: sonnet`)
whose sole job is to run `codex exec --yolo` directly against the diff, using the verbatim
adversarial prompt from the codex plugin, and return the structured JSON output.

**Why direct CLI, not the plugin slash command:** `/codex:adversarial-review` has
`disable-model-invocation: true` in its frontmatter, so the Skill tool cannot invoke it from
within a model turn. The companion script path is also blocked for the same reason. Calling
`codex exec` directly with the verbatim prompt produces the same output while remaining
invocable from an agent context. See `references/CODEX-SOURCES.md` for the source mapping.

**Why `--yolo`:** Codex's internal bwrap sandbox cannot create nested user namespaces inside
Docker (tested). `--yolo` is the officially documented short alias for
`--dangerously-bypass-approvals-and-sandbox`, which is "intended solely for running in
environments that are externally sandboxed". Our container IS the external sandbox.

**Subagent prompt template (fill in `<BASE_BRANCH>`):**

````
You are Validator E of the /team-qa pipeline — a cross-model adversarial review using Codex
(OpenAI). Your ONLY job is to shell out to codex exec, capture its structured JSON output, and
return it verbatim. Do NOT do your own adversarial review.

STEP 1 — Locate the prompt template and schema.

The verbatim adversarial prompt and output schema ship as references alongside this team-qa
skill. They're installed wherever the bootstrap-workflow plugin is mounted. Locate them:

```bash
PROMPT_FILE=$(find / -path '*/team-qa/references/codex-adversarial-prompt.md' 2>/dev/null | head -1)
SCHEMA_FILE=$(find / -path '*/team-qa/references/codex-review-output.schema.json' 2>/dev/null | head -1)
if [ -z "$PROMPT_FILE" ] || [ -z "$SCHEMA_FILE" ]; then
  echo "ERROR: codex prompt/schema not found — team-qa references missing"
  exit 2
fi
```

STEP 2 — Build the prompt file with substitutions.

The template uses three placeholders:
- {{TARGET_LABEL}} → "branch diff against <BASE_BRANCH>"
- {{USER_FOCUS}} → "general adversarial review"
- {{REVIEW_INPUT}} → the git diff content

Use Node for the substitution — sed breaks on diff content with special chars.
Pass the paths as command-line arguments (via `node -`) so you don't have to
deal with environment-variable export semantics:

```bash
cd "<REPO_ROOT>"  # the git repo root the lead gave you
git diff "<BASE_BRANCH>..HEAD" > /tmp/codex-diff.txt

node - "$PROMPT_FILE" /tmp/codex-diff.txt /tmp/codex-prompt.md <<'NODE_EOF'
const fs = require('fs');
const [, , tplPath, diffPath, outPath] = process.argv;
const tpl = fs.readFileSync(tplPath, 'utf8');
const diff = fs.readFileSync(diffPath, 'utf8');
const prompt = tpl
  .replace('{{TARGET_LABEL}}', 'branch diff against <BASE_BRANCH>')
  .replace('{{USER_FOCUS}}', 'general adversarial review')
  .replace('{{REVIEW_INPUT}}', diff);
fs.writeFileSync(outPath, prompt);
NODE_EOF
```

The `<<'NODE_EOF'` (quoted heredoc) prevents shell expansion inside the Node
script, so you can use `$`, backticks, or quotes freely in the JavaScript.

STEP 3 — Run codex exec with --yolo and the output schema.

```bash
codex exec \
  --yolo \
  --ephemeral \
  --output-schema "$SCHEMA_FILE" \
  --output-last-message /tmp/codex-result.json \
  - < /tmp/codex-prompt.md 2>&1 | tail -40
```

The `--output-last-message` flag writes Codex's final structured JSON to a file, which is
easier to parse than extracting it from streaming output.

STEP 4 — Return the JSON output to the lead.

```bash
cat /tmp/codex-result.json
```

Return the raw JSON verbatim. Do not summarize, reformat, or add commentary. The lead will
parse it and merge the findings into the team-qa report.

ANTI-PATTERNS:
- Do NOT write your own adversarial prompt — use the verbatim template file.
- Do NOT call the codex plugin's companion script — it's blocked by disable-model-invocation.
- Do NOT invoke /codex:adversarial-review or /codex:review via the Skill tool — same block.
- Do NOT run codex with a sandbox mode other than --yolo — bwrap will fail in containers.
- Do NOT split the diff into chunks — pass the full diff in one call. Codex handles large diffs.

If codex exec fails with an error, return the error output so the lead can report it in the
team-qa gate message.
````

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

---

## Validator Routing by File Type

Team-qa decides "swarm or not" per file type below; review-swarm picks its own reviewer mix
internally (`review-swarm/SKILL.md:71-78`).

| Changed file type | Denoise | Style | Doc | Code Review (CD) |
|-------------------|---------|-------|-----|------------------|
| API route / controller | ✓ | ✓ | ✓ | ✓ |
| Data layer / queries | ✓ | ✓ | ✓ | ✓ |
| Auth / middleware | ✓ | ✓ | ✓ | ✓ |
| Frontend component | ✓ | ✓ | ✓ | ✓ |
| Config / env | ✓ | — | ✓ | — (no code) |
| Tests | ✓ | ✓ | — | ✓ |
| Docs / README | — | — | ✓ | — (no code) |
| Migrations / schema | ✓ | ✓ | ✓ | ✓ |
| dbt model / SQL transformation | ✓ | ✓ | ✓ | ✓ |
| Pipeline / DAG definition | ✓ | ✓ | ✓ | ✓ |
| Notebook (.ipynb) | ✓ | ✓ | ✓ | ✓ |
| ML / feature code | ✓ | ✓ | ✓ | ✓ |
| Metric / dashboard definition | ✓ | ✓ | ✓ | ✓ |
| Schema / quality definition | ✓ | ✓ | ✓ | ✓ |
| GL model / financial SQL | ✓ | ✓ | ✓ | ✓ |
| Reconciliation script | ✓ | ✓ | ✓ | ✓ |
| Regulatory / report output config | ✓ | — | ✓ | ✓ |
| LLM client / API wrapper | ✓ | ✓ (llm-engineering) | ✓ | ✓ |
| Prompt template / eval harness | ✓ | ✓ (llm-engineering) | ✓ | ✓ |
| Agent loop / orchestrator | ✓ | ✓ (agentic-systems) | ✓ | ✓ |
| MCP server / tool definition | ✓ | ✓ (agentic-systems) | ✓ | ✓ |
| Mobile screen / component | ✓ | ✓ (vercel-react-native-skills) | ✓ | ✓ |
| Native module bridge | ✓ | ✓ | ✓ | ✓ |
| Mobile config (app.json, eas.json) | ✓ | — | ✓ | — (no code) |

**Note:** When `vercel-react-native-skills` is in `relevant_global_skills`, Validator A loads it for mobile screen/component files.

**Validator E (Codex) routing:** Codex operates on the git diff as a whole, not on individual file types. It runs on **every QA invocation** that has any code changes, regardless of file type — its adversarial framing applies broadly (auth, data, race conditions, observability gaps appear everywhere). Skip Validator E only when:
- The diff contains pure docs (`.md`, `README`) and no code at all
- The diff is empty (no changed files)
- Codex CLI is unavailable (pre-flight skip with warning)

---

## Domain Hints to Forward to Swarm

Build the `<DOMAIN_HINTS>` block for the Validator CD invocation from Parts 1 and 2 below.
Part 1 is always included; Part 2 is conditional on project skills.

### Part 1: File-type concern annotations (always included)

Build the annotation block from the changed files identified in Step 1. For each file type
present in the diff, include the matching line below. Send to review-swarm verbatim — these
are hints, not directives; review-swarm's dynamic selection still decides which reviewers
to spawn.

```
File-type concerns to consider when selecting and prompting reviewers:

- API route / controller       → security (auth, input validation), performance (N+1)
- Data layer / queries         → security (injection, access control), performance (indexes, unbounded fetches)
- Auth / middleware            → security (priority — permission boundaries, session handling)
- Frontend component           → security (XSS), performance (re-renders, bundle size)
- Config / env                 → security (secret exposure)
- Migrations / schema          → performance (index coverage, lock duration), data correctness (backfill safety)
- dbt model / SQL              → security (PII exposure), performance (query cost, materialization sizing)
- Pipeline / DAG               → security (credentials in config), correctness (idempotency, late arrivals)
- Notebook (.ipynb)            → security (PII in cell outputs), performance (memory, chunking)
- ML / feature code            → security (data leakage, train/test contamination), performance (compute)
- Metric / dashboard           → security (PII in dashboard exposure), correctness (metric definition drift)
- GL model / financial SQL     → security (salary/comp PII, row-level access controls), performance (full-table scans on multi-year transaction tables)
- Reconciliation script        → correctness (control totals), performance (query cost)
- Regulatory / report config   → security (audit trail, data access controls)
- LLM client / API wrapper     → security (API key exposure, prompt injection), performance (token cost, model tier)
- Prompt template / eval       → security (system prompt leakage, key in eval scripts), performance (token budget, live API in unit tests)
- Agent loop / orchestrator    → security (prompt injection via tool results, inter-agent trust), performance (unbounded loops, cost per run)
- MCP server / tool definition → security (auth on tool endpoints, scope creep), performance (tool error handling, retry behavior)
- Mobile screen / component    → security (deep links, API keys in config), performance (list perf, animation)
- Native module bridge         → security (permissions, native API misuse), performance
- Mobile config (app.json)     → security (secrets, permissions)
```

### Part 2: Project-specific gate skills (conditional)

At Step 2, team-qa already discovers `.claude/skills/` and notes which exist. If any of the
following project-specific gate skills are present, append the corresponding load instruction
to the `<DOMAIN_HINTS>` block. If absent, skip silently — review-swarm operates fine without
them via its built-in reviewer focus areas.

```
[If .claude/skills/security-review-gates/SKILL.md exists:]
Project-specific security rules: load `.claude/skills/security-review-gates/SKILL.md` in your
security-reviewer prompt (in addition to your built-in focus areas).

[If .claude/skills/performance-review-gates/SKILL.md exists:]
Project-specific performance rules: load `.claude/skills/performance-review-gates/SKILL.md` in your
performance-reviewer prompt (in addition to your built-in focus areas).

[If .claude/skills/code-conventions/SKILL.md exists:]
Project-specific conventions: load `.claude/skills/code-conventions/SKILL.md` in your domain-reviewer
prompt for naming/structure/idiom checks (in addition to CLAUDE.md). Note: Validator A also loads
this skill for its own scoped style audit, so domain-reviewer should avoid duplicating
already-flagged style issues — focus on convention violations that A's mechanical pass would miss
(judgment-dependent idioms, framework-specific patterns).

[If none of the above exist:]
No project-specific gate skills present. Use your built-in reviewer focus areas + CLAUDE.md.
```

---

## Anti-Patterns (Do Not Do These)

- **Don't run validators on the entire codebase.** Only changed files. Full sweeps produce noise that buries real findings.
- **Don't skip denoise.** Style checking noisy code flags things that would disappear after cleanup. Denoise first, validate clean.
- **Don't waive security findings without a stated reason.** "Won't fix" on a security issue is a decision that must be documented.
- **Don't merge advisory findings with MUST-FIX.** Different urgency = different lists. Don't let advisory volume make MUST-FIX items feel optional.
- **Don't loop QA on the same files endlessly.** If a finding keeps re-appearing, escalate to the user — it's a design issue, not a QA issue.

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
