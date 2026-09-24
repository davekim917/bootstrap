"""Tests for check_claims.py: python3 -m unittest discover -s <this dir> -p 'test_*.py'

The replay cases rebuild, with fictional names and figures, the errors found in two real
agent-written deliverables (2026-09-24) and pin down which ones this script catches and which it cannot. A test that asserts
PASS on a wrong deliverable documents a limit that only the independent verifier covers.
"""
import contextlib
import csv
import io
import json
import os
import shutil
import tempfile
import unittest

from decimal import Decimal

import check_claims as cc

DELIVERED_CSV = """Year,New Online customers,New Studio customers (first service),"New customers, unique across Online + Studio",Studio service appointments
2013,412,0,412,0
2014,8310,0,8310,0
2015,41276,0,41276,0
2016,63518,41,63547,57
2017,88742,1820,90144,2931
2018,102355,3964,105702,9480
2019,118903,8127,125611,21744
2020,176480,9215,184338,30152
2021,158227,24860,179120,88415
2022,131064,38519,164870,190376
2023,117392,41236,153011,268904
2024,104718,45802,144233,331560
2025,99347,50119,142906,402718
2026 YTD (thru 9/23),71205,36644,102397,318227
Total,1281949,260347,1505877,1664564
"""

# The saved query.sql computed "combined" as Online OR any studio order, so a rerun
# of it could not reproduce the delivered column (Online OR first service).
RERUN_OF_SAVED_QUERY = {'2016': 63561, '2017': 90310, '2018': 105840, '2019': 125702}

# First draft to the CFO, as posted for approval.
DRAFT_V1 = """Hey Sam - numbers thru 9/23 below, full yearly breakdown in the attached csv

New customers
• Online ever: 1.28M
• Studio ever (had a service): 260K
• 36K did both, so unique across Online + Studio is 1.51M
• new by yr, unique across both: 2013 <1K, 2014 8K, 2015 41K, 2016 64K, 2017 90K, 2018 106K, 2019 126K, 2020 184K, 2021 179K, 2022 165K, 2023 153K, 2024 144K, 2025 143K, 2026 YTD 102K

Studio services (completed appointments)
• 1.66M total since the first studio opened in Dec 2016
• by yr: 2017 3K, 2018 9K, 2019 22K, 2020 30K, 2021 88K, 2022 190K, 2023 269K, 2024 332K, 2025 403K, 2026 YTD 318K

couple notes for the all-channel estimate
• counted by customer account, so someone w 2 accounts counts twice
• another 91K people bought product at a studio but never had a service. if you want them in, the unique total is 1.57M
"""

# The corrected draft after the independent check.
DRAFT_V2 = """Hey Sam - numbers thru ~5pm PT 9/23 below, full yearly breakdown in the attached csv

New customers (counted by customer account)
• Online ever: 1.28M
• Studio ever (had a service): 260K
• 36K did both, so unique across Online + Studio is 1.51M
• new by yr, unique across both: 2013 <1K, 2014 8K, 2015 41K, 2016 64K, 2017 90K, 2018 106K, 2019 126K, 2020 184K, 2021 179K, 2022 165K, 2023 153K, 2024 144K, 2025 143K, 2026 YTD 102K

Studio services (completed appointments)
• 1.66M total since the first studio opened in Dec 2016
• by yr: 2016 <1K, 2017 3K, 2018 9K, 2019 22K, 2020 30K, 2021 88K, 2022 190K, 2023 269K, 2024 332K, 2025 403K, 2026 YTD 318K

couple notes for the all-channel estimate
• someone w 2 accounts counts twice
• another 91K accounts had a studio order but never a service. 23K of those already ordered Online, so adding them brings the unique total to 1.57M (+69K)
"""


SECTIONS = '''## Wrong
| Where | Deliverable says | Actually | Evidence |
|---|---|---|---|

## Stale or overstated
none

## Unsupported
none

## Confirmed
- every number
'''


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cc.main(argv)
    return code, out.getvalue() + err.getvalue()


class Tmp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, name, content):
        path = os.path.join(self.dir, name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content if isinstance(content, str) else json.dumps(content, indent=1))
        return path


def csv_rows():
    return list(csv.reader(io.StringIO(DELIVERED_CSV)))


def count_ledger(version, svc_2016='anchor', extra_relations=()):
    """The ledger an author following the skill would keep for the CFO draft: every
    cell of the delivered table read from the file, each shown or omitted on purpose."""
    header, *rows = csv_rows()

    def cell(cid, year, col, anchor):
        value = int(next(r for r in rows if r[0] == year)[header.index(col)])
        claim = {'id': cid, 'value': value, 'source': 'q', 'locate': {'where': {'Year': year}, 'column': col}}
        claim.update({'omit': anchor[5:]} if anchor.startswith('omit:') else {'anchors': [anchor]})
        return claim

    unique_col, svc_col = 'New customers, unique across Online + Studio', 'Studio service appointments'
    claims = [
        cell('online_ever', 'Total', 'New Online customers', 'Online ever: 1.28M'),
        cell('studio_ever', 'Total', 'New Studio customers (first service)', 'Studio ever (had a service): 260K'),
        cell('unique_ever', 'Total', unique_col, 'unique across Online + Studio is 1.51M'),
        cell('services_total', 'Total', svc_col, '1.66M total'),
        {'id': 'both_ever', 'value': 36419, 'expr': 'online_ever + studio_ever - unique_ever', 'anchors': ['36K did both']},
        {'id': 'shop_only', 'value': 91437, 'source': 'retail', 'locate': {'json': '[0].STUDIO_NO_SERVICE_ACCOUNTS'},
         'anchors': ['another 91K']},
        {'id': 'shop_only_net', 'value': 68915, 'source': 'retail', 'locate': {'json': '[0].NET_OF_ONLINE'}},
        {'id': 'shop_also_online', 'value': 22522, 'expr': 'shop_only - shop_only_net'},
        {'id': 'unique_with_shop', 'value': 1574792, 'expr': 'unique_ever + shop_only_net', 'anchors': ['unique total is 1.57M']},
        {'id': 'first_studio', 'value': '2016-12-01', 'source': 'q', 'anchors': ['first studio opened in Dec 2016']},
    ]
    if version == 1:
        claims[6]['omit'] = 'not in this draft'
        claims[7]['omit'] = 'not in this draft'
        claims.append({'id': 'cutoff', 'value': '2026-09-23T17:00:00-07:00', 'source': 'q', 'anchors': ['thru 9/23']})
    else:
        claims[6]['anchors'] = ['1.57M (+69K)']
        claims[7]['anchors'] = ['23K of those already ordered Online']
        claims[8]['anchors'] = ['unique total to 1.57M']
        claims.append({'id': 'cutoff', 'value': '2026-09-23T17:00:00-07:00', 'source': 'q', 'anchors': ['thru ~5pm PT 9/23']})
    for row in rows:
        year = row[0]
        if year == 'Total':
            continue
        label = '2026 YTD' if year.startswith('2026') else year
        slug = label.replace(' ', '_').lower()

        def shown(n):
            return '<1K' if n < 1000 else f'{round(n / 1000)}K'

        claims.append(cell(f'new_{slug}', year, unique_col, f'{label} {shown(int(row[3]))}'))
        n_svc = int(row[4])
        if not n_svc:
            claims.append(cell(f'svc_{slug}', year, svc_col, 'omit:no studios before Dec 2016'))
        elif year == '2016':
            claims.append(cell('svc_2016', year, svc_col,
                               'by yr: 2016 <1K' if svc_2016 == 'anchor' else 'omit:rounds to zero, in the CSV'))
        else:
            claims.append(cell(f'svc_{slug}', year, svc_col, f'{label} {shown(n_svc)}'))
    return {
        'sources': {
            'q': {'type': 'query', 'sql': 'query.sql', 'result': 'delivered.csv', 'grain': 'customer account',
                  'as_of': '2026-09-23T17:00:00-07:00'},
            'retail': {'type': 'file', 'path': 'retail.json', 'as_of': '2026-09-24T19:30:00Z'},
        },
        'claims': claims,
        'relations': ['online_ever + studio_ever - both_ever == unique_ever', *extra_relations],
        'exempt': ['w 2 accounts'],
    }


