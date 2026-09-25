# Test campaign

A campaign classifies every test one subsystem owns, such as one package, one
plugin, or one core area. It lands as a series of bounded PRs, not one large
one. The value bar, retention bar, candidate evidence, preservation, and
validation rules in [SKILL.md](../SKILL.md) apply to every step. This file
adds the order of work. Each step ends on its completion criterion. Don't
start the next step early.

A campaign closes on **completeness and containment**: every declaration
classified with evidence, and no uncontained external side effects. An
accepted containment exception (step 3) is bounded, so it doesn't block
closure. There is no deletion or line-count target. Set a CI-time target
only after profiling a pilot.

## 1. Baseline

At a pinned main-branch commit, record for the subsystem:

- test and test-support line counts, with production counted separately;
- each test file's pass or fail result;
- comparable CI duration for the subsystem's suites;
- the coverage numbers and every coverage floor that applies.

Keep baseline failures in their own list. A kept test that fails on the
baseline may be a real product bug, not a stale test.

Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
name prefixes. For a messaging adapter, the lanes might be accounts, inbound,
outbound, persistence, transport, shared helpers, and the test harness.
Include the subsystem's cases at shared core boundaries, and its end-to-end
or live-proof harness tests.

Lanes are a unit of review, not of staffing. One reviewer can take several
lanes, and one lane can go to parallel reviewers. What matters is that every
lane gets a full read.

Done when every test file and scenario the subsystem owns belongs to exactly
one lane, and the inventory is complete. A truncated listing from a tool is
not an inventory. Rerun the listing in smaller pieces until nothing is cut
off.

## 3. Containment pass

Before classifying for value, find every test in scope with an external side
effect: real network, writes outside a disposable directory, inherited
credentials or environment, writable production mounts, or child processes
that inherit the parent's environment. Contain each one (see "Containment
before pruning" in SKILL.md), or record it as an accepted exception. An
exception is acceptable only when the side effect is the point of the test
(a live-proof check against a real service, say), the test runs only in an
opt-in lane rather than the default suite, and it reaches no production data
or credentials. Record the reason and the lane. Land containment fixes as
their own bounded PRs, ahead of any pruning in that lane.

Done when every test in scope has a reviewed containment status. A lower
escape count doesn't count: an allowlist can hide an escape without
containing it.

## 4. Read-only ledger per lane

A read-only reviewer reads every test in the lane in full, including
parameter tables, fixtures, and shared setup. They also read the production
owners with their entry points, callers, history, and CI routing. Each test
declaration goes into a written **ledger** with one mark. A parameterized
declaration gets one mark unless its rows need different marks. In that
case, mark each row.

- `R`, retain: name the contract and the bug it catches. A test that only
  moves to a better-named file stays `R`, with the move noted.
- `F`, fix: keep the contract but repair the assertion, such as a negative
  check that passes when only one of several items is missing.
- `C`, consolidate: name the keeper that absorbs the assertion first, whether
  a sibling table case, a stronger boundary suite, or a shared owner.
- `D`, delete: name the proof that remains, or explain why no contract exists.
- `U`, unknown: the stack, syntax, or evidence is not enough to judge. An
  unknown is never deleted and never counted as coverage.

Judge a test by its assertions, not its name. A test named for clearing a
cache can assert that the cache was *not* cleared.

Done when every declaration in the lane has a mark and an evidence line.

## 5. Layer plan per lane

Treat the ledger as input, not as the edit list. A second read-only pass
starts from the ledger and looks for a redundant **layer**: for example,
several suites replaying one shared helper through the same mock around a
stronger suite at the real transport. Name the **keeper** for each contract.
Prefer the cheapest boundary that proves the contract, such as a real
transport with a fake network over a mocked collaborator, and keep a
separate integration test only for a distinct risk. Correct any ledger
errors this pass finds.

Done when each lane plan names its retired files, its keeper for each
contract, the assertions to carry into keepers, and the production seams it
unlocks. Seams that make tests safe stay.

## 6. Bounded cutover

Land one lane, or one coherent part of a lane, per PR. For each PR:

- before deleting a `C` test, or a `D` test whose mark cites remaining proof,
  run the representative-fault check from SKILL.md "Preservation" against its
  keeper and record the red result. A `D` test marked as guarding no contract
  (an assertion-free probe, say) has no keeper to check. Its evidence is the
  written reason, and the preservation reviewer must agree with it;
- remove only the test-only production seams this PR's deletions unlock;
- register moved suites in CI routing and test inventories;
- keep every coverage floor where it is;
- run the owner and sibling tests on the final head, and the full suite if
  the PR touches a shared harness or retires a layer;
- serialize changes to shared harnesses and support files through one owner
  at a time.

Write durable test-ownership rules into the subsystem's contributor or agent
instructions, drawn from mistakes this campaign actually found.

Done when every lane plan is applied, and each lane's keepers pass on main.

## 7. Preservation review

Before claiming a lane is complete, have independent reviewers compare the
deleted coverage against the keepers, one reviewer per boundary group. They
look for contracts that lost their only proof, and for new assertions that
cannot fail, such as a rejection row the production code never reaches. They
review the complete diff. If a review tool shows a truncated file list, split
the review until each reviewer sees every file.

For each gap they find, restore the contract and repeat the
representative-fault check.

Done when every reported gap is restored or rejected with source evidence,
and every restored contract has a caught fault.

## 8. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its
owner in a separate commit, and prove it through the real user flow with a
**control** run: revert the fix and show the old behavior. Record unrelated
product discrepancies as follow-ups instead of fixing them in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 9. When main moves

A campaign outlives many main-branch commits. Keep each PR small enough to
rebase or merge cleanly. When main changes a file the campaign has
classified, the old decision lapses. Reread the file and decide again,
whether the change on main or the campaign's edit came first. A deletion is
never kept automatically. Confirm that every new test main added has a mark
and, where needed, a keeper. Rerun the lane's suites on the updated head.

## Hand off

Hand off with the report from SKILL.md, plus:

- baseline and final test and test-support line counts, with production
  counted separately, and CI duration measured the same way;
- declarations classified out of the total, with unknowns listed;
- containment status and the exceptions you accepted;
- lanes, retired layers, and keepers;
- preservation gaps found, and the faults that proved each keeper;
- product defects, with control and candidate proof.
