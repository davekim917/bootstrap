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

    def __init__(self, links=False):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.links = links

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append('\n')
        elif tag == 'a' and self.links and not self.skip and dict(attrs).get('href'):
            self.parts.append(f' [link]({dict(attrs)["href"]}) ')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def read_text(path: str, links=False) -> str:
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
        parser = _HTMLText(links)
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
BOUNDARY = '\u2016'  # marks a bullet or paragraph start in normalized text; ends a sentence
_FOOTNOTE = re.compile(r'\[\d{1,3}\]')


def normalize(text: str) -> str:
    """One normal form for deliverables and anchors alike, so an anchor copied from
    either the source or the rendered text still matches."""
    t = unicodedata.normalize('NFKC', text).translate(_TRANSLATE)
    t = _CHAT_TOKEN.sub(' ', t)
    t = _MD_LINK.sub(r'\1', t)
    t = _URL.sub(' ', t)
    t = re.sub(r'\n[ \t]*\n', f'\n{BOUNDARY} ', t)
    t = _LIST_MARKER.sub(f'{BOUNDARY} ', t)
    t = _FOOTNOTE.sub(' ', t)
    for mark in ('**', '__', '`', '*'):
        t = t.replace(mark, '')
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(f'({BOUNDARY} ?)+', f'{BOUNDARY} ', t)
    return t.strip(f' {BOUNDARY}')


# ---------------------------------------------------------------- number tokens

_NUM = re.compile(r'(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?')
_SCALE = re.compile(r'\s?(thousand|million|billion|trillion)\b|(bn|mm|[kKmMbB])(?![A-Za-z])')
_SCALE_MULT = {'thousand': Decimal(10) ** 3, 'million': Decimal(10) ** 6, 'billion': Decimal(10) ** 9,
               'trillion': Decimal(10) ** 12, 'k': Decimal(10) ** 3, 'm': Decimal(10) ** 6,
               'mm': Decimal(10) ** 6, 'b': Decimal(10) ** 9, 'bn': Decimal(10) ** 9}
_PCT = re.compile(r'\s?(%|percent\b|per cent\b|pct\b|pp\b|percentage points?\b)', re.I)
# The only qualifiers read. Anything else next to a number that looks like one is refused,
# not guessed at: a false "exact" is the failure this script exists to prevent.
_PREFIX = re.compile(
    r'(?<![A-Za-z])(no more than|not more than|no less than|not less than|no fewer than|not fewer than|more than|'
    r'greater than|over|above|exceeding|at least|a minimum of|minimum of|min\.|less than|fewer than|'
    r'under|below|at most|up to|a maximum of|maximum of|max\.|about|around|approximately|approx\.?|'
    r'roughly|nearly|almost|~|≈|<=|>=|≤|≥|<|>)\s*$',
    re.I,
)
_PREFIX_OP = {
    'more than': 'gt', 'greater than': 'gt', 'over': 'gt', 'above': 'gt', 'exceeding': 'gt', '>': 'gt',
    'at least': 'gte', 'no less than': 'gte', 'not less than': 'gte', 'no fewer than': 'gte',
    'not fewer than': 'gte', 'a minimum of': 'gte', 'minimum of': 'gte', 'min': 'gte', '>=': 'gte', '≥': 'gte',
    'less than': 'lt', 'fewer than': 'lt', 'under': 'lt', 'below': 'lt', '<': 'lt',
    'at most': 'lte', 'up to': 'lte', 'no more than': 'lte', 'not more than': 'lte', 'a maximum of': 'lte',
    'maximum of': 'lte', 'max': 'lte', '<=': 'lte', '≤': 'lte',
    'nearly': 'near', 'almost': 'near',
}
_SUFFIX = re.compile(
    r'\s*(\+|or more\b|or greater\b|or higher\b|or above\b|or over\b|and up\b|and above\b|and over\b|plus\b|'
    r'or less\b|or fewer\b|or lower\b|or below\b|or under\b)', re.I)
# Bound wording. Attached to a number, it is read; left over anywhere in a sentence, it makes
# every number in that sentence unreadable, since its number can't be told. Approximation words
# ("about 50") and "over/under/above/below" count only when attached: "surveyed 50 customers
# about onboarding" and "over the last 12 months" are ordinary wording.
_FREE_BOUND = re.compile(
    r'(?<![A-Za-z])(no more than|not more than|no less than|not less than|no fewer than|not fewer than|'
    r'more than|greater than|less than|fewer than|exceeding|at least|at most|up to|a minimum of|minimum of|'
    r'a maximum of|maximum of|minimum|maximum|or more|or greater|or higher|or above|or over|and up|'
    r'and above|and over|or less|or fewer|or lower|or below|or under)(?![A-Za-z])', re.I)
