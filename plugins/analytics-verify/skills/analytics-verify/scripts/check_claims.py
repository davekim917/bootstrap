#!/usr/bin/env python3
"""Mechanical claim checks for analytics deliverables. Python 3.8+, standard library only.

A PASS means every number in the deliverable is accounted for by a claim in the ledger
and every claim is bound to its source. It is not an independent verification: a wrong
source, a misread menu, or a false sentence built from correct numbers all pass.

  check     LEDGER DELIVERABLE...   account for every number; bind claims to sources
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
from decimal import Decimal, InvalidOperation, localcontext

MECHANICAL_ONLY = (
    'Mechanical check only: it shows the numbers match the ledger and the ledger matches '
    'its files. It does not show the sources or the sentences are right.'
)


class InputError(Exception):
    """The input cannot be checked at all (exit 2), as opposed to a finding (exit 1)."""


def dec(value) -> Decimal | None:
    """Exact decimal of a JSON number or numeric string; None for anything else,
    including booleans, NaN and infinities."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return d if d.is_finite() else None


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
_URL = re.compile(r'(?:https?://|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/\S*', re.I)
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

_NUM = re.compile(r'(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?')
_CURRENCY_CODES = {'usd', 'us', 'eur', 'gbp', 'cad', 'aud', 'nzd', 'jpy', 'inr', 'rs', 'mxn', 'chf', 'cny', 'sgd', 'hkd'}
_SCALE = re.compile(r'\s?(thousand|million|billion|trillion)\b|(bn|mm|[kKmMbB])(?![A-Za-z])')
_SCALE_MULT = {'thousand': Decimal(10) ** 3, 'million': Decimal(10) ** 6, 'billion': Decimal(10) ** 9,
               'trillion': Decimal(10) ** 12, 'k': Decimal(10) ** 3, 'm': Decimal(10) ** 6,
               'mm': Decimal(10) ** 6, 'b': Decimal(10) ** 9, 'bn': Decimal(10) ** 9}
_PCT = re.compile(r'\s?(%|percent\b|per cent\b|pct\b|pp\b|percentage points?\b)', re.I)
_CMP = re.compile(
    r'(not more than|not less than|not fewer than|more than|greater than|over|above|exceeding|at least|'
    r'no less than|no fewer than|less than|fewer than|under|below|at most|up to|no more than|about|'
    r'around|approximately|approx\.?|roughly|nearly|almost|~|\u2248|<=|>=|\u2264|\u2265|<|>)\s*$',
    re.I,
)
_CMP_OP = {
    'more than': 'gt', 'greater than': 'gt', 'over': 'gt', 'above': 'gt', 'exceeding': 'gt', '>': 'gt',
    'at least': 'gte', 'no less than': 'gte', 'no fewer than': 'gte', 'not less than': 'gte',
    'not fewer than': 'gte', '>=': 'gte', '\u2265': 'gte',
    'less than': 'lt', 'fewer than': 'lt', 'under': 'lt', 'below': 'lt', '<': 'lt',
    'at most': 'lte', 'up to': 'lte', 'no more than': 'lte', 'not more than': 'lte', '<=': 'lte', '\u2264': 'lte',
    'nearly': 'near', 'almost': 'near',
}
PCT_UNITS = {'%', 'pct', 'percent', 'pp', 'percentage points'}

_SMALL = {w: i for i, w in enumerate(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
    'sixteen seventeen eighteen nineteen'.split())}
_TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90}
_BIG = {'thousand': 10 ** 3, 'million': 10 ** 6, 'billion': 10 ** 9}
_NUMBER_WORDS = set(_SMALL) | set(_TENS) | set(_BIG) | {'hundred', 'dozen'}


class Token:
    __slots__ = ('start', 'end', 'text', 'value', 'step', 'pct', 'sign', 'op')

    def __init__(self, start, end, text, value, step, pct=False, sign='', op='eq'):
        self.start, self.end, self.text = start, end, text
        self.value, self.step, self.pct, self.sign, self.op = value, step, pct, sign, op

    def __repr__(self):
        return f'Token({self.text!r}, {self.sign}{self.value}, op={self.op})'


def _comparator(text: str, lead: int) -> str:
    m = _CMP.search(text[max(0, lead - 24):lead])
    if not m:
        return 'eq'
    word = re.sub(r'\s+', ' ', m.group(1).lower()).rstrip('.')
    return _CMP_OP.get(word, 'eq')  # about/around/~/roughly: still exact at the shown precision


