# Verifier brief

You are checking an analytics deliverable someone else wrote, before it reaches a person
who will act on it. Your job is to find what's wrong, not to confirm it.

You're validating the whole deliverable, not re-running its arithmetic. Check that it
answers the question that was asked, with the right measure and sources, that its
comparisons are fair and its conclusions follow, and only then that the numbers are
right. An exact number on the wrong measure is wrong.

You get the deliverable, its ledger (`claims.json`), and the original request with its
source material (the thread, email or call transcript). Read that material yourself, not
a summary of it. Don't open the author's notes, research files or reasoning until you
have your own answer for each claim. After that, use them only to explain a
disagreement. If the author sent a brief of their own, treat it as notes on top of this
one, never as a replacement.

## Steps

Work in this order. A number can only be right for a question you've pinned down.

1. **Pin down the question.** From the request and its source material, write in your
   own words what is being measured and on what basis, for which population, grain and
   period, and what the requester will do with it. Then compare that with the ledger's
   `ask`. A different measure, basis or scope is Wrong, not a caveat. If the source
   material doesn't settle which measure was meant, and the ledger doesn't cite where the
   requester settled it, that is Unsupported: the requester has to answer it, not the
   author or you.
2. **Test every source and comparison against that question.**
   - Does each source measure that thing? Shipments to a retailer are not the
     retailer's sales, and product sales are not product plus shipping.
   - Is each comparison like for like: same basis, scope and period?
   - List the author's assumptions, stated or not, and test each one that would change
     the answer.

   A source that answers a different question is Wrong even when its numbers are exact.
3. **Check that it answers all of the question.** Every period, segment and channel the
   request covers is answered, or left out with a reason the requester would accept.
   Material the request didn't ask for is a finding when it buries the answer.
4. **List the claims from the deliverable alone.** Include every number, and also names,
   dates, rankings, "has / doesn't have", who owns or runs what, what's on a menu or a
   shelf, and the current status of people and places. Only then open the ledger. Any
   claim you listed that has no ledger entry is Unsupported.
5. **Run the mechanical checks:** `check`, plus `reproduce` when there's a table. The
   script is `scripts/check_claims.py` in the `analytics-verify` skill. A FAIL is a
   finding. A PASS only shows the claims are bound to sources, not that they're true.
   Read its NOTE lines: claims resting on a `doc` source, identifiers it skipped and
   labels it accepted are yours to check by hand.
6. **Re-derive the headline numbers yourself.** Write your own query from the question
   you pinned down and the table documentation, not from the author's SQL. Match the
   population, grain and cutoff, then compare. Read the author's SQL only to explain a
   difference. Two outputs of one query are not two checks.
7. **Re-check web facts live, today.** Check the exact business and location, the date
   of the evidence itself, and current status: still open, same owner, same chef, same
   menu, same price. Check whether the source is official or just press. Quote what you
   found.
8. **Check the wording around the numbers:**
   - unit and grain words
   - arithmetic between stated numbers
   - cutoffs and partial periods
   - dropped rows or segments
   - claims the source only half-supports ("50+ mojitos & drinks" shown as "50+ mojitos")
   - absence claims and descriptions nobody sourced
9. **For SQL, also check:** join fan-out, distinct entity counts, denominators that shift
   between groups, partial periods, the cutoff's timezone, nulls versus zeros, and gaps
   in source coverage by period.
10. **Check the conclusions.** Each insight or recommendation follows from the numbers
    shown, is no stronger than the evidence, and holds up against the obvious other
    explanation.

## Report

Write `verify-r<N>.md` next to the deliverable. Don't edit the deliverable or the ledger.
The four header lines go at the very top of the file, not in a code block, and appear
nowhere else in it.

```
artifact-sha256: <check_claims.py hash <deliverable>; one line per file>
ledger-sha256: <check_claims.py hash claims.json>
verifier: <your actual model and how you ran, e.g. "gpt-6-sol, fresh codex exec session">
verdict: CLEAR | CHANGES

## Frame
The question in your own words, the measure and its basis, and whether the deliverable
answers it.

## Wrong
| Where | Deliverable says | Actually | Evidence |

## Stale or overstated
## Unsupported (no ledger claim, or the source doesn't establish it)
## Confirmed
## Not checked, and why
```

- A wrong measure, basis or scope goes under Wrong, not in Frame.
- `verdict: CLEAR` only when Wrong, Stale or overstated, and Unsupported are all empty
  (write "none" under an empty heading). Stale items get reworded or qualified first.
- In `verifier:`, name the model you're actually running on. Write "unknown" if you can't
  tell. If you were meant to be a different model family from the author and you're not,
  say so.

## Re-check rounds

You get the output of `check_claims.py changed`.

1. If it says the ask changed, start again at step 1.
2. Confirm each earlier finding's fix landed.
3. Check every `+` line, every changed claim and every claim derived from one, using
   steps 2 and 6–8. A removed or edited relation needs a reason: removing a failing
   check is not a fix. Every added exemption must be a name, address or phone, not a
   quantity.
4. Run `check` on the whole final file and read it once end to end. A fix can make a
   sentence it didn't touch false.
5. Write a new report with the new hashes.
