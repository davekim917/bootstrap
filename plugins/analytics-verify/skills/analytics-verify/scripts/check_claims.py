#!/usr/bin/env python3
"""Mechanical claim checks for analytics deliverables. Python 3.8+, standard library only.

A PASS means every number in the deliverable is bound to a claim in the ledger and
every claim is bound to its source. It is not an independent verification: a wrong
source, a misread menu, or a false sentence built from correct numbers all pass.

  check     LEDGER DELIVERABLE...   bind numbers to claims and claims to sources
  scaffold  RESULT.csv --source ID --key COL[,COL] [--columns A,B] [--prefix P]
  reproduce DELIVERED.csv RERUN.csv --key COL[,COL] [--rel-tol X] [--abs-tol Y]
  changed   OLD NEW [--old-ledger A --new-ledger B]
  hash      FILE...
  receipt   REPORT LEDGER DELIVERABLE...

Exit status: 0 pass, 1 findings, 2 unusable input. Ledger format: ../references/ledger.md
"""
from __future__ import annotations

import argparse
import ast
import csv
import datetime as dt
import difflib
import hashlib
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata

MECHANICAL_ONLY = (
    'Mechanical check only: it shows the numbers match the ledger and the ledger matches '
    'its files. It does not show the sources or the sentences are right.'
)


class InputError(Exception):
    """The input cannot be checked at all (exit 2), as opposed to a finding (exit 1)."""


# ---------------------------------------------------------------- text extraction

class _HTMLText(html.parser.HTMLParser):
    SKIP = {'script', 'style', 'noscript', 'template', 'head', 'title'}
    BLOCK = {
        'p', 'div', 'br', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section',
        'article', 'header', 'footer', 'ul', 'ol', 'table', 'blockquote', 'pre', 'hr', 'dt', 'dd',
        'figcaption', 'caption', 'aside', 'main', 'nav', 'figure',
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def read_text(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.csv', '.tsv', '.xlsx', '.xls', '.json', '.parquet'):
        raise InputError(f'{path}: a table is checked with `reproduce`; run `check` on the prose that presents it')
    if not os.path.isfile(path):
        raise InputError(f'{path}: not found')
    if ext == '.pdf':
        exe = shutil.which('pdftotext')
        if not exe:
            raise InputError(
                f'{path}: pdftotext is not installed. Check the HTML or Markdown the PDF is rendered from, '
                'or install poppler-utils'
            )
        out = subprocess.run([exe, '-enc', 'UTF-8', path, '-'], capture_output=True, text=True)
        if out.returncode != 0:
            raise InputError(f'{path}: pdftotext failed: {out.stderr.strip()}')
        return out.stdout
    with open(path, encoding='utf-8') as f:
        raw = f.read()
    if ext in ('.html', '.htm'):
        parser = _HTMLText()
        parser.feed(raw)
        parser.close()
        return ''.join(parser.parts)
    return raw


_TRANSLATE = str.maketrans({
    '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2212': '-', '\u00a0': ' ',
})
_MD_LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
_URL = re.compile(r'(?:https?://|www\.)\S+')
_CHAT_TOKEN = re.compile(r'<(?:[@#!][^>]*|t:\d+(?::[A-Za-z])?)>')
_LIST_MARKER = re.compile(r'^[ \t]*(?:\d{1,3}[.)]|[-*\u2022+])[ \t]+', re.M)
_FOOTNOTE = re.compile(r'\[\d{1,3}\]')


def normalize(text: str) -> str:
    """One normal form for deliverables and anchors alike, so an anchor copied from
    either the source or the rendered text still matches."""
    t = unicodedata.normalize('NFKC', text).translate(_TRANSLATE)
    t = _CHAT_TOKEN.sub(' ', t)
    t = _MD_LINK.sub(r'\1', t)
    t = _URL.sub(' ', t)
    t = _LIST_MARKER.sub('', t)
    t = _FOOTNOTE.sub(' ', t)
    for mark in ('**', '__', '`', '*'):
        t = t.replace(mark, '')
    return re.sub(r'\s+', ' ', t).strip()


# ---------------------------------------------------------------- number tokens

_NUM = re.compile(r'(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+')
_UNITS = {
    'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'dozen': 12, 'hundred': 100,
}
_ONES = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9}
_TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90}
# "one" is left out on purpose: "one-off", "no one" and "one of" would make every report fail.
_WORD_NUM = re.compile(
    r'\b(?:(' + '|'.join(_TENS) + r')(?:[- ](' + '|'.join(_ONES) + r'))?|(' + '|'.join(_UNITS) + r'))\b',
    re.I,
)
_SCALE = re.compile(r'\s?(thousand|million|billion|trillion)\b|(bn|mm|[kKmMbB])(?![A-Za-z])')
_SCALE_MULT = {'thousand': 1e3, 'million': 1e6, 'billion': 1e9, 'trillion': 1e12,
               'k': 1e3, 'm': 1e6, 'mm': 1e6, 'b': 1e9, 'bn': 1e9}