class CustomerCountReplay(Tmp):
    def setUp(self):
        super().setUp()
        self.write('delivered.csv', DELIVERED_CSV)
        self.write('query.sql', 'select 1')
        self.write('retail.json', [{'STUDIO_NO_SERVICE_ACCOUNTS': 91437, 'NET_OF_ONLINE': 68915}])

    def ledger(self, version, **kw):
        return self.write('claims.json', count_ledger(version, **kw))

    def test_v2_passes(self):
        code, out = run(['check', self.ledger(2), self.write('v2.md', DRAFT_V2)])
        self.assertEqual(code, 0, out)

    def test_v1_dropped_2016_services_row_is_caught(self):
        code, out = run(['check', self.ledger(1), self.write('v1.md', DRAFT_V1)])
        self.assertEqual(code, 1)
        self.assertIn('svc_2016: "by yr: 2016 <1K" is not in the deliverable', out)

    def test_v1_additive_sentence_fails_the_relation_it_asserts(self):
        # "another 91K ... the unique total is 1.57M" asserts 1.51M + 91K = 1.57M.
        led = self.ledger(1, svc_2016='omit', extra_relations=['unique_ever + shop_only == unique_with_shop'])
        code, out = run(['check', led, self.write('v1.md', DRAFT_V1)])
        self.assertEqual(code, 1)
        self.assertIn('FAIL relation  unique_ever + shop_only == unique_with_shop', out)

    def test_v1_wording_errors_pass_mechanically(self):
        # "people" for accounts, "thru 9/23" for a 5pm cutoff, and 91K framed as additive
        # are all wording: without a declared relation, only the verifier catches them.
        code, out = run(['check', self.ledger(1, svc_2016='omit'), self.write('v1.md', DRAFT_V1)])
        self.assertEqual(code, 0, out)

    def test_saved_query_that_does_not_reproduce_is_caught(self):
        rows = []
        for parts in csv_rows():
            if parts[0] in RERUN_OF_SAVED_QUERY:
                parts[3] = str(RERUN_OF_SAVED_QUERY[parts[0]])
            rows.append(parts)
        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        rerun = self.write('rerun.csv', buf.getvalue())
        code, out = run(['reproduce', os.path.join(self.dir, 'delivered.csv'), rerun, '--key', 'Year'])
        self.assertEqual(code, 1)
        self.assertIn("('2016',) New customers, unique across Online + Studio: delivered 63547, rerun 63561", out)

    def test_live_drift_is_reported_not_hidden(self):
        drifted = DELIVERED_CSV.replace('2025,99347,', '2025,99346,')
        rerun = self.write('rerun.csv', drifted)
        code, out = run(['reproduce', os.path.join(self.dir, 'delivered.csv'), rerun, '--key', 'Year'])
        self.assertEqual(code, 1)
        code, out = run(['reproduce', os.path.join(self.dir, 'delivered.csv'), rerun, '--key', 'Year', '--rel-tol', '0.001'])
        self.assertEqual(code, 0)
        self.assertIn('RESULT: PASS WITH DRIFT', out)
        self.assertIn('delivered 99347, rerun 99346 (-1)', out)


class InsightReportReplay(Tmp):
    """Claims from a market insight report and its cross-exam."""

    def ledger(self, claims, exempt=()):
        sources = {
            'census': {'type': 'web', 'url': 'https://example.gov/acs', 'retrieved': '2026-09-24',
                       'effective': '2025-12-11', 'entity': 'Riverton city (ACS 2020-24 B16001)'},
            'cafe': {'type': 'web', 'url': 'https://example.com/cafe', 'retrieved': '2026-09-24',
                      'effective': '2026-07-01', 'entity': 'Cafe Uno, Old Town'},
            'bar': {'type': 'web', 'url': 'https://example.com/bar', 'retrieved': '2026-09-24',
                    'effective': '2026-09-01', 'entity': 'Bar Dos, Harbor Hotel'},
            'mojitos': {'type': 'web', 'url': 'https://example.com/mojitos', 'retrieved': '2026-09-24',
                        'effective': '2026-09-01', 'entity': 'Mojito House, Main St'},
        }
        return self.write('claims.json', {'sources': sources, 'claims': claims, 'exempt': list(exempt)})

    def test_unsourced_number_is_caught(self):
        led = self.ledger([])
        code, out = run(['check', led, self.write('r.md', 'Riverton is more than 70% bilingual.')])
        self.assertEqual(code, 1)
        self.assertIn('FAIL unbound   "70%" is not bound to any claim', out)

    def test_display_that_overstates_the_source_is_caught(self):
        led = self.ledger([{'id': 'riverton_bilingual', 'value': 64.2, 'unit': '%', 'source': 'census',
                            'quote': 'Bilingual: 64.2% of Riverton residents', 'anchors': ['more than 70% bilingual']}])
        code, out = run(['check', led, self.write('r.md', 'Riverton is more than 70% bilingual.')])
        self.assertEqual(code, 1)
        self.assertIn('riverton_bilingual: "more than 70% bilingual" shows 70%; the ledger value is 64.2%', out)

    def test_spelled_out_count_is_checked(self):
        led = self.ledger([{'id': 'bar_rum', 'value': 5, 'source': 'bar', 'quote': 'five of the ten cocktails use rum',
                            'labels': [10], 'anchors': ['Six of the ten cocktails are rum']}])
        code, out = run(['check', led, self.write('r.md', 'Six of the ten cocktails are rum.')])
        self.assertEqual(code, 1)
        self.assertIn('shows Six', out)

    def test_wrong_evidence_passes_mechanically(self):
        # The research notes said 11 (it counted July specials); the menu has 9. A ledger
        # built from the notes agrees with the prose, so only a live re-check catches this.
        led = self.ledger([{'id': 'cafe_rum', 'value': 11, 'source': 'cafe',
                            'quote': '11 rum cocktails on current bar menu', 'anchors': ['11 rum cocktails']}])
        code, out = run(['check', led, self.write('r.md', 'Cafe Uno pours 11 rum cocktails.')])
        self.assertEqual(code, 0, out)

    def test_dropped_qualifier_passes_mechanically(self):
        # "50+ mojitos & drinks" became "50+ mojitos": right number, false sentence.
        led = self.ledger([{'id': 'mojito_count', 'value': 50, 'source': 'mojitos', 'quote': '50+ mojitos & drinks',
                            'anchors': ['50+ mojitos']}])
        code, out = run(['check', led, self.write('r.md', 'The menu lists 50+ mojitos.')])
        self.assertEqual(code, 0, out)

    def test_quote_that_does_not_show_the_value_is_caught(self):
        led = self.ledger([{'id': 'mojito_count', 'value': 13, 'source': 'mojitos', 'quote': '50+ mojitos & drinks',
                            'anchors': ['13 mojito flavors']}])
        code, out = run(['check', led, self.write('r.md', 'The menu lists 13 mojito flavors.')])
        self.assertEqual(code, 1)
        self.assertIn('the quote does not show 13', out)

    def test_fix_pass_additions_are_listed_for_recheck(self):
        old = self.write('old.md', 'Corner Liquors stocks Coconut Cream.')
        new = self.write('new.md', 'Corner Liquors stocks Coconut Cream. It is owner-run, with long weekend hours.')
        code, out = run(['changed', old, new])
        self.assertEqual(code, 0)
        self.assertIn('+ It is owner-run, with long weekend hours.', out)


