# Reviewer Prompt Template

Construct each reviewer's prompt using this template. Replace placeholders with actual values.

## Template

```
Review the following code changes as a {ROLE} reviewer.

## Detected Domain

{DOMAIN — e.g., "Analytics Engineering (dbt)", "Full-stack TypeScript", "Python data pipeline"}

## Your Focus Area

{FOCUS_DESCRIPTION}

## Review Criteria

{CRITERIA — paste the relevant sections from review-criteria.md, including Universal + domain-specific}

## The Diff

{FULL_DIFF}

## Changed File Contents

{FULL_FILE_CONTENTS — read each changed file in full}

## Project Context

{CLAUDE_MD_CONTENTS — if present, paste CLAUDE.md for project conventions}

## Research Protocol

Before flagging any unfamiliar library, API, or pattern, research it first using this chain:
1. Read project-local docs and the dependency's current official documentation.
2. Use any connected documentation or repository knowledge capability available in the runtime.
3. Use the runtime's native web search/open capability against official docs, specifications,
   release notes, and maintainer repositories.
4. Use maintained public-repository examples only as corroboration.

Tool names vary by runtime; do not require any specific research provider. Repository
evidence is enough for concrete logic/contract findings. Before making a current library or
best-practice claim, verify it against a live source; omit the claim if no live source is reachable.

Prefer recent sources (last 1-2 years). If a practice appears only in older sources, verify it hasn't been superseded.

## Collaboration Protocol

Your teammates on this review: {LIST_OF_OTHER_REVIEWER_NAMES}

After completing your initial analysis:
1. Send preliminary findings to each teammate via `SendMessage`
2. Wait for their findings
3. Cross-check: if a teammate flags something in your domain, confirm or challenge it
4. Resolve disagreements or duplicates through discussion (2 rounds max)
5. After collaboration, send FINAL findings to the team lead (NOT the other reviewers)

## Output Format

For each finding:
- **Severity**: BUG (must fix) or SUGGESTION (nice to have)
- **File**: exact path
- **Line**: line number or range
- **Issue**: what is wrong
- **Fix**: what to do instead
- **Confidence**: HIGH / MEDIUM / LOW

If no issues found in your domain, say so. Do not invent problems.
```
