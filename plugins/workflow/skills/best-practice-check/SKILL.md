---
name: best-practice-check
description: >
  Assess whether current implementation follows known patterns and best practices.
  Researches established approaches via exa before forming opinions. Reports on
  pattern conformance, drift from best practices, and maintainability/scalability
  assessment. Read-only — no code changes.
  Use when user asks "are we following a known pattern", "best practices check",
  "how maintainable is this", "are we drifting", "pattern check", "sanity check".
  Do not use for code review or when the user wants code changes made.
version: 2.0.0
---

# /best-practice-check — Known Pattern Conformance Assessment

## What This Skill Does

Assesses whether the current implementation (or a specified scope) follows established, known patterns for the problem it's solving. Researches real-world approaches before forming opinions — does not rely on training data alone.

**Output:** Structured assessment with pattern identification, conformance analysis, drift report, and maintainability/scalability rating.
**NOT output:** Code changes, refactoring suggestions with implementation, or design documents. This is a diagnostic, not a prescription.

## Prerequisites

- Code to assess — either the current working directory, a specific file/module, or a described subsystem
- If no scope is clear, ask: "Which part of the system should I assess?"

## When to Use

- Mid-build sanity check: "Are we building this the right way?"
- Before committing to an architectural approach
- When something feels off but the issue is unclear
- Periodic health checks on a subsystem

## When NOT to Use

- Code review (bugs, edge cases, correctness) → use a dedicated code review workflow
- When the user wants fixes applied → just fix it directly

---

## Process

### Step 1: Identify What's Being Built

Read the code in scope and determine:
1. **The problem being solved** — what is this code trying to do? (e.g., "ETL pipeline with incremental loads", "real-time event streaming", "REST API with auth middleware")
2. **The approach taken** — what pattern is the code using? (e.g., "medallion architecture", "event sourcing", "repository pattern")
3. **The technology context** — language, runtime, frameworks, constraints

Write a 2-3 sentence summary. Confirm with the user if the scope is ambiguous.

### Step 2: Research Known Patterns

**This step is mandatory. Do not skip it.** Claude's training data is not sufficient — research what the industry actually does for this class of problem.

Use the **research chain** — work top to bottom, but **Exa is always mandatory** regardless of what earlier steps return:

1. **context7** (if libraries/frameworks are involved) — `mcp__plugin_context7_context7__resolve-library-id` then `mcp__plugin_context7_context7__query-docs` to get current official docs for any library, framework, or SDK. Training data goes stale; context7 does not. If context7 fails (rate limit, empty result), record the failure in your output notes AND proceed immediately to the next step.
2. **deepwiki** (if specific GitHub repos are involved) — `mcp__deepwiki__read_wiki_structure` then `mcp__deepwiki__read_wiki_contents` or `mcp__deepwiki__ask_question` for architecture docs of specific open-source projects. If deepwiki fails (rate limit, timeout), record the failure in your output notes AND proceed immediately to the next step.
3. **Exa (mandatory — always run this step)** — `mcp__exa__web_search_exa` with queries like:
   - "[problem domain] architecture patterns"
   - "[specific approach] best practices [language/runtime]"
   - "[problem domain] production [language] open source"
4. **Exa code context** — `mcp__exa__get_code_context_exa` to find how real projects solve this
5. **Exa advanced** — `mcp__exa__web_search_advanced_exa` when you need filtered results (e.g., domain-specific sources, date ranges, excluding certain sites)
6. **WebSearch fallback** — if exa returns insufficient results

**Fallback discipline:** Steps 1-2 are preferred but may fail due to rate limits or missing coverage. Steps 3-5 (Exa) are the mandatory floor — they must always run. If steps 1-2 both fail, Exa alone must produce sufficient research. Never fall back to training data as a primary source. If all external research fails, stop and tell the user rather than producing an assessment based on training data alone.

**Recency matters.** Prefer sources from the last 1-2 years. Use date filtering (exa advanced) when available. If a pattern appears only in older sources (3+ years), verify it hasn't been superseded — search for "[pattern name] alternatives" or "[pattern name] deprecated". Ecosystems evolve fast; a best practice from a few years ago may be an anti-pattern today.

**Source credibility is mandatory.** Not all search results are equal. Classify every source before using it:

| Tier | Source Type | Examples | Can cite alone? |
|------|-----------|---------|----------------|
| **T1** — Authoritative | Official docs, RFCs, specs, framework authors, language core teams | docs.python.org, react.dev, PEPs, RFCs, CNCF whitepapers | Yes |
| **T2** — Practitioner | Engineering blogs from known orgs, maintainer posts, peer-reviewed content, conference talks | Netflix/Stripe/Uber/Airbnb tech blogs, project maintainer blogs, StrangeLoop/QCon talks | Yes |
| **T3** — Community | Content with quality signals but no institutional backing | Well-starred GitHub repos (1k+), highly-voted SO answers, established community guides | Only if corroborated by T1 or T2 |
| **T4** — Unvetted | SEO content, undated posts, anonymous authors, content farms, generic tutorials | Random Medium/Dev.to posts, sites with no author attribution, AI-generated content | Never cite alone — discard unless corroborated by 2+ higher-tier sources |

**Credibility rules:**
1. **Corroboration required.** Every pattern claim must be supported by **at least 2 independent sources**, with at least one being T1 or T2. A single blog post — no matter how well-written — cannot drive an assessment.
2. **Domain-first search.** When using `mcp__exa__web_search_advanced_exa`, start with `includeDomains` targeting known-good sources (official docs, major engineering blogs) before broadening to the open web.
3. **Flag suspect content.** If a source lacks author attribution, has generic/boilerplate prose, or comes from an unfamiliar domain with no track record — treat it as T4 regardless of how relevant its content appears. LLM-generated content farms are widespread; don't let them pollute the assessment.
4. **Disclose tiers in notes.** When recording a source, tag it with its tier (e.g., "React docs (T1)", "Uber eng blog (T2)"). This makes credibility visible during assessment and in the final output.

