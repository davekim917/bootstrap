---
name: test-audit
description: >
  Authoring gate for new or changed tests, plus an evidence-first audit workflow
  for low-value, implementation-coupled, duplicative, or uncontained tests. Load
  it whenever you write, change, review, or sweep tests, in any stack
  (TypeScript/vitest, Bun, Python/pytest, dbt and others), and before deleting,
  consolidating, skipping, or loosening any existing test.
---

# Test audit

Three modes share one value bar.

- **Authoring:** gate every new or changed test when you write it.
- **Audit:** a focused sweep of one bounded scope for tests that re-assert
  source, duplicate stronger proof, couple to implementation, never fail, or
  escape their sandbox.
- **Campaign:** classify every test a subsystem owns, landed as a series of
  bounded PRs. Read [references/campaign.md](references/campaign.md) first.

The goal is confidence and completeness: every test in scope classified with
evidence. Deletion count is not a goal, and no mode has a percentage target.
Test count and test-to-source ratio are screening signals only. Code with
migrations, permissions, persistence, several runtimes, or recovery paths
earns a lot of tests. Waste needs stronger evidence: tests that detect the
same faults, coupling to implementation, fixture cost out of proportion to
the risk, or assertions that cannot fail. Coverage shows what executed, not
what an assertion would catch.

For stack-specific syntax (fixtures, parametrized cases, skip markers,
snapshots, data tests), read [references/stacks.md](references/stacks.md). If
the stack or syntax is not covered there and you cannot read a test's
assertions and fixtures with confidence, classify it **unknown**. Unknown
never means safe to delete, and it never counts as proof of coverage.

## Authoring gate

Before adding or changing a test, answer four questions. If any answer is
missing, don't add the test yet.

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why doesn't existing coverage already catch that failure? Each contract has
   one primary test at the cheapest boundary that proves it. A second layer
   needs its own distinct risk, such as an integration, transport, or
   lifecycle failure the primary test cannot reach. Prefer adding a row to a
   table-driven case or reusing a shared fixture over writing a near-duplicate,
   and consolidate duplicated setup in the same change.
4. Does it need a seam in production code? Seams that make a test safer or
   deterministic are fine: a controlled clock, an injected dependency, a fake
   network at the transport boundary, a configurable filesystem root. Reject a
   seam that exists only to reach private state, or that keeps alive a code
   path no production caller uses. In that case, move the test to the real
   boundary.

