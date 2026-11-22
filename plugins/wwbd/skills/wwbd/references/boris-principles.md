# Boris Cherny — Sourced Principles

Sources: his own X posts, blog and recorded interviews, the Claude Code team's docs, and
Anthropic engineering posts. Team and Anthropic positions are marked as such: they are
not his words. His
bylined April 2025 best-practices post (anthropic.com/research/claude-code-best-practices)
has been marked no longer maintained since 2026-01-26; the docs page that replaced it
(code.claude.com/docs/en/best-practices) is unbylined and was rewritten after
2026-08-31. Researched 2026-11-22. Cite these when channeling him — don't invent
positions, and don't attribute a team position to him.

## Simplicity

1. **Define the problem, then a clear and simple approach.** "Most often, the failure
   mode I see is (3) failure to clearly define the problem, and (4) failure to define an
   approach that is clear and simple. When one of these is missing, it leads to complex
   plans and unclear success criteria." *(His blog, 2026-09-19,
   borischerny.com/management,/product/2026/09/19/I-am-often-wrong.html)*
2. **Simple mechanisms beat sophisticated infrastructure.** Claude Code's file search
   is plain search driven by the model; the team tried local vector databases and
   model-based indexing and dropped them, citing stale indexes and permission
   complexity. *(Pragmatic Engineer, "Building Claude Code with Boris
   Cherny", 2026-03-04, https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny
   — the interviewer's summary of his account)*
3. **Finish migrations you start.** "always make sure that when you start a migration,
   you finish the migration." *(Pragmatic Engineer, 2026-03-04, quoted by the
   interviewer)*

## Quality bar

4. **The bar scales with blast radius.** "Prototypes and other throw-away code can be
   treated as totally black box. If you're going to throw it away anyway, and if the
   blast radius of it breaking is low, it doesn't need to be perfect." / "Production
   code written by Claude should have a higher bar than if it was written by a human."
   / "Your job is to hold the bar on code quality." *(Boris Cherny on X, 2026-09-11)*
5. **Give the agent a way to verify its work.** "probably the most important thing to
   get great results out of Claude Code -- give Claude a way to verify its work. If
   Claude has that feedback loop, it will 2-3x the quality of the final result." *(Boris Cherny on X, 2026-01-02)*
6. **Don't fix every review finding.** "A reviewer that's asked to find problems will
   always find *something*. If you fix every finding, you end up with extra abstraction
   layers and tests for cases that can't happen." *(team — Claude Code docs, best
   practices, https://code.claude.com/docs/en/best-practices)*

## Directing the model

7. **For most tasks, say the goal, the effort and the check rather than the steps.** "There's no need to be
   overly scaffolded or prescriptive for most tasks -- give Claude a goal, and it will
   figure it out. … communicate to the model: 1. What you want it to do 2. How much
   effort you want it to spend 3. How it should verify that it did the right thing"
   *(Boris Cherny on X, 2026-10-06)*
8. **Scaffolding goes stale as models improve.** "Every time that a new model comes
   out, we delete a bunch of the system prompt … So yeah, we deleted 80% of the system
   prompt." *(YC Startup School, July 2026,
   https://www.youtube.com/watch?v=qyPCVqFUyDo)* Also, as
   quoted by Y Combinator on X from the Lightcone podcast (secondhand, 2026-02-25): "At
   Anthropic, we don't build for the model of today, we build for the model of six
   months from now." An Anthropic engineering post puts it this way: "every component in a harness encodes an assumption about what the model
   can't do on its own". *(Anthropic, not his — Prithvi Rajasekaran, "Harness design for long-running
   application development", 2026-03-24,
   https://www.anthropic.com/engineering/harness-design-long-running-apps)*
9. **His team records what Claude gets wrong in a shared, checked-in CLAUDE.md.** "Anytime we
   see Claude do something incorrectly we add it to the CLAUDE.md, so Claude knows not
   to do it next time." *(Boris Cherny on X, 2026-01-02 — his team's practice)*
10. **Leave out what the agent would find and look for on its own; enforce only what
    can't bend.**
    "Could it find this by reading the code? Would it actually go and look? If both are
    yes, leave it out." / "if you have hooks for things that are only preferences,
    delete them and let Claude decide." *(team — Claude Code docs, best practices,
    https://code.claude.com/docs/en/best-practices)*
11. **When it goes sideways, re-plan rather than push; after a mediocre fix, scrap it.**
    "the moment something goes sideways, they switch back to plan mode and re-plan.
    Don't keep pushing." / "After a mediocre fix, say: 'Knowing everything you know
    now, scrap this and implement the elegant solution'" *(Boris Cherny on X,
    2026-01-31, tips he shared from the Claude Code team)*
