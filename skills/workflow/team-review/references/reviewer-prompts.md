# Reviewer Prompt Templates

Reference for the team lead when constructing prompts for each reviewer in Step 2.

---

## Reviewer A: Claude (architecture-advisor subagent)

Passed via Task tool `prompt` parameter. The architecture-advisor has its own system prompt and
tools (Read, Grep, Glob, Bash, Exa, Serena) — this prompt scopes its review lens.

Reviewer A has direct access to Context7 and Exa MCP tools — it can independently verify
library capabilities using the Research Fallback Chain.

```
Review the design document at .claude/tmp/review-input.md as a critical architecture reviewer.

Your lens: STRUCTURAL INTEGRITY
- Is the design internally consistent? Do the constraints, options, and recommendation align?
- Does the recommended approach fit the project patterns in CLAUDE.md?
- Are there hidden coupling risks or dependency problems?
- Are the constraint classifications (HARD/SOFT) correct?
- What's missing that should be there?
- What risks are understated or unacknowledged?

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

---

## Reviewer B: Codex (adversarial perspective)

Passed via `codex exec -s read-only "PROMPT"`. Codex has filesystem read access.

```
You are performing an adversarial design review. Your job is to find flaws, not validate.

Read the design document:
  cat .claude/tmp/review-input.md

Read the project context:
  cat CLAUDE.md

Your lens: ASSUMPTION CHALLENGE & BLIND SPOTS
- What assumptions is this design making that might be wrong?
- What simpler approach would solve the same problem?
- What would cause this design to fail in production?
- What's being optimized for that shouldn't be?
- What's NOT being optimized for that should be?
- What would a skeptical senior engineer object to?

Do NOT validate — find problems. Be specific: cite the section of the design you are critiquing.

For each finding:
- What the assumption or problem is
- Why it could be wrong or risky
- What a better alternative might look like

End with a numbered list of findings only. No prose summary.
```

---

## Reviewer C: Gemini / Cursor (implementation feasibility)

**Primary:** Gemini — passed via `gemini -p "PROMPT"` (add `--model <model>` if the user specified one; omit for Gemini CLI's default).
**Secondary:** Cursor — passed via `agent -p "PROMPT"` (add `--model <model>` if the user specified one).
Both have filesystem access. Use the same prompt for either CLI.

```
You are reviewing a design document for implementation feasibility.

Read the design document:
  cat .claude/tmp/review-input.md

Read the project context:
  cat CLAUDE.md

Your lens: IMPLEMENTATION RISK & UNDERSPECIFICATION
- Where will builders have to guess? (underspecified areas)
- What will be genuinely hard to implement as described?
- What edge cases aren't handled by the design?
- What integration risks exist between this design and the existing codebase?
- Where does the design contradict what's actually in the codebase?
- What's missing from the Assumptions Log that should be there?

Be concrete: cite the specific section or line of the design you are flagging.

For each finding:
- What is underspecified or risky
- What a builder would have to guess or discover on their own
- What should be added to the design to resolve it

End with a numbered list of findings only. No prose summary.
```

---

## Notes on Prompt Delivery

**For Codex, Gemini, and Cursor via here-doc:**

When building the shell invocation in practice, use a here-doc to avoid quoting issues:

```bash
PROMPT=$(cat <<'EOF'
[prompt text here]
EOF
)
# Add --config model_reasoning_effort="<effort>" if user specified one; omit for Codex's default
codex exec -s read-only "$PROMPT"

# Add --model <model> if user specified one; omit for Gemini CLI's default
gemini -p "$PROMPT"

# Cursor (secondary): add --model <model> if user specified one; omit for Cursor's default
agent -p "$PROMPT"
```

**Fill in before sending:**
- `[LIST SKILL NAMES]` in Reviewer A's prompt: replace with the actual skill names identified in
  Step 1 (e.g., "code-conventions, review-gates, security-review-gates")
- For Reviewers B (Codex) and C (Gemini or Cursor): include pre-fetched library documentation
  inline in the prompt (as text). Reviewers B/C run via CLI tools and cannot call MCP tools. The
  team lead fetches the docs in Step 1 and pastes the relevant sections as:
  `---\nLibrary docs (pre-fetched):\n[content]\n---` before the reviewer's lens instructions.

---

## Fallback Prompts

Used when the corresponding CLI tool is unavailable. The team lead checks availability in Step 1.5
and uses these prompts with the Task tool instead.

---

### Reviewer B Fallback (Claude general-purpose subagent)

Activated when `codex` CLI is unavailable. Passed via Task tool `prompt` parameter.

```
You are performing an adversarial design review. Your job is to find flaws, not validate.

Read the design document using the Read tool: .claude/tmp/review-input.md
Read the project context using the Read tool: CLAUDE.md

Your lens: ASSUMPTION CHALLENGE & BLIND SPOTS
- What assumptions is this design making that might be wrong?
- What simpler approach would solve the same problem?
- What would cause this design to fail in production?
- What's being optimized for that shouldn't be?
- What's NOT being optimized for that should be?
- What would a skeptical senior engineer object to?

Do NOT validate — find problems. Be specific: cite the section of the design you are critiquing.

Note at the start of your findings: "⚠ Running as Claude general-purpose fallback (Codex CLI unavailable). Cross-model diversity reduced."

For each finding:
- What the assumption or problem is
- Why it could be wrong or risky
- What a better alternative might look like

End with a numbered list of findings only. No prose summary.
```

---

### Reviewer C Fallback (Claude code-review-specialist subagent)

Activated when both `gemini` (Gemini CLI) and `agent` (Cursor CLI) are unavailable. Passed via Task tool `prompt` parameter.

```
You are reviewing a design document for implementation feasibility.

Read the design document using the Read tool: .claude/tmp/review-input.md
Read the project context using the Read tool: CLAUDE.md

Your lens: IMPLEMENTATION RISK & UNDERSPECIFICATION
- Where will builders have to guess? (underspecified areas)
- What will be genuinely hard to implement as described?
- What edge cases aren't handled by the design?
- What integration risks exist between this design and the existing codebase?
- Where does the design contradict what's actually in the codebase?
- What's missing from the Assumptions Log that should be there?
- Are there [RENDER-CHECK NEEDED] flags on visual decisions (color combinations, layout structure, spacing, typography)? If visual decisions appear in the design without a render-check flag, note it as an underspecification risk.

Be concrete: cite the specific section or line of the design you are flagging.

Note at the start of your findings: "⚠ Running as Claude code-review-specialist fallback (Gemini and Cursor CLIs unavailable). Cross-model diversity reduced."

For each finding:
- What is underspecified or risky
- What a builder would have to guess or discover on their own
- What should be added to the design to resolve it

End with a numbered list of findings only. No prose summary.
```

---

### When fallbacks activate

| Reviewer | CLI check | Fallback subagent_type |
|----------|-----------|------------------------|
| B (Codex) | `command -v codex` fails | `general-purpose` (model: sonnet) |
| C (Gemini/Cursor) | both `command -v gemini` and `command -v agent` fail | `code-review-specialist` |

Reviewer A (Claude architecture-advisor) always runs via Task tool — no fallback needed.
