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

{PROJECT_INSTRUCTIONS — if present, paste AGENTS.md and/or CLAUDE.md for project conventions}

## Research Protocol

Before flagging any unfamiliar library, API, or pattern, research it first using this chain:
1. `mcp__plugin_context7_context7__resolve-library-id` + `mcp__plugin_context7_context7__query-docs` — current library/framework docs (preferred, may fail due to rate limits)
2. `mcp__deepwiki__ask_question` — architecture docs for specific GitHub repos/dependencies (preferred, may fail due to rate limits). If insufficient, try `mcp__deepwiki__read_wiki_structure` + `mcp__deepwiki__read_wiki_contents`.
3. `mcp__exa__web_search_exa` — official docs and known pitfalls (mandatory — always run even if steps 1-2 succeed)
4. `mcp__exa__get_code_context_exa` — real usage patterns in public repos
5. `mcp__exa__web_search_advanced_exa` — filtered/recent results when needed

If steps 1-2 fail, record the failure in your output notes AND proceed immediately to step 3 (Exa), which is the mandatory floor. Do not flag something as wrong without verifying against current docs.

Prefer recent sources (last 1-2 years). If a practice appears only in older sources, verify it hasn't been superseded.

## Convergence Protocol

Your fellow reviewers on this swarm: {LIST_OF_OTHER_REVIEWER_NAMES}

You run as an independent worker pass and return your findings to the lead. You do not message the
other reviewers directly. To make lead-mediated convergence possible:

1. For each finding, state the file:line, the issue, the fix, and your confidence.
2. If a finding touches another reviewer's domain (e.g. you are the performance reviewer but you spot a
   security concern), explicitly tag it `cross-domain: {reviewer-role}` so the lead routes it for
   confirmation.
3. Do not suppress a finding just because it overlaps another role — surface it and tag it. The lead
   deduplicates.
4. If you are uncertain whether something is a real issue, mark confidence LOW and say what additional
   context would resolve it — the lead may re-dispatch a targeted follow-up.

(On runtimes where reviewers can message each other directly, this same convergence happens as live
peer exchange instead of lead mediation — the required output below is identical either way.)

## Output Format

For each finding:
- **Severity**: BUG (must fix) or SUGGESTION (nice to have)
- **File**: exact path
- **Line**: line number or range
- **Issue**: what is wrong
- **Fix**: what to do instead
- **Confidence**: HIGH / MEDIUM / LOW
- **Cross-domain**: {reviewer-role} if the finding belongs to another reviewer's area, else omit

If no issues found in your domain, say so. Do not invent problems.
```
