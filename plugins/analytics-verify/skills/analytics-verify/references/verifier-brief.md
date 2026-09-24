# Verifier brief

You are checking an analytics deliverable someone else wrote, before it reaches a person
who will act on it. Your job is to find what's wrong, not to confirm it.

You get the deliverable, its ledger (`claims.json`), and the original ask. Don't open the
author's notes, research files or reasoning until you have your own answer for each
claim. After that, use them only to explain a disagreement.

## Steps

1. **List the claims from the deliverable alone.** Include every number, and also names,
   dates, rankings, "has / doesn't have", who owns or runs what, what's on a menu or a
   shelf, and the current status of people and places. Only then open the ledger. Any
   claim you listed that has no ledger entry is Unsupported.
2. **Run the mechanical checks:** `check`, plus `reproduce` when there's a table. The
   script is `scripts/check_claims.py` in the `analytics-verify` skill. A FAIL is a
   finding. A PASS only shows the claims are bound to sources, not that they're true.
3. **Re-derive the headline numbers yourself.** Write your own query from the ask and
   the table documentation, not from the author's SQL. Match the population, grain and
   cutoff, then compare. Read the author's SQL only to explain a difference. Two outputs
   of one query are not two checks.
4. **Re-check web facts live, today.** Check the exact business and location, the date
   of the evidence itself, and current status: still open, same owner, same chef, same
   menu, same price. Check whether the source is official or just press. Quote what you
   found.
5. **Check the wording around the numbers:**
   - unit and grain words
   - arithmetic between stated numbers
   - cutoffs and partial periods
   - dropped rows or segments
   - claims the source only half-supports ("50+ mojitos & drinks" shown as "50+ mojitos")
   - absence claims and descriptions nobody sourced
6. **For SQL, also check:** join fan-out, distinct entity counts, denominators that shift
   between groups, partial periods, the cutoff's timezone, nulls versus zeros, and gaps
   in source coverage by period.

## Report

Write `verify-r<N>.md` next to the deliverable. Don't edit the deliverable or the ledger.

```
artifact-sha256: <check_claims.py hash <deliverable>; one line per file>
ledger-sha256: <check_claims.py hash claims.json>
verifier: <your actual model and how you ran, e.g. "gpt-6-sol, fresh codex exec session">
verdict: CLEAR | CHANGES

## Wrong
| Where | Deliverable says | Actually | Evidence |

## Stale or overstated
## Unsupported (no ledger claim, or the source doesn't establish it)
## Confirmed
## Not checked, and why
```

- `verdict: CLEAR` only when Wrong and Unsupported are both empty.
- In `verifier:`, name the model you're actually running on. Write "unknown" if you can't
  tell. If you were meant to be a different model family from the author and you're not,
  say so.

## Re-check rounds

You get the output of `check_claims.py changed`.

1. Confirm each earlier finding's fix landed.
2. Check every `+` line, every changed claim and every claim derived from one, using
   steps 3–5.
3. Run `check` on the whole final file and read it once end to end. A fix can make a
   sentence it didn't touch false.
4. Write a new report with the new hashes.
