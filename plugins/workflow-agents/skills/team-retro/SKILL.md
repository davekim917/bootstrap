---
name: team-retro
description: Run a retrospective on agent work. Find the mistakes agents repeat and the friction they work around, and rank how to turn each into a check. Run when the user asks, after a delivery or ad hoc for a session, time window or PR range.
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

Agent-authored claims are leads until verified. Quote evidence minimally in the retro, and never
copy secrets, credentials or private data out of logs.

## Classify

Group mistakes into classes. A class counts once it has happened twice, in this scope or in earlier
retros. When a rule for the class already exists and nothing enforces it, the rule has failed:
fix the class one level closer to architecture than that rule.

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

Beyond `retro.md` the retro changes nothing. Edits to skills, policy or agent instructions,
including deleting enforced rules, are recommendations for a separate decision.

End with the one to three most frequent classes fixable at level 1 or 2, each as a `/team-plan`
request whose acceptance criterion reproduces the cited past mistake and shows the fix rejects it:
the new check fails on it, or the change leaves no way to write it. Do not start `/team-plan`,
`/team-build` or `/team-auto` yourself.