class Displays(unittest.TestCase):
    def tok(self, text):
        toks = cc.tokenize(cc.normalize(text))[0]
        self.assertEqual(len(toks), 1, toks)
        return toks[0]

    def ok(self, text, value, unit=None, **kw):
        return cc.displays(self.tok(text), cc.dec(value), unit, **kw)

    def test_rounding_to_shown_precision(self):
        self.assertTrue(self.ok('1.23M', 1234567))
        self.assertFalse(self.ok('1.23M', 1250000))
        self.assertTrue(self.ok('$24.99', 24.99, 'USD'))
        self.assertFalse(self.ok('1,000,000,001', 1000000000))

    def test_approximate_words_do_not_loosen(self):
        self.assertFalse(self.ok('about 80%', 76.2, '%'))
        self.assertTrue(self.ok('about 76%', 76.2, '%'))

    def test_comparators(self):
        self.assertTrue(self.ok('<1K', 412))
        self.assertFalse(self.ok('<1K', 1200))
        self.assertTrue(self.ok('50+', 50))
        self.assertFalse(self.ok('more than 50', 50))
        self.assertFalse(self.ok('nearly 30', 30.4))
        self.assertTrue(self.ok('not more than 70%', 64.2, '%'))
        self.assertFalse(self.ok('not more than 80%', 81, '%'))

    def test_percent_needs_a_percent_claim(self):
        self.assertTrue(self.ok('64.2%', 0.642, 'ratio'))
        self.assertFalse(self.ok('64.2%', 64.2))
        self.assertFalse(self.ok('64.2', 64.2, '%'))
        self.assertTrue(self.ok('Six percent', 6, '%'))

    def test_identifiers_are_not_quantities_but_are_reported(self):
        toks, skipped = cc.tokenize(cc.normalize("Q1's combined column, H2 and table B03001"))
        self.assertEqual(toks, [])
        self.assertEqual(skipped, ['Q1', 'H2', 'B03001'])

    def test_full_numeric_forms(self):
        self.assertTrue(self.ok('1e6 units', 1000000))
        self.assertFalse(self.ok('1e6 units', 1))
        self.assertTrue(self.ok('USD1200', 1200))
        self.assertTrue(self.ok('twenty-five customers', 25))
        self.assertEqual(cc.tokenize(cc.normalize('no one ordered a one-off'))[0], [])
        for phrase in ('Two hundred customers', 'One thousand and five', 'One million and one', 'a dozen'):
            self.assertEqual(self.tok(phrase).problem, 'write it in digits', phrase)

    def test_signs_are_kept(self):
        self.assertFalse(self.ok('+7 dollars', -7))
        self.assertFalse(self.ok('fell 6.6%', -6.6, '%'))
        self.assertTrue(self.ok('fell 6.6%', -6.6, '%', magnitude=True))
        self.assertTrue(self.ok('-6.6%', -6.6, '%'))