_PCT = re.compile(r'\s?(%|percent\b|per cent\b|pct\b|pp\b|percentage points?\b)', re.I)
_CMP = re.compile(
    r'(more than|greater than|over|above|exceeding|at least|no less than|no fewer than|less than|'
    r'fewer than|under|below|at most|up to|no more than|about|around|approximately|approx\.?|'
    r'roughly|nearly|almost|~|\u2248|<=|>=|\u2264|\u2265|<|>)\s*$',
    re.I,
)
_CMP_OP = {
    'more than': 'gt', 'greater than': 'gt', 'over': 'gt', 'above': 'gt', 'exceeding': 'gt', '>': 'gt',
    'at least': 'gte', 'no less than': 'gte', 'no fewer than': 'gte', '>=': 'gte', '\u2265': 'gte',
    'less than': 'lt', 'fewer than': 'lt', 'under': 'lt', 'below': 'lt', '<': 'lt',
    'at most': 'lte', 'up to': 'lte', 'no more than': 'lte', '<=': 'lte', '\u2264': 'lte',
    'nearly': 'near', 'almost': 'near',
}
PCT_UNITS = {'%', 'pct', 'percent', 'pp', 'percentage points'}


class Token:
    __slots__ = ('start', 'end', 'text', 'value', 'step', 'pct', 'neg', 'op')

    def __init__(self, start, end, text, value, step, pct=False, neg=False, op='eq'):
        self.start, self.end, self.text = start, end, text
        self.value, self.step, self.pct, self.neg, self.op = value, step, pct, neg, op

    def __repr__(self):
        return f'Token({self.text!r}, {self.value}, op={self.op})'


def _comparator(text: str, lead: int) -> str:
    m = _CMP.search(text[max(0, lead - 24):lead])
    if not m:
        return 'eq'
    word = re.sub(r'\s+', ' ', m.group(1).lower()).rstrip('.')
    return _CMP_OP.get(word, 'eq')  # about/around/~/roughly: still exact at the shown precision


