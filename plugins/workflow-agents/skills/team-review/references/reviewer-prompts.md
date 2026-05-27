# Reviewer Prompt Templates

Reference for the team lead when constructing prompts for each reviewer in Step 2.

---

## Reviewer A: Architecture (architecture-advisor role)

Delivered as the worker prompt for an independent worker carrying the architecture-advisor role
(spawn it with the per-runtime worker primitive in SKILL.md § Dispatch by Runtime). Give the worker
read/grep/glob/shell access plus Context7 and Exa so it can verify library capabilities and read
codebase files — this prompt scopes its review lens.

Reviewer A has direct access to Context7 and Exa — it can independently verify library capabilities.

```
Review the design document at .agents/tmp/bootstrap-workflow/review-input.md as a critical architecture reviewer.

Your lens: STRUCTURAL INTEGRITY
- Is the design internally consistent? Do the constraints, options, and recommendation align?
- Does the recommended approach fit the project patterns in AGENTS.md/CLAUDE.md?
- Are there hidden coupling risks or dependency problems?
- Are the constraint classifications (HARD/SOFT) correct?
- What's missing that should be there?
- What risks are understated or unacknowledged?
- What assumptions does the design make that might not hold?

For any library the design references, verify it can do what the design claims:
1. Context7 first: resolve-library-id → query-docs
2. Exa fallback: mcp__exa__get_code_context_exa or mcp__exa__web_search_exa
3. WebSearch last resort

Also load these relevant project skills: [LIST SKILL NAMES]

For each finding:
- What the issue is (cite the specific design section)
- Why it matters (consequence if ignored)
- Suggested resolution
- Confidence: High / Medium / Low

End with a numbered list of findings only. No prose summary.
```

**Fill in before sending:**
- `[LIST SKILL NAMES]`: replace with the actual domain skill names identified in Step 1
  (e.g., "software-engineering, llm-engineering" — names match the bootstrap-domain skill set)

---

## Reviewer B: Best Practices (forwarder for /bootstrap-workflow:best-practice-check)

Delivered as the worker prompt for an independent generic worker (spawn it with the per-runtime
worker primitive in SKILL.md § Dispatch by Runtime). The worker's only job is to invoke the
`/bootstrap-workflow:best-practice-check` skill via your runtime's skill/command invocation with the
design document as scope, then return the skill's output verbatim.

Why a forwarder pattern: the lead spawns a separate worker so the skill's external research (which
produces hundreds of search results) runs in an isolated context and doesn't pollute the lead's
context. The lead receives only the structured assessment.

```
You are Reviewer B for a team-review of a design document. Your ONLY job is to invoke the
/bootstrap-workflow:best-practice-check skill on the design and return its output.

Step 1: Read the design document at .agents/tmp/bootstrap-workflow/review-input.md and the project context at AGENTS.md/CLAUDE.md.

Step 2: Invoke the `/bootstrap-workflow:best-practice-check` skill via your runtime's skill/command
invocation (the per-runtime form is in SKILL.md § Dispatch by Runtime).

When the skill asks for scope, give it the design document as a "described subsystem":
- Problem being solved: extract from the design's problem statement / requirements section
- Approach taken: extract from the design's recommendation / chosen option
- Technology context: extract from AGENTS.md/CLAUDE.md and the design's tech stack references

The skill will research established patterns externally (via Context7, DeepWiki, Exa) with
rigorous source-tier discipline (T1/T2/T3 corroboration), then produce a structured pattern
assessment.

Step 3: Return the skill's complete structured output to the lead. Do not summarize, paraphrase,
or add commentary — return it exactly as the skill produces it.

CRITICAL — do not approximate the skill:
- Do NOT do your own pattern research using Exa or WebSearch
- Do NOT cite sources you found yourself
- Do NOT write your own assessment
- Invoke /bootstrap-workflow:best-practice-check via your runtime's skill/command invocation. The
  skill has source-tier classification, corroboration rules, and recency filters that you cannot
  replicate manually.

If the skill returns no findings (the design conforms to known patterns with no drift), return
that result verbatim. "No drift" is a valid finding.

End with the skill's structured output. No prose summary, no commentary.
```

---

## Reviewer C: Adversarial (cross-model, design-focused)

Delivered as the worker prompt for an independent generic worker (spawn it with the per-runtime
worker primitive in SKILL.md § Dispatch by Runtime). The worker's only job is to run the verbatim
adversarial design prompt at `references/codex-adversarial-design-prompt.md` **on a model different
from the host runtime** (cross-model diversity), substitute three placeholders, capture the output,
and return it verbatim to the lead. Which model to target, the launch command, and the same-runtime
fallback are in SKILL.md § Dispatch by Runtime; the substitution mechanics below are model-agnostic.

Why a forwarder pattern: the cross-model adversarial reviewer is a CLI/worker that produces
substantial output. Running it in the lead's context would pollute the review state with its
reasoning traces. Isolating it in a separate worker keeps the lead clean for finding merge +
classification.