class Mechanics(Tmp):
    def base(self, claims, sources=None, **extra):
        sources = sources or {'f': {'type': 'file', 'path': 't.csv', 'as_of': '2026-09-24T12:00:00Z'}}
        self.write('t.csv', 'k,v\na,1234567\nb,7\n')
        return self.write('claims.json', {'sources': sources, 'claims': claims, **extra})

    def test_typed_number_from_a_file_is_rejected(self):
        led = self.base([{'id': 'x', 'value': 1234567, 'source': 'f', 'anchors': ['total of 1.23M']}])
        code, out = run(['check', led, self.write('d.md', 'A total of 1.23M.')])
        self.assertEqual(code, 1)
        self.assertIn('must be read from its file', out)

    def test_ledger_value_that_disagrees_with_its_cell(self):
        led = self.base([{'id': 'x', 'value': 1234576, 'source': 'f', 'locate': {'where': {'k': 'a'}, 'column': 'v'},
                          'anchors': ['total of 1.23M']}])
        code, out = run(['check', led, self.write('d.md', 'A total of 1.23M.')])
        self.assertEqual(code, 1)
        self.assertIn('ledger says 1234576 but t.csv says 1234567', out)

    def test_bare_number_anchor_is_rejected(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'},
                          'anchors': ['7']}])
        code, out = run(['check', led, self.write('d.md', 'We found 7 stores.')])
        self.assertEqual(code, 1)
        self.assertIn('is a bare number', out)

    def test_clean_deliverable_passes_and_says_it_is_mechanical(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'},
                          'anchors': ['7 stores']}], exempt=['100 Main St'])
        code, out = run(['check', led, self.write('d.md', 'We found 7 stores near 100 Main St.')])
        self.assertEqual(code, 0, out)
        self.assertIn(cc.MECHANICAL_ONLY, out)

    def test_html_is_read_as_rendered_text(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'},
                          'anchors': ['7 stores']}])
        html = '<html><head><title>Q 99</title></head><body><p>We found <b>7</b> stores.</p></body></html>'
        code, out = run(['check', led, self.write('d.html', html)])
        self.assertEqual(code, 0, out)

    def test_date_anchor_numbers_must_come_from_the_date(self):
        src = {'q': {'type': 'doc', 'ref': 'run log'}}
        led = self.base([{'id': 'cutoff', 'value': '2026-09-23T17:00:00-07:00', 'source': 'q',
                          'anchors': ['thru ~5pm PT 9/24']}], sources=src)
        code, out = run(['check', led, self.write('d.md', 'Numbers thru ~5pm PT 9/24.')])
        self.assertEqual(code, 1)
        self.assertIn('shows 9/24', out)

    def test_undated_web_evidence_is_flagged_stale(self):
        src = {'w': {'type': 'web', 'url': 'https://x.test', 'retrieved': '2026-09-24', 'entity': 'El Patio'}}
        led = self.base([{'id': 'm', 'value': 2, 'source': 'w', 'quote': 'two Dominican-rum mojitos',
                          'anchors': ['two Dominican-rum mojitos']}], sources=src)
        code, out = run(['check', led, self.write('d.md', 'It pours two Dominican-rum mojitos.')])
        self.assertEqual(code, 0, out)
        self.assertIn('WARN stale     w: undated evidence', out)

    def test_every_claim_must_be_shown_or_omitted_with_a_reason(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'}}])
        code, out = run(['check', led, self.write('d.md', 'Nothing here.')])
        self.assertEqual(code, 1)
        self.assertIn('x: not shown in the deliverable', out)

    def test_scaffold_reads_values_instead_of_typing_them(self):
        self.write('t.csv', 'k,v\na,1234567\nb,7\n')
        code, out = run(['scaffold', os.path.join(self.dir, 't.csv'), '--source', 'f', '--key', 'k'])
        self.assertEqual(code, 0)
        claims = json.loads(out[:out.rindex(']') + 1])
        self.assertEqual(claims[0], {'id': 'v_a', 'value': 1234567, 'source': 'f',
                                     'locate': {'where': {'k': 'a'}, 'column': 'v'}, 'anchors': []})

    def report(self, doc, led, verdict='CLEAR', body=SECTIONS):
        return '\n'.join([f'artifact-sha256: {cc.sha256(doc)}', f'ledger-sha256: {cc.sha256(led)}',
                          f'verdict: {verdict}', 'verifier: gpt-6-sol (fresh codex exec session)', '', body])

    def test_receipt_binds_to_exact_bytes(self):
        led = self.base([])
        doc = self.write('d.md', 'final text')
        report = self.write('verify.md', self.report(doc, led))
        self.assertEqual(run(['receipt', report, led, doc])[0], 0)
        self.write('d.md', 'final text, edited after the check')
        code, out = run(['receipt', report, led, doc])
        self.assertEqual(code, 1)
        self.assertIn('is not the file that was verified', out)

    def test_changed_lists_claims_and_their_dependents(self):
        a = self.write('a.json', {'sources': {}, 'claims': [{'id': 'x', 'value': 1}, {'id': 'y', 'value': 2, 'expr': 'x + 1'}],
                                  'relations': ['y > x']})
        b = self.write('b.json', {'sources': {}, 'claims': [{'id': 'x', 'value': 5}, {'id': 'y', 'value': 2, 'expr': 'x + 1'}],
                                  'relations': ['y > x']})
        d = self.write('d.md', 'same')
        code, out = run(['changed', d, d, '--old-ledger', a, '--new-ledger', b])
        self.assertEqual(code, 0)
        self.assertIn('Claims changed, added or removed: x', out)
        self.assertIn('Claims derived from them: y', out)
        self.assertIn('Relations touching them: y > x', out)

    def test_tables_are_not_checked_as_prose(self):
        led = self.base([])
        code, out = run(['check', led, os.path.join(self.dir, 't.csv')])
        self.assertEqual(code, 2)
        self.assertIn('reproduce', out)



class ReviewRegressions(Tmp):
    """Inputs that passed an earlier version and must not (Codex review, round 1)."""

    SRC = {'f': {'type': 'file', 'path': 't.csv', 'as_of': '2026-09-24T12:00:00Z'},
           'w': {'type': 'web', 'url': 'https://x.test', 'retrieved': '2026-09-24', 'effective': '2026-09-01',
                 'entity': 'Mojito House, Main St'},
           'd': {'type': 'doc', 'ref': 'ops log'}}

    def led(self, claims, **extra):
        self.write('t.csv', 'k,v\na,7\nb,12\nc,15\n')
        return self.write('claims.json', {'sources': self.SRC, 'claims': claims, **extra})

    def cell(self, cid, key, anchor):
        return {'id': cid, 'value': {'a': 7, 'b': 12, 'c': 15}[key], 'source': 'f',
                'locate': {'where': {'k': key}, 'column': 'v'}, 'anchors': [anchor]}

    def check(self, led, text):
        return run(['check', led, self.write('d.md', text)])

    def test_extra_number_inside_an_anchor_is_unbound(self):
        code, out = self.check(self.led([self.cell('x', 'a', '7 stores sold 999 units')]), '7 stores sold 999 units.')
        self.assertEqual(code, 1)
        self.assertIn('"999" sits in the anchor for x but no claim accounts for it', out)

    def test_a_range_is_two_claims(self):
        one = self.led([self.cell('lo', 'b', 'Range: 12-15 days')])
        self.assertEqual(self.check(one, 'Range: 12-15 days.')[0], 1)
        two = self.led([self.cell('lo', 'b', 'Range: 12-15 days'), self.cell('hi', 'c', 'Range: 12-15 days')])
        code, out = self.check(two, 'Range: 12-15 days.')
        self.assertEqual(code, 0, out)

    def test_text_claims_do_not_silence_numbers(self):
        claim = {'id': 'award', 'value': 'ranked on the list', 'source': 'd', 'anchors': ['#42 on the 50 Best list']}
        self.assertEqual(self.check(self.led([claim]), 'Cafe Uno is #42 on the 50 Best list.')[0], 1)
        claim.update({'quote': 'No. 42, North America 50 Best', 'labels': [42, 50]})
        code, out = self.check(self.led([claim]), 'Cafe Uno is #42 on the 50 Best list.')
        self.assertEqual(code, 0, out)
        claim['labels'] = [42, 51]
        code, out = self.check(self.led([claim]), 'Cafe Uno is #42 on the 50 Best list.')
        self.assertIn("label 51 must appear as a number in this claim's", out)

    def test_a_quoted_bound_does_not_establish_a_larger_value(self):
        claim = {'id': 'm', 'value': 500, 'source': 'w', 'quote': '50+ mojitos & drinks', 'anchors': ['500 drinks']}
        code, out = self.check(self.led([claim]), 'The menu lists 500 drinks.')
        self.assertEqual(code, 1)
        self.assertIn('the quote does not show 500', out)
        claim.update({'value': 50, 'anchors': ['50 drinks']})
        code, out = self.check(self.led([claim]), 'The menu lists 50 drinks.')
        self.assertIn('the source gives only "gte" this value', out)

    def test_derived_claims_need_a_sourced_root(self):
        circle = [{'id': 'a', 'value': 999, 'expr': 'b', 'anchors': ['999 sales']},
                  {'id': 'b', 'value': 999, 'expr': 'a', 'omit': 'intermediate'}]
        code, out = self.check(self.led(circle), '999 sales.')
        self.assertEqual(code, 1)
        self.assertIn('claims derive from each other in a circle', out)
        constant = [{'id': 'a', 'value': 999, 'expr': '999', 'anchors': ['999 sales']}]
        code, out = self.check(self.led(constant), '999 sales.')
        self.assertIn('a bare number needs a source', out)

    def test_glued_currency_code_needs_a_claim(self):
        code, out = self.check(self.led([]), 'Revenue: USD1200.')
        self.assertEqual(code, 1)
        self.assertIn('"1200" is not bound', out)

    def test_dates_are_checked_in_their_roles(self):
        claim = {'id': 'cut', 'value': '2026-09-23', 'source': 'd', 'anchors': ['As of 2026-09-09']}
        code, out = self.check(self.led([claim]), 'As of 2026-09-09.')
        self.assertEqual(code, 1)
        self.assertIn('shows 2026-09-09', out)
        claim = {'id': 'cut', 'value': '2026-09-23T18:00:00-07:00', 'source': 'd', 'anchors': ['thru ~5pm PT 9/23']}
        code, out = self.check(self.led([claim]), 'Numbers thru ~5pm PT 9/23.')
        self.assertIn('shows 5pm', out)

    def test_bare_number_exemption_is_refused(self):
        code, out = self.check(self.led([], exempt=['2026']), 'In 2026 we grew.')
        self.assertIn('"2026" is a bare number', out)
        code, out = self.check(self.led([], exempt=['(555) 555-0100']), 'Call (555) 555-0100.')
        self.assertEqual(code, 0, out)


class ReproduceExactly(Tmp):
    def compare(self, a, b, *flags):
        return run(['reproduce', self.write('a.csv', a), self.write('b.csv', b), '--key', 'id', *flags])

    def test_large_and_float_edge_values_are_not_equal(self):
        for x, y in (('1000000000', '1000000001'), ('9007199254740992', '9007199254740993'),
                     ('50%', '50'), ('inf', '999'), ('$5', '5')):
            code, out = self.compare(f'id,v\nr,{x}\n', f'id,v\nr,{y}\n')
            self.assertEqual(code, 1, (x, y, out))

    def test_formatting_only_difference_is_equal(self):
        code, out = self.compare('id,v\nr,"1,000"\n', 'id,v\nr,1000\n')
        self.assertEqual(code, 0, out)
        self.assertIn('RESULT: PASS:', out)

    def test_duplicate_or_ragged_columns_are_refused(self):
        code, out = self.compare('id,v,v\nx,1,7\n', 'id,v,v\nx,999,7\n')
        self.assertEqual(code, 2)
        self.assertIn('duplicate column', out)
        code, out = self.compare('id,v\nx,1,7\n', 'id,v\nx,1\n')
        self.assertEqual(code, 2)


class ReceiptCase(Tmp):
    def setUp(self):
        super().setUp()
        self.led = self.write('claims.json', {'sources': {}, 'claims': []})
        self.doc = self.write('d.md', 'final text')

    def header(self, verdict='CLEAR', doc_hash=None):
        return (f'artifact-sha256: {doc_hash or cc.sha256(self.doc)}\nledger-sha256: {cc.sha256(self.led)}\n'
                f'verdict: {verdict}\nverifier: gpt-6-sol (fresh codex exec session)\n\n')

    def receipt(self, text):
        return run(['receipt', self.write('verify.md', text), self.led, self.doc])


class ReceiptParsing(ReceiptCase):
    def test_clean_report_passes(self):
        code, out = self.receipt(self.header() + SECTIONS)
        self.assertEqual(code, 0, out)

    def test_quoted_example_cannot_override_the_header(self):
        forged = (self.header('CHANGES', doc_hash='0' * 64) + SECTIONS
                  + '```\n' + self.header() + '```\n')
        code, out = self.receipt(forged)
        self.assertEqual(code, 1)
        self.assertIn('outside the header block', out)

    def test_clear_with_open_findings_fails(self):
        body = SECTIONS.replace('## Stale or overstated\nnone', '## Stale or overstated\n- El Patio menu is undated')
        code, out = self.receipt(self.header() + body)
        self.assertEqual(code, 1)
        self.assertIn('CLEAR with 1 open item(s) under "Stale"', out)

    def test_missing_sections_fail(self):
        code, out = self.receipt(self.header() + '## Confirmed\n- all\n')
        self.assertEqual(code, 1)
        self.assertIn('no "Wrong" section', out)



class LedgerCase(Tmp):
    def led(self, claims, sources=None, files=None, **extra):
        for name, body in (files or {}).items():
            self.write(name, body)
        base = {'d': {'type': 'doc', 'ref': 'ops log'},
                'w': {'type': 'web', 'url': 'https://x.test', 'retrieved': '2026-09-24', 'effective': '2026-09-01',
                      'entity': 'Bar X, Riverton'}}
        return self.write('claims.json', {'sources': {**base, **(sources or {})}, 'claims': claims, **extra})

    def check(self, led, text):
        return run(['check', led, self.write('d.md', text)])


class ReviewRegressionsRound2(LedgerCase):
    """Inputs that passed after round 1 and must not (Codex review, round 2)."""

    def test_row_labels_need_a_confirmed_file_row(self):
        claim = {'id': 'x', 'value': 7, 'source': 'd', 'locate': {'where': {'fake': 999}, 'column': 'v'},
                 'anchors': ['7 stores sold 999 units']}
        code, out = self.check(self.led([claim]), '7 stores sold 999 units.')
        self.assertEqual(code, 1)
        self.assertIn('"locate" reads a query or file source', out)
        self.assertIn('"999" sits in the anchor', out)

    def test_bounds_do_not_pass_through_derivation_or_rounding(self):
        a = {'id': 'a', 'value': 50, 'source': 'w', 'quote': '50+ drinks', 'omit': 'intermediate'}
        b = {'id': 'b', 'value': 50, 'expr': 'a', 'anchors': ['Exactly 50 drinks']}
        code, out = self.check(self.led([a, b]), 'Exactly 50 drinks.')
        self.assertIn('which the source gives only as a bound', out)
        c = {'id': 'c', 'value': 50.4, 'source': 'w', 'quote': 'at least 50 drinks', 'anchors': ['at least 50 drinks']}
        code, out = self.check(self.led([c]), 'It has at least 50 drinks.')
        self.assertIn('the value must be that number exactly', out)

    def test_other_bound_forms_are_bounds(self):
        for quote in ('50 or more drinks', 'a minimum of 50 drinks', '50 and up'):
            claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': quote, 'anchors': ['Exactly 50 drinks']}
            code, out = self.check(self.led([claim]), 'Exactly 50 drinks.')
            self.assertEqual(code, 1, quote)
            self.assertIn('the source gives only "gte" this value', out, quote)

    def test_negated_qualifiers_are_refused(self):
        claim = {'id': 'm', 'value': 60, 'source': 'w', 'quote': '60 drinks', 'anchors': ['not over 50 drinks']}
        code, out = self.check(self.led([claim]), 'It pours not over 50 drinks.')
        self.assertEqual(code, 1)
        self.assertIn('can\'t be read exactly (a negated qualifier', out)

    def test_decimal_lexemes_survive_json_and_expressions(self):
        files = {'s.json': '{"v": 9007199254740993.0}'}
        src = {'j': {'type': 'file', 'path': 's.json', 'as_of': '2026-09-24T00:00:00Z'}}
        claim = {'id': 'x', 'value': 9007199254740992, 'source': 'j', 'locate': {'json': 'v'},
                 'anchors': ['total 9007199254740992']}
        code, out = self.check(self.led([claim], src, files), 'The total 9007199254740992.')
        self.assertIn('ledger says 9007199254740992 but s.json says 9007199254740993.0', out)
        self.assertEqual(cc.evaluate('a + 9007199254740993.0', {'a': cc.dec(0)}), cc.dec('9007199254740993.0'))

    def test_scaffold_keeps_exact_decimals(self):
        self.write('t.csv', 'k,v\na,90071992547409.93\n')
        code, out = run(['scaffold', os.path.join(self.dir, 't.csv'), '--source', 'f', '--key', 'k'])
        self.assertIn('"value": "90071992547409.93"', out)

    def test_percent_cells_need_a_percent_unit(self):
        files = {'t.csv': 'k,v\nchurn,50%\n'}
        src = {'f': {'type': 'file', 'path': 't.csv', 'as_of': '2026-09-24T00:00:00Z'}}
        claim = {'id': 'x', 'value': 50, 'unit': 'ratio', 'source': 'f',
                 'locate': {'where': {'k': 'churn'}, 'column': 'v'}, 'anchors': ['Churn: 5000%']}
        code, out = self.check(self.led([claim], src, files), 'Churn: 5000%.')
        self.assertIn('the cell is a percentage', out)

    def test_three_letter_currency_codes_are_quantities(self):
        for code_ in ('SEK', 'BRL', 'ZAR', 'NOK'):
            code, out = self.check(self.led([]), f'Revenue: {code_}1200.')
            self.assertEqual(code, 1, code_)
            self.assertIn('"1200" is not bound', out)

    def test_explicit_negatives_are_kept(self):
        for text in ('Balance: -\u00a57 dollars', 'Balance: \u2212 7 dollars', 'Balance: -seven dollars'):
            claim = {'id': 'x', 'value': 7, 'source': 'w', 'quote': '7 dollars', 'anchors': [cc.normalize(text)]}
            code, out = self.check(self.led([claim]), text)
            self.assertEqual(code, 1, text)

    def test_iso_and_day_month_dates_are_read(self):
        claim = {'id': 'cut', 'value': '2026-09-23T17:00:00-07:00', 'source': 'd',
                 'anchors': ['As of 2026-09-23T17:00:00-07:00']}
        code, out = self.check(self.led([claim]), 'As of 2026-09-23T17:00:00-07:00.')
        self.assertEqual(code, 0, out)
        claim = {'id': 'day', 'value': '2026-09-23', 'source': 'd', 'anchors': ['on 23 September 2026']}
        code, out = self.check(self.led([claim]), 'Signed on 23 September 2026.')
        self.assertEqual(code, 0, out)


class TablesRound2(Tmp):
    def test_ragged_or_unterminated_rows_are_refused(self):
        good = self.write('a.csv', 'id,v\nx,1\n')
        for bad in ('id,v\nx,1\n,,\n', 'id,v\nx,"1\n'):
            code, out = run(['reproduce', good, self.write('b.csv', bad), '--key', 'id'])
            self.assertEqual(code, 2, bad)

    def test_signed_currency_is_a_unit_change(self):
        code, out = run(['reproduce', self.write('a.csv', 'id,v\nr,+$5\n'), self.write('b.csv', 'id,v\nr,5\n'),
                         '--key', 'id'])
        self.assertEqual(code, 1)


class ReceiptRound2(ReceiptCase):
    def test_findings_under_a_subheading_still_count(self):
        body = SECTIONS.replace('| Where | Deliverable says | Actually | Evidence |\n|---|---|---|---|\n',
                                '### Revenue\n- Revenue is unsupported\n')
        code, out = self.receipt(self.header() + body)
        self.assertEqual(code, 1)
        self.assertIn('open item(s) under "Wrong"', out)

    def test_a_finding_written_only_as_a_subheading_counts(self):
        # Codex round 4 on the published PR.
        body = SECTIONS.replace('| Where | Deliverable says | Actually | Evidence |\n|---|---|---|---|\n',
                                '### Revenue is overstated\n')
        code, out = self.receipt(self.header() + body)
        self.assertEqual(code, 1)
        self.assertIn('CLEAR with 1 open item(s) under "Wrong"', out)

    def test_hash_command_output_can_fill_the_header(self):
        head = (f'artifact-sha256: {cc.sha256(self.doc)}  {self.doc}\nledger-sha256: {cc.sha256(self.led)}  claims.json\n'
                'verdict: CLEAR\nverifier: gpt-6-sol (fresh codex exec session)\n\n')
        code, out = self.receipt(head + SECTIONS)
        self.assertEqual(code, 0, out)



class ReviewRegressionsRound3(LedgerCase):
    """Inputs that passed after round 2 and must not (Codex review, round 3)."""

    def jled(self, value, anchor, **claim_extra):
        files = {'s.json': json.dumps({'v': value})}
        src = {'j': {'type': 'file', 'path': 's.json', 'as_of': '2026-09-24T00:00:00Z'}}
        claim = {'id': 'x', 'value': value, 'source': 'j', 'locate': {'json': 'v'}, 'anchors': [anchor], **claim_extra}
        return self.led([claim], src, files)

    def test_a_sign_after_a_word_is_kept(self):
        code, out = self.check(self.jled(7000000, 'Net income -$7 million'), 'Net income -$7 million.')
        self.assertEqual(code, 1)
        code, out = self.check(self.jled(7000000, 'Revenue - 7 million'), 'Revenue - 7 million.')
        self.assertIn('a detached "+" or "-" after a word', out)

    def test_a_bound_is_repeated_not_rounded(self):
        claim = {'id': 'm', 'value': 1499, 'source': 'w', 'quote': 'at most 1499 accounts', 'anchors': ['At most 1K accounts']}
        code, out = self.check(self.led([claim]), 'At most 1K accounts.')
        self.assertEqual(code, 1)

    def test_detached_qualifiers_are_refused_or_read(self):
        claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': 'at least USD 50 revenue', 'anchors': ['Exactly USD 50 revenue']}
        self.assertEqual(self.check(self.led([claim]), 'Exactly USD 50 revenue.')[0], 1)
        claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': '50 accounts or more', 'anchors': ['Exactly 50 accounts']}
        code, out = self.check(self.led([claim]), 'Exactly 50 accounts.')
        self.assertIn('If the source gives a bound, declare it', out)
        claim.update({'bound': '>=', 'anchors': ['at least 50 accounts']})
        code, out = self.check(self.led([claim]), 'It has at least 50 accounts.')
        self.assertEqual(code, 0, out)

    def test_qualifiers_do_not_match_inside_words(self):
        code, out = self.check(self.jled(60000000, 'Turnover $50M'), 'Turnover $50M.')
        self.assertEqual(code, 1)

    def test_iso_seconds_are_checked(self):
        claim = {'id': 'cut', 'value': '2026-09-23T17:00:00-07:00', 'source': 'd',
                 'anchors': ['As of 2026-09-23T17:00:59-07:00']}
        code, out = self.check(self.led([claim]), 'As of 2026-09-23T17:00:59-07:00.')
        self.assertEqual(code, 1)

    def test_approximate_cutoff_warns(self):
        claim = {'id': 'cut', 'value': '2026-09-23T17:00:00-07:00', 'source': 'd', 'anchors': ['thru ~5pm PT 9/23']}
        code, out = self.check(self.led([claim]), 'Numbers thru ~5pm PT 9/23.')
        self.assertEqual(code, 0, out)
        self.assertIn('gives an approximate time', out)
        self.assertIn('resting on a doc source', out)



class ReviewRegressionsRound4(LedgerCase):
    """Inputs that passed after round 3 and must not (Codex review, round 4)."""

    def test_a_sign_after_a_currency_symbol_is_kept(self):
        files = {'s.json': '{"v": 7000000}'}
        src = {'j': {'type': 'file', 'path': 's.json', 'as_of': '2026-09-24T00:00:00Z'}}
        claim = {'id': 'x', 'value': 7000000, 'source': 'j', 'locate': {'json': 'v'}, 'anchors': ['Net income $-7 million']}
        code, out = self.check(self.led([claim], src, files), 'Net income $-7 million.')
        self.assertEqual(code, 1)

    def test_every_qualifier_in_the_clause_counts(self):
        for quote in ('more than US$50 revenue', '50 accounts or over', 'up to about 50 accounts'):
            claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': quote, 'anchors': ['Exactly 50 accounts']}
            code, out = self.check(self.led([claim]), 'Exactly 50 accounts.')
            self.assertEqual(code, 1, quote)
        for text in ('50 accounts or over', 'up to about 50 accounts'):
            self.assertIsNotNone(cc.tokenize(cc.normalize(text))[0][0].problem, text)

    def test_ordinary_wording_is_not_a_qualifier(self):
        for text in ('over the last 12 months', '2013 <1K, 2014 8K', 'at least 50 of the 70 accounts'):
            self.assertFalse([t for t in cc.tokenize(cc.normalize(text))[0] if t.problem], text)

    def test_a_declared_bound_cannot_contradict_the_quote(self):
        claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': 'at most 50 accounts', 'bound': '>=',
                 'anchors': ['at least 50 accounts']}
        code, out = self.check(self.led([claim]), 'It has at least 50 accounts.')
        self.assertIn('"bound" says >= but the quote says', out)
        claim.update({'quote': '50 accounts', 'bound': '>='})
        code, out = self.check(self.led([claim]), 'It has at least 50 accounts.')
        self.assertIn('the quote shows 50 exactly; drop "bound"', out)



