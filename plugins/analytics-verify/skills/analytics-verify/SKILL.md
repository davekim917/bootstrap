---
name: analytics-verify
description: >
  Verification loop for analytics and research deliverables: a claim ledger, a
  mechanical check script, an independent verifier on a fresh context, a re-check
  of every fix, and a receipt tied to the exact file sent. Load BEFORE sending
  numbers or factual claims from data or research to anyone (a report, deck, PDF,
  CSV, dashboard, a draft for someone else, or a chat answer someone will act on
  or forward). Also load it when asked to validate, verify, cross-check or
  cross-examine an analysis, and when you are the verifier.
---

# Analytics verify

In agent-written analyses the computation is usually right. The errors sit in the
claims around it: numbers rounded up or retyped, the wrong unit ("people" for
accounts), sums that don't add, dropped rows, vague cutoffs, stale or wrong-location
sources, embellished copy, and new errors added while fixing old ones. Rereading your
own work doesn't catch these, because you reread your own beliefs. What catches them is
binding every claim to its source, then having someone who didn't write it check it.

The costliest error sits upstream of all of these: an exact calculation on the wrong
measure, such as shipments to a retailer when the question was the retailer's sales. So
the loop starts from the question, and the verifier checks that before any number.

## Which loop

- **Full loop (default):** anything someone may forward, publish or act on, including
  a chat answer.
- **Exploratory:** only when the requester is exploring and nothing will be forwarded
  or decided yet. Run the ledger check if you show numbers, and end with: "Exploratory,
  not verified. Ask for a check before using these numbers."

If you're unsure, use the full loop.

## Author loop

1. **Pin down the question before any query.** Fill in the ledger's `ask`: the request
   in the requester's own words and where it came from (the message, thread or call
   transcript), the exact measure (what is counted or summed, on what basis, for which
   population, grain and period), and your assumptions. When the request could mean two
   measures (sales to a retailer or by it, accounts or people, gross or net), settle it
   from the source material or ask. Don't pick one silently.
2. **Put the deliverable in a file** (message, Markdown, or the HTML a PDF renders
   from). What you send is exactly that file.
3. **Keep a ledger as you work:** `claims.json` next to the deliverable, in the format
   in [references/ledger.md](references/ledger.md).
   - Numbers are read from result files, never typed. `scaffold` turns a result CSV
     into claims that point at their cells. Name each result column for what it counts
     (`AS new_customers`, not `value` or `col1`): the verifier reads every number against
     that name. When a report renders from a data file
     (a list of accounts, say), have the same script write `claims.json` from that
     data, so the ledger and the report can't drift apart.
   - Every web fact carries the source's own words, the exact business and location,
     and the date of the evidence.
   - Every sentence that combines numbers ("did both", "of which", "brings the total
     to") gets a `relations` entry.
   - Every row, year and segment the ask expects is shown, or `omit`ted with a reason.
   - Before a finding rests on a date (how old, what came first, inside a window),
     confirm which event the column records: created, updated, answered or shipped.
     One row per customer that is updated in place keeps its created date.
   - Every number in the deliverable is accounted for, including years, dates and
     spelled-out counts. A range is two claims. Write large or compound numbers and
     fractions in digits ("200", not "two hundred"; "75%", not "three quarters"), and state bounds plainly ("at least 50", not
     "not under 50"): the check refuses what it can't read exactly.
4. **Run the mechanical checks until they pass.** The script is
   `scripts/check_claims.py` in this skill's directory:
   ```
   python3 <skill-dir>/scripts/check_claims.py check claims.json report.md
   python3 <skill-dir>/scripts/check_claims.py reproduce delivered.csv rerun.csv --key Year
   ```
   `rerun.csv` comes from running the saved SQL file again, not from memory. If live
   data moved, rerun with `--rel-tol` and report the drift it lists.
5. **Get an independent verifier.** Use the first of these you have:
   1. a fresh headless session of another model family that can reach the same data
      (`codex exec`, `claude -p`);
   2. a peer agent on another model family in this conversation (mention it);
   3. a fresh-context subagent of your own model. Call it a same-family check in the
      stamp.

   Give it the deliverable, the ledger, the original request with its source material
   (the thread or transcript itself, not your summary of it), and
   [references/verifier-brief.md](references/verifier-brief.md). Paste the brief into
   a CLI or subagent prompt; a peer that has this plugin loads this skill as the
   verifier. Notes of your own go after the brief, never in place of it. Don't give it
   your research files or conclusions: those are the blind spots it is there to avoid.
6. **Fix in one pass.** Change only what the findings name. A new sentence or number
   goes into the ledger first. Re-run step 4, then send the verifier what changed:
   ```
   python3 <skill-dir>/scripts/check_claims.py changed old.md new.md --old-ledger old.json --new-ledger claims.json
   ```
   It re-checks those lines and claims, then the whole final file. Stop after three
   rounds and deliver with the open disagreements listed for the requester to decide.
   If the last verdict is still CHANGES when you stop, the stamp says so and names what
   wasn't re-checked: "checked in 3 rounds" alone reads as a pass.
7. **Deliver with a receipt and a one-line stamp.** Run
   `check_claims.py receipt verify-r<N>.md claims.json <deliverable>` first. PASS means
   the verifier's report covers these exact bytes with a clean verdict; any later edit
   sends you back to step 6. Put the stamp in your message to the requester, not inside
   the verified file (that would change its bytes). The stamp says what ran, who
   checked, and what wasn't checked:
   > Verified: ledger PASS (41 numbers, 3 relations), CSV reproduces exactly; checked
   > by gpt-6-sol in a fresh Codex session, CLEAR after 2 rounds. Not checked: store
   > shelf stock.

   Name the verifier's actual model. If you asked for another model family and got
   your own (quota fallback, no CLI), say "same-family check".

## Writing rules

These are the places the errors were.

- Name the measure and its basis wherever a number could be read two ways: retail
  sales or shipments to the retailer, product sales or product plus shipping.
- Show numbers at the precision the source supports. "About" doesn't make a different
  number true.
- Name the unit you counted: accounts, orders or appointments. Say "people" only if
  you deduplicated people.
- Numbers that combine in a sentence combine in the ledger. State the overlap.
- Give the exact cutoff (date, time, timezone) and flag partial periods.
- Every requested row, year and segment appears, or you say why not.
- Tie web facts to the exact business and location, the date of the evidence (not the
  day you read it), and the source's own words. A chain's website isn't a store's
  shelf, an old menu isn't the current one, and a working title isn't an official
  serve.
- Don't make absence claims ("has no rating") or use descriptions you can't source
  ("owner-run", "a big part of the business").

## Limits

Say these plainly when they apply. The script catches numbers with no source, values
retyped or rounded away from their file, displays that overstate their source, sums
that don't hold, dropped rows, queries that don't reproduce, undated or old evidence
(as a warning), and files edited after verification. It can't catch wrong evidence (a
miscounted menu), a true number in a false sentence, wrong unit words, or stale facts
about people and places. Nor can it tell whether you measured the right thing: it
checks that `ask` is filled in, and the verifier checks that the deliverable answers
it. Those are the verifier's job. Enforcement is
instruction-only, and a receipt shows what a verifier wrote, not who wrote it, so a
human should still see the stamp before anything leaves.
