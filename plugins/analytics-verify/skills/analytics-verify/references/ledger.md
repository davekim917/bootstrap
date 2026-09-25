# Claim ledger (`claims.json`)

The ledger connects each claim in the deliverable to where it came from. File paths are
relative to the ledger's folder.

```json
{
  "ask": {
    "request": "How many new customers have we had since launch, by year?",
    "from": "the CFO's email, 2026-09-22",
    "measure": "new customer accounts (first completed order), Online and Studio combined and deduplicated, by calendar year, through 2026-09-23 17:00 PT",
    "assumptions": ["a customer is an account, so someone with two accounts counts twice"]
  },
  "sources": {
    "q1":  {"type": "query", "sql": "query.sql", "result": "results.csv",
            "as_of": "2026-09-23T17:00:00-07:00", "grain": "customer account"},
    "acs": {"type": "web", "url": "https://example.gov/acs/...", "retrieved": "2026-09-24",
            "effective": "2025-12-11", "entity": "Riverton city (ACS 2020-24, B16001)"},
    "memo": {"type": "doc", "ref": "the CFO's email, 2026-09-22"}
  },
  "claims": [
    {"id": "online_ever", "value": 1281949, "source": "q1",
     "locate": {"where": {"Year": "Total"}, "column": "New Online customers"},
     "anchors": ["Online ever: 1.28M"]},
    {"id": "both_ever", "value": 36419, "expr": "online_ever + studio_ever - unique_ever",
     "anchors": ["36K did both"]},
    {"id": "riverton_bilingual", "value": 64.2, "unit": "%", "source": "acs",
     "quote": "Bilingual 41,380 of 64,452 (64.2%)", "anchors": ["64.2% bilingual"]},
    {"id": "online_2013", "value": 412, "source": "q1",
     "locate": {"where": {"Year": "2013"}, "column": "New Online customers"},
     "omit": "in the attached CSV only"}
  ],
  "relations": ["online_ever + studio_ever - both_ever == unique_ever"],
  "exempt": ["100 Main St", "(555) 555-0100"]
}
```

## Ask

What the deliverable has to answer, written before any query. The verifier checks the
deliverable against it, and checks it against the request itself.

- **`request`**: the ask in the requester's own words.
- **`from`**: where the request came from (message, thread, call transcript), so the
  verifier can read it.
- **`measure`**: exactly what is counted or summed and on what basis (retail sales or
  shipments to the retailer, product sales or product plus shipping), for which
  population, grain and period.
- **`assumptions`**: a list of every assumption that would change the answer, `[]` if
  there are none.

The check fails a ledger without `request`, `from` and `measure`, or without an
`assumptions` list. `changed` reports an edited ask, and the verifier starts over from
the question.

## Sources