class ReviewRegressionsRound5(LedgerCase):
    """Inputs that passed after round 4 and must not, and correct sentences it refused
    (Codex review, round 5)."""

    def test_leftover_bound_wording_anywhere_in_the_sentence(self):
        for quote in ('up to a total of about 50 accounts', '50 active enterprise customer accounts or more',
                      'up to approx. 50 accounts'):
            claim = {'id': 'm', 'value': 50, 'source': 'w', 'quote': quote, 'anchors': ['Exactly 50 accounts']}
            code, out = self.check(self.led([claim]), 'Exactly 50 accounts.')
            self.assertEqual(code, 1, quote)
            self.assertIn('attached to no number', out, quote)

    def test_ordinary_wording_still_reads(self):
        for text in ('We surveyed 50 customers about onboarding', 'Revenue rose from USD 50 to about USD 70',
                     'over the last 12 months', 'at least 50 of the 70 accounts', '2013 <1K, 2014 8K'):
            self.assertFalse([t for t in cc.tokenize(cc.normalize(text))[0] if t.problem], text)

    def test_a_bullet_or_paragraph_ends_the_sentence(self):
        toks = cc.tokenize(cc.normalize('- 50 accounts\n- up to 70 more planned'))[0]
        self.assertEqual([(t.text, t.op, t.problem) for t in toks], [('50', 'eq', None), ('70', 'lte', None)])