def _suffixes(text, end):
    """Scale, percent and a trailing "+" after a number. Returns (end, mult, pct, plus)."""
    mult = Decimal(1)
    sm = _SCALE.match(text, end)
    if sm:
        mult = _SCALE_MULT[(sm.group(1) or sm.group(2)).lower()]
        end = sm.end()
    pm = _PCT.match(text, end)
    if pm:
        end = pm.end()
    plus = end < len(text) and text[end] == '+'
    return end + (1 if plus else 0), mult, bool(pm), plus


def _word_numbers(text):
    """Spelled-out quantities as (start, end, value). "one" counts only inside a larger
    phrase ("one hundred"), and "a" only before a multiplier ("a dozen"), or every
    "no one" and "a store" would need a claim."""
    words = [(m.start(), m.end(), m.group(0).lower()) for m in re.finditer(r'[A-Za-z]+', text)]
    multipliers = {'hundred', 'dozen'} | set(_BIG)
    out, i, n = [], 0, len(words)
    while i < n:
        seq, j = [], i
        while j < n:
            s, e, w = words[j]
            if seq:
                gap = text[seq[-1][1]:s]
                if not (gap in (' ', '-') or (gap == ' and ' and seq[-1][2] == 'hundred')):
                    break
            if w == 'and' and seq and seq[-1][2] == 'hundred':
                j += 1
                continue
            if w == 'a' and not seq and j + 1 < n and words[j + 1][2] in multipliers and text[e:words[j + 1][0]] == ' ':
                seq.append(words[j])
            elif w in _NUMBER_WORDS:
                seq.append(words[j])
            else:
                break
            j += 1
        names = [w for _, _, w in seq]
        if not seq or names == ['one']:
            i = max(j, i + 1)
            continue
        total, current = 0, 0
        for w in names:
            if w in _SMALL:
                current += _SMALL[w]
            elif w in _TENS:
                current += _TENS[w]
            elif w == 'a':
                current = 1
            elif w == 'hundred':
                current = max(current, 1) * 100
            elif w == 'dozen':
                current = max(current, 1) * 12
            else:
                total += max(current, 1) * _BIG[w]
                current = 0
        out.append((seq[0][0], seq[-1][1], total + current))
        i = j
    return out


def tokenize(text: str):
    """Every number in normalized text, and the identifiers skipped. A digit run right after
    letters (Q1, H2, B03001) is an identifier, unless the letters are a currency code."""
    tokens: list[Token] = []
    skipped: list[str] = []
    for m in _NUM.finditer(text):
        s, e = m.span()
        lead = s
        if s and (text[s - 1].isalpha() or text[s - 1] == '_'):
            j = s
            while j and text[j - 1].isalpha():
                j -= 1
            if text[j:s].lower() in _CURRENCY_CODES and (j == 0 or not text[j - 1].isalnum()):
                lead = j
            else:
                skipped.append(text[j:e])
                continue
        sign = ''
        if lead and text[lead - 1] in '$\u20ac\u00a3':
            lead -= 1
        if lead and text[lead - 1] in '+-' and (lead < 2 or not text[lead - 2].isalnum()):
            sign, lead = text[lead - 1], lead - 1
        if lead and text[lead - 1] in '$\u20ac\u00a3':
            lead -= 1
        raw = m.group(0).replace(',', '')
        value = Decimal(raw)
        end, mult, pct, plus = _suffixes(text, e)
        step = Decimal(1).scaleb(value.as_tuple().exponent) * mult
        op = 'gte' if plus else _comparator(text, lead)
        tokens.append(Token(s, end, text[s:end], value * mult, step, pct, sign, op))
    for s, e, value in _word_numbers(text):
        if any(t.start < e and s < t.end for t in tokens):
            continue  # "5 million": the digits already carry the word as their scale
        end, mult, pct, plus = _suffixes(text, e)
        op = 'gte' if plus else _comparator(text, s)
        tokens.append(Token(s, end, text[s:end], Decimal(value) * mult, mult, pct, '', op))
    tokens.sort(key=lambda t: t.start)
    return tokens, skipped


def _unit_value(tok: Token, value: Decimal, unit, magnitude: bool):
    """The ledger value in the token's terms, or None when they can't be compared."""
    unit = (unit or '').strip().lower()
    v = value
    if tok.pct:
        if unit == 'ratio':
            v *= 100
        elif unit not in PCT_UNITS:
            return None
    elif unit in PCT_UNITS or unit == 'ratio':
        return None
    if v < 0 and not tok.sign:
        if not magnitude:
            return None  # an unsigned display of a negative value needs "magnitude": true
        v = -v
    return v


def _shown(tok: Token) -> Decimal:
    return -tok.value if tok.sign == '-' else tok.value


