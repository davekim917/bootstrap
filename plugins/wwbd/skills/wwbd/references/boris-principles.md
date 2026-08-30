# Boris Cherny — Sourced Principles for Directing an AI Agent

Distilled from primary sources: the Anthropic engineering doc he authored and his team
maintains ("Claude Code: Best practices for agentic coding", code.claude.com/docs/en/best-practices),
his publicly shared personal CLAUDE.md, his X/Twitter threads on his own workflow, and
the Pragmatic Engineer interview ("Building Claude Code with Boris Cherny").
Researched 2026-08-30. Cite these when channeling him — don't invent positions.

## Planning & scoping

1. **Explore → Plan → Implement → Commit, in that order.** Separate research/planning
   from coding so the agent doesn't solve the wrong problem — default to plan mode for
   anything non-trivial. *(Anthropic best-practices doc)*
2. **Skip planning when you could describe the diff in one sentence.** Plan mode has
   overhead; it pays off when scope is uncertain, the change spans multiple files, or
   the code is unfamiliar — not for a typo fix or a log line. *(Anthropic best-practices doc)*
3. **For ambiguous or large features, have the agent interview you and write a spec
   before any code**, then start a fresh session to implement it. A precise spec
   written up front beats watching implementation happen. *(Anthropic best-practices doc)*
4. **Finish migrations you start — never leave a codebase half-converted.** A
   mixed-pattern codebase confuses the model exactly as much as a human reader.
   *(Pragmatic Engineer interview)*

## Verification loops

5. **Give the agent something that returns pass/fail** — a test, a build, a screenshot
   diff. He calls this "probably the most important thing" for quality; without a
   check, "looks done" is the only signal and the human becomes the verification loop.
   *(Anthropic best-practices doc; his X "13 tips" thread)*
6. **Show evidence (test output, command + result, screenshot) rather than asserting
   success.** Reviewing evidence is faster than re-verifying, and it's the only option
   for unattended runs. *(Anthropic best-practices doc)*
7. **Add an adversarial review step: a fresh-context subagent grades the diff against
   the plan/criteria, not its own reasoning.** Tell it to flag only correctness and
   requirement gaps — a reviewer told to find gaps will always find some, and chasing
   all of them causes over-engineering. *(Anthropic best-practices doc)*
8. **Writer/Reviewer across two separate sessions** — one implements, a fresh second
   session reviews for edge cases and consistency — rather than trusting the
   implementing session to self-grade. *(Anthropic best-practices doc)*
9. **Address root causes, not symptoms** — describe the failing behavior and
   explicitly instruct "fix it, don't suppress the error." *(Anthropic best-practices
   doc; his personal CLAUDE.md)*

## Prompting

10. **Be specific: name the file, the test cases, the constraint, or an existing
    pattern to follow.** "Add tests for foo.py" → "test the edge case where the user
    is logged out; avoid mocks." *(Anthropic best-practices doc)*
11. **Vague, open-ended prompts are fine specifically when exploring** and you can
    afford to course-correct — they surface things you wouldn't think to ask.
    *(Anthropic best-practices doc)*

## Course-correction & context management

12. **Interrupt and redirect the moment the agent drifts** — don't let it run further
    off track; stop with context preserved and rewind if needed. *(Anthropic
    best-practices doc)*
13. **After two failed corrections on the same issue, stop correcting** — clear and
    write a better initial prompt instead. A clean session with a sharper prompt
    reliably beats a long session cluttered with failed attempts. *(Anthropic
    best-practices doc)*
14. **Scope investigations narrowly, or delegate them to a subagent** — an unscoped
    "investigate X" burns the main context reading hundreds of files. *(Anthropic
    best-practices doc)*
15. **The "kitchen sink session" is a top failure mode** — unrelated tasks piling into
    one context. Clear between unrelated tasks. *(Anthropic best-practices doc)*

## CLAUDE.md

16. **One CLAUDE.md checked into git, shared by the whole team, updated multiple times
    a week.** *(His X "13 tips" thread; Pragmatic Engineer interview)*
17. **Prune ruthlessly: for every line ask "would removing this cause a mistake?"** A
    bloated CLAUDE.md causes the agent to ignore the instructions that matter; if a
    rule is ignored, the file is usually too long, not the rule too weak. *(Anthropic
    best-practices doc)*
18. **When the agent makes the same mistake twice, add it to CLAUDE.md — or better, a
    hook — instead of re-correcting every session.** *(His X "13 tips" thread; his
    personal CLAUDE.md "self-improvement loop")*
19. **Hooks for anything that must happen with zero exceptions** (e.g., auto-format on
    write). CLAUDE.md is advisory; hooks are deterministic. *(Anthropic best-practices
    doc; his X "13 tips" thread)*

## Subagents & parallelism

20. **Delegate research/exploration to subagents** to keep it out of the main context —
    they run in a separate window and report back a summary. *(Anthropic
    best-practices doc; his personal CLAUDE.md — "one task per subagent")*
21. **Run multiple sessions in parallel (git worktrees) rather than one at a time.**
    He personally runs ~5 in terminal tabs plus more on the web, moving work between
    them. *(His X threads on his personal setup)*

## Permissions & tooling

22. **Pre-approve trusted commands via permission allowlists instead of skipping
    permissions wholesale.** Cuts prompt fatigue without giving up control. *(His X
    "13 tips" thread; Anthropic best-practices doc)*
23. **Point the agent at CLI tools (`gh`, cloud CLIs) for external services rather
    than raw APIs** — more context-efficient and avoids unauthenticated rate limits.
    *(Anthropic best-practices doc)*

## Simplicity bias

24. **Prefer simple mechanisms over sophisticated infrastructure.** Claude Code's own
    file search is model-driven grep/glob, which beat RAG/vector-DB approaches on
    reliability. *(Pragmatic Engineer interview)*
25. **Demand elegance on substantial changes; don't over-engineer trivial fixes.** His
    own CLAUDE.md includes "knowing everything I know now, implement the elegant
    solution" as a deliberate pause-and-reconsider step, reserved for real changes.
    *(His personal CLAUDE.md — "Demand Elegance")*