class ParenthesesReadAsWritten(LedgerCase):
    """A number in parentheses reads as written. The guard against a loss shown unsigned is
    the ledger's sign: a negative value needs a signed display or "magnitude": true."""

    def test_a_negative_ledger_value_fails_an_unsigned_display(self):
        claim = {'id': 'ni', 'value': -50, 'source': 'w', 'quote': 'net income: -$50', 'anchors': ['Net income was ($50)']}
        code, out = self.check(self.led([claim]), 'Net income was ($50).')
        self.assertEqual(code, 1)
        self.assertIn('ni: "Net income was ($50)" shows 50; the ledger value is -50', out)
        claim['magnitude'] = True
        code, out = self.check(self.led([claim]), 'Net income was ($50).')
        self.assertEqual(code, 0, out)

    def test_a_wrong_positive_ledger_passes_mechanically(self):
        # The source says -$50 and the ledger says 50: only the verifier catches this.
        claim = {'id': 'ni', 'value': 50, 'source': 'w', 'quote': 'net income: $50', 'anchors': ['Net income was ($50)']}
        code, out = self.check(self.led([claim]), 'Net income was ($50).')
        self.assertEqual(code, 0, out)

    def test_parenthesized_numbers_read_normally(self):
        for text, value in (('41,380 of 64,452 (64.2%)', Decimal('64.2')), ('the unique total (+69K)', Decimal(69000)),
                            ('a loss (-$50)', Decimal(50)), ('Net income was ($50).', Decimal(50)),
                            ('Revenue reported in USD. (2024) was a good year.', Decimal(2024))):
            tok = cc.tokenize(cc.normalize(text))[0][-1]
            self.assertIsNone(tok.problem, text)
            self.assertEqual(tok.value, value, text)


