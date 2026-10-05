---
name: team-retro
description: Find the mistakes agents repeat and the friction they work around, and turn each repeat into a check. Run when the user asks, after a delivery or ad hoc for a session, time window or PR range.
---

# /team-retro — Turn repeat mistakes into checks

Read `../shared/workflow-contract.md` first. Run only when the user asks.

## Scope

Take the scope the user names: a feature, a session, a time window or a range of PRs or commits.
Default to the current session. Write `docs/retros/<scope-slug>/retro.md`.

## Sources

For that scope, read:

- `plan.md` and `run.md` when present, commits, reverts and review threads;
- session logs or transcripts on this machine. Agents work around friction and still deliver, so
  failed or retried commands, unrunnable or bypassed checks and detours show up only here;
- the corrections the user gave agents;
- earlier retros and the repository's agent instructions and rules.

Agent-authored claims are leads until verified.

## Classify

Group mistakes into classes. A class counts once it has happened twice, in this scope or in earlier
retros. When a rule for the class already exists and nothing enforces it, the class is a repeat:
fix it one level higher than last time.

Report as its own finding any check that exists but is unwired, cannot run where the work happens,
or passes without checking anything.

Separate product or code failures from obstruction the workflow itself caused. Do not recommend
more process unless repetition, scale, risk or failure impact shows it pays for itself.

## Choose the highest level that works

1. **Architecture.** One owner for each piece of state, one supported way to do each task. Delete
   the old way an agent would copy.
2. **A type, lint rule or test** whose failure names the fix.
3. **Agent instructions, skills or docs**, only for judgment calls nothing can check.

For each class, give the level and why a higher one does not work. Name the rules that a check now
enforces, so they can be deleted.

## Output

`retro.md` holds the scope and the sources read; a table of classes with evidence, occurrences,
level and why not higher; unwired checks; rules to delete; and up to five learnings in the form
"Next time, do X because Y occurred".

Do not edit skills, policy or agent instructions during the retro. Those are recommendations for a
separate decision.

For the one to three most frequent classes fixable at level 1 or 2, write
`docs/specs/<class-slug>/plan.md`. Its acceptance criterion: the new check fails on the cited past
mistake and passes on the fix. End with the plans and the `/team-auto` command for each. Run
`/team-auto` only when the user's request invokes it by name: it commits, pushes and merges.