_SENTENCE_END = re.compile(BOUNDARY + r'|[.!?;](?=\s+[A-Z"(\u2016]|\s*$)')
_BOUND_OPS = {'>=': 'gte', 'gte': 'gte', '>': 'gt', 'gt': 'gt', '<=': 'lte', 'lte': 'lte', '<': 'lt', 'lt': 'lt'}
_NEGATION = re.compile(r"(\bnot|\bnever|n't|\bhardly|\bbarely|\bno)\s*$", re.I)
PCT_UNITS = {'%', 'pct', 'percent', 'pp', 'percentage points'}

_SMALL = {w: i for i, w in enumerate(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
    'sixteen seventeen eighteen nineteen'.split())}
_TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90}
_WORD_SCALES = {'hundred', 'thousand', 'million', 'billion', 'trillion', 'dozen', 'dozens', 'hundreds',
                'thousands', 'millions', 'billions'}


class Token:
    __slots__ = ('start', 'end', 'text', 'value', 'step', 'pct', 'sign', 'op', 'problem')

    def __init__(self, start, end, text, value, step, pct=False, sign='', op='eq', problem=None):
        self.start, self.end, self.text = start, end, text
        self.value, self.step, self.pct, self.sign, self.op = value, step, pct, sign, op
        self.problem = problem

    def __repr__(self):
        return f'Token({self.text!r}, {self.sign}{self.value}, op={self.op}{", " + self.problem if self.problem else ""})'


def _is_currency(ch):
    return bool(ch) and unicodedata.category(ch) == 'Sc'


def _lead(text, start):
    """Walk left from a number over a currency symbol or code and a sign.
    Returns (lead, sign, problem). A "-" attached to the number is a sign unless a
    letter or digit touches it ("5-7", "Q3-5"). A detached one ("- 7") is a sign after
    punctuation, a range after a digit, and refused after a word: it could be a dash."""
    lead = start
    while lead and (_is_currency(text[lead - 1]) or (text[lead - 1] == ' ' and lead >= 2 and _is_currency(text[lead - 2]))):
        lead -= 1
    if lead == start:
        code = re.search(r'(?<![A-Za-z])[A-Z]{3} $', text[max(0, lead - 5):lead])
        if code:
            lead -= len(code.group(0))
    if lead < start and _is_currency(text[lead]):
        glued = re.search(r'(?<![A-Za-z])[A-Z]{1,3}$', text[:lead])
        if glued:
            lead -= len(glued.group(0))  # US$50, C$50
    if lead and text[lead - 1] in '+-':
        before = text[lead - 2] if lead >= 2 else ''
        if before.isalnum():
            return lead, '', None
        sign = text[lead - 1]
        lead -= 1
        while lead and _is_currency(text[lead - 1]):
            lead -= 1
        return lead, sign, None
    j = lead
    while j and text[j - 1] == ' ':
        j -= 1
    if j < lead and j and text[j - 1] in '+-':
        k = j - 1
        while k and text[k - 1] == ' ':
            k -= 1
        before = text[k - 1] if k else ''
        if before.isdigit():
            return lead, '', None
        if before.isalpha():
            return j - 1, '', 'a detached "+" or "-" after a word (a sign, or a dash?)'
        return j - 1, text[j - 1], None
    return lead, '', None


def _accounting(text, lead, end, sign, pct):
    """An unsigned money amount alone in parentheses ("($50)", "$(50)", "(USD 50)") is how
    accounting writes a negative. Without a currency mark, parentheses are a note: a review
    count after a rating ("4.6 (1,947)") or a year after a source ("survey (2024)")."""
    if sign or pct or not lead or text[lead - 1] != '(':
        return None
    close = re.match(r'( ?[A-Z]{3})?\)', text[end:end + 5])  # "(50)" or "(50 USD)"
    if not close:
        return None
    inner = text[lead:end]
    before = text[max(0, lead - 3):lead - 1].rstrip()   # "$(50)" or "$ (50)"
    money = (any(_is_currency(ch) for ch in inner) or close.group(1)
             or re.match(r'(?:[A-Z]{3}|[Rr]s|US)(?![a-z])', inner)
             or (before and _is_currency(before[-1])))
    return 'a money amount alone in parentheses (an accounting negative?)' if money else None