def displays(tok: Token, value: Decimal, unit=None, magnitude=False, bound=None) -> bool:
    """Whether a displayed number faithfully shows a ledger value: equal at the precision
    shown, or true under the comparator shown. A value the source gives only as a bound
    ("50+") is shown faithfully only with that same bound."""
    v = _unit_value(tok, value, unit, magnitude)
    if v is None:
        return False
    x, half = _shown(tok), tok.step / 2
    if bound:
        return tok.op == bound and abs(v - x) <= half
    if tok.op == 'gt':
        return v > x
    if tok.op == 'gte':
        return v >= x
    if tok.op == 'lt':
        return v < x
    if tok.op == 'lte':
        return v <= x
    if tok.op == 'near':
        return v <= x and abs(v - x) <= half
    return abs(v - x) <= half


# ---------------------------------------------------------------- dates

_MONTHS = {m: i for i, m in enumerate(
    'jan feb mar apr may jun jul aug sep oct nov dec'.split(), start=1)}
_MON = r'(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?'
_DATE_PATTERNS = [
    ('ymd', re.compile(r'\b(\d{4})-(\d{1,2})-(\d{1,2})\b')),
    ('mdy', re.compile(r'\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b')),
    ('Mdy', re.compile(r'\b' + _MON + r'\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?', re.I)),
    ('My', re.compile(r'\b' + _MON + r'\s+(\d{4})\b', re.I)),
    ('hm12', re.compile(r'\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![A-Za-z])', re.I)),
    ('hm24', re.compile(r'\b(\d{1,2}):(\d{2})\b')),
    ('y', re.compile(r'\b(1[89]\d{2}|2[01]\d{2})\b')),
]


def parse_when(value):
    """(date, time or None) for an ISO date or datetime string, else None."""
    if not isinstance(value, str):
        return None
    text = value.strip().replace('Z', '+00:00')
    try:
        if len(text) == 10:
            return dt.date.fromisoformat(text), None
        stamp = dt.datetime.fromisoformat(text)
        return stamp.date(), stamp.time()
    except ValueError:
        return None


def _year(s):
    y = int(s)
    return y + 2000 if y < 100 else y


def date_matches(segment: str, when):
    """Date displays in an anchor, each checked in its own role (month as month, day as
    day). Returns a list of (start, end, ok, shown)."""
    day, clock = when
    taken, out = [], []
    for kind, rx in _DATE_PATTERNS:
        for m in rx.finditer(segment):
            if any(m.start() < e and s < m.end() for s, e in taken):
                continue
            g = m.groups()
            if kind == 'ymd':
                ok = (int(g[0]), int(g[1]), int(g[2])) == (day.year, day.month, day.day)
            elif kind == 'mdy':
                ok = (int(g[0]), int(g[1])) == (day.month, day.day) and (g[2] is None or _year(g[2]) == day.year)
            elif kind == 'Mdy':
                ok = (_MONTHS[g[0][:3].lower()], int(g[1])) == (day.month, day.day) and (g[2] is None or int(g[2]) == day.year)
            elif kind == 'My':
                ok = (_MONTHS[g[0][:3].lower()], int(g[1])) == (day.month, day.year)
            elif kind == 'hm12':
                hour = int(g[0]) % 12 + (12 if g[2].lower().startswith('p') else 0)
                ok = clock is not None and (hour, int(g[1] or 0)) == (clock.hour, clock.minute)
            elif kind == 'hm24':
                ok = clock is not None and (int(g[0]), int(g[1])) == (clock.hour, clock.minute)
            else:
                ok = int(g[0]) == day.year
            taken.append(m.span())
            out.append((m.start(), m.end(), ok, m.group(0)))
    return out


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


def cell_number(cell):
    """(Decimal, shape) for a table cell. shape records % and currency marks so a unit
    change is not mistaken for equality. Decimal is None for text and non-finite values."""
    s = str(cell).strip()
    shape = ('%' if s.endswith('%') else '') + ('$' if s.startswith(('$', '-$')) else '')
    core = s.rstrip('%').replace(',', '').replace('$', '').replace(' ', '')
    return dec(core), shape


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        raise InputError(f'{path}: not found')
    except json.JSONDecodeError as exc:
        raise InputError(f'{path}: not valid JSON ({exc})')


def load_table(path):
    """A CSV as (header, rows). Duplicate column names or ragged rows make it unusable:
    a dict reader would silently keep only one of two same-named columns."""
    try:
        with open(path, newline='', encoding='utf-8-sig') as fh:
            rows = list(csv.reader(fh))
    except FileNotFoundError:
        raise InputError(f'{path}: not found')
    if not rows:
        raise InputError(f'{path}: empty')
    header = [h.strip() for h in rows[0]]
    dups = sorted({h for h in header if header.count(h) > 1})
    if dups:
        raise InputError(f'{path}: duplicate column name(s) {dups}')
    body = []
    for n, row in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in row):
            continue
        if len(row) != len(header):
            raise InputError(f'{path}: line {n} has {len(row)} fields; the header has {len(header)}')
        body.append(dict(zip(header, row)))
    return header, body


