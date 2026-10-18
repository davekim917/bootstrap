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

The costliest errors sit upstream of all of these: an exact calculation of the wrong
thing. The wrong measure (shipments to a retailer when the question was the retailer's
sales), or the right measure over a window, population or comparison the author picked,
where the answer flips under the one the requester uses. So the loop starts from the
question, and every choice the request left open is recorded and tested before any
number is trusted.

## Which loop

- **Full loop (default):** anything someone may forward, publish or act on, including
  a chat answer.
- **Exploratory:** only when the requester is exploring and nothing will be forwarded
  or decided yet. Run the ledger check if you show numbers, and end with: "Exploratory,
  not verified. Ask for a check before using these numbers."

If you're unsure, use the full loop.

## Author loop

1. **Pin down the question before any query.** Fill in the ledger's `ask`
   ([references/ledger.md](references/ledger.md)):
   - the request in the requester's own words, where it came from (the message, thread
     or call transcript), and the exact measure: what is counted or summed, on what basis,
     for which population, grain and period;
   - the premise: what the requester believes or will decide;
   - the reference: the number they already read for this measure (a dashboard tile, a
     wiki metric, a prior deck). Pull it now. Your headline has to reconcile to it, or
     open with the bridge;
   - every choice that could change the headline (period, population, exclusions, basis,
     date field) and who decided it. When the request leaves one open, use the
     reference's convention, or ask in the thread. A choice you make yourself carries its
     alternatives: rerun the headline under each, and if one flips the answer, the
     deliverable leads with both readings.
2. **Put the deliverable in a file** (message, Markdown, or the HTML a PDF renders
   from). What you send is exactly that file, including any caveats or open questions
   you plan to send with it (step 7).
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
     spelled-out counts. A range is two claims. The check refuses wording it can't read
     exactly; [references/ledger.md](references/ledger.md) lists what it reads.
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
      (`codex exec -c model_reasoning_effort=<effort>`, `claude -p --effort <effort>`),
      with stdin closed (`</dev/null`) or it waits forever;
   2. a peer agent on another model family in this conversation (mention it);
   3. a fresh-context subagent of your own model. Call it a same-family check in the
      stamp.

   `<effort>` is the `effort` in `<skill-dir>/verifier.json`. Pass it explicitly
   wherever the verifier takes one: left unset, a CLI can fall back to no reasoning.

   Give it the deliverable, the ledger, the original request with its source material
   (the thread or transcript itself, not your summary of it), and
   [references/verifier-brief.md](references/verifier-brief.md). Paste the brief into
   a CLI or subagent prompt; a peer that has this plugin loads this skill as the
   verifier. Notes of your own go after the brief, never in place of it. Don't give it
   your research files or conclusions: those are the blind spots it is there to avoid.

   Run a headless verifier in the foreground with a 60-minute (`3600000` ms) timeout;
   30 minutes in is still healthy. Save its output: a CLI prints its model and reasoning
   effort in the first lines, and the stamp names both from there.

   A same-family round can't clear a Frame that a cross-family round left open (the
   receipt refuses it). If the other family isn't reachable again, stop and deliver with
   the open Frame finding listed.
6. **Fix in one pass.** Change only what the findings name. A new sentence or number
   goes into the ledger first. Re-run step 4, then send the verifier what changed:
   ```
   python3 <skill-dir>/scripts/check_claims.py changed old.md new.md --old-ledger old.json --new-ledger claims.json
   ```
   It re-checks those lines and claims, then the whole final file; run it once per
   changed file. Three rounds is the usual budget, not a cap. Run another while the open
   findings include one you can fix yourself: a Wrong, an open Frame line, or a number
   your own error moved (live data refreshing is drift to report, not a finding).

   Stop in either of these cases, and deliver with the open findings listed for the
   requester to decide:
   - None is yours to fix: each needs the requester's answer (a measure or period only
     they can settle), is cosmetic wording that changes no number, unit, measure or
     claim, or is a disagreement the verifier still holds after seeing your answer.
   - Past three rounds, a round leaves no fewer open findings than the one before. You
     aren't converging, even if what's left is yours to fix.

   Stopping with a finding open is not a pass. The last verdict stays CHANGES, there is
   no receipt, and the stamp names each open finding and what wasn't re-checked:
   "checked in 3 rounds" alone reads as a pass. Past three rounds, the stamp also says
   what each extra round caught.
7. **Deliver with a receipt and a one-line stamp.** Run
   `check_claims.py receipt verify-r<N>.md claims.json <deliverable> [<notes>]` first,
   naming every verified file. PASS means
   the verifier's report covers these exact bytes with a clean verdict; any later edit
   sends you back to step 6. Put the stamp in your message to the requester, not inside
   the verified file (that would change its bytes). The stamp says what ran, who
   checked, and what wasn't checked:
   > Verified: ledger PASS (41 numbers, 3 relations), CSV reproduces exactly; checked
   > by gpt-6.1-sol at high effort in a fresh Codex session, CLEAR after 2 rounds. Not checked: store
   > shelf stock.

   Name the verifier's actual model and reasoning effort, from its output header or the
   peer's own report, never from memory. If you asked for another model family and got
   your own (quota fallback, no CLI), say "same-family check".

   The message carries the verified file and the stamp, nothing new. Caveats, open
   questions and next steps that state a figure, date or fact go in a file before the
   check, and so does any headline or summary you want in the message. When the
   deliverable is for someone other than the requester (a reply they'll post, a deck),
   it holds only what that person receives, so the bytes posted are the bytes verified.
   Notes for the requester alone go in a second file, checked alongside it (one
   `artifact-sha256` line per file), and you paste that file's text into your message
   to the requester. A note left only in a file never reaches them: they read the
   conversation, not this machine. After the receipt, your own words may only paste a
   verified file, point at one, or ask for a decision it already raises, and state no
   other figures; the stamp is the one exception.
   A restated figure can be retyped wrong, and the receipt can't see it. Anything that
   states a figure, comparison or claim, in this message or a later status post, goes
   back to step 6.

## Writing rules

The check can't see these.

- Name the measure and its basis wherever a number could be read two ways: retail
  sales or shipments to the retailer, product sales or product plus shipping.
- Name the period and population beside the headline, and the reference's reading
  when yours differs.
- Name the unit you counted: accounts, orders or appointments. Say "people" only if
  you deduplicated people.
- Give the exact cutoff (date, time, timezone) and flag partial periods.
- Don't make absence claims ("has no rating") or use descriptions you can't source
  ("owner-run", "a big part of the business").

## Limits

Say these plainly when they apply. The script catches numbers with no source, values
retyped or rounded away from their file, displays that overstate their source, sums
that don't hold, dropped rows, queries that don't reproduce, undated or old evidence
(as a warning), and files edited after verification. The receipt covers the file, not
lines added around it when you send. It can't catch wrong evidence (a
miscounted menu), a true number in a false sentence, wrong unit words, or stale facts
about people and places. Nor can it tell whether you measured the right thing: it
checks that `ask` is filled in, that the reference is shown and that an alternative
which flips the headline is shown and reads a cell of its own, but not that the choices
listed are all of them, the alternatives the reasonable ones, or that cell the real
rerun. Those are the verifier's job. Enforcement is
instruction-only, and a receipt shows what a verifier wrote, not who wrote it, so a
human should still see the stamp before anything leaves.