def _qualifiers(text, lead, end):
    """The qualifier attached to the number spanning [lead, end): one prefix or one suffix.
    Returns (op, new_end, problem, used spans). Wording left over in the sentence is
    judged later, once every number has claimed its own qualifier."""
    op, problem, used = 'eq', None, []
    base = max(0, lead - 30)
    pre = text[base:lead]
    m = _PREFIX.search(pre)
    if m:
        word = re.sub(r'\s+', ' ', m.group(1).lower()).rstrip('.')
        op = _PREFIX_OP.get(word, 'eq')  # about/around/~/roughly: still exact at the shown precision
        used.append((base + m.start(1), base + m.end(1)))
        if not word.startswith(('no ', 'not ')) and _NEGATION.search(pre[:m.start()]):
            problem = f'a negated qualifier ("{pre[max(0, m.start() - 12):].strip()}")'
    elif _NEGATION.search(pre) and not re.search(r'\bno\s*$', pre, re.I):
        problem = f'a negation right before it ("{pre[-12:].strip()}")'
    sm = _SUFFIX.match(text, end)
    if sm:
        word = sm.group(1).lower()
        suffix_op = 'lte' if word.startswith(('or less', 'or fewer', 'or lower', 'or below', 'or under')) else 'gte'
        if m:
            problem = problem or 'two qualifiers on one number'
        op = suffix_op
        used.append((sm.start(1), sm.end(1)))
        end = sm.end()
    return op, end, problem, used


def _word_numbers(text):
    """Spelled-out numbers as (start, end, value, problem). Single words and tens-units
    ("twenty-five") are read; anything with hundred, thousand, dozen and the like is
    refused ("write it in digits") rather than half-read. "one" alone is not a number,
    or every "no one" would need a claim, unless a qualifier is attached ("at least one")."""
    words = [(m.start(), m.end(), m.group(0).lower()) for m in re.finditer(r'[A-Za-z]+', text)]
    vocab = set(_SMALL) | set(_TENS) | _WORD_SCALES
    out, i, n = [], 0, len(words)
    while i < n:
        if words[i][2] not in vocab and not (words[i][2] == 'a' and i + 1 < n and words[i + 1][2] in _WORD_SCALES):
            i += 1
            continue
        j = i + 1
        while j < n and text[words[j - 1][1]:words[j][0]] in (' ', '-', ' and ') and (
                words[j][2] in vocab or (words[j][2] == 'and' and j + 1 < n and words[j + 1][2] in vocab)):
            j += 1
        seq = words[i:j]
        names = [w for _, _, w in seq if w != 'and']
        start, end = seq[0][0], seq[-1][1]
        if names == ['a']:
            i = j
            continue
        if any(w in _WORD_SCALES for w in names) or 'a' in names or 'and' in [w for _, _, w in seq]:
            out.append((start, end, None, 'write it in digits'))
        elif names == ['one']:
            if _PREFIX.search(text[max(0, start - 30):start]):
                out.append((start, end, 1, None))
        elif len(names) == 1 and names[0] in _SMALL:
            out.append((start, end, _SMALL[names[0]], None))
        elif len(names) == 1 and names[0] in _TENS:
            out.append((start, end, _TENS[names[0]], None))
        elif len(names) == 2 and names[0] in _TENS and names[1] in _SMALL and 0 < _SMALL[names[1]] < 10:
            out.append((start, end, _TENS[names[0]] + _SMALL[names[1]], None))
        else:
            out.append((start, end, None, 'write it in digits'))
        i = j
    return out


def _suffixes(text, end):
    """Scale and percent after a number. Returns (end, mult, pct)."""
    mult = Decimal(1)
    sm = _SCALE.match(text, end)
    if sm:
        mult = _SCALE_MULT[(sm.group(1) or sm.group(2)).lower()]
        end = sm.end()
    pm = _PCT.match(text, end)
    if pm:
        end = pm.end()
    return end, mult, bool(pm)