def _parse_date(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


class _Eval:
    OPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
           ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b}

    def __init__(self, values):
        self.values = values

    def run(self, node):
        if isinstance(node, ast.Expression):
            return self.run(node.body)
        if isinstance(node, ast.BinOp) and type(node.op) in self.OPS:
            left, right = self.run(node.left), self.run(node.right)
            if isinstance(node.op, ast.Div) and right == 0:
                raise ValueError('division by zero')
            return self.OPS[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = self.run(node.operand)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.Constant) and dec(node.value) is not None:
            return dec(node.value)
        if isinstance(node, ast.Name):
            if node.id not in self.values:
                raise ValueError(f'unknown or non-numeric claim "{node.id}"')
            return self.values[node.id]
        raise ValueError('only claim ids, numbers, + - * / and parentheses are allowed')


def expr_names(expr: str) -> set[str]:
    try:
        tree = ast.parse(expr, mode='eval')
    except SyntaxError:
        return set()
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}


def evaluate(expr: str, values: dict) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 50
        return _Eval(values).run(ast.parse(expr, mode='eval'))


_REL_OPS = {ast.Eq: '==', ast.LtE: '<=', ast.GtE: '>=', ast.Lt: '<', ast.Gt: '>'}


def check_relation(expr: str, values: dict, tolerance: Decimal):
    tree = ast.parse(expr, mode='eval').body
    if not (isinstance(tree, ast.Compare) and len(tree.ops) == 1 and type(tree.ops[0]) in _REL_OPS):
        raise ValueError('a relation is one comparison: ==, <=, >=, < or >')
    with localcontext() as ctx:
        ctx.prec = 50
        left = _Eval(values).run(tree.left)
        right = _Eval(values).run(tree.comparators[0])
    op = _REL_OPS[type(tree.ops[0])]
    if op == '==':
        ok = abs(left - right) <= tolerance
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
            self.cache[p] = load_table(p)
        return self.cache[p]

    def json(self, rel):
        p = self.path(rel)
        if p not in self.cache:
            self.cache[p] = load_json(p)
        return self.cache[p]


def _json_get(doc, path):
    cur = doc
    for part in re.findall(r'[^.\[\]]+|\[\d+\]', path):
        cur = cur[int(part[1:-1])] if part.startswith('[') else cur[part]
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
        header, rows = tables.rows(table)
        for col in [column, *where]:
            if col not in header:
                return None, f'column "{col}" is not in {table}'
        hits = [r for r in rows if all(r[k].strip() == str(v).strip() for k, v in where.items())]
        if len(hits) != 1:
            return None, f'{len(hits)} rows of {table} match {where}; exactly one must'
        return hits[0][column], None
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        return None, f'cannot read {table}: {exc}'


def _number_labels(text):
    return {t.value for t in tokenize(normalize(str(text)))[0] if not t.pct and not t.sign}


class Claim:
    """A ledger claim with everything the deliverable check needs."""

    def __init__(self, raw):
        self.raw = raw
        self.id = raw['id']
        self.value = dec(raw.get('value'))
        self.when = parse_when(raw.get('value')) if self.value is None else None
        self.unit = raw.get('unit')
        self.magnitude = raw.get('magnitude') is True
        self.bound = None
        self.labels: set[Decimal] = set()


