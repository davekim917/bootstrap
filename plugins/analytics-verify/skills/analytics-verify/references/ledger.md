# Claim ledger (`claims.json`)

The ledger connects each claim in the deliverable to where it came from. File paths are
relative to the ledger's folder.

```json
{
  "sources": {
    "q1":  {"type": "query", "sql": "query.sql", "result": "results.csv",
            "as_of": "2026-09-23T17:00:00-07:00", "grain": "MR account"},
    "acs": {"type": "web", "url": "https://data.census.gov/...", "retrieved": "2026-09-24",
            "effective": "2025-12-11", "entity": "Hialeah city, FL (ACS 2020-24, B03001)"},
    "memo": {"type": "doc", "ref": "Jose's email, 2026-09-22"}
  },
  "claims": [
    {"id": "direct_ever", "value": 1966205, "source": "q1",
     "locate": {"where": {"Year": "Total"}, "column": "New Direct customers"},
     "anchors": ["Direct ever: 1.97M"]},
    {"id": "both_ever", "value": 105984, "expr": "direct_ever + hcb_ever - unique_ever",
     "anchors": ["106K did both"]},
    {"id": "hialeah_cuban", "value": 73.7, "unit": "%", "source": "acs",
     "quote": "Cuban 166,612 of 226,154 (73.7%)", "anchors": ["73.7% Cuban"]},
    {"id": "direct_2013", "value": 191, "source": "q1",
     "locate": {"where": {"Year": "2013"}, "column": "New Direct customers"},
     "omit": "in the attached CSV only"}
  ],
  "relations": ["direct_ever + hcb_ever - both_ever == unique_ever"],
  "exempt": ["1200 Brickell Ave", "(305) 555-0100"]
}
```

## Sources

| type | required | notes |
|---|---|---|
| `query` | `sql`, `result`, `as_of`, `grain` | `as_of` is the exact cutoff, with time and timezone. `grain` is what one row counts. |
| `file` | `path` | Give an `as_of` too. |
| `web` | `url`, `retrieved`, `entity` | `entity` is the exact business, place or body. `effective` is the date of the evidence itself; without it, the check warns that the source is undated. |
| `doc` | `ref` | Who said it, where and when. |

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
  the check won't read. The quote must still show the number.
- **`magnitude`**: `true` lets an unsigned display show a negative value ("fell 6.6%" for
  -6.6). Without it, signs must match, and "+7" never shows -7.
- **`labels`**: numbers that name something in the anchor rather than state a value
  ("#42 on the **50** Best list"). Each must appear as a number in this claim's `quote`.
  Numbers in a claim's `locate.where` values are labels automatically once the file
  confirms the row: the row key "2014" in "2014 17K".
- **`anchors` or `omit`**: exactly one.
  - `anchors` are text copied from the deliverable that shows this claim, with the words
    around the number ("106K did both", not "106K").
  - `omit` is the reason the claim isn't shown. "In the attached table only" is a normal
    reason for cells the prose doesn't repeat.

## What `check` enforces

- Every number in the deliverable is accounted for: it is the value of a claim whose
  anchor holds it, a label of that claim, or inside an `exempt` snippet.
  - This includes years, dates, `1e6`, currency codes (`USD1200`, `SEK1200`) and
    spelled-out numbers from "two" to "ninety-nine".
  - A digit run right after other letters is an identifier and is skipped (Q1, H2,
    B03001, Brugal01), unless the letters are three capitals, which read as a currency
    code. The output lists every identifier it skipped.
  - Displays it can't read exactly fail with "rephrase": spelled-out numbers with
    hundred, thousand or dozen, negated qualifiers ("not over 50"), a qualifier that
    isn't next to its number ("50 accounts or more"), and a spaced minus after a word
    ("Revenue - 7%", which may be a dash).
  - Line-start list markers and URLs are also skipped.
  - A number inside an anchor that nothing accounts for fails. A range ("12-15 days")
    is two claims sharing one anchor.
  - An `exempt` snippet must be more than one bare number: an address, a phone number,
    a product name, or an illustration that isn't a finding ("someone with 2 accounts").
- Each anchor is in the deliverable, and every appearance shows the claim's value. For
  a date claim, each date shown is checked field by field: "9/23" must be September 23,
  and "5pm" must be the claim's hour.
  - The shown number must equal the value rounded to the precision displayed: `1.97M`
    matches 1,966,205.
  - A comparator must be true: "more than 80%" fails for 73.7, "<1K" passes for 191, and
    "50+" passes for 50. The qualifiers read are: more than, over, above, exceeding, at
    least, a minimum of, less than, fewer than, under, below, at most, up to, a maximum
    of, no more than, no less than, nearly, almost; and after the number, "+", "or more",
    "and up", "plus", "or less", "or fewer".
  - "About", "around" and "~" don't loosen the match.
- Each claim is shown or omitted on purpose.
- Every relation holds (`==`, `<=`, `>=`, `<`, `>`, with an optional `"tolerance"`).
- Every `expr` claim derives from other claims, with no circles, down to sourced claims.
- Arithmetic is exact decimal: 1,000,000,001 is not 1,000,000,000.

## Commands

```
check     LEDGER DELIVERABLE...          # all files share one ledger
scaffold  RESULT.csv --source q1 --key Year [--columns A,B] [--prefix new_]
reproduce DELIVERED.csv RERUN.csv --key Year [--rel-tol 0.001] [--abs-tol 0]
changed   OLD NEW [--old-ledger A --new-ledger B]
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
  those fields appear anywhere else. It also fails a CLEAR report that still lists
  items under Wrong, Stale or Unsupported.
