# Boris Cherny — Sourced Principles

Sources: his own X posts, blog and recorded interviews, and the Claude Code team's docs
and engineering posts. Team positions are marked *(team)*: they are not his words. His
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
2. **Simple mechanisms beat sophisticated infrastructure.** Claude Code's search is
   model-driven glob and grep; the team tried local vector databases and model-based
   indexing and dropped them. Interviewer's summary: "Plain glob and grep, driven by
   the model, beat everything." *(Pragmatic Engineer, "Building Claude Code with Boris
   Cherny", 2026-03-04 — summary is secondhand, the experiment is his account)*
3. **Finish migrations you start.** "always make sure that when you start a migration,
   you finish the migration." *(Pragmatic Engineer, 2026-03-04, quoted by the
   interviewer)*

## Quality bar

4. **The bar scales with blast radius.** "Prototypes and other throw-away code can be
   treated as totally black box. If you're going to throw it away anyway, and if the
   blast radius of it breaking is low, it doesn't need to be perfect." / "Production
   code written by Claude should have a higher bar than if it was written by a human."
   / "Your job is to hold the bar on code quality." *(@bcherny on X, 2026-09-11)*
5. **Give the agent a way to verify its work.** "probably the most important thing to
   get great results out of Claude Code -- give Claude a way to verify its work. If
   Claude has that feedback loop, it will 2-3x the quality of the final result." *(@bcherny on X, 2026-01-02)*
6. **Don't fix every review finding.** "A reviewer that's asked to find problems will
   always find *something*. If you fix every finding, you end up with extra abstraction
   layers and tests for cases that can't happen." *(team — Claude Code docs, best
   practices)*

## Directing the model

7. **Say the goal, the effort and the check, not the steps.** "There's no need to be
   overly scaffolded or prescriptive for most tasks -- give Claude a goal, and it will
   figure it out. … communicate to the model: 1. What you want it to do 2. How much
   effort you want it to spend 3. How it should verify that it did the right thing"
   *(@bcherny on X, 2026-10-06)*
8. **Scaffolding goes stale as models improve.** "Every time that a new model comes
   out, we delete a bunch of the system prompt … So yeah, we deleted 80% of the system
   prompt." *(YC Startup School, July 2026, speaker-labelled transcript)* The team's
   framing: "every component in a harness encodes an assumption about what the model
   can't do on its own". *(team — Anthropic, "Harness design for long-running
   application development", 2026-03-24)*
9. **Record what the agent gets wrong in a shared, checked-in CLAUDE.md.** "Anytime we
   see Claude do something incorrectly we add it to the CLAUDE.md, so Claude knows not
   to do it next time." *(@bcherny on X, 2026-01-02 — his team's practice)*
10. **Write down only what the agent can't find, and enforce only what can't bend.**
    "Could it find this by reading the code? Would it actually go and look? If both are
    yes, leave it out." / "if you have hooks for things that are only preferences,
    delete them and let Claude decide." *(team — Claude Code docs, best practices)*
11. **When it goes sideways, re-plan rather than push; after a mediocre fix, scrap it.**
    "the moment something goes sideways, they switch back to plan mode and re-plan.
    Don't keep pushing." / "After a mediocre fix, say: 'Knowing everything you know
    now, scrap this and implement the elegant solution'" *(@bcherny on X,
    2026-01-31, tips he shared from the Claude Code team)*