def check_ledger(ledger, base, today, stale_days, f: Findings):
    """Schema, source metadata, cell binding, quotes, derived values and relations.
    Returns {claim_id: Claim}."""
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

    by_id: dict[str, Claim] = {}
    for i, raw in enumerate(claims):
        if not isinstance(raw, dict):
            f.fail('claim', f'claims[{i}] is not an object')
            continue
        cid = raw.get('id')
        if not isinstance(cid, str) or not _ID.match(cid):
            f.fail('claim', f'claims[{i}]: id must look like a variable name (letters, digits, _)')
            continue
        if cid in by_id:
            f.fail('claim', f'{cid}: duplicate id')
            continue
        claim = Claim(raw)
        by_id[cid] = claim
        value = raw.get('value')
        if claim.value is None and not (isinstance(value, str) and value.strip() and dec(value) is None):
            f.fail('claim', f'{cid}: value must be a finite number or non-empty text')
        has_src, has_expr = 'source' in raw, 'expr' in raw
        if has_src == has_expr:
            f.fail('claim', f'{cid}: give exactly one of "source" or "expr"')
        anchors, omit = raw.get('anchors'), raw.get('omit')
        if anchors is not None and omit is not None:
            f.fail('claim', f'{cid}: give "anchors" or "omit", not both')
        elif anchors is None and not (isinstance(omit, str) and omit.strip()):
            f.fail('omitted', f'{cid}: not shown in the deliverable. Add "anchors", or "omit" with the reason it is left out')
        loc = raw.get('locate')
        if isinstance(loc, dict) and isinstance(loc.get('where'), dict):
            for v in loc['where'].values():
                claim.labels |= _number_labels(v)
        quote = raw.get('quote')
        for label in raw.get('labels') or []:
            d = dec(label)
            if d is None or d not in (_number_labels(quote) if quote else set()):
                f.fail('label', f'{cid}: label {label!r} must appear as a number in this claim\'s "quote"')
            else:
                claim.labels.add(d)
        if not has_src:
            continue
        src = sources.get(raw['source'])
        if not isinstance(src, dict):
            f.fail('claim', f'{cid}: source "{raw["source"]}" is not declared')
            continue
        kind = src.get('type')
        if kind in ('query', 'file') and claim.value is not None:
            if 'locate' not in raw:
                f.fail('retyped', f'{cid}: a number from {raw["source"]} must be read from its file ("locate"), not typed')
            else:
                cell, err = _locate(raw, src, tables)
                if err:
                    f.fail('bind', f'{cid}: {err}')
                else:
                    got = dec(cell) if isinstance(cell, (int, float)) else cell_number(cell)[0]
                    if got is None:
                        f.fail('bind', f'{cid}: the located cell is empty or not a finite number ({cell!r})')
                    elif got != claim.value:
                        f.fail('bind', f'{cid}: ledger says {value} but {src.get("result") or src.get("path")} says {cell}')
        if kind == 'web' and not (isinstance(quote, str) and quote.strip()):
            f.fail('quote', f'{cid}: a web claim needs the exact source text it rests on ("quote")')
        elif isinstance(quote, str) and quote.strip() and claim.value is not None:
            shown = tokenize(normalize(quote))[0]
            exact = [t for t in shown if t.op in ('eq',) and displays(t, claim.value, claim.unit, claim.magnitude)]
            bounds = [t for t in shown if t.op != 'eq' and displays(t, claim.value, claim.unit, claim.magnitude, bound=t.op)]
            if exact:
                pass
            elif bounds:
                claim.bound = bounds[0].op  # the source gives only a bound ("50+"); displays must keep it
            else:
                f.fail('quote', f'{cid}: the quote does not show {value} ({quote.strip()[:80]!r})')

    numeric = {k: c.value for k, c in by_id.items() if c.value is not None}
    for cid, claim in by_id.items():
        if 'expr' not in claim.raw:
            continue
        expr = str(claim.raw['expr'])
        names = expr_names(expr)
        if not names:
            f.fail('derived', f'{cid}: "expr" must derive from other claims; a bare number needs a source')
            continue
        try:
            got = evaluate(expr, numeric)
        except (ValueError, SyntaxError, ArithmeticError) as exc:
            f.fail('derived', f'{cid}: cannot evaluate {expr!r}: {exc}')
            continue
        if claim.value is None or got != claim.value:
            f.fail('derived', f'{cid}: {expr} = {got}, ledger says {claim.raw.get("value")}')
    _check_derivation_roots(by_id, f)

    for i, rel in enumerate(ledger.get('relations') or []):
        expr = rel.get('expr') if isinstance(rel, dict) else rel
        tol = dec(rel.get('tolerance', 0)) if isinstance(rel, dict) else Decimal(0)
        try:
            ok, left, right = check_relation(str(expr), numeric, tol if tol is not None else Decimal(0))
        except (ValueError, SyntaxError, ArithmeticError) as exc:
            f.fail('relation', f'relations[{i}] {expr!r}: {exc}')
            continue
        if not ok:
            f.fail('relation', f'{expr}: left side is {left}, right side is {right}')
    return by_id


def _check_derivation_roots(by_id, f: Findings):
    """Every derived claim must bottom out in sourced claims, with no cycles."""
    state: dict[str, str] = {}

    def visit(cid, path):
        claim = by_id.get(cid)
        if claim is None or 'expr' not in claim.raw:
            return
        if state.get(cid) == 'done':
            return
        if state.get(cid) == 'active':
            f.fail('derived', f'{" -> ".join(path + [cid])}: claims derive from each other in a circle')
            return
        state[cid] = 'active'
        for name in expr_names(str(claim.raw['expr'])):
            visit(name, path + [cid])
        state[cid] = 'done'

    for cid in by_id:
        visit(cid, [])


def _occurrences(text, needle):
    out, i = [], text.find(needle)
    while needle and i != -1:
        out.append((i, i + len(needle)))
        i = text.find(needle, i + len(needle))
    return out