```
You are Reviewer C for a team-review of a design document. Your ONLY job is to run the verbatim
adversarial design prompt on a model DIFFERENT from the host runtime and return its output. Do NOT
do your own adversarial review.

STEP 0 — Pre-flight. Verify a model different from the host runtime is available (the exact
detection command for your runtime is in SKILL.md § Dispatch by Runtime — e.g. probing for a
non-host model's CLI on PATH such as `command -v claude` when the host is Codex, or `command -v
codex && test -r ~/.codex/auth.json` when the host is OpenCode).

If a different model IS available, run the adversarial pass there (STEP 1-4 below).
If NO different model is available:
- If you can run a same-runtime adversarial pass (a native worker on the host runtime), do so in an
  isolated context, prepend to the prompt: `⚠ Running as a same-runtime adversarial pass (no model
  different from the host available). Cross-model diversity reduced.`, and proceed.
- If even that is impossible, return exactly this string and stop:
    REVIEWER_C_SKIPPED: no model different from the host available — <reason>

STEP 1 — Locate the verbatim design-adversarial prompt template. It ships as a reference
alongside this team-review skill. Find it:

    PROMPT_FILE=$(find / -path '*/team-review/references/codex-adversarial-design-prompt.md' 2>/dev/null | head -1)
    if [ -z "$PROMPT_FILE" ]; then
      echo "REVIEWER_C_SKIPPED: prompt template not found"
      exit 2
    fi

STEP 2 — Build the substituted prompt. The template uses three placeholders:
- {{TARGET_LABEL}} → "design document for <feature name>" (extract from the design title)
- {{USER_FOCUS}} → "general adversarial design review" (unless the user supplied a specific focus)
- {{REVIEW_INPUT}} → the full contents of .agents/tmp/bootstrap-workflow/review-input.md

Use Node with argv (NOT env vars — those don't inherit cleanly into child processes):

    node - "$PROMPT_FILE" .agents/tmp/bootstrap-workflow/review-input.md /tmp/codex-design-prompt.md "<TARGET_LABEL>" "<USER_FOCUS>" <<'NODE_EOF'
    const fs = require('fs');
    const [, , tplPath, designPath, outPath, targetLabel, userFocus] = process.argv;
    const tpl = fs.readFileSync(tplPath, 'utf8');
    const design = fs.readFileSync(designPath, 'utf8');
    const prompt = tpl
      .replace('{{TARGET_LABEL}}', targetLabel)
      .replace('{{USER_FOCUS}}', userFocus)
      .replace('{{REVIEW_INPUT}}', design);
    fs.writeFileSync(outPath, prompt);
    NODE_EOF

The quoted heredoc `<<'NODE_EOF'` prevents shell expansion inside the Node script so you can
use `$`, backticks, or quotes freely in the JavaScript.

STEP 3 — Run the substituted prompt on the different model. The exact launch command is in
SKILL.md § Dispatch by Runtime (e.g. `claude -p` when the host is Codex, or `codex exec --yolo`
when the different model is Codex). Use a free-form run — design review does NOT use a structured
output schema (the schema in team-qa/references is code-diff-shaped with required
line_start/line_end fields; design findings don't have line numbers). Free-form output is correct
here.

Adversarial design review is a deep analytical task: assumption challenge, blind-spot
detection, and simpler-approach exploration benefit from maximum reasoning. Default to maximum
reasoning effort (when the different model is Codex, that is `--config model_reasoning_effort="xhigh"`).
Only drop to a lower effort if a human operator explicitly asked for a faster/cheaper run on a
small/simple design. When the different model is Codex, run it read-only-bypassing with `--yolo`
(bwrap can't nest in Docker), e.g.:

    codex exec --yolo --ephemeral --config model_reasoning_effort="xhigh" - < /tmp/codex-design-prompt.md 2>&1 | tee /tmp/codex-design-output.log

STEP 4 — Return the different model's output verbatim to the lead. Do not summarize, reformat, or
add commentary. If it returned "NO MATERIAL OBJECTIONS — design is defensible as written." return
that exactly. The lead will parse it and merge with Reviewers A and B.

CRITICAL — do NOT do any of these:
- Do NOT write your own adversarial prompt. Use the verbatim template file.
- Do NOT invoke /codex:adversarial-review or /codex:review via your runtime's skill/command
  invocation — both are blocked by `disable-model-invocation: true` in their frontmatter.
- Do NOT call the codex plugin's companion script — same block.
- When the different model is Codex, do NOT run it with a sandbox mode other than --yolo — bwrap will fail in containers.
- Do NOT silently run the adversarial pass on the host model. If no different model is reachable,
  either run the same-runtime fallback **with the reduced-diversity warning prepended** (STEP 0) or
  report REVIEWER_C_SKIPPED and let the lead decide whether to proceed with A+B only.

If the run errors out mid-run (timeout, network, unknown error), return:
    REVIEWER_C_FAILED: <error summary>

so the lead can note it in the report header.
```

---

## Notes on Prompt Delivery

**For all three reviewers:**

- Each prompt above is delivered as the worker prompt for an independent worker — spawn each with
  the per-runtime worker primitive in SKILL.md § Dispatch by Runtime.
- Reviewer A carries the architecture-advisor role (identity is the prompt, not a registered agent type).
- Reviewers B and C are generic workers (forwarders, not specialized reviewers).
- All workers need skill/command invocation (B invokes /bootstrap-workflow:best-practice-check) and
  shell access (C runs the adversarial pass on a model different from the host — see § Dispatch by Runtime).

**Pre-fetched library docs (optional):**

If the design references specific libraries that the lead has already pre-fetched docs for,
inline them in Reviewer A's prompt as:
```
---
Library docs (pre-fetched):
[content]
---
```

Reviewer B does not need pre-fetched docs — `/best-practice-check` does its own research.
Reviewer C does not need pre-fetched docs either — it's an assumption-challenge pass on the
design document itself, not a library-specific verification.
