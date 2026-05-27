# QA Validator Subagent Prompts

Verbatim prompts for the two validators that spawn external workers (Validator A: Style Audit, Validator E: Codex Adversarial). Validators B and CD are not here — B runs inline and CD is delegated to `/review-swarm` via a skill/command invocation, both lean enough to live directly in `team-qa/SKILL.md`. The runtime-specific spawn primitive for each worker lives in team-qa `SKILL.md` § Dispatch by Runtime; this file carries only the model-neutral worker prompts.

The lead reads this file when constructing a validator worker. Don't paraphrase — the prompts encode finding-classification rules and pre-existing-vs-introduced discipline that the lead's classification step depends on downstream.

## Table of contents

- [Validator A: Style Audit prompt](#validator-a-style-audit-prompt)
- [Validator E: Codex Adversarial subagent prompt](#validator-e-codex-adversarial-subagent-prompt)

---

## Validator A: Style Audit prompt

Spawn an isolated style-audit worker (Sonnet tier) — see team-qa `SKILL.md` § Dispatch by Runtime for the spawn primitive on your runtime — and give it the following verbatim prompt. The pre-existing-vs-introduced classification is load-bearing — it stops the validator from penalizing the current change for issues that predate it.

```
You are performing a style audit on recently changed files.

Load `AGENTS.md/CLAUDE.md` for project-specific conventions, then apply general conventions for
the project's primary language for anything AGENTS.md/CLAUDE.md doesn't cover.

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

## Validator E: Codex Adversarial subagent prompt

Spawn a generic worker (Sonnet tier) — see team-qa `SKILL.md` § Dispatch by Runtime for the spawn primitive on your runtime — whose sole job is to shell out to the **cross-model adversarial CLI** and return its structured JSON verbatim. The worker does not do its own adversarial reasoning; the targeted model does.

**Cross-model targeting (read § Dispatch by Runtime first):** Validator E exists to attack the diff with a model **different from the host runtime** — that diversity is the whole point. The CLI the worker shells out to therefore depends on the host:

- On a **non-Codex host** (the cross-model case): shell to `codex exec` per the four-step procedure below. This is genuinely cross-model.
- On a **Codex host**: `codex exec` would be same-model, so § Dispatch by Runtime points the worker at a *non-Codex* model's CLI instead (e.g. `claude -p`) carrying the same adversarial framing and JSON schema. The four-step procedure below still applies — substitute the non-Codex CLI for the `codex exec` line.
- **Same-runtime fallback:** if no second model is reachable, run the adversarial pass on the host model anyway and prepend `⚠ Running a same-runtime adversarial pass (no second model available). Cross-model diversity reduced.` to the worker output so the lead can log it in the QA gate.

The adversarial prompt template (`codex-adversarial-prompt.md`) and output schema (`codex-review-output.schema.json`) are model-agnostic — the `<role>` framing transfers to whatever model is targeted; only the CLI binary changes.

**Why this layer of indirection exists:**
- `/codex:adversarial-review` has `disable-model-invocation: true` in its frontmatter, so a skill/command invocation cannot reach it from a model turn. The companion script path is blocked the same way.
- A worker shelling out to the adversarial CLI directly produces equivalent output while remaining invocable from an agent context.
- See `references/CODEX-SOURCES.md` for the source mapping.

**Why `--yolo`** (Codex-CLI path only): Codex's internal `bwrap` sandbox cannot create nested user namespaces inside Docker (tested). `--yolo` is the documented short alias for `--dangerously-bypass-approvals-and-sandbox`, "intended solely for running in environments that are externally sandboxed". The agent container is the external sandbox. (A non-Codex CLI uses its own non-interactive flags instead.)

Fill in `<BASE_BRANCH>` and `<REPO_ROOT>` for the project before spawning.

````
You are Validator E of the /team-qa pipeline — a cross-model adversarial review run on a model
DIFFERENT from the host runtime. Your ONLY job is to shell out to the cross-model adversarial CLI
your lead designated (codex exec by default; a non-Codex CLI such as `claude -p` when the host
runtime is itself Codex — your lead tells you which), capture its structured JSON output, and
return it verbatim. Do NOT do your own adversarial review.

The four-step procedure below is written for the `codex exec` CLI. If your lead designated a
different CLI (because the host runtime is Codex and codex would be same-model), keep STEP 1 and
STEP 2 identical and substitute that CLI's non-interactive invocation for the `codex exec` command
in STEP 3, still passing the same prompt file and requesting JSON that matches the schema. If no
second model was available and your lead told you to run a same-runtime pass, prepend
"⚠ Running a same-runtime adversarial pass (no second model available). Cross-model diversity
reduced." to your returned output.

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
# Use three-dot syntax: changes on this branch since divergence from BASE_BRANCH.
# Two-dot would also include unrelated commits added to BASE_BRANCH after this branch diverged.
git diff "<BASE_BRANCH>...HEAD" > /tmp/codex-diff.txt

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

Adversarial QA review is a deep analytical task: spotting subtle bugs, race conditions,
and missing edge cases benefits from maximum reasoning. Default to `xhigh`. Only drop to
`high` or `medium` if a human operator explicitly asked for a faster/cheaper run on a
small or trivial diff.

```bash
codex exec \
  --yolo \
  --ephemeral \
  --config model_reasoning_effort="xhigh" \
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
- Do NOT invoke /codex:adversarial-review or /codex:review via a skill/command invocation — same block.
- Do NOT run codex with a sandbox mode other than --yolo — bwrap will fail in containers (Codex-CLI path only).
- Do NOT split the diff into chunks — pass the full diff in one call. The targeted model handles large diffs.

If the adversarial CLI fails with an error, return the error output so the lead can report it in the
team-qa gate message.
````

The worker returns a JSON document matching `references/codex-review-output.schema.json`. Lead-side parsing logic and severity mapping live in `team-qa/SKILL.md` Validator E section.