def _residue(snippet, tokens_inside, start):
    """The snippet with the given numbers blanked out."""
    rest = list(snippet)
    for t in tokens_inside:
        for k in range(t.start - start, t.end - start):
            if 0 <= k < len(rest):
                rest[k] = ' '
    return ''.join(rest)


def check_deliverables(paths, claims, exempt, f: Findings):
    texts = {p: normalize(read_text(p)) for p in paths}
    tokenized = {p: tokenize(t) for p, t in texts.items()}
    tokens = {p: tokenized[p][0] for p in paths}
    accounted = {p: set() for p in paths}   # indices of tokens some claim accounts for
    in_anchor = {p: {} for p in paths}      # index -> ids of claims whose anchor holds it
    exempt_spans = {p: [] for p in paths}
    labels_used = 0

    for claim in claims.values():
        anchors = claim.raw.get('anchors')
        if anchors is None:
            continue
        if isinstance(anchors, str):
            anchors = [anchors]
        if not isinstance(anchors, list) or not anchors:
            f.fail('anchor', f'{claim.id}: "anchors" must be a non-empty list of text copied from the deliverable')
            continue
        for anchor in anchors:
            na = normalize(str(anchor))
            found = False
            for p in paths:
                for (s, e) in _occurrences(texts[p], na):
                    found = True
                    inside = [(i, t) for i, t in enumerate(tokens[p]) if t.start >= s and t.end <= e]
                    for i, _ in inside:
                        in_anchor[p].setdefault(i, []).append(claim.id)
                    shown_value = []
                    if claim.value is not None:
                        for i, t in inside:
                            if displays(t, claim.value, claim.unit, claim.magnitude, claim.bound):
                                accounted[p].add(i)
                                shown_value.append(t)
                        if not shown_value:
                            got = ', '.join(t.text for _, t in inside) or 'no whole number'
                            note = f' (the source gives only "{claim.bound}" this value)' if claim.bound else ''
                            f.fail('anchor', f'{claim.id}: "{na}" shows {got}; the ledger value is '
                                             f'{claim.raw.get("value")}{claim.unit or ""}{note}')
                        elif not re.search(r'[A-Za-z0-9]', _residue(texts[p][s:e], shown_value, s)):
                            f.fail('anchor', f'{claim.id}: "{na}" is a bare number; include the words that say what it counts')
                    elif claim.when is not None:
                        dates = date_matches(texts[p][s:e], claim.when)
                        for ds, de, ok, shown in dates:
                            if not ok:
                                f.fail('anchor', f'{claim.id}: "{na}" shows {shown}; the date is {claim.raw.get("value")}')
                            for i, t in inside:
                                if ds <= t.start - s and t.end - s <= de:
                                    accounted[p].add(i)
                        if not any(ok for *_, ok, _ in dates):
                            f.fail('anchor', f'{claim.id}: "{na}" shows no part of {claim.raw.get("value")}')
                    for i, t in inside:
                        if i not in accounted[p] and t.op == 'eq' and not t.pct and not t.sign and t.value in claim.labels:
                            accounted[p].add(i)
                            labels_used += 1
            if not found:
                f.fail('anchor', f'{claim.id}: "{na}" is not in the deliverable (edited since the ledger was written?)')

    for snippet in exempt or []:
        ns = normalize(str(snippet))
        hits = [(p, span) for p in paths for span in _occurrences(texts[p], ns)]
        if not hits:
            f.warn('exempt', f'"{ns}" is not in the deliverable; remove it from "exempt"')
            continue
        p0, (s0, e0) = hits[0]
        inside0 = [t for t in tokens[p0] if t.start >= s0 and t.end <= e0]
        if len(inside0) < 2 and not re.search(r'[A-Za-z]', _residue(texts[p0][s0:e0], inside0, s0)):
            f.fail('exempt', f'"{ns}" is a bare number; exempt the address, phone or name it belongs to')
            continue
        for p, span in hits:
            exempt_spans[p].append(span)

    total = 0
    for p in paths:
        for i, t in enumerate(tokens[p]):
            total += 1
            if i in accounted[p] or any(s <= t.start and t.end <= e for s, e in exempt_spans[p]):
                continue
            around = texts[p][max(0, t.start - 50):t.end + 50]
            if i in in_anchor[p]:
                f.fail('unbound', f'"{t.text}" sits in the anchor for {", ".join(in_anchor[p][i])} but no claim '
                                  f'accounts for it: give it its own claim (a range is two claims), or a label '
                                  f'if it names the row: ...{around}...')
                continue
            cands = [c.id for c in claims.values() if c.value is not None
                     and displays(t, c.value, c.unit, c.magnitude, c.bound)][:3]
            hint = f' (value matches {", ".join(cands)}: anchor it)' if cands else ''
            f.fail('unbound', f'"{t.text}" is not bound to any claim{hint}: ...{around}...')
        skipped = tokenized[p][1]
        if skipped:
            shown = ', '.join(sorted(set(skipped))[:12])
            f.note('skipped', f'{p}: read as identifiers, not quantities: {shown}')
    if labels_used:
        f.note('labels', f'{labels_used} number(s) accepted as row or name labels; the verifier should read them')
    return total


