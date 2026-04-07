# Reviewer Prompt Templates

Reference for the team lead when constructing prompts for each reviewer in Step 2.

---

## Reviewer A: Architecture (architecture-advisor subagent)

Passed via Task tool `prompt` parameter with `subagent_type: architecture-advisor`. The
architecture-advisor has its own system prompt and tools (Read, Grep, Glob, Bash, Exa, Serena) —
this prompt scopes its review lens.

Reviewer A has direct access to Context7 and Exa MCP tools — it can independently verify
library capabilities.

```
Review the design document at .claude/tmp/review-input.md as a critical architecture reviewer.

Your lens: STRUCTURAL INTEGRITY
- Is the design internally consistent? Do the constraints, options, and recommendation align?
- Does the recommended approach fit the project patterns in CLAUDE.md?
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
- `[LIST SKILL NAMES]`: replace with the actual skill names identified in Step 1
  (e.g., "code-conventions, review-gates, security-review-gates")

---

## Reviewer B: Best Practices (forwarder for /bootstrap-workflow:best-practice-check)

Passed via Task tool `prompt` parameter with `subagent_type: general-purpose`. The subagent's
only job is to invoke the `/bootstrap-workflow:best-practice-check` skill via the Skill tool
with the design document as scope, then return the skill's output verbatim.

Why a forwarder pattern: the lead spawns a subagent so the skill's external research (which
produces hundreds of search results) runs in an isolated context and doesn't pollute the lead's
context. The lead receives only the structured assessment.

```
You are Reviewer B for a team-review of a design document. Your ONLY job is to invoke the
/bootstrap-workflow:best-practice-check skill on the design and return its output.

Step 1: Read the design document at .claude/tmp/review-input.md and the project context at CLAUDE.md.

Step 2: Invoke the skill via the Skill tool:

  Skill({ skill: "bootstrap-workflow:best-practice-check" })

When the skill asks for scope, give it the design document as a "described subsystem":
- Problem being solved: extract from the design's problem statement / requirements section
- Approach taken: extract from the design's recommendation / chosen option
- Technology context: extract from CLAUDE.md and the design's tech stack references

The skill will research established patterns externally (via Context7, DeepWiki, Exa) with
rigorous source-tier discipline (T1/T2/T3 corroboration), then produce a structured pattern
assessment.

Step 3: Return the skill's complete structured output to the lead. Do not summarize, paraphrase,
or add commentary — return it exactly as the skill produces it.

CRITICAL — do not approximate the skill:
- Do NOT do your own pattern research using Exa or WebSearch
- Do NOT cite sources you found yourself
- Do NOT write your own assessment
- Use the Skill tool to invoke /bootstrap-workflow:best-practice-check. The skill has source-tier
  classification, corroboration rules, and recency filters that you cannot replicate manually.

If the skill returns no findings (the design conforms to known patterns with no drift), return
that result verbatim. "No drift" is a valid finding.

End with the skill's structured output. No prose summary, no commentary.
```

---

## Reviewer C: Adversarial (Codex, design-focused)

Passed via Task tool `prompt` parameter with `subagent_type: general-purpose`. The subagent's
only job is to run `codex exec --yolo` with the verbatim adversarial design prompt at
`references/codex-adversarial-design-prompt.md`, substitute three placeholders, capture the
output, and return it verbatim to the lead.

Why a forwarder pattern: Codex is a CLI that produces substantial output. Running it in the
lead's context would pollute the review state with Codex's reasoning traces. Isolating it in
a subagent keeps the lead clean for finding merge + classification.

```
You are Reviewer C for a team-review of a design document. Your ONLY job is to run Codex
with the verbatim adversarial design prompt and return its output. Do NOT do your own
adversarial review.

STEP 0 — Pre-flight. Verify Codex is available:

    command -v codex && test -r /home/node/.codex/auth.json

If either check fails, return exactly this string and stop:
    REVIEWER_C_SKIPPED: Codex unavailable — <reason (no binary / no auth file)>

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
- {{REVIEW_INPUT}} → the full contents of .claude/tmp/review-input.md

Use Node with argv (NOT env vars — those don't inherit cleanly into child processes):

    node - "$PROMPT_FILE" .claude/tmp/review-input.md /tmp/codex-design-prompt.md "<TARGET_LABEL>" "<USER_FOCUS>" <<'NODE_EOF'
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

STEP 3 — Run codex exec with --yolo. Design review does NOT use --output-schema (the schema
in team-qa/references is code-diff-shaped with required line_start/line_end fields; design
findings don't have line numbers). Free-form output is correct here:

    codex exec --yolo --ephemeral - < /tmp/codex-design-prompt.md 2>&1 | tee /tmp/codex-design-output.log

STEP 4 — Return the Codex output verbatim to the lead. Do not summarize, reformat, or add
commentary. If Codex returned "NO MATERIAL OBJECTIONS — design is defensible as written."
return that exactly. The lead will parse it and merge with Reviewers A and B.

CRITICAL — do NOT do any of these:
- Do NOT write your own adversarial prompt. Use the verbatim template file.
- Do NOT invoke /codex:adversarial-review or /codex:review via the Skill tool — both are
  blocked by `disable-model-invocation: true` in their frontmatter.
- Do NOT call the codex plugin's companion script — same block.
- Do NOT run codex with a sandbox mode other than --yolo — bwrap will fail in containers.
- Do NOT fall back to your own Claude review if Codex fails — just report
  REVIEWER_C_SKIPPED and let the lead decide whether to proceed with A+B only.

If codex exec errors out mid-run (timeout, network, unknown error), return:
    REVIEWER_C_FAILED: <error summary>

so the lead can note it in the report header.
```

---

## Notes on Prompt Delivery

**For all three reviewers:**

- All prompts are passed via the Task tool's `prompt` parameter
- Reviewer A uses `subagent_type: architecture-advisor`
- Reviewers B and C use `subagent_type: general-purpose` (they're forwarders, not specialized reviewers)
- All subagents have access to the Skill tool (B invokes /bootstrap-workflow:best-practice-check)
  and Bash (C runs codex exec --yolo)

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
