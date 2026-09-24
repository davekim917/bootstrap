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
- **`value`**: a number, or text for a non-numeric fact. A text value that is an ISO
  date or datetime also checks that the numbers in its anchors come from that date.
- **`source` or `expr`**: exactly one. `expr` derives the value from other claims
  (`+ - * /`, parentheses, numbers) and must equal `value`.
- **`locate`** (required for a number from a `query` or `file` source): where to read
  it.
  - For a CSV, `{"where": {"<col>": "<value>"}, "column": "<col>"}`. Exactly one row
    must match.
  - For JSON, `{"json": "[0].field"}`.
- **`quote`** (required for `web`): the source's own words. For a number, the quote must
  show it. The quote's own qualifiers count, and the verifier checks that the quote
  actually supports the claim.
- **`unit`**: set it to `%` or `ratio` for percentages. A `%` display only matches a
  `%` or `ratio` claim, and a ratio is multiplied by 100.
- **`anchors` or `omit`**: exactly one.
  - `anchors` are text copied from the deliverable that shows this claim, with the words
    around the number ("106K did both", not "106K").
  - `omit` is the reason the claim isn't shown.

## What `check` enforces

- Every number in the deliverable sits inside an anchor or an `exempt` snippet.
  - This includes years, dates and spelled-out counts ("six").
  - A digit run right after a letter is an identifier and is skipped (Q1, H2, v2).
  - Line-start list markers and URLs are also skipped.
- Each anchor is in the deliverable, and every appearance shows the claim's value.
  - The shown number must equal the value rounded to the precision displayed: `1.97M`
    matches 1,966,205.
  - A comparator must be true: "more than 80%" fails for 73.7, "<1K" passes for 191, and
    "50+" passes for 50.
  - "About", "around" and "~" don't loosen the match.
- Each claim is shown or omitted on purpose.
- Every relation holds (`==`, `<=`, `>=`, `<`, `>`, with an optional `"tolerance"`).

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
  null-versus-zero, and each cell that moved within tolerance (as drift, not a match).