def tokenize(text: str):
    """Every number in normalized text, and the identifiers skipped. A digit run right after
    letters is an identifier (Q1, H2, B03001, Acme01), unless the letters are three
    capitals (a currency code such as SEK1200) or a currency word, which are quantities."""
    tokens: list[Token] = []
    skipped: list[str] = []
    used: list[tuple[int, int]] = []
    for m in _NUM.finditer(text):
        s, e = m.span()
        if s and (text[s - 1].isalpha() or text[s - 1] == '_'):
            j = s
            while j and text[j - 1].isalpha():
                j -= 1
            prefix = text[j:s]
            standalone = j == 0 or not text[j - 1].isalnum()
            if not (standalone and (re.fullmatch(r'[A-Z]{3}', prefix) or prefix.lower() in ('rs', 'us'))):
                skipped.append(text[j:e])
                continue
            lead, sign = j, ''
            k = j
            while k and text[k - 1] == ' ':
                k -= 1
            if k and text[k - 1] in '+-' and (k < 2 or not text[k - 2].isalnum()):
                lead, sign = k - 1, text[k - 1]
            sign_problem = None
        else:
            lead, sign, sign_problem = _lead(text, s)
        raw = m.group(0).replace(',', '')
        value = Decimal(raw)
        end, mult, pct = _suffixes(text, e)
        sign_problem = sign_problem or _accounting(text, lead, end, sign, pct)
        op, end, problem, spans = _qualifiers(text, lead, end)
        used += spans
        step = Decimal(1).scaleb(value.as_tuple().exponent) * mult
        tokens.append(Token(s, end, text[s:end], value * mult, step, pct, sign, op, sign_problem or problem))
    for s, e, value, problem in _word_numbers(text):
        if any(t.start < e and s < t.end for t in tokens):
            continue  # "5 million": the digits already carry the word as their scale
        lead, sign, sign_problem = _lead(text, s)
        end, mult, pct = _suffixes(text, e)
        op, end, qproblem, spans = _qualifiers(text, lead, end)
        used += spans
        v = Decimal(value) * mult if value is not None else Decimal(0)
        tokens.append(Token(s, end, text[s:end], v, mult, pct, sign, op, problem or sign_problem or qproblem))
    tokens.sort(key=lambda t: t.start)
    _refuse_leftover_bounds(text, tokens, used)
    return tokens, skipped


def _refuse_leftover_bounds(text, tokens, used):
    """Bound wording no number claimed makes every number in its sentence unreadable."""
    cuts = [0] + [m.end() for m in _SENTENCE_END.finditer(text)] + [len(text)]
    for a, b in zip(cuts, cuts[1:]):
        for q in _FREE_BOUND.finditer(text, a, b):
            if any(x <= q.start() and q.end() <= y for x, y in used):
                continue
            for t in tokens:
                if a <= t.start < b and not t.problem:
                    t.problem = f'"{q.group(0)}" in the same sentence is attached to no number'


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
    ("50+") is shown faithfully only with that same bound and number."""
    if tok.problem:
        return False
    v = _unit_value(tok, value, unit, magnitude)
    if v is None:
        return False
    x, half = _shown(tok), tok.step / 2
    if bound:
        return tok.op == bound and v == x  # a rounded threshold is a different, stronger claim
    if tok.op == 'gt':
        return v > x
    if tok.op == 'gte':
        return v >= x
    if tok.op == 'lt':
        return v < x
    if tok.op == 'lte':
        return v <= x
    if tok.op == 'near':
        return v < x and abs(v - x) <= half  # "nearly 50" says below 50, and close to it
    return abs(v - x) <= half


# ---------------------------------------------------------------- dates

_MONTHS = {m: i for i, m in enumerate(
    'jan feb mar apr may jun jul aug sep oct nov dec'.split(), start=1)}
_MON = r'(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?'
_DATE_PATTERNS = [
    ('iso', re.compile(r'\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?')),
    ('ymd', re.compile(r'\b(\d{4})-(\d{1,2})-(\d{1,2})\b')),
    ('mdy', re.compile(r'\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b')),
    ('dMy', re.compile(r'\b(\d{1,2})(?:st|nd|rd|th)?\s+' + _MON + r'(?:,?\s+(\d{4}))?\b', re.I)),
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
        return stamp.date(), stamp.timetz()
    except ValueError:
        return None


def _same_offset(shown, clock):
    """A shown UTC offset must match the claim's; no shown offset is not checked here."""
    if not shown:
        return True
    if clock.tzinfo is None:
        return False
    minutes = 0 if shown == 'Z' else (1 if shown[0] == '+' else -1) * (int(shown[1:3]) * 60 + int(shown[-2:]))
    return clock.utcoffset() == dt.timedelta(minutes=minutes)


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
            if kind == 'iso':
                frac = (g[6] or '').ljust(6, '0')
                ok = ((int(g[0]), int(g[1]), int(g[2])) == (day.year, day.month, day.day) and clock is not None
                      and (int(g[3]), int(g[4])) == (clock.hour, clock.minute)
                      and (g[5] is None or int(g[5]) == clock.second)
                      and (g[6] is None or (frac[6:].strip('0') == '' and int(frac[:6]) == clock.microsecond))
                      and _same_offset(g[7], clock))
            elif kind == 'dMy':
                ok = (_MONTHS[g[1][:3].lower()], int(g[0])) == (day.month, day.day) and (g[2] is None or int(g[2]) == day.year)
            elif kind == 'ymd':
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
    shape = ('%' if s.endswith('%') else '') + ''.join(sorted({ch for ch in s if _is_currency(ch)}))
    core = ''.join(ch for ch in s.rstrip('%') if not _is_currency(ch)).replace(',', '').replace(' ', '')
    return dec(core), shape


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f, parse_float=Decimal)
    except FileNotFoundError:
        raise InputError(f'{path}: not found')
    except json.JSONDecodeError as exc:
        raise InputError(f'{path}: not valid JSON ({exc})')