def cmd_check(args):
    ledger = load_json(args.ledger)
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    f = Findings()
    claims = check_ledger(ledger, os.path.dirname(os.path.abspath(args.ledger)), today, args.stale_days, f)
    total = check_deliverables(args.deliverables, claims, ledger.get('exempt'), f)
    rels = len(ledger.get('relations') or [])
    return f.emit(f'{total} number(s) in {len(args.deliverables)} file(s), {len(claims)} claim(s), {rels} relation(s).')


# ---------------------------------------------------------------- scaffold

def _slug(text):
    s = re.sub(r'[^0-9A-Za-z]+', '_', str(text)).strip('_').lower()
    return s if s and not s[0].isdigit() else f'c_{s}'


def cmd_scaffold(args):
    header, rows = load_table(args.result)
    if not rows:
        raise InputError(f'{args.result}: no rows')
    keys = [k.strip() for k in args.key.split(',')]
    for k in keys:
        if k not in header:
            raise InputError(f'--key {k} is not a column of {args.result}')
    columns = [c.strip() for c in args.columns.split(',')] if args.columns else [c for c in header if c not in keys]
    for col in columns:
        if col not in header:
            raise InputError(f'--columns {col} is not a column of {args.result}')
    out, seen = [], set()
    for row in rows:
        for col in columns:
            value, shape = cell_number(row[col])
            if value is None:
                print(f'skipped non-numeric {col} at {[row[k] for k in keys]}: {row[col]!r}', file=sys.stderr)
                continue
            cid = _slug(args.prefix + '_'.join([col] + [row[k] for k in keys]))
            base, n = cid, 2
            while cid in seen:
                cid, n = f'{base}_{n}', n + 1
            seen.add(cid)
            claim = {
                'id': cid,
                'value': int(value) if value == value.to_integral_value() else float(value),
                'source': args.source,
                'locate': {'where': {k: row[k] for k in keys}, 'column': col},
                'anchors': [],
            }
            if '%' in shape:
                claim['unit'] = '%'
            out.append(claim)
    json.dump(out, sys.stdout, indent=2)
    print()
    print(f'{len(out)} claim(s). Fill each "anchors" with the text that shows it, or replace it with "omit".', file=sys.stderr)
    return 0


# ---------------------------------------------------------------- reproduce