Then check the test against every [junk pattern](#junk-patterns). A match
fails the gate unless the [retention bar](#retention-bar) names the contract
the test independently guards. A test that breaks under a behavior-preserving
refactor is probably asserting implementation. Rewrite it at the owning
boundary, unless it guards an independent contract such as a wire format,
public name, or generated artifact.

**Existing tests are not yours to weaken.** Never delete or loosen an existing
test's assertions, cases, parameter rows, fixtures, snapshots, or thresholds
just to make a change pass. If an existing test fails, either your change
broke a contract (fix the code) or the contract changed on purpose. In that
case, say so, update the test in the same change, and give the reason. A new
skip or todo marker needs a reason and a tracked follow-up. A focus marker
(`.only` and its equivalents) never lands.

**A regression test must fail on the pre-fix code** for the intended reason,
then pass after the fix at the owning boundary. Show that failure: run the
test against the pre-fix code and record the command and the failing output. A
regression test that never demonstrably failed proves the mock, not the fix.
One regression at the owning boundary covers the bug. Don't replay the same
scenario at every layer it crosses.

## Junk patterns

Both modes share this checklist. The authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- each implementation replaying the tests of a helper they all share;
- tests whose only purpose is keeping test-only exports, globals, or wrappers alive;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing
  in for different APIs;
- fixtures that supply the receipt, admission, or callback ordering the owner
  should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or acknowledgement the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "clears the cache" test asserting the cache was *not* cleared.

## Value bar

A test justifies its maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change under a behavior-preserving refactor is suspect, but not
automatically deletable.

Before judging a candidate, read the complete test and its production owner.
Also read the owner's entry point, callers, callees, and sibling
implementations, plus overlapping tests, how CI routes the test, and the
relevant history, including any incident the test was written for. Read the
repository's agent and contributor instructions first. When a test claims
behavior that comes from a dependency, read the dependency's source or types.

## Discovery

Keep discovery read-only, and report evidence before editing anything. For a
broad scope, split the work along production owner boundaries. Parallel
read-only reviewers help when they are available.

Hunt in this order:

1. **Containment.** Find tests with uncontained external side effects: real
   network calls, writes outside a disposable directory, inherited credentials
   or environment, writable production mounts, or child processes that inherit
   the parent's environment. See [Containment](#containment-before-pruning).
2. Vacuous assertions and expectations the code under test produced itself.
3. Obsolete tests for removed behavior.
4. Duplication, then coupling to source text.

Outside campaign mode, a few high-confidence candidates beat a large
speculative inventory.

## Containment before pruning

A real git repository, database, or filesystem in an integration test can be
essential. Keep such a test if it guards a contract, but make it contained:

- disposable temporary directories and databases, removed afterwards;
- a scrubbed environment: no inherited credentials, cloud profiles, or
  tool-location variables such as `GIT_DIR` or `GIT_WORK_TREE`, and no home
  directory configuration;
- no writable production mounts and no real credentials;
- no network unless it is faked at the transport boundary.

An in-process filesystem wrapper does not contain a child process. Setting
`cwd` on a subprocess doesn't stop it from inheriting the environment. An
allowlist that lets a call through also hides it, so a lower escape count is
not evidence of containment. Record which tests you reviewed for containment
and each exception with its reason. An exception is acceptable only when the
side effect is the point of the test, the test runs in an opt-in lane rather
than the default suite, and it reaches no production data or credentials.

Contain first, prune second. Pruning an uncontained suite risks deleting the
test that would have exposed the escape.

## Retention bar

Keep a test when it independently enforces a public API, extension or plugin
API, protocol, config, migration, storage, security, platform, default,
exact-output, generated cross-language, package, release, or architecture
contract. Also keep:

- call ordering when the order is observable behavior;
- regressions with a credible failure mode, especially ones tied to a
  production incident;
- source inspection when it is the cheapest independent guard, for example a
  check that fixture paths stay inside a sandbox root. It fails when the
  contract changes (the user-facing key, byte, or path) and survives a rename
  of internal identifiers;
- a kept test that fails on the baseline. Treat it as a possible product bug,
  reproduce it, and repair the owner rather than deleting the test.

Being static or slow is not a reason to delete. A test that resembles the
implementation may still be the only independent guard of a contract. Prove
otherwise before removing it.

## Candidate evidence

Record every field below before editing. A candidate with a missing field is
not ready for deletion or consolidation.

- exact test name and location, including the parameter row if rows differ;
- the failure it can actually detect;
- non-test callers of the production or support seam it covers;
- the stronger proof that remains at the owning boundary (the **keeper**), or
  why no proof is needed;
- the representative fault the keeper catches: the fault, the command, and
  the red result (see [Preservation](#preservation)). If the test guards no
  contract, there is no keeper; record why instead;
- relevant history and the reason the test or seam exists;
- the production or test-support code its removal unlocks;
- risk, and the focused validation command.

## Preservation

- **The keeper must catch a representative fault before its duplicate goes.**
  Make one deliberate fault in the production owner that the deleted test
  would have caught, confirm the keeper fails, then restore the source byte
  for byte and confirm with a diff.
- Have an independent reviewer compare the deleted coverage against the
  keepers. They look for contracts that lost their only proof, and for new
  assertions that cannot fail, such as a rejection row the production code
  never reaches.
- **Never lower a coverage floor.** Don't lower an existing coverage threshold,
  per-path floor, or its tolerance, and don't replace a per-path floor with an
  aggregate allowance.
- If a deletion touches a shared harness or retires a whole test layer, run
  the full suite before merge, not only the suites a PR run selects.
- Name the operational risks that are still untested after the change.

## Edit shape

Choose one coherent batch at one owner boundary per PR. Delete obsolete
test-only exports, globals, wrappers, and dead production paths instead of
keeping aliases, but keep the seams that make tests safe. Move kept
regressions to their canonical owners. Fold repeated package or dependency
assertions into one generic contract.

Prefer removing production code to adding it, except for safety seams. Don't
add replacement tests that restate the same implementation. Don't turn
uncertain candidates into deletions to raise a count; they stay unknown.

## Validation

1. Don't edit sources or tests while a test watcher is running in the checkout.
2. Run the smallest owner and sibling tests on the final head.
3. For a removed source-inspection or plan assertion, run the executable
   script or dry run that owns the real contract.
4. Run the formatter and linter on the touched files, then `git diff --check`.
5. Run the changed-file gate the repository requires, and the full suite when
   [Preservation](#preservation) calls for it.
6. Check diff stats, and report production and tooling lines separately from
   tests and test support.
7. Keep heavy coverage and mutation runs off shared or production hosts, and
   throttle local runs.
8. Get an independent review of the final diff.

## Landing and continuation

Commit, push, open a PR, or merge only when authorized. Land one coherent PR at
a time. After it lands, refresh from the main branch and rerun read-only
discovery for the next batch. A decision made against an older main is not
carried forward. When a file you classified has changed, classify it again.

Having this skill available doesn't authorize installing CI gates, deleting
tests in a repository you don't own, or touching production data. Those need
the repository owner's approval.

## Handoff

Report:

- classification completeness: declarations classified out of the total in
  scope, with unknowns listed;
- containment status and the exceptions you accepted;
- the root cause and the low-value categories you removed;
- simplifications to production owners;
- false positives you kept, and why they are still valuable;
- the representative faults and their red results;
- the focused and full proof you actually ran;
- production lines versus test lines;
- PR and merge state;
- named follow-ups.

---

Adapted from the `test-audit` skill in OpenClaw, © 2026 OpenClaw Foundation,
under the MIT License. See [NOTICE.md](../../NOTICE.md) for provenance and
changes, and [LICENSE-OPENCLAW](../../LICENSE-OPENCLAW) for the license text.