For each pattern found, note:
- Pattern name (if it has one)
- Where it's commonly used (which projects, what scale)
- Key characteristics and constraints
- Known failure modes
- **Source tier** (T1/T2/T3 — T4 sources should not appear in notes)

Gather **at least 2-3 established patterns** for the problem domain before proceeding. At least one pattern must be backed by a T1 source.

<!-- GATE: research-complete — At least 2 patterns researched via exa, each backed by 2+ sources with at least one T1/T2, before assessment -->

### Step 3: Assess Conformance

Compare the implementation against discovered patterns across three lenses:

#### Lens 1: Pattern Conformance
- Which known pattern does this most closely follow?
- Where does it conform faithfully?
- Where does it deviate — and is the deviation intentional/justified or accidental drift?
- Is the chosen pattern appropriate for the scale and constraints?

#### Lens 2: Best Practice Drift
- What best practices exist for this pattern that the implementation doesn't follow?
- Are there anti-patterns present?
- Is the drift cosmetic (naming, structure) or structural (missing error handling, incorrect lifecycle)?

#### Lens 3: Maintainability, Scalability, Repeatability
- **Maintainability:** Can someone unfamiliar with this code understand and modify it? Are boundaries clear?
- **Scalability:** What breaks first as load/complexity grows? Is the current approach appropriate for the expected scale?
- **Repeatability:** Could this pattern be applied to a similar problem elsewhere? Is it generic enough, or too coupled?

### Step 4: Present Assessment

Use this format:

```
---
**Pattern Check: [subsystem/scope name]**

**What's being built:** [2-3 sentence summary from Step 1]

**Closest known pattern:** [pattern name or description]
Sources:
- [URL or title] (T1/T2/T3)
- [URL or title] (T1/T2/T3)

**Conformance:**
- [area]: CONFORMING — [brief note]
- [area]: CONFORMING — [brief note]
- [area]: DRIFTING — [what differs and why it matters]
- [area]: NOVEL — [no known pattern match; this is custom]

**Best Practice Drift:**
[If drifts found:]
- [drift]: Severity [LOW/MEDIUM/HIGH] — [what the best practice is vs what the code does]
[If none:]
- No significant drift from established practices.

**Maintainability:** [GOOD/FAIR/POOR] — [1-2 sentences]
**Scalability:** [GOOD/FAIR/POOR] — [1-2 sentences, what breaks first]
**Repeatability:** [GOOD/FAIR/POOR] — [1-2 sentences]

**Bottom line:** [1-2 sentences — is this on the right track?]
---
```

<!-- GATE: assessment-presented — Structured assessment shown before any follow-up -->

**STOP here.** Do not suggest code changes. If the user wants fixes, they will ask — that's a separate task.

---

## Anti-Patterns (Do Not Do These)

- **Opining without research.** Do not assess pattern conformance from training data alone. The research step exists because patterns evolve and Claude's knowledge has a cutoff.
- **Citing unvetted sources.** A search result is not a credible source. Every cited source must be tier-classified and meet the corroboration rules. If you can't find T1/T2 sources for a claim, the claim is not well-established enough to assert.
- **Suggesting code changes.** This is a diagnostic skill. "Here's what's wrong and here's the fix" belongs in a different workflow.
- **Vague assessments.** "This looks fine" or "could be improved" without specifics. Every conformance/drift claim must reference a specific pattern or practice found in research.
- **Comparing to ideal rather than practical.** The question is "does this follow known patterns for this scale" — not "could this be a FAANG-scale system."
- **Inventing pattern names.** If no established pattern matches, say NOVEL. Don't fabricate a pattern name to sound authoritative.

---

## Rationalization Resistance

| Excuse | Counter |
|--------|---------|
| "I already know the patterns for this" | Training data has a cutoff. Research confirms current best practice, not 2-year-old assumptions. |
| "The code is too small to have a pattern" | Even 50 lines follow or break patterns. Small code drifts compound into large architectural debt. |
| "No one builds exactly this" | Find the closest analog. Every problem domain has well-studied precedents — message passing, data pipelines, API design, state management. |
| "Everything is CONFORMING, nothing to report" | Unlikely. If every assessment is clean, the research was too shallow or the lenses weren't applied critically. |
| "I'll just mention a few improvements" | This is not a code review. Resist the urge to prescribe. Diagnose only. |
| "The user wants to know if it's good, so I'll say it's good" | The user wants an honest assessment, not reassurance. Report drift even if the overall picture is positive. |
| "This source looks good enough" | Classify it. If you can't identify the author, org, or why this source is credible, it's T4. Don't cite it alone. |
| "I only found one good source" | Then the pattern isn't well-established enough to assert confidently. Say so — "limited evidence" is honest; a single-source claim is not. |
| "The Medium post explains it better than the docs" | Readability ≠ credibility. Cite the docs (T1), then optionally note the blog as supplementary (T3/T4). The assessment must stand on authoritative sources. |

---

## Context Discipline

**Read:** Code in scope, CLAUDE.md (for project constraints and conventions)
**Research:** context7 + deepwiki (preferred), Exa (mandatory), WebSearch (fallback)
**Write:** Nothing — assessment is presented in conversation only
**Do NOT:** Make code changes, write files, suggest refactoring implementations, or fall back to training data when research tools fail
