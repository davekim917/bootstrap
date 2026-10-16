# Sources behind the bar

Gathered 2026-10-12. Counts and claims below are the authors' own unless marked.

## Lauren Tan (@poteto), Cursor

- **"codebases have always contained slop"** (X, 2026-10-11, ~660k views). Good code
  is correct, bug-free, and fast and cheap to run. Most software never needed it to
  be perfect; tests and observability stand in. Agents can make code better on
  average if the environment is set up for it.
- **"organic architecture"** (X, ~2026-09-01). Hard constraints in the code, and a
  stack with strong types and compiler diagnostics, matter more than AGENTS.md or
  skills. "The best rules are in your code."
- **"every time you intervene and correct your agent..."** (X, 2026-08-16). The
  ladder this skill uses: architecture or data structures, then lint or test, then
  a skill or rule, then human review ("ngmi").
- **"every team needs a gardener"** (X, ~2026-09). Watch the stream of PRs for
  smells; every weed pulled becomes a rule so it cannot grow back.
- **"everything i know about managing agents..."** (X, 2026-10-05). Constraints
  free both humans and agents; big-company problems (lint, compilers, tests,
  observability) are now everyone's.
- **Time to rewrite (TTR)** (X, ~2026-10). Heuristic for how agent-ready a codebase
  is: how long would a hands-off rewrite take, and what stops you trusting it?
- **pstack** (github.com/cursor/plugins, `pstack/`, read at commit 1b6d44f).
  24 one-rule principle skills. Most used here: minimize-reader-load,
  model-the-domain, boundary-discipline, type-system-discipline,
  make-operations-idempotent, separate-before-serializing-shared-state,
  migrate-callers-then-delete-legacy-apis, subtract-before-you-add,
  prove-it-works, test-behavior-not-implementation, encode-lessons-in-structure,
  and the `architect` design red flags (shallow module, information leakage,
  temporal decomposition, pass-through method, split ownership, two ways to do
  one task, importable internals, hand-synced list). The `correct` skill is the
  source of section 4's procedure.
- **Talk and Matt Pocock interview** (2026-09/10, via transcript and summaries at
  pjfp.com and barnabyrobson.org). Verification first, then constraints, then
  outside context, then autonomy. The human is the "meat proxy" wherever they
  carry information an agent could fetch. Split each skill into judgment and a
  script. Caveat: the 2,500 PRs a month includes much small gardening work; it is
  self-reported and the talk names no defect rate or cost.

## Others

- **OpenAI, "Harness engineering"** (Ryan Lopopolo, 2026-02-11). ~1M lines, zero
  hand-written. AGENTS.md as a ~100-line map, not an encyclopedia. Rigid layers per
  domain with mechanically validated dependency direction. Custom lints whose
  messages carry the fix. Recurring "garbage collection" agents against golden
  principles, replacing a weekly manual slop cleanup. App, logs and metrics made
  queryable by the agent.
- **Birgitta Böckeler, "Harness engineering for coding agent users"**
  (martinfowler.com, 2026-04-02). Guides (before the agent acts) and sensors
  (after), split into deterministic and judgment-based.
- **"AI-Generated Smells"** (arXiv 2605.02741; ASE 2026). Measured: code volume
  predicts architectural decay almost perfectly (rho 0.94); more detailed prompts
  had no measurable effect on quality; agents produce "modular mirage", meaning
  many files without cohesion, plus god classes. Supports structure over prose.
- **TRIM** (arXiv 2607.18161). Agent patches carry leftovers of their own search;
  17.8%–32.9% of edits were removable with tests still passing. Asking the agent to
  minimize its own patch often failed. Supports the "remove leftovers" rule and an
  independent review.
- **John Ousterhout, A Philosophy of Software Design**, via Matt Pocock's "deep
  modules for agents" and others (2026). Deep modules give agents one test
  boundary and fewer hops; agents left alone build shallow sprawl.
- **Modular monolith and Postgres-first** (several 2026 practitioner posts; no
  single primary source). The consensus is consistent, but these are opinion
  pieces, not measurements.

## Where this bar disagrees with a source

- Tan runs agents that merge their own PRs overnight. Here, merges still go through
  the repo's review gate and restarts through the user, because these systems serve
  clients daily and not every change is verifiable end to end.
- OpenAI's layered architecture has more boundaries than the deep-module advice
  suggests. The two agree on the goal, predicting where code lives without reading
  everything; enforce dependency direction mechanically either way.
