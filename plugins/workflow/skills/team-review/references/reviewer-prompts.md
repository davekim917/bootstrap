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

## Notes on Prompt Delivery

**For both reviewers:**

- Both prompts are passed via the Task tool's `prompt` parameter
- Reviewer A uses `subagent_type: architecture-advisor`
- Reviewer B uses `subagent_type: general-purpose` (it's a thin forwarder, not a specialized reviewer)
- Both subagents have access to the Skill tool and can invoke skills in their own isolated contexts

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