class ReviewRegressionsPr28(LedgerCase):
    """Codex review of the published PR, round 1."""

    def query_led(self, as_of):
        src = {'q': {'type': 'query', 'sql': 'q.sql', 'result': 't.csv', 'as_of': as_of, 'grain': 'account'}}
        return self.led([], sources=src, files={'q.sql': 'select 1', 't.csv': 'k,v\na,1\n'})

    def test_a_malformed_query_cutoff_fails(self):
        for as_of in ('not-a-dateT99:99+99:99', '2026-09-23T25:00:00Z', '2026-09-23T17:00:00-07:00 or so'):
            code, out = self.check(self.query_led(as_of), 'Nothing here.')
            self.assertEqual(code, 1, as_of)
            self.assertIn('is not an ISO date or datetime', out, as_of)

    def test_valid_cutoffs_pass_or_warn_as_documented(self):
        for as_of in ('2026-09-23T17:00:00-07:00', '2026-09-24T00:30:00Z'):
            code, out = self.check(self.query_led(as_of), 'Nothing here.')
            self.assertEqual(code, 0, out)
            self.assertNotIn('as_of', out)
        for as_of in ('2026-09-23', '2026-09-23T17:00:00'):
            code, out = self.check(self.query_led(as_of), 'Nothing here.')
            self.assertEqual(code, 0, out)
            self.assertIn('has no time and timezone', out)

    def test_dates_with_trailing_text_are_not_dates(self):
        self.assertIsNone(cc._parse_date('2026-09-24garbage'))
        self.assertEqual(cc._parse_date('2026-09-24T12:00:00Z'), cc.dt.date(2026, 9, 24))

    def test_changed_reports_relation_and_exemption_edits(self):
        base = {'sources': {}, 'claims': [{'id': 'a', 'value': 1, 'source': 'd'}],
                'relations': ['a + b == c', 'a <= c'], 'exempt': ['100 Main St']}
        edited = {**base, 'relations': ['a + b >= c'], 'exempt': ['100 Main St', '7 stores']}
        old_l, new_l = self.write('old.json', base), self.write('new.json', edited)
        doc = self.write('d.md', 'Same.')
        code, out = run(['changed', doc, doc, '--old-ledger', old_l, '--new-ledger', new_l])
        self.assertEqual(code, 0)
        self.assertIn('Claims changed, added or removed: none', out)
        self.assertIn('Relations added or edited: a + b >= c', out)
        self.assertIn('Relations removed or edited: a + b == c; a <= c', out)
        self.assertIn('Exemptions added: 7 stores', out)
        self.assertIn('Exemptions removed: none', out)