def load_table(path):
    """A CSV as (header, rows). Duplicate column names or ragged rows make it unusable:
    a dict reader would silently keep only one of two same-named columns."""
    try:
        with open(path, newline='', encoding='utf-8-sig') as fh:
            rows = list(csv.reader(fh, strict=True))
    except FileNotFoundError:
        raise InputError(f'{path}: not found')
    except csv.Error as exc:
        raise InputError(f'{path}: malformed CSV ({exc})')
    if not rows:
        raise InputError(f'{path}: empty')
    header = [h.strip() for h in rows[0]]
    dups = sorted({h for h in header if header.count(h) > 1})
    if dups:
        raise InputError(f'{path}: duplicate column name(s) {dups}')
    body = []
    for n, row in enumerate(rows[1:], start=2):
        if not row:
            continue
        if len(row) != len(header):
            raise InputError(f'{path}: line {n} has {len(row)} fields; the header has {len(header)}')
        body.append(dict(zip(header, row)))
    return header, body


def _parse_stamp(value):
    """The whole value as an ISO date or datetime, or None: nothing trailing is ignored."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    if s.endswith(('Z', 'z')):
        s = s[:-1] + '+00:00'
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        return None


def _parse_date(value):
    stamp = _parse_stamp(value)
    return stamp.date() if stamp else None


class _Eval:
    OPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
           ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b}

    def __init__(self, values, source=''):
        self.values = values
        self.source = source

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
            return dec(ast.get_source_segment(self.source, node) or node.value)
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
        return _Eval(values, expr).run(ast.parse(expr, mode='eval'))


_REL_OPS = {ast.Eq: '==', ast.LtE: '<=', ast.GtE: '>=', ast.Lt: '<', ast.Gt: '>'}


def check_relation(expr: str, values: dict, tolerance: Decimal):
    tree = ast.parse(expr, mode='eval').body
    if not (isinstance(tree, ast.Compare) and len(tree.ops) == 1 and type(tree.ops[0]) in _REL_OPS):
        raise ValueError('a relation is one comparison: ==, <=, >=, < or >')
    with localcontext() as ctx:
        ctx.prec = 50
        left = _Eval(values, expr).run(tree.left)
        right = _Eval(values, expr).run(tree.comparators[0])
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


def _where_labels(raw):
    """Numbers in a claim's row key, which its file has just confirmed."""
    out = set()
    for v in (raw.get('locate') or {}).get('where', {}).values():
        out |= _number_labels(v)
    return out


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
    def future(d):  # a day of slack: the author and this host may be in different time zones
        return d is not None and d > today + dt.timedelta(days=1)

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
                f.fail('source', f'{sid}: say what one row counts ("grain": e.g. "customer account", not "person")')
            as_of = src.get('as_of')
            if not as_of:
                f.fail('source', f'{sid}: "as_of" is required: the exact cutoff the query ran to')
            elif not (stamp := _parse_stamp(as_of)):
                f.fail('source', f'{sid}: as_of "{as_of}" is not an ISO date or datetime')
            elif future(stamp.date()):
                f.fail('source', f'{sid}: as_of {as_of} is in the future')
            elif stamp.tzinfo is None or not re.search(r'[T ]\d', str(as_of).strip()):
                f.warn('source', f'{sid}: as_of "{as_of}" has no time and timezone; a date alone hides a partial day')
        elif kind == 'file':
            if not src.get('path'):
                f.fail('source', f'{sid}: a file source needs "path"')
            elif not os.path.isfile(tables.path(src['path'])):
                f.fail('source', f'{sid}: {src["path"]} does not exist')
            if not src.get('as_of'):
                f.warn('source', f'{sid}: no "as_of"; say when the file was produced')
            elif not _parse_date(src.get('as_of')):
                f.warn('source', f'{sid}: as_of "{src.get("as_of")}" is not a date; if the cutoff is unknown, say so in the deliverable')
            elif future(_parse_date(src.get('as_of'))):
                f.fail('source', f'{sid}: as_of {src.get("as_of")} is in the future')
        elif kind == 'web':
            if not re.match(r'https?://', str(src.get('url', ''))):
                f.fail('source', f'{sid}: a web source needs an http(s) "url"')
            if not _parse_date(src.get('retrieved')):
                f.fail('source', f'{sid}: "retrieved" must be an ISO date')
            elif future(_parse_date(src.get('retrieved'))):
                f.fail('source', f'{sid}: retrieved {src.get("retrieved")} is in the future')
            if not src.get('entity'):
                f.fail('source', f'{sid}: name the exact business, place or body the page is about ("entity")')
            effective = _parse_date(src.get('effective'))
            if not effective:
                f.warn('stale', f'{sid}: undated evidence; treat it as stale until it is re-checked live')
            elif future(effective):
                f.fail('source', f'{sid}: effective {effective} is in the future')
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
        table = src.get('result') or src.get('path')
        if 'locate' in raw and kind not in ('query', 'file'):
            f.fail('bind', f'{cid}: "locate" reads a query or file source; {raw["source"]} is {kind}')
        elif kind in ('query', 'file') and claim.value is not None and 'locate' not in raw:
            f.fail('retyped', f'{cid}: a number from {raw["source"]} must be read from its file ("locate"), not typed')
        elif kind in ('query', 'file') and 'locate' in raw:
            cell, err = _locate(raw, src, tables)
            if err:
                f.fail('bind', f'{cid}: {err}')
            elif claim.value is None:
                if str(cell).strip() != str(value).strip():
                    f.fail('bind', f'{cid}: ledger says {value!r} but {table} says {cell!r}')
                else:
                    claim.labels |= _where_labels(raw)
            else:
                if isinstance(cell, (int, float, Decimal)) and not isinstance(cell, bool):
                    got, shape = dec(cell), ''
                else:
                    got, shape = cell_number(cell)
                if got is None:
                    f.fail('bind', f'{cid}: the located cell is empty or not a finite number ({cell!r})')
                elif got != claim.value:
                    f.fail('bind', f'{cid}: ledger says {value} but {table} says {cell}')
                elif '%' in shape and (claim.unit or '').strip().lower() not in PCT_UNITS:
                    f.fail('bind', f'{cid}: the cell is a percentage ({cell}); set "unit": "%"')
                else:
                    claim.labels |= _where_labels(raw)
        if kind == 'web' and not (isinstance(quote, str) and quote.strip()):
            f.fail('quote', f'{cid}: a web claim needs the exact source text it rests on ("quote")')
        elif isinstance(quote, str) and quote.strip() and claim.value is not None:
            shown = tokenize(normalize(quote))[0]
            exact = [t for t in shown if t.op == 'eq' and displays(t, claim.value, claim.unit, claim.magnitude)]
            bounds = []
            for t in shown:
                v = None if t.op == 'eq' or t.problem else _unit_value(t, claim.value, claim.unit, claim.magnitude)
                if v is not None and abs(v - _shown(t)) <= t.step / 2:
                    bounds.append(t)
            unclear = [t for t in shown if t.problem]
            declared = _BOUND_OPS.get(str(raw.get('bound', '')).strip().lower())
            if raw.get('bound') is not None and not declared:
                f.fail('quote', f'{cid}: "bound" must be one of >=, >, <=, <')
            elif declared and exact:
                f.fail('quote', f'{cid}: the quote shows {value} exactly; drop "bound"')
            elif declared and bounds and bounds[0].op != declared:
                f.fail('quote', f'{cid}: "bound" says {raw["bound"]} but the quote says "{bounds[0].text}"')
            elif declared:
                same = [t for t in shown if _unit_value(t, claim.value, claim.unit, claim.magnitude) == _shown(t)]
                if same:
                    claim.bound = declared
                else:
                    f.fail('quote', f'{cid}: the quote does not show {value}, the bound "bound" declares')
            elif exact:
                pass
            elif bounds:
                t = bounds[0]
                if _unit_value(t, claim.value, claim.unit, claim.magnitude) != _shown(t):
                    f.fail('quote', f'{cid}: the source gives only "{t.text}"; the value must be that number exactly')
                else:
                    claim.bound = t.op  # the source gives only a bound ("50+"); every display must keep it
            elif unclear:
                f.fail('quote', f'{cid}: the quote shows {unclear[0].text!r}, which can\'t be read exactly '
                                f'({unclear[0].problem}). If the source gives a bound, declare it: "bound": ">="')
            else:
                f.fail('quote', f'{cid}: the quote does not show {value} ({quote.strip()[:80]!r})')

    on_doc = sorted(k for k, c in by_id.items()
                    if isinstance(sources.get(c.raw.get('source')), dict) and sources[c.raw['source']].get('type') == 'doc')
    if on_doc:
        f.note('doc', f'resting on a doc source, which this script can\'t check: {", ".join(on_doc)}')
    numeric = {k: c.value for k, c in by_id.items() if c.value is not None}
    bounded = {k for k, c in by_id.items() if c.bound}
    for cid, claim in by_id.items():
        if 'expr' not in claim.raw:
            continue
        expr = str(claim.raw['expr'])
        names = expr_names(expr)
        if not names:
            f.fail('derived', f'{cid}: "expr" must derive from other claims; a bare number needs a source')
            continue
        if names & bounded:
            f.fail('derived', f'{cid}: derives from {", ".join(sorted(names & bounded))}, which the source gives only as a bound')
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
        if expr_names(str(expr)) & bounded:
            f.fail('relation', f'{expr}: uses {", ".join(sorted(expr_names(str(expr)) & bounded))}, which the source gives only as a bound')
            continue
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
    # Every number has one role: a value or date owned by exactly one claim, a label (a row
    # key or a name) any number of claims may share, or part of an exempt snippet. Labels
    # are settled after ownership, so the order of claims cannot change the result.
    owner = {p: {} for p in paths}          # index -> the one claim whose value or date it states
    labelled = {p: set() for p in paths}    # indices read as a row or name label
    label_wanted = []                       # (p, index, claim) waiting for ownership to settle
    in_anchor = {p: {} for p in paths}      # index -> ids of claims whose anchor holds it

    def own(p, i, claim, na):
        """A number in the deliverable states one fact: it belongs to exactly one claim."""
        held = owner[p].setdefault(i, claim.id)
        if held != claim.id:
            f.fail('anchor', f'{claim.id}: "{na}" shows {tokens[p][i].text}, which already states {held}; '
                             'one number is one fact, so give each claim its own occurrence')
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
                                shown_value.append((i, t))
                        if len(shown_value) == 1:
                            own(p, shown_value[0][0], claim, na)
                        shown_value = [t for _, t in shown_value]
                        if not shown_value:
                            got = ', '.join(t.text for _, t in inside) or 'no whole number'
                            note = f' (the source gives only "{claim.bound}" this value)' if claim.bound else ''
                            f.fail('anchor', f'{claim.id}: "{na}" shows {got}; the ledger value is '
                                             f'{claim.raw.get("value")}{claim.unit or ""}{note}')
                        elif len(shown_value) > 1:
                            f.fail('anchor', f'{claim.id}: "{na}" holds {len(shown_value)} numbers that show this value; '
                                             'shorten it to the one this claim is about')
                        elif not re.search(r'[A-Za-z0-9]', _residue(texts[p][s:e], shown_value, s)):
                            f.fail('anchor', f'{claim.id}: "{na}" is a bare number; include the words (or row key) that say what it counts')
                    elif claim.when is not None:
                        dates = date_matches(texts[p][s:e], claim.when)
                        if claim.when[1] is not None and re.search(r'(~|\babout|\baround|\bapprox|\broughly)\s*\d', texts[p][max(0, s - 12):e], re.I):
                            f.warn('cutoff', f'{claim.id}: "{na}" gives an approximate time; state the exact cutoff')
                        for ds, de, ok, shown in dates:
                            if not ok:
                                f.fail('anchor', f'{claim.id}: "{na}" shows {shown}; the date is {claim.raw.get("value")}')
                            for i, t in inside:
                                if ds <= t.start - s and t.end - s <= de:
                                    own(p, i, claim, na)
                        if not any(ok for *_, ok, _ in dates):
                            f.fail('anchor', f'{claim.id}: "{na}" shows no part of {claim.raw.get("value")}')
                    for i, t in inside:
                        if t.op == 'eq' and not t.pct and not t.sign and t.value in claim.labels:
                            label_wanted.append((p, i, claim))
            if not found:
                f.fail('anchor', f'{claim.id}: "{na}" is not in the deliverable (edited since the ledger was written?)')

    for p, i, claim in label_wanted:
        held = owner[p].get(i)
        if held == claim.id:
            continue  # the claim's own value, which its row key happens to repeat
        if held:
            f.fail('anchor', f'{claim.id}: reads {tokens[p][i].text} as a label, but it states {held}; '
                             'one number has one role')
        elif i not in labelled[p]:
            labelled[p].add(i)
            labels_used += 1

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
            for i, held in owner[p].items():
                if span[0] <= tokens[p][i].start and tokens[p][i].end <= span[1]:
                    f.fail('exempt', f'"{ns}" covers {tokens[p][i].text}, which states {held}; '
                                     'exempt only names, addresses and phone numbers')

    total = 0
    for p in paths:
        for i, t in enumerate(tokens[p]):
            total += 1
            if any(s <= t.start and t.end <= e for s, e in exempt_spans[p]):
                continue
            around = texts[p][max(0, t.start - 50):t.end + 50]
            if t.problem:
                f.fail('unclear', f'"{t.text}" can\'t be read exactly ({t.problem}). Rephrase it with digits and a '
                                  f'plain qualifier, or exempt it if it isn\'t a quantity: ...{around}...')
                continue
            if i in owner[p] or i in labelled[p]:
                continue
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
                'value': int(value) if value == value.to_integral_value() else str(value),
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
    """Sentences for `changed`. Link destinations stay in: `check` skips them, but a swapped
    citation is exactly what a re-check must see."""
    out = []
    for line in read_text(path, links=True).splitlines():
        for part in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9"\'(])', line):
            urls = re.findall(r'\]\(([^)\s]+)', part) + [u for u in _URL.findall(part) if not part.count(f']({u}')]
            n = normalize(part).replace(BOUNDARY, '').strip()
            if urls:
                n = f'{n} <{" ".join(urls)}>'.strip()
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
                 if json.dumps(ca.get(k), sort_keys=True, default=str) != json.dumps(cb.get(k), sort_keys=True, default=str)}
        sa, sb = la.get('sources') or {}, lb.get('sources') or {}
        src_moved = {k for k in sa.keys() | sb.keys()
                     if json.dumps(sa.get(k), sort_keys=True, default=str) != json.dumps(sb.get(k), sort_keys=True, default=str)}
        moved |= {k for k, c in cb.items() if c.get('source') in src_moved}
        deps, frontier = set(), set(moved)
        while frontier:
            nxt = {k for k, c in cb.items() if 'expr' in c and expr_names(str(c['expr'])) & frontier} - moved - deps
            deps |= nxt
            frontier = nxt

        def rel_text(r):
            return str(r.get('expr') if isinstance(r, dict) else r)

        def listed(ledger, key):
            return {json.dumps(x, sort_keys=True, default=str): x for x in ledger.get(key) or []}

        rels = [rel_text(r) for r in lb.get('relations') or []]
        hit_rels = [r for r in rels if expr_names(r) & (moved | deps)]
        ra, rb = listed(la, 'relations'), listed(lb, 'relations')
        ea, eb = listed(la, 'exempt'), listed(lb, 'exempt')
        print('Claims changed, added or removed: ' + (', '.join(sorted(k for k in moved if k)) or 'none'))
        print('Claims derived from them: ' + (', '.join(sorted(deps)) or 'none'))
        print('Relations touching them: ' + ('; '.join(hit_rels) or 'none'))
        print('Relations added or edited: ' + ('; '.join(rel_text(rb[k]) for k in rb if k not in ra) or 'none'))
        print('Relations removed or edited: ' + ('; '.join(rel_text(ra[k]) for k in ra if k not in rb) or 'none'))
        print('Exemptions added: ' + ('; '.join(str(eb[k]) for k in eb if k not in ea) or 'none'))
        print('Exemptions removed: ' + ('; '.join(str(ea[k]) for k in ea if k not in eb) or 'none'))
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
    """Lines of real content under the Wrong / Stale / Unsupported headings, including
    their subheadings. A table's first row counts as its header only when a separator
    row follows it."""
    counts, current, level = {}, None, 0
    for n, line in enumerate(lines):
        heading = re.match(r'^\s*(#{1,6})\s*(.*)$', line)
        if heading:
            depth, title = len(heading.group(1)), heading.group(2).strip().lower()
            if current and depth > level:
                counts[current] += 1  # a finding written as a subheading is still a finding
                continue
            current = next((k for k in _OPEN_SECTIONS if title.startswith(k)), None)
            level = depth
            if current:
                counts.setdefault(current, 0)
            continue
        if current is None:
            continue
        s = line.strip()
        if not s or re.fullmatch(r'[-*]?\s*\(?(none|n/a|nothing)\)?\.?', s, re.I):
            continue
        if s.startswith('|') and re.fullmatch(r'\|?[\s:|-]+\|?', s):
            continue
        nxt = lines[n + 1].strip() if n + 1 < len(lines) else ''
        if s.startswith('|') and re.fullmatch(r'\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?', nxt):
            continue  # a header row
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
    ledger_hash = (fields.get('ledger-sha256') or [''])[0].split()
    if not ledger_hash or ledger_hash[0].lower() != sha256(args.ledger):
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