def cmd_reproduce(args):
    cols_a, rows_a = load_table(args.delivered)
    cols_b, rows_b = load_table(args.rerun)
    keys = [k.strip() for k in args.key.split(',')]
    rel_tol, abs_tol = dec(args.rel_tol), dec(args.abs_tol)
    if rel_tol is None or abs_tol is None or rel_tol < 0 or abs_tol < 0:
        raise InputError('--rel-tol and --abs-tol must be finite and non-negative')
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
            k = tuple(r[c].strip() for c in keys)
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
            va, vb = a[k][c].strip(), b[k][c].strip()
            if va == vb:
                continue
            (na, shape_a), (nb, shape_b) = cell_number(va), cell_number(vb)
            if (va == '') != (vb == ''):
                f.fail('null', f'{k} {c}: delivered {va!r}, rerun {vb!r} (empty is not zero)')
            elif na is None or nb is None or shape_a != shape_b:
                f.fail('value', f'{k} {c}: delivered {va!r}, rerun {vb!r}')
            elif na == nb:
                continue  # same number, different formatting
            elif abs(na - nb) <= max(abs_tol, rel_tol * max(abs(na), abs(nb))):
                drift += 1
                f.warn('drift', f'{k} {c}: delivered {va}, rerun {vb} ({nb - na:+})')
            else:
                f.fail('value', f'{k} {c}: delivered {va}, rerun {vb} ({nb - na:+})')
    summary = f'{len(a)} row(s) x {len(shared)} column(s) compared on {", ".join(keys)}.'
    if drift and not f.fails:
        summary += (f' {drift} cell(s) differ within tolerance (rel {args.rel_tol}, abs {args.abs_tol}):'
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
    if bool(args.old_ledger) != bool(args.new_ledger):
        raise InputError('pass both --old-ledger and --new-ledger, or neither')
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
    if args.old_ledger:
        la, lb = load_json(args.old_ledger), load_json(args.new_ledger)
        ca = {c.get('id'): c for c in la.get('claims') or [] if isinstance(c, dict)}
        cb = {c.get('id'): c for c in lb.get('claims') or [] if isinstance(c, dict)}
        moved = {k for k in ca.keys() | cb.keys()
                 if json.dumps(ca.get(k), sort_keys=True) != json.dumps(cb.get(k), sort_keys=True)}
        sa, sb = la.get('sources') or {}, lb.get('sources') or {}
        src_moved = {k for k in sa.keys() | sb.keys()
                     if json.dumps(sa.get(k), sort_keys=True) != json.dumps(sb.get(k), sort_keys=True)}
        moved |= {k for k, c in cb.items() if c.get('source') in src_moved}
        deps, frontier = set(), set(moved)
        while frontier:
            nxt = {k for k, c in cb.items() if 'expr' in c and expr_names(str(c['expr'])) & frontier} - moved - deps
            deps |= nxt
            frontier = nxt
        rels = [r.get('expr') if isinstance(r, dict) else r for r in lb.get('relations') or []]
        hit_rels = [str(r) for r in rels if expr_names(str(r)) & (moved | deps)]
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


_META = re.compile(r'^\s*(artifact-sha256|ledger-sha256|verifier|verdict)\s*:\s*(.*?)\s*$', re.I)
_OPEN_SECTIONS = ('wrong', 'stale', 'unsupported')


def _open_findings(lines):
    """Lines of real content under the Wrong / Stale / Unsupported headings."""
    counts, current, in_table = {}, None, False
    for line in lines:
        heading = re.match(r'^\s*#{2,}\s*(.*)$', line)
        if heading:
            title = heading.group(1).strip().lower()
            current = next((k for k in _OPEN_SECTIONS if title.startswith(k)), None)
            if current:
                counts.setdefault(current, 0)
            in_table = False
            continue
        if current is None:
            continue
        s = line.strip()
        if not s or re.fullmatch(r'[-*]?\s*\(?(none|n/a|nothing)\)?\.?', s, re.I):
            in_table = False
            continue
        if s.startswith('|'):
            if re.fullmatch(r'\|?[\s:|-]+\|?', s):
                continue
            if not in_table:
                in_table = True  # the table's header row
                continue
        counts[current] += 1
    return counts


def cmd_receipt(args):
    with open(args.report, encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    f = Findings()
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    header = []
    while i < len(lines) and _META.match(lines[i]):
        header.append(_META.match(lines[i]).groups())
        i += 1
    for line in lines[i:]:
        if _META.match(line):
            f.fail('receipt', f'"{line.strip()[:60]}" is outside the header block at the top of the report')
    fields: dict[str, list[str]] = {}
    for key, value in header:
        fields.setdefault(key.lower(), []).append(value.strip('`* '))
    for key in ('ledger-sha256', 'verifier', 'verdict'):
        if len(fields.get(key, [])) != 1:
            f.fail('receipt', f'the header needs exactly one "{key}:" line (found {len(fields.get(key, []))})')
    arts = {v.split()[0].lower() for v in fields.get('artifact-sha256', []) if v}
    for p in args.deliverables:
        if sha256(p) not in arts:
            f.fail('receipt', f'{p} is not the file that was verified (edited after the check, or never checked)')
    if [v.lower() for v in fields.get('ledger-sha256', [''])][:1] != [sha256(args.ledger)]:
        f.fail('receipt', f'{args.ledger} is not the ledger that was verified')
    verdict = (fields.get('verdict') or [''])[0].upper()
    who = (fields.get('verifier') or [''])[0]
    if verdict != 'CLEAR':
        f.fail('receipt', f'verdict is {verdict or "missing"}, not CLEAR')
    if not who:
        f.fail('receipt', 'no verifier named')
    open_counts = _open_findings(lines[i:])
    for section in _OPEN_SECTIONS:
        if section not in open_counts:
            f.fail('receipt', f'the report has no "{section.capitalize()}" section')
        elif open_counts[section] and verdict == 'CLEAR':
            f.fail('receipt', f'CLEAR with {open_counts[section]} open item(s) under "{section.capitalize()}"')
    for line in f.fails:
        print(line)
    if f.fails:
        print('RESULT: FAIL: this receipt does not cover these exact files with a clean verdict.')
        return 1
    print(f'RESULT: PASS: verified as-is by {who}. A receipt shows what a verifier wrote, not who wrote it.')
    return 0


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('check', help='account for every number and bind every claim to a source')
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
    p.add_argument('--rel-tol', default='0')
    p.add_argument('--abs-tol', default='0')
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