| type | required | notes |
|---|---|---|
| `query` | `sql`, `result`, `as_of`, `grain` | `as_of` is the exact cutoff, an ISO datetime with timezone (a value that doesn't parse fails; a date alone warns). `grain` is what one row counts. |
| `file` | `path` | Give an `as_of` too. |
| `web` | `url`, `retrieved`, `entity` | `entity` is the exact business, place or body. `effective` is the date of the evidence itself; without it, the check warns that the source is undated. |
| `doc` | `ref` | Who said it, where and when. |

A source date (`as_of`, `retrieved`, `effective`) more than a day after `--today` fails.

## Claims

- **`id`**: letters, digits and `_` only, so relations can use it.
- **`value`**: a number, a numeric string (for exact decimals: `"90071992547409.93"`), or
  text for a non-numeric fact. A text value that is an ISO date or datetime also checks
  that the numbers in its anchors come from that date.
- **`source` or `expr`**: exactly one. `expr` derives the value from other claims
  (`+ - * /`, parentheses, numbers) and must equal `value`.
- **`locate`** (required for a number from a `query` or `file` source, refused for any
  other source): where to read it. A text value is compared with the cell as text. A
  cell written as a percentage needs `"unit": "%"`.
  - For a CSV, `{"where": {"<col>": "<value>"}, "column": "<col>"}`. Exactly one row
    must match.
  - For JSON, `{"json": "[0].field"}`.
- **`quote`** (required for `web`): the source's own words. For a number, the quote must
  show it exactly. If the quote gives only a bound ("50+ mojitos & drinks"), the claim
  may only repeat that bound ("50+", not "50" or "more than 50", nor a rounded "at most
  1K" for "at most 1,499"), its value must be the bound's number exactly, and no `expr`
  or relation may use it. When the quote's wording is one the check won't read ("50
  accounts or more"), declare the bound yourself: `"bound": ">="`. The verifier checks that
  the quote actually supports the claim.
- **`unit`**: set it to `%` or `ratio` for percentages. A `%` display only matches a
  `%` or `ratio` claim, and a ratio is multiplied by 100.
- **`bound`**: `>=`, `>`, `<=` or `<`, for a source that states only a bound in wording
  the check won't read. The quote must still show the number, and `bound` can't be set
  when the quote's own wording already reads (exactly, or as a different bound).
- **`magnitude`**: `true` lets an unsigned display show a negative value ("fell 6.6%" for
  -6.6). Without it, signs must match, and "+7" never shows -7.
- **`labels`**: numbers that name something in the anchor rather than state a value
  ("#42 on the **50** Best list"). Each must appear as a number in this claim's `quote`.
  Numbers in a claim's `locate.where` values are labels automatically once the file
  confirms the row: the row key "2014" in "2014 17K".
- **`anchors` or `omit`**: exactly one.
  - `anchors` are text copied from the deliverable that shows this claim, with the words
    around the number ("36K did both", not "36K").
  - `omit` is the reason the claim isn't shown. "In the attached table only" is a normal
    reason for cells the prose doesn't repeat.

## What `check` enforces

- Every number in the deliverable is accounted for: it is the value of a claim whose
  anchor holds it, a label of that claim, or inside an `exempt` snippet.
  - This includes years, dates, `1e6`, currency codes (`USD1200`, `SEK1200`) and
    spelled-out numbers from "two" to "ninety-nine". A lone "one" is not checked, and a
    qualifier attached to it ("at least one") belongs to it. Hyphenated spelled fractions
    ("one-third") fail. Spaced ones aren't recognized: "three quarters" reads as 3 and
    "a quarter" as no number. Write every fraction in digits (75%, 1/3).
  - A digit run right after other letters is an identifier and is skipped (Q1, H2,
    B03001, Acme01), unless the letters are three capitals, which read as a currency
    code. The output lists every identifier it skipped.
  - Displays it can't read exactly fail with "rephrase": spelled-out numbers with
    hundred, thousand or dozen, negated qualifiers ("not over 50"), a spaced minus
    after a word ("Revenue - 7%", which may be a dash).
  - Numbers in parentheses read as written: "4.6 (1,947)", "survey (2024)", "($50)" is
    50. A negative value in the ledger needs a signed display ("-$50") or
    `"magnitude": true`. The check can't tell that "($50)" means a loss when the ledger
    also says 50; write negatives with their sign.
  - Each number reads the one qualifier attached to it (right before or right after).
    Bound wording attached to no number ("up to a total of 50", "50 accounts or more")
    makes every number in its sentence fail. Approximation words and "over", "under",
    "above" and "below" count only when attached, so "surveyed 50 customers about
    onboarding" and "over the last 12 months" read fine. A bullet or a blank line ends
    a sentence.
  - Line-start list markers and URLs are also skipped.
  - A number inside an anchor that nothing accounts for fails. A range ("12-15 days")
    is two claims sharing one anchor.
  - One number has one role: a value or date owned by exactly one claim, a label any
    number of claims can share, or part of an `exempt` snippet. An anchor holds exactly
    one number that shows its claim's value, and no two claims can show through the same
    number: "Revenue was 5; headcount was 5" is two claims, each anchored to its own 5.
  - An `exempt` snippet must be more than one bare number: an address, a phone number,
    a product name, or an illustration that isn't a finding ("someone with 2 accounts").
- Each anchor is in the deliverable, and every appearance shows the claim's value. For
  a date claim, each date shown is checked field by field: "9/23" must be September 23,
  and "5pm" must be the claim's hour.
  - The shown number must equal the value rounded to the precision displayed: `1.23M`
    matches 1,234,567.
  - A comparator must be true: "more than 70%" fails for 64.2, "<1K" passes for 412, and
    "50+" passes for 50. The qualifiers read are: more than, over, above, exceeding, at
    least, a minimum of, less than, fewer than, under, below, at most, up to, a maximum
    of, no more than, no less than, nearly, almost; and after the number, "+", "or more",
    "and up", "plus", "or less", "or fewer".
  - "About", "around" and "~" don't loosen the match. "Nearly" and "almost" mean below
    the number and within its rounding: "nearly 50" fails for 50 and for 49.4.
- Each claim is shown or omitted on purpose.
- Every relation holds (`==`, `<=`, `>=`, `<`, `>`, with an optional `"tolerance"`).
- Every `expr` claim derives from other claims, with no circles, down to sourced claims.
- Arithmetic is exact decimal: 1,000,000,001 is not 1,000,000,000.

## Commands

```
check     LEDGER DELIVERABLE...          # all files share one ledger
scaffold  RESULT.csv --source q1 --key Year [--columns A,B] [--prefix new_]
reproduce DELIVERED.csv RERUN.csv --key Year [--rel-tol 0.001] [--abs-tol 0]
changed   OLD NEW [--old-ledger A --new-ledger B]   # link destinations count as text
hash      FILE...
receipt   verify-r2.md claims.json DELIVERABLE...
```

Exit status: 0 pass, 1 findings, 2 input the script can't check.

- `check` reads Markdown, text and HTML. It reads PDF only when `pdftotext` is
  installed; otherwise check the HTML or Markdown the PDF is rendered from.
- `reproduce` compares on declared keys and reports duplicate keys, missing rows,
  null-versus-zero, unit changes (`50%` vs `50`), and each cell that moved within
  tolerance (as drift, not a match). It refuses a table with duplicate column names or
  ragged rows.
- `receipt` reads only the header block at the very top of the report, and fails if
  those fields appear anywhere else. It also fails a report that doesn't open with a
  `## Frame` section right after the header giving `Question:`, `Measure:` and `Answers
  it:`, and a CLEAR report that still lists items under Wrong, Stale or Unsupported. It
  shows the Frame names a question and a measure, not that they're right.