class ReviewRegressionsPr28Round2(LedgerCase):
    """Codex review of the published PR, round 2."""

    def test_one_claim_cannot_account_for_two_equal_numbers(self):
        claim = {'id': 'rev', 'value': 5, 'source': 'w', 'quote': 'revenue: 5', 'anchors': ['Revenue was 5; headcount was 5']}
        code, out = self.check(self.led([claim]), 'Revenue was 5; headcount was 5.')
        self.assertEqual(code, 1)
        self.assertIn('holds 2 numbers that show this value', out)

    def test_two_claims_cannot_share_one_number(self):
        # Codex round 3: the mirror of the case above.
        rev = {'id': 'rev', 'value': 5, 'source': 'w', 'quote': 'revenue: 5', 'anchors': ['Revenue was 5']}
        head = {'id': 'head', 'value': 5, 'source': 'w', 'quote': 'headcount: 5', 'anchors': ['Revenue was 5']}
        code, out = self.check(self.led([rev, head]), 'Revenue was 5.')
        self.assertEqual(code, 1)
        self.assertIn('head: "Revenue was 5" shows 5, which already states rev', out)
        head['anchors'] = ['headcount was 5']
        code, out = self.check(self.led([rev, head]), 'Revenue was 5; headcount was 5.')
        self.assertEqual(code, 0, out)

    def test_a_label_cannot_also_be_a_value_in_either_order(self):
        # Codex round 4: "#5 ranking had 1 winner" -- the 5 names the ranking.
        winners = {'id': 'winners', 'value': 1, 'source': 'w', 'quote': 'ranking 5 had 1 winner', 'labels': [5],
                   'anchors': ['#5 ranking had 1 winner']}
        head = {'id': 'head', 'value': 5, 'source': 'w', 'quote': 'headcount: 5', 'anchors': ['#5 ranking']}
        for claims in ([winners, head], [head, winners]):
            code, out = self.check(self.led(claims), '#5 ranking had 1 winner.')
            self.assertEqual(code, 1, [c['id'] for c in claims])
            self.assertIn('winners: reads 5 as a label, but it states head', out)

    def test_labels_are_still_shared(self):
        a = {'id': 'a', 'value': 64, 'source': 'w', 'quote': '2016: 64 new', 'labels': [2016], 'anchors': ['2016: 64 new']}
        b = {'id': 'b', 'value': 57, 'source': 'w', 'quote': '2016: 57 services', 'labels': [2016],
             'anchors': ['2016: 64 new, 57 services']}
        code, out = self.check(self.led([a, b]), '2016: 64 new, 57 services.')
        self.assertEqual(code, 0, out)

    def test_an_exemption_cannot_cover_a_claimed_number(self):
        rev = {'id': 'rev', 'value': 5, 'source': 'w', 'quote': 'revenue: 5', 'anchors': ['Revenue was 5']}
        code, out = self.check(self.led([rev], exempt=['Revenue was 5']), 'Revenue was 5.')
        self.assertEqual(code, 1)
        self.assertIn('"Revenue was 5" covers 5, which states rev', out)

    def test_nearly_excludes_the_threshold(self):
        # Codex round 5: "nearly 50" asserts a value below 50.
        for text in ('nearly 50 accounts', 'almost 50 accounts'):
            tok = cc.tokenize(cc.normalize(text))[0][0]
            self.assertFalse(cc.displays(tok, Decimal(50)), text)
            self.assertTrue(cc.displays(tok, Decimal('49.6')), text)
            self.assertFalse(cc.displays(tok, Decimal('49.4')), text)

    def test_two_date_claims_cannot_share_one_date(self):
        a = {'id': 'cutoff', 'value': '2026-09-23', 'source': 'd', 'anchors': ['thru 9/23']}
        b = {'id': 'launch', 'value': '2026-09-23', 'source': 'd', 'anchors': ['thru 9/23']}
        code, out = self.check(self.led([a, b]), 'Numbers thru 9/23.')
        self.assertEqual(code, 1)
        self.assertIn('which already states cutoff', out)

    def test_changed_sees_a_swapped_link(self):
        for ext, old, new in (('md', 'Open late [per its site](https://a.test/hours).', 'Open late [per its site](https://b.test/hours).'),
                              ('md', 'Open late, per https://a.test/hours today.', 'Open late, per https://b.test/hours today.'),
                              ('html', '<p>Open late <a href="https://a.test/hours">per its site</a>.</p>',
                               '<p>Open late <a href="https://b.test/hours">per its site</a>.</p>')):
            code, out = run(['changed', self.write(f'old.{ext}', old), self.write(f'new.{ext}', new)])
            self.assertEqual(code, 0)
            self.assertIn('+ ', out, ext)
            self.assertIn('https://b.test/hours', out, ext)
            self.assertNotIn('(none)', out, ext)

    def test_links_still_do_not_count_as_numbers(self):
        code, out = self.check(self.led([]), 'See [the 2025 list](https://a.test/2025/top-50).')
        self.assertIn('"2025"', out)
        self.assertNotIn('"50"', out)

    def test_source_dates_in_the_future_fail(self):
        web = {'type': 'web', 'url': 'https://x.test', 'entity': 'Bar X, Riverton'}
        for src, needle in (({**web, 'retrieved': '2099-01-01', 'effective': '2026-09-01'}, 'retrieved 2099-01-01 is in the future'),
                            ({**web, 'retrieved': '2026-09-24', 'effective': '2099-01-01'}, 'effective 2099-01-01 is in the future'),
                            ({'type': 'query', 'sql': 'q.sql', 'result': 't.csv', 'grain': 'account',
                              'as_of': '2099-01-01T00:00:00Z'}, 'as_of 2099-01-01T00:00:00Z is in the future'),
                            ({'type': 'file', 'path': 't.csv', 'as_of': '2099-01-01'}, 'as_of 2099-01-01 is in the future')):
            led = self.led([], sources={'s': src}, files={'q.sql': 'select 1', 't.csv': 'k,v\na,1\n'})
            code, out = run(['check', led, self.write('d.md', 'Nothing here.'), '--today', '2026-09-24'])
            self.assertEqual(code, 1, needle)
            self.assertIn(needle, out)
        led = self.led([], sources={'s': {**web, 'retrieved': '2026-09-25', 'effective': '2026-09-01'}})
        code, out = run(['check', led, self.write('d.md', 'Nothing here.'), '--today', '2026-09-24'])
        self.assertNotIn('in the future', out)



class RealReportFalseAlarms(LedgerCase):
    """Normal copy in a shipped insight report that 1.0.0 refused."""

    def test_notes_in_parentheses_read_normally(self):
        for text, values in (('4.6 (1,947)', [Decimal('4.6'), Decimal(1947)]),
                             ('4.2 (3.1k)', [Decimal('4.2'), Decimal(3100)]),
                             ('Sources: industry survey (2024); menus', [Decimal(2024)]),
                             ('Net income was (1,234).', [Decimal(1234)]),
                             ('Best of NYC (2024)', [Decimal(2024)]),
                             ('We told us (2024) twice', [Decimal(2024)])):
            toks = cc.tokenize(cc.normalize(text))[0]
            self.assertEqual([t.problem for t in toks], [None] * len(values), text)
            self.assertEqual([t.value for t in toks], values, text)

    def test_a_qualified_one_owns_its_qualifier(self):
        # "one" is never a checked number; a qualifier attached to it is not left over.
        toks = cc.tokenize(cc.normalize('Each store here has at least one of three traits.'))[0]
        self.assertEqual([(t.value, t.op, t.problem) for t in toks], [(3, 'eq', None)])
        # Codex round 4: a hyphenated word is not a suffix ("plus-sized"), for digits too.
        self.assertEqual(cc.tokenize(cc.normalize('one plus-sized store'))[0], [])
        for text, op in (('1 plus-sized store', 'eq'), ('5 plus stores', 'gte')):
            toks = cc.tokenize(cc.normalize(text))[0]
            self.assertEqual([(t.op, t.problem) for t in toks], [(op, None)], text)
        self.assertIn('attached to no number', cc.tokenize(cc.normalize('3 or more-ish stores'))[0][0].problem)
        for text in ('one or more stores', 'one+ stores', 'one and up', 'one plus\u2011sized store'):
            self.assertEqual(cc.tokenize(cc.normalize(text))[0], [], text)
        # Codex round 5: typographic hyphens, and spelled fractions.
        toks = cc.tokenize(cc.normalize('1 plus\u2011sized store'))[0]
        self.assertEqual([(t.op, t.problem) for t in toks], [('eq', None)])
        for text in ('at least one-third of users', 'two-thirds of stores', 'one\u2011half of them'):
            toks = cc.tokenize(cc.normalize(text))[0]
            self.assertEqual([t.problem for t in toks], ['write it in digits'], text)
        self.assertEqual(cc.tokenize(cc.normalize('No one else stocks it.'))[0], [])
        self.assertEqual(cc.tokenize(cc.normalize('One of the best bars.'))[0], [])


if __name__ == '__main__':
    unittest.main()