def tokenize(text: str) -> list[Token]:
    """Every number in normalized text. A digit run directly after a letter (Q1, H2, v2)
    is an identifier, not a quantity; nothing else is skipped."""
    tokens: list[Token] = []
    for m in _NUM.finditer(text):
        s, e = m.start(), m.end()
        prev = text[s - 1] if s else ''
        if prev.isalpha() or prev == '_':
            continue
        lead, neg = s, False
        if prev in '$\u20ac\u00a3':
            lead = s - 1
        if lead and text[lead - 1] == '-' and (lead < 2 or not text[lead - 2].isalnum()):
            neg, lead = True, lead - 1
        if lead and text[lead - 1] in '$\u20ac\u00a3':
            lead -= 1
        raw = m.group(0)
        decimals = len(raw.split('.', 1)[1]) if '.' in raw else 0
        mult = 1.0
        end = e
        sm = _SCALE.match(text, end)
        if sm:
            mult = _SCALE_MULT[(sm.group(1) or sm.group(2)).lower()]
            end = sm.end()
        pm = _PCT.match(text, end)
        pct = bool(pm)
        if pm:
            end = pm.end()
        op = _comparator(text, lead)
        if end < len(text) and text[end] == '+':
            op, end = 'gte', end + 1
        value = float(raw.replace(',', '')) * mult
        tokens.append(Token(s, end, text[s:end], -value if neg else value, (10 ** -decimals) * mult, pct, neg, op))
    for m in _WORD_NUM.finditer(text):
        if m.group(3):
            value = _UNITS[m.group(3).lower()]
        else:
            value = _TENS[m.group(1).lower()] + (_ONES[m.group(2).lower()] if m.group(2) else 0)
        tokens.append(Token(m.start(), m.end(), m.group(0), float(value), 1.0, op=_comparator(text, m.start())))
    tokens.sort(key=lambda t: t.start)
    return tokens


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def token_matches(tok: Token, value, unit) -> bool:
    """Whether a displayed number is a faithful display of a ledger value: the same
    after rounding to the precision shown, or true under the comparator shown."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    unit = (unit or '').strip().lower()
    v = float(value)
    if tok.pct:
        if unit == 'ratio':
            v *= 100
        elif unit not in PCT_UNITS:
            return False
    elif unit in PCT_UNITS or unit == 'ratio':
        return False
    x = tok.value
    if not tok.neg and v < 0:
        v = -v  # "fell 6.6%" displays a negative change without its sign
    half = tok.step / 2 * (1 + 1e-9) + 1e-12
    if tok.op == 'gt':
        return v > x
    if tok.op == 'gte':
        return v >= x
    if tok.op == 'lt':
        return v < x
    if tok.op == 'lte':
        return v <= x
    if tok.op == 'near':
        return v <= x + 1e-12 and abs(v - x) <= half
    return abs(v - x) <= half


def _date_parts(value: str):
    try:
        text = value.strip().replace('Z', '+00:00')
        if len(text) == 10:
            d = dt.date.fromisoformat(text)
            return {d.year, d.year % 100, d.month, d.day}
        t = dt.datetime.fromisoformat(text)
    except (ValueError, AttributeError):
        return None
    hour12 = t.hour % 12 or 12
    return {t.year, t.year % 100, t.month, t.day, t.hour, hour12, t.minute}


# ---------------------------------------------------------------- ledger

_ID = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


class Findings:
    def __init__(self):
        self.fails: list[str] = []
        self.warns: list[str] = []
        self.notes: list[str] = []

    def fail(self, kind, msg):
        self.fails.append(f'FAIL {kind:<9} {msg}')

    def warn(self, kind, msg):
        self.warns.append(f'WARN {kind:<9} {msg}')

    def note(self, kind, msg):
        self.notes.append(f'NOTE {kind:<9} {msg}')

    def emit(self, summary):
        for line in self.fails + self.warns + self.notes:
            print(line)
        verdict = 'FAIL' if self.fails else 'PASS'
        print(f'RESULT: {verdict}: {len(self.fails)} failure(s), {len(self.warns)} warning(s). {summary}')
        print(MECHANICAL_ONLY)
        return 1 if self.fails else 0


def _num(cell):
    if cell is None:
        return None
    s = str(cell).strip().replace(',', '').replace('$', '').replace('%', '').replace(' ', '')
    if s == '':
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        raise InputError(f'{path}: not found')
    except json.JSONDecodeError as exc:
        raise InputError(f'{path}: not valid JSON ({exc})')


def _parse_date(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


class _Eval(ast.NodeVisitor):
    OPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
           ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b}

    def __init__(self, values):
        self.values = values
        self.names: set[str] = set()

    def run(self, node):
        if isinstance(node, ast.Expression):
            return self.run(node.body)
        if isinstance(node, ast.BinOp) and type(node.op) in self.OPS:
            return self.OPS[type(node.op)](self.run(node.left), self.run(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = self.run(node.operand)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.Constant) and _is_number(node.value):
            return float(node.value)
        if isinstance(node, ast.Name):
            self.names.add(node.id)
            if node.id not in self.values:
                raise ValueError(f'unknown or non-numeric claim "{node.id}"')
            return float(self.values[node.id])
        raise ValueError('only claim ids, numbers, + - * / and parentheses are allowed')


def expr_names(expr: str) -> set[str]:
    try:
        tree = ast.parse(expr, mode='eval')
    except SyntaxError:
        return set()
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}


def evaluate(expr: str, values: dict) -> float:
    return _Eval(values).run(ast.parse(expr, mode='eval'))


_REL_OPS = {ast.Eq: '==', ast.LtE: '<=', ast.GtE: '>=', ast.Lt: '<', ast.Gt: '>'}


def check_relation(expr: str, values: dict, tolerance: float):
    tree = ast.parse(expr, mode='eval').body
    if not (isinstance(tree, ast.Compare) and len(tree.ops) == 1 and type(tree.ops[0]) in _REL_OPS):
        raise ValueError('a relation is one comparison: ==, <=, >=, < or >')
    left = _Eval(values).run(tree.left)
    right = _Eval(values).run(tree.comparators[0])
    op = _REL_OPS[type(tree.ops[0])]
    if op == '==':
        ok = abs(left - right) <= tolerance or _close(left, right)
    else:
        ok = {'<=': left <= right, '>=': left >= right, '<': left < right, '>': left > right}[op]
    return ok, left, right


class _Tables:
    def __init__(self, base):
        self.base = base
        self.cache: dict[str, object] = {}

    def path(self, rel):
        return rel if os.path.isabs(rel) else os.path.join(self.base, rel)

    def rows(self, rel):
        p = self.path(rel)
        if p not in self.cache:
            with open(p, newline='', encoding='utf-8-sig') as f:
                self.cache[p] = list(csv.DictReader(f))
        return self.cache[p]

    def json(self, rel):
        p = self.path(rel)
        if p not in self.cache:
            self.cache[p] = load_json(p)
        return self.cache[p]


def _json_get(doc, path):
    cur = doc
    for part in re.findall(r'[^.\[\]]+|\[\d+\]', path):
        if part.startswith('['):
            cur = cur[int(part[1:-1])]
        else:
            cur = cur[part]
    return cur


def _locate(claim, src, tables: _Tables):
    """Read the cell a claim points at. Returns (value, error)."""
    loc = claim.get('locate')
    table = src.get('result') or src.get('path')
    if not isinstance(loc, dict) or not table:
        return None, 'locate needs {"where": {...}, "column": ...} or {"json": "a.b[0]"} and a source result/path'
    try:
        if 'json' in loc:
            return _json_get(tables.json(table), loc['json']), None
        where, column = loc.get('where') or {}, loc.get('column')
        rows = tables.rows(table)
        if rows and column not in rows[0]:
            return None, f'column "{column}" is not in {table}'
        for key in where:
            if rows and key not in rows[0]:
                return None, f'where-column "{key}" is not in {table}'
        hits = [r for r in rows if all((r.get(k) or '').strip() == str(v).strip() for k, v in where.items())]
        if len(hits) != 1:
            return None, f'{len(hits)} rows of {table} match {where}; exactly one must'
        return hits[0].get(column), None
    except (OSError, KeyError, IndexError, TypeError, ValueError) as exc:
        return None, f'cannot read {table}: {exc}'


def check_ledger(ledger, base, today, stale_days, f: Findings):
    """Schema, source metadata, cell binding, quotes, derived values and relations.
    Returns {claim_id: claim} for the claims that are usable downstream."""
    if not isinstance(ledger, dict):
        raise InputError('the ledger must be a JSON object')
    sources = ledger.get('sources') or {}
    claims = ledger.get('claims')
    if not isinstance(sources, dict) or not isinstance(claims, list):
        raise InputError('the ledger needs "sources" (object) and "claims" (list)')
    tables = _Tables(base)

    for sid, src in sources.items():
        kind = src.get('type') if isinstance(src, dict) else None
        if kind == 'query':
            for field in ('sql', 'result'):
                if not src.get(field):
                    f.fail('source', f'{sid}: a query source needs "{field}"')
                elif not os.path.isfile(tables.path(src[field])):
                    f.fail('source', f'{sid}: {field} file {src[field]} does not exist')
            if not src.get('grain'):
                f.fail('source', f'{sid}: say what one row counts ("grain": e.g. "MR account", not "person")')
            as_of = src.get('as_of')
            if not as_of:
                f.fail('source', f'{sid}: "as_of" is required: the exact cutoff the query ran to')
            elif not re.search(r'T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$', str(as_of)):
                f.warn('source', f'{sid}: as_of "{as_of}" has no time and timezone; a date alone hides a partial day')
        elif kind == 'file':
            if not src.get('path'):
                f.fail('source', f'{sid}: a file source needs "path"')
            elif not os.path.isfile(tables.path(src['path'])):
                f.fail('source', f'{sid}: {src["path"]} does not exist')
            if not src.get('as_of'):
                f.warn('source', f'{sid}: no "as_of"; say when the file was produced')
        elif kind == 'web':
            if not re.match(r'https?://', str(src.get('url', ''))):
                f.fail('source', f'{sid}: a web source needs an http(s) "url"')
            if not _parse_date(src.get('retrieved')):
                f.fail('source', f'{sid}: "retrieved" must be an ISO date')
            if not src.get('entity'):
                f.fail('source', f'{sid}: name the exact business, place or body the page is about ("entity")')
            effective = _parse_date(src.get('effective'))
            if not effective:
                f.warn('stale', f'{sid}: undated evidence; treat it as stale until it is re-checked live')
            elif (today - effective).days > stale_days:
                f.warn('stale', f'{sid}: evidence dated {effective} is over {stale_days} days old')
        elif kind == 'doc':
            if not src.get('ref'):
                f.fail('source', f'{sid}: a doc source needs "ref" (who said it, where, when)')
        else:
            f.fail('source', f'{sid}: type must be query, file, web or doc')

    by_id: dict[str, dict] = {}
    for i, claim in enumerate(claims):
        if not isinstance(claim, dict):
            f.fail('claim', f'claims[{i}] is not an object')
            continue
        cid = claim.get('id')
        if not isinstance(cid, str) or not _ID.match(cid):
            f.fail('claim', f'claims[{i}]: id must look like a variable name (letters, digits, _)')
            continue
        if cid in by_id:
            f.fail('claim', f'{cid}: duplicate id')
            continue
        by_id[cid] = claim
        value = claim.get('value')
        if not (_is_number(value) or (isinstance(value, str) and value.strip())):
            f.fail('claim', f'{cid}: value must be a number or non-empty text')
        has_src, has_expr = 'source' in claim, 'expr' in claim
        if has_src == has_expr:
            f.fail('claim', f'{cid}: give exactly one of "source" or "expr"')
        anchors, omit = claim.get('anchors'), claim.get('omit')
        if anchors is not None and omit is not None:
            f.fail('claim', f'{cid}: give "anchors" or "omit", not both')
        elif anchors is None and not (isinstance(omit, str) and omit.strip()):
            f.fail('omitted', f'{cid}: not shown in the deliverable. Add "anchors", or "omit" with the reason it is left out')
        if has_src:
            src = sources.get(claim['source'])
            if not isinstance(src, dict):
                f.fail('claim', f'{cid}: source "{claim["source"]}" is not declared')
                continue
            kind = src.get('type')
            if kind in ('query', 'file') and _is_number(value):
                if 'locate' not in claim:
                    f.fail('retyped', f'{cid}: a number from {claim["source"]} must be read from its file ("locate"), not typed')
                else:
                    cell, err = _locate(claim, src, tables)
                    if err:
                        f.fail('bind', f'{cid}: {err}')
                    else:
                        got = _num(cell) if not _is_number(cell) else float(cell)
                        if got is None:
                            f.fail('bind', f'{cid}: the located cell is empty or not a number ({cell!r})')
                        elif not _close(got, float(value)):
                            f.fail('bind', f'{cid}: ledger says {value} but {src.get("result") or src.get("path")} says {cell}')
            if kind == 'web':
                quote = claim.get('quote')
                if not (isinstance(quote, str) and quote.strip()):
                    f.fail('quote', f'{cid}: a web claim needs the exact source text it rests on ("quote")')
                elif _is_number(value):
                    shown = tokenize(normalize(quote))
                    if not any(token_matches(t, value, claim.get('unit')) for t in shown):
                        f.fail('quote', f'{cid}: the quote does not show {value} ({quote.strip()[:80]!r})')

    numeric = {k: float(c['value']) for k, c in by_id.items() if _is_number(c.get('value'))}
    for cid, claim in by_id.items():
        if 'expr' not in claim:
            continue
        try:
            got = evaluate(str(claim['expr']), numeric)
        except (ValueError, SyntaxError, ZeroDivisionError) as exc:
            f.fail('derived', f'{cid}: cannot evaluate {claim["expr"]!r}: {exc}')
            continue
        if not _is_number(claim.get('value')) or not _close(got, float(claim['value'])):
            f.fail('derived', f'{cid}: {claim["expr"]} = {got:g}, ledger says {claim.get("value")}')

    for i, rel in enumerate(ledger.get('relations') or []):
        expr = rel.get('expr') if isinstance(rel, dict) else rel
        tol = float(rel.get('tolerance', 0)) if isinstance(rel, dict) else 0.0
        try:
            ok, left, right = check_relation(str(expr), numeric, tol)
        except (ValueError, SyntaxError, ZeroDivisionError) as exc:
            f.fail('relation', f'relations[{i}] {expr!r}: {exc}')
            continue
        if not ok:
            f.fail('relation', f'{expr}: left side is {left:g}, right side is {right:g}')
    return by_id


def _occurrences(text, needle):
    out, i = [], text.find(needle)
    while needle and i != -1:
        out.append((i, i + len(needle)))
        i = text.find(needle, i + len(needle))
    return out


def check_deliverables(paths, claims, exempt, f: Findings):
    texts = {p: normalize(read_text(p)) for p in paths}
    tokens = {p: tokenize(t) for p, t in texts.items()}
    covered = {p: [] for p in paths}  # (start, end) spans
    text_bound = []
    numeric_claims = [c for c in claims.values() if _is_number(c.get('value'))]

    for cid, claim in claims.items():
        anchors = claim.get('anchors')
        if anchors is None:
            continue
        if isinstance(anchors, str):
            anchors = [anchors]
        if not isinstance(anchors, list) or not anchors:
            f.fail('anchor', f'{cid}: "anchors" must be a non-empty list of text copied from the deliverable')
            continue
        value, unit = claim.get('value'), claim.get('unit')
        dates = _date_parts(value) if isinstance(value, str) else None
        for anchor in anchors:
            na = normalize(str(anchor))
            found = False
            for p in paths:
                for (s, e) in _occurrences(texts[p], na):
                    found = True
                    covered[p].append((s, e))
                    inside = [t for t in tokens[p] if t.start >= s and t.end <= e]
                    if _is_number(value):
                        hits = [t for t in inside if token_matches(t, value, unit)]
                        if not hits:
                            shown = ', '.join(t.text for t in inside) or 'no whole number'
                            f.fail('anchor', f'{cid}: "{na}" shows {shown}; the ledger value is {value}{unit or ""}')
                            continue
                        rest = na
                        for t in hits[:1]:
                            rest = rest.replace(t.text, '', 1)
                        if not re.search(r'[A-Za-z0-9]', rest):
                            f.fail('anchor', f'{cid}: "{na}" is a bare number; include the words that say what it counts')
                    elif dates is not None:
                        bad = [t.text for t in inside if int(abs(t.value)) not in dates or t.value != int(t.value)]
                        if bad:
                            f.fail('anchor', f'{cid}: "{na}" shows {", ".join(bad)}, which is not part of {value}')
                    elif inside:
                        text_bound.append(f'{cid}: {", ".join(t.text for t in inside)} in "{na}"')
            if not found:
                f.fail('anchor', f'{cid}: "{na}" is not in the deliverable (edited since the ledger was written?)')

    for snippet in exempt or []:
        ns = normalize(str(snippet))
        hits = [(p, span) for p in paths for span in _occurrences(texts[p], ns)]
        if not hits:
            f.warn('exempt', f'"{ns}" is not in the deliverable; remove it from "exempt"')
        for p, span in hits:
            covered[p].append(span)

    total = 0
    for p in paths:
        for t in tokens[p]:
            total += 1
            if any(s <= t.start and t.end <= e for s, e in covered[p]):
                continue
            around = texts[p][max(0, t.start - 50):t.end + 50]
            cands = [c['id'] for c in numeric_claims if token_matches(t, c['value'], c.get('unit'))][:3]
            hint = f' (value matches {", ".join(cands)}: anchor it)' if cands else ''
            f.fail('unbound', f'"{t.text}" is not bound to any claim{hint}: ...{around}...')
    for line in text_bound:
        f.note('text', f'numbers bound to a text claim, unchecked here: {line}')
    return total


def cmd_check(args):
    ledger_path = args.ledger
    ledger = load_json(ledger_path)
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    f = Findings()
    claims = check_ledger(ledger, os.path.dirname(os.path.abspath(ledger_path)), today, args.stale_days, f)
    total = check_deliverables(args.deliverables, claims, ledger.get('exempt'), f)
    rels = len(ledger.get('relations') or [])
    return f.emit(f'{total} number(s) in {len(args.deliverables)} file(s), {len(claims)} claim(s), {rels} relation(s).')


# ---------------------------------------------------------------- scaffold

def _slug(text):
    s = re.sub(r'[^0-9A-Za-z]+', '_', str(text)).strip('_').lower()
    return s if s and not s[0].isdigit() else f'c_{s}'


def cmd_scaffold(args):
    with open(args.result, newline='', encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise InputError(f'{args.result}: no rows')
    keys = [k.strip() for k in args.key.split(',')]
    for k in keys:
        if k not in rows[0]:
            raise InputError(f'--key {k} is not a column of {args.result}')
    columns = [c.strip() for c in args.columns.split(',')] if args.columns else [c for c in rows[0] if c not in keys]
    out, seen = [], set()
    for row in rows:
        for col in columns:
            if col not in row:
                raise InputError(f'--columns {col} is not a column of {args.result}')
            value = _num(row[col])
            if value is None:
                print(f'skipped non-numeric {col} at {[row[k] for k in keys]}: {row[col]!r}', file=sys.stderr)
                continue
            cid = _slug(args.prefix + '_'.join([col] + [row[k] for k in keys]))
            base, n = cid, 2
            while cid in seen:
                cid, n = f'{base}_{n}', n + 1
            seen.add(cid)
            out.append({
                'id': cid,
                'value': int(value) if value == int(value) else value,
                'source': args.source,
                'locate': {'where': {k: row[k] for k in keys}, 'column': col},
                'anchors': [],
            })
    json.dump(out, sys.stdout, indent=2)
    print()
    print(f'{len(out)} claim(s). Fill each "anchors" with the text that shows it, or replace it with "omit".', file=sys.stderr)
    return 0


# ---------------------------------------------------------------- reproduce

def cmd_reproduce(args):
    def load(path):
        with open(path, newline='', encoding='utf-8-sig') as fh:
            reader = csv.DictReader(fh)
            return list(reader.fieldnames or []), list(reader)

    cols_a, rows_a = load(args.delivered)
    cols_b, rows_b = load(args.rerun)
    keys = [k.strip() for k in args.key.split(',')]
    f = Findings()
    for side, cols in (('delivered', cols_a), ('rerun', cols_b)):
        for k in keys:
            if k not in cols:
                raise InputError(f'key column {k} is not in the {side} file')
    for c in cols_a:
        if c not in cols_b:
            f.fail('column', f'"{c}" is in the delivered file but not the rerun')
    for c in cols_b:
        if c not in cols_a:
            f.fail('column', f'"{c}" is in the rerun but not the delivered file')

    def index(rows, side):
        idx = {}
        for r in rows:
            k = tuple((r.get(c) or '').strip() for c in keys)
            if k in idx:
                f.fail('key', f'{side} has key {k} more than once')
            idx[k] = r
        return idx

    a, b = index(rows_a, 'delivered'), index(rows_b, 'rerun')
    for k in a:
        if k not in b:
            f.fail('row', f'{k} is in the delivered file but not the rerun')
    for k in b:
        if k not in a:
            f.fail('row', f'{k} is in the rerun but not the delivered file')
    shared = [c for c in cols_a if c in cols_b and c not in keys]
    drift = 0
    for k in a:
        if k not in b:
            continue
        for c in shared:
            va, vb = (a[k].get(c) or '').strip(), (b[k].get(c) or '').strip()
            if va == vb:
                continue
            na, nb = _num(va), _num(vb)
            if (va == '') != (vb == ''):
                f.fail('null', f'{k} {c}: delivered {va!r}, rerun {vb!r} (empty is not zero)')
            elif na is None or nb is None:
                f.fail('value', f'{k} {c}: delivered {va!r}, rerun {vb!r}')
            elif _close(na, nb):
                continue
            elif abs(na - nb) <= max(args.abs_tol, args.rel_tol * max(abs(na), abs(nb))):
                drift += 1
                f.warn('drift', f'{k} {c}: delivered {va}, rerun {vb} ({nb - na:+g})')
            else:
                f.fail('value', f'{k} {c}: delivered {va}, rerun {vb} ({nb - na:+g})')
    summary = f'{len(a)} row(s) x {len(shared)} column(s) compared on {", ".join(keys)}.'
    if drift and not f.fails:
        summary += (f' {drift} cell(s) differ within tolerance (rel {args.rel_tol:g}, abs {args.abs_tol:g}):'
                    ' report them as live-data drift, not as a match.')
    for line in f.fails + f.warns:
        print(line)
    verdict = 'FAIL' if f.fails else ('PASS WITH DRIFT' if drift else 'PASS')
    print(f'RESULT: {verdict}: {summary}')
    return 1 if f.fails else 0


# ---------------------------------------------------------------- changed

def _units(path):
    out = []
    for line in read_text(path).splitlines():
        for part in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9"\'(])', line):
            n = normalize(part)
            if n:
                out.append(n)
    return out


def cmd_changed(args):
    old, new = _units(args.old), _units(args.new)
    sm = difflib.SequenceMatcher(None, old, new, autojunk=False)
    changed = 0
    print('Changed text (re-check every + line):')
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == 'equal':
            continue
        for u in old[i1:i2]:
            print(f'  - {u}')
        for u in new[j1:j2]:
            print(f'  + {u}')
            changed += 1
    if not changed:
        print('  (none)')
    if bool(args.old_ledger) != bool(args.new_ledger):
        raise InputError('pass both --old-ledger and --new-ledger, or neither')
    if args.old_ledger:
        la, lb = load_json(args.old_ledger), load_json(args.new_ledger)
        ca = {c.get('id'): c for c in la.get('claims') or [] if isinstance(c, dict)}
        cb = {c.get('id'): c for c in lb.get('claims') or [] if isinstance(c, dict)}
        moved = {k for k in ca.keys() | cb.keys()
                 if json.dumps(ca.get(k), sort_keys=True) != json.dumps(cb.get(k), sort_keys=True)}
        src_moved = {k for k in (la.get('sources') or {}).keys() | (lb.get('sources') or {}).keys()
                     if json.dumps((la.get('sources') or {}).get(k), sort_keys=True)
                     != json.dumps((lb.get('sources') or {}).get(k), sort_keys=True)}
        moved |= {k for k, c in cb.items() if c.get('source') in src_moved}
        deps, frontier = set(), set(moved)
        while frontier:
            nxt = {k for k, c in cb.items() if 'expr' in c and expr_names(str(c['expr'])) & frontier} - moved - deps
            deps |= nxt
            frontier = nxt
        rels = [r.get('expr') if isinstance(r, dict) else r for r in lb.get('relations') or []]
        hit_rels = [r for r in rels if expr_names(str(r)) & (moved | deps)]
        print('Claims changed, added or removed: ' + (', '.join(sorted(k for k in moved if k)) or 'none'))
        print('Claims derived from them: ' + (', '.join(sorted(deps)) or 'none'))
        print('Relations touching them: ' + ('; '.join(hit_rels) or 'none'))
    print('Then run `check` on the whole final deliverable: a change can falsify a sentence it did not touch.')
    return 0


# ---------------------------------------------------------------- hash / receipt

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 16), b''):
            h.update(block)
    return h.hexdigest()


def cmd_hash(args):
    for p in args.files:
        print(f'{sha256(p)}  {p}')
    return 0


def cmd_receipt(args):
    with open(args.report, encoding='utf-8') as fh:
        report = fh.read()
    arts = set(re.findall(r'artifact-sha256:\s*`?([0-9a-f]{64})', report, re.I))
    ledgers = set(re.findall(r'ledger-sha256:\s*`?([0-9a-f]{64})', report, re.I))
    verdicts = re.findall(r'^\W*verdict:\s*\**\s*([A-Z]+)', report, re.I | re.M)
    verifier = re.findall(r'^\W*verifier:\s*(.+)$', report, re.I | re.M)
    f = Findings()
    for p in args.deliverables:
        if sha256(p) not in {a.lower() for a in arts}:
            f.fail('receipt', f'{p} is not the file that was verified (edited after the check, or never checked)')
    if sha256(args.ledger) not in {x.lower() for x in ledgers}:
        f.fail('receipt', f'{args.ledger} is not the ledger that was verified')
    if not verdicts:
        f.fail('receipt', 'no "verdict:" line')
    elif verdicts[-1].upper() != 'CLEAR':
        f.fail('receipt', f'verdict is {verdicts[-1].upper()}, not CLEAR')
    who = verifier[-1].strip() if verifier else ''
    if not who:
        f.fail('receipt', 'no "verifier:" line naming the model that checked it')
    for line in f.fails:
        print(line)
    if f.fails:
        print('RESULT: FAIL: this receipt does not cover these exact files.')
        return 1
    print(f'RESULT: PASS: verified as-is by {who}.')
    return 0


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('check', help='bind every number to a claim and every claim to a source')
    p.add_argument('ledger')
    p.add_argument('deliverables', nargs='+')
    p.add_argument('--stale-days', type=int, default=365)
    p.add_argument('--today', help='YYYY-MM-DD, for reproducible staleness checks')
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser('scaffold', help='print ledger claims for every numeric cell of a result CSV')
    p.add_argument('result')
    p.add_argument('--source', required=True)
    p.add_argument('--key', required=True, help='column(s) that identify a row, comma-separated')
    p.add_argument('--columns', help='comma-separated; default every non-key column')
    p.add_argument('--prefix', default='')
    p.set_defaults(fn=cmd_scaffold)

    p = sub.add_parser('reproduce', help='compare a delivered table with a fresh rerun of its saved query')
    p.add_argument('delivered')
    p.add_argument('rerun')
    p.add_argument('--key', required=True)
    p.add_argument('--rel-tol', type=float, default=0.0)
    p.add_argument('--abs-tol', type=float, default=0.0)
    p.set_defaults(fn=cmd_reproduce)

    p = sub.add_parser('changed', help='list what a fix pass changed, for the re-check')
    p.add_argument('old')
    p.add_argument('new')
    p.add_argument('--old-ledger')
    p.add_argument('--new-ledger')
    p.set_defaults(fn=cmd_changed)

    p = sub.add_parser('hash', help='sha256 of files, for a verification receipt')
    p.add_argument('files', nargs='+')
    p.set_defaults(fn=cmd_hash)

    p = sub.add_parser('receipt', help='confirm a verification report covers these exact files')
    p.add_argument('report')
    p.add_argument('ledger')
    p.add_argument('deliverables', nargs='+')
    p.set_defaults(fn=cmd_receipt)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except InputError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    except OSError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
