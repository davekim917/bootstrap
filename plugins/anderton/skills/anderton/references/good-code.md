# The engineering bar

Every contributor to these codebases is an agent that sees only the files it opened,
copies the nearest example, and takes the shortest path that compiles. Write code so
that a change which looks right from one file is right for the whole repo.

## What good code means

In order:

1. **Correct.** It does what was asked, including the empty, duplicate, concurrent
   and crashed-halfway cases.
2. **Proven.** Something reruns and shows it works: a test of behavior, a script, a
   recorded run. Unproven code has unknown correctness, however clean it looks.
3. **Cheap to run.** No wasted queries, calls or tokens on the hot path. Measured,
   not guessed.
4. **Cheap to read.** A new reader answers "where does X come from?" and "what can
   change X?" in under 30 seconds. Reader load has two axes: layers to trace and
   state to hold. Line count and pattern names are proxies.

Code volume is the strongest predictor of decay in agent-written systems. The best
change is often a deletion.

## Writing for the next agent

- **One way to do each task.** When a second way appears, migrate the callers and
  delete the old one in the same change. Two ways means every future agent picks
  one at random, and both keep gaining callers.
- **One owner per piece of state.** Others read it or ask the owner to change it.
  Derive values instead of syncing copies.
- **One list, derived everywhere.** A list kept in sync by hand gets updated in one
  place. Derive the others, or fail the build when they disagree.
- **Model the domain in data.** A state machine, not scattered booleans. A
  discriminated union, not a bag of optional fields. A lookup table, not an if/else
  chain that grows a branch per feature. If you can write a comment explaining when
  a combination of fields is valid, make it a type.
- **Parse at the boundary, trust inside.** External input (HTTP, files, env, DB
  rows, CLI args, model output) becomes a typed value at the edge. No re-validation
  or defensive null checks deeper in.
- **Exhaustive matching.** Adding a variant must fail compilation where it is not
  handled, so the compiler tells the next agent where to look.
- **Organize by what a module knows, not when it runs.** Separate load, validate,
  transform and save modules repeat the same rules four times.
- **Errors propagate.** Catch only where you can recover. A catch that logs and
  continues turns a loud bug into a silent one.
- **Names say what, not how.** No `utils`, `helpers`, `manager` or `misc` modules.
- **Comments only for what code cannot say:** an outside system's quirk, or why the
  obvious approach was wrong. Never narration, history or ticket numbers. A stated
  constraint belongs in a type, test or lint.
- **Lint and error messages name the fix,** because the agent reads them as
  instructions at the exact moment it errs.

## Simple without over-abstracting

An abstraction must remove something: duplicated knowledge, branches, invalid
states, or lifecycle risk. Indirection that removes none of these is cost.

- **Prefer deep modules:** a small interface hiding real behavior. Shallow ones are
  many small files with wide interfaces, where callers must call several methods in
  order to do one thing.
- **Inline these on sight:** a wrapper with one caller, an interface with one
  implementation, a factory that always returns the same thing, a pass-through
  method, a config object read by one function, a `utils` file with one export, a
  constant extracted for one use.
- **Duplication versus a wrong abstraction.** Two similar blocks are fine. Extract
  when the blocks share knowledge (a rule, a protocol, an invariant) that must
  change together, not when they merely look alike.
- **No scaffolding without a consumer.** Do not build support for a feature that
  does not exist yet in the same change.
- **Smallest diff that solves it.** Remove leftovers from your own search before
  committing: abandoned edits, debug code, guards added while chasing the bug.

## A backend foundation that holds

Boring and proven beats novel. Each extra moving part needs a reason you can name.

- **Postgres is the system of record** unless a measured need says otherwise.
  Queues, schedules, idempotency keys and audit logs all fit in it
  (`FOR UPDATE SKIP LOCKED`, unique constraints, append-only tables).
- **Modular monolith first.** One deployable, modules with enforced boundaries (lint
  or structural test on imports, each module owns its tables). Split a service out
  only for a named reason: independent scaling, a different reliability profile, or
  a regulatory boundary.
- **Every operation is idempotent and resumable.** Ask: what if this runs twice?
  What if the last run died at every possible line? If the answer depends on
  leftover state, add a reconciliation step. Side effects to the outside world
  carry an idempotency key.
- **Explicit state machines for anything with a lifecycle** (jobs, orders, runs),
  with transitions recorded append-only, so "what happened" is a query.
- **Migrations go expand, migrate, contract.** Never a destructive change in the
  same deploy as the code that stops needing the column. Every migration reruns
  safely.
- **Separate before you lock.** If two actors write the same thing, first ask
  whether they need to. Give each its own row, file or key. Lock only when sharing
  is a real invariant, and enforce it structurally, never by convention.
- **Observable by agents.** Logs, metrics and traces are queryable from a CLI, so
  an agent can debug production without a human pasting screenshots.
- **Secrets never in code, env files or chat.** Inject them at the boundary.
- **Timestamps stored in UTC ISO-8601.** Rendered in the viewer's zone.

## Verification

- Each app has one scripted way to prove its behavior (run it, drive it, read the
  result) that any agent can use. Treat it as critical infrastructure.
- A test calls the code as its users do and asserts the exact result. Delete any
  test that would still pass if the function returned nothing.
- Order work as small units that each end green. A failing test first, then the
  fix.
- When a check fails, suspect the observation before the system.
- Debug to the root cause: reproduce, ask why until you reach it, fix the pattern
  everywhere it occurs. Never silence a symptom with a guard.
