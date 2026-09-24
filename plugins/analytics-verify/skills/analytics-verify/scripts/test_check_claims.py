"""Tests for check_claims.py: python3 -m unittest discover -s <this dir> -p 'test_*.py'

The replay cases rebuild real errors from two agent-written deliverables (2026-09-24)
and pin down which ones this script catches and which it cannot. A test that asserts
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

import check_claims as cc

DELIVERED_CSV = """Year,New Direct customers,New HCB customers (first service),"New customers, unique across Direct + HCB",HCB service appointments
2013,191,0,191,0
2014,17123,0,17123,0
2015,97086,0,97086,0
2016,122935,89,122987,93
2017,168222,3510,170876,5069
2018,173399,5089,177115,15619
2019,174451,14358,185631,37691
2020,648334,19676,657691,48886
2021,212614,49114,244513,176388
2022,109948,70282,161092,377817
2023,85596,63793,132456,537845
2024,59559,66157,110917,663493
2025,56551,76277,119674,841582
2026 YTD (thru 9/23),40196,53326,84540,724672
Total,1966205,421671,2281892,3429155
"""

# The saved query.sql computed "combined" as Direct OR any Color Bar order, so a rerun
# of it could not reproduce the delivered column (Direct OR first service).
RERUN_OF_SAVED_QUERY = {'2016': 123002, '2017': 171535, '2018': 178418, '2019': 188912}

# First draft to the CFO, as posted for approval.
MR_DRAFT_V1 = """Hey Jose - numbers thru 9/23 below, full yearly breakdown in the attached csv

New customers
• Direct ever: 1.97M
• HCB ever (had a service): 422K
• 106K did both, so unique across Direct + HCB is 2.28M
• new by yr, unique across both: 2013 <1K, 2014 17K, 2015 97K, 2016 123K, 2017 171K, 2018 177K, 2019 186K, 2020 658K, 2021 245K, 2022 161K, 2023 132K, 2024 111K, 2025 120K, 2026 YTD 85K

HCB services (completed appointments)
• 3.43M total since the first bar opened in Dec 2016
• by yr: 2017 5K, 2018 16K, 2019 38K, 2020 49K, 2021 176K, 2022 378K, 2023 538K, 2024 663K, 2025 842K, 2026 YTD 725K

couple notes for the all-channel estimate
• counted by MR account, so someone w 2 accounts counts twice
• another 202K people bought product at a bar but never had a service. if you want them in, the unique total is 2.44M
"""

# The corrected draft after the independent check.
MR_DRAFT_V2 = """Hey Jose - numbers thru ~5pm PT 9/23 below, full yearly breakdown in the attached csv

New customers (counted by MR account)
• Direct ever: 1.97M
• HCB ever (had a service): 422K
• 106K did both, so unique across Direct + HCB is 2.28M
• new by yr, unique across both: 2013 <1K, 2014 17K, 2015 97K, 2016 123K, 2017 171K, 2018 177K, 2019 186K, 2020 658K, 2021 245K, 2022 161K, 2023 132K, 2024 111K, 2025 120K, 2026 YTD 85K

HCB services (completed appointments)
• 3.43M total since the first bar opened in Dec 2016
• by yr: 2016 <1K, 2017 5K, 2018 16K, 2019 38K, 2020 49K, 2021 176K, 2022 378K, 2023 538K, 2024 663K, 2025 842K, 2026 YTD 725K

couple notes for the all-channel estimate
• someone w 2 accounts counts twice
• another 202K accounts had a bar order but never a service. 48K of those already ordered Direct, so adding them brings the unique total to 2.44M (+154K)
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


def mr_ledger(version, svc_2016='anchor', extra_relations=()):
    """The ledger an author following the skill would keep for the CFO draft: every
    cell of the delivered table read from the file, each shown or omitted on purpose."""
    header, *rows = csv_rows()

    def cell(cid, year, col, anchor):
        value = int(next(r for r in rows if r[0] == year)[header.index(col)])
        claim = {'id': cid, 'value': value, 'source': 'q', 'locate': {'where': {'Year': year}, 'column': col}}
        claim.update({'omit': anchor[5:]} if anchor.startswith('omit:') else {'anchors': [anchor]})
        return claim

    unique_col, svc_col = 'New customers, unique across Direct + HCB', 'HCB service appointments'
    claims = [
        cell('direct_ever', 'Total', 'New Direct customers', 'Direct ever: 1.97M'),
        cell('hcb_ever', 'Total', 'New HCB customers (first service)', 'HCB ever (had a service): 422K'),
        cell('unique_ever', 'Total', unique_col, 'unique across Direct + HCB is 2.28M'),
        cell('services_total', 'Total', svc_col, '3.43M total'),
        {'id': 'both_ever', 'value': 105984, 'expr': 'direct_ever + hcb_ever - unique_ever', 'anchors': ['106K did both']},
        {'id': 'bar_only', 'value': 202023, 'source': 'retail', 'locate': {'json': '[0].HCB_NO_SERVICE_ACCOUNTS'},
         'anchors': ['another 202K']},
        {'id': 'bar_only_net', 'value': 154172, 'source': 'retail', 'locate': {'json': '[0].NET_OF_DIRECT'}},
        {'id': 'bar_also_direct', 'value': 47851, 'expr': 'bar_only - bar_only_net'},
        {'id': 'unique_with_bar', 'value': 2436064, 'expr': 'unique_ever + bar_only_net', 'anchors': ['unique total is 2.44M']},
        {'id': 'first_bar', 'value': '2016-12-01', 'source': 'q', 'anchors': ['first bar opened in Dec 2016']},
    ]
    if version == 1:
        claims[6]['omit'] = 'not in this draft'
        claims[7]['omit'] = 'not in this draft'
        claims.append({'id': 'cutoff', 'value': '2026-09-23T17:00:00-07:00', 'source': 'q', 'anchors': ['thru 9/23']})
    else:
        claims[6]['anchors'] = ['2.44M (+154K)']
        claims[7]['anchors'] = ['48K of those already ordered Direct']
        claims[8]['anchors'] = ['unique total to 2.44M']
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
            claims.append(cell(f'svc_{slug}', year, svc_col, 'omit:no bars before Dec 2016'))
        elif year == '2016':
            claims.append(cell('svc_2016', year, svc_col,
                               'by yr: 2016 <1K' if svc_2016 == 'anchor' else 'omit:rounds to zero, in the CSV'))
        else:
            claims.append(cell(f'svc_{slug}', year, svc_col, f'{label} {shown(n_svc)}'))
    return {
        'sources': {
            'q': {'type': 'query', 'sql': 'query.sql', 'result': 'delivered.csv', 'grain': 'MR account',
                  'as_of': '2026-09-23T17:00:00-07:00'},
            'retail': {'type': 'file', 'path': 'retail.json', 'as_of': '2026-09-24T19:30:00Z'},
        },
        'claims': claims,
        'relations': ['direct_ever + hcb_ever - both_ever == unique_ever', *extra_relations],
        'exempt': ['w 2 accounts'],
    }


class MadisonReedReplay(Tmp):
    def setUp(self):
        super().setUp()
        self.write('delivered.csv', DELIVERED_CSV)
        self.write('query.sql', 'select 1')
        self.write('retail.json', [{'HCB_NO_SERVICE_ACCOUNTS': 202023, 'NET_OF_DIRECT': 154172}])

    def ledger(self, version, **kw):
        return self.write('claims.json', mr_ledger(version, **kw))

    def test_v2_passes(self):
        code, out = run(['check', self.ledger(2), self.write('v2.md', MR_DRAFT_V2)])
        self.assertEqual(code, 0, out)

    def test_v1_dropped_2016_services_row_is_caught(self):
        code, out = run(['check', self.ledger(1), self.write('v1.md', MR_DRAFT_V1)])
        self.assertEqual(code, 1)
        self.assertIn('svc_2016: "by yr: 2016 <1K" is not in the deliverable', out)

    def test_v1_additive_sentence_fails_the_relation_it_asserts(self):
        # "another 202K ... the unique total is 2.44M" asserts 2.28M + 202K = 2.44M.
        led = self.ledger(1, svc_2016='omit', extra_relations=['unique_ever + bar_only == unique_with_bar'])
        code, out = run(['check', led, self.write('v1.md', MR_DRAFT_V1)])
        self.assertEqual(code, 1)
        self.assertIn('FAIL relation  unique_ever + bar_only == unique_with_bar', out)

    def test_v1_wording_errors_pass_mechanically(self):
        # "people" for accounts, "thru 9/23" for a 5pm cutoff, and 202K framed as additive
        # are all wording: without a declared relation, only the verifier catches them.
        code, out = run(['check', self.ledger(1, svc_2016='omit'), self.write('v1.md', MR_DRAFT_V1)])
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
        self.assertIn("('2016',) New customers, unique across Direct + HCB: delivered 122987, rerun 123002", out)

    def test_live_drift_is_reported_not_hidden(self):
        drifted = DELIVERED_CSV.replace('2025,56551,', '2025,56550,')
        rerun = self.write('rerun.csv', drifted)
        code, out = run(['reproduce', os.path.join(self.dir, 'delivered.csv'), rerun, '--key', 'Year'])
        self.assertEqual(code, 1)
        code, out = run(['reproduce', os.path.join(self.dir, 'delivered.csv'), rerun, '--key', 'Year', '--rel-tol', '0.001'])
        self.assertEqual(code, 0)
        self.assertIn('RESULT: PASS WITH DRIFT', out)
        self.assertIn('delivered 56551, rerun 56550 (-1)', out)


class XzoReplay(Tmp):
    """Claims from the Ozama Miami insight report and its cross-exam."""

    def ledger(self, claims, exempt=()):
        sources = {
            'census': {'type': 'web', 'url': 'https://data.census.gov/x', 'retrieved': '2026-09-24',
                       'effective': '2025-12-11', 'entity': 'Hialeah city, FL (ACS 2020-24 B03001)'},
            'trova': {'type': 'web', 'url': 'https://example.com/trova', 'retrieved': '2026-09-24',
                      'effective': '2026-07-01', 'entity': 'Cafe La Trova, Little Havana'},
            'cmc': {'type': 'web', 'url': 'https://example.com/cmc', 'retrieved': '2026-09-24',
                    'effective': '2026-09-01', 'entity': 'Call Me Cuban, Cardozo Hotel'},
            'mojitos': {'type': 'web', 'url': 'https://mojitos.com', 'retrieved': '2026-09-24',
                        'effective': '2026-09-01', 'entity': 'Mojitos Cuban Cuisine, Calle 8'},
        }
        return self.write('claims.json', {'sources': sources, 'claims': claims, 'exempt': list(exempt)})

    def test_unsourced_number_is_caught(self):
        led = self.ledger([])
        code, out = run(['check', led, self.write('r.md', 'Hialeah is more than 80% Cuban.')])
        self.assertEqual(code, 1)
        self.assertIn('FAIL unbound   "80%" is not bound to any claim', out)

    def test_display_that_overstates_the_source_is_caught(self):
        led = self.ledger([{'id': 'hialeah_cuban', 'value': 73.7, 'unit': '%', 'source': 'census',
                            'quote': 'Cuban: 73.7% of Hialeah residents', 'anchors': ['more than 80% Cuban']}])
        code, out = run(['check', led, self.write('r.md', 'Hialeah is more than 80% Cuban.')])
        self.assertEqual(code, 1)
        self.assertIn('hialeah_cuban: "more than 80% Cuban" shows 80%; the ledger value is 73.7%', out)

    def test_spelled_out_count_is_checked(self):
        led = self.ledger([{'id': 'cmc_rum', 'value': 5, 'source': 'cmc', 'quote': 'five of the ten cocktails use rum',
                            'labels': [10], 'anchors': ['Six of the ten cocktails are rum']}])
        code, out = run(['check', led, self.write('r.md', 'Six of the ten cocktails are rum.')])
        self.assertEqual(code, 1)
        self.assertIn('shows Six', out)

    def test_wrong_evidence_passes_mechanically(self):
        # The research notes said 11 (it counted July specials); the menu has 9. A ledger
        # built from the notes agrees with the prose, so only a live re-check catches this.
        led = self.ledger([{'id': 'trova_rum', 'value': 11, 'source': 'trova',
                            'quote': '11 rum cocktails on current bar menu', 'anchors': ['11 rum cocktails']}])
        code, out = run(['check', led, self.write('r.md', 'Cafe La Trova pours 11 rum cocktails.')])
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
        old = self.write('old.md', 'Liquors For You stocks Key Lime Cream.')
        new = self.write('new.md', 'Liquors For You stocks Key Lime Cream. It is owner-run, with long weekend hours.')
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
        self.assertTrue(self.ok('1.97M', 1966205))
        self.assertFalse(self.ok('1.97M', 1980000))
        self.assertTrue(self.ok('$24.99', 24.99, 'USD'))
        self.assertFalse(self.ok('1,000,000,001', 1000000000))

    def test_approximate_words_do_not_loosen(self):
        self.assertFalse(self.ok('about 80%', 76.2, '%'))
        self.assertTrue(self.ok('about 76%', 76.2, '%'))

    def test_comparators(self):
        self.assertTrue(self.ok('<1K', 191))
        self.assertFalse(self.ok('<1K', 1200))
        self.assertTrue(self.ok('50+', 50))
        self.assertFalse(self.ok('more than 50', 50))
        self.assertFalse(self.ok('nearly 30', 30.4))
        self.assertTrue(self.ok('not more than 80%', 73.7, '%'))
        self.assertFalse(self.ok('not more than 80%', 81, '%'))

    def test_percent_needs_a_percent_claim(self):
        self.assertTrue(self.ok('73.7%', 0.737, 'ratio'))
        self.assertFalse(self.ok('73.7%', 73.7))
        self.assertFalse(self.ok('73.7', 73.7, '%'))
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
        self.write('t.csv', 'k,v\na,1966205\nb,7\n')
        return self.write('claims.json', {'sources': sources, 'claims': claims, **extra})

    def test_typed_number_from_a_file_is_rejected(self):
        led = self.base([{'id': 'x', 'value': 1966205, 'source': 'f', 'anchors': ['total of 1.97M']}])
        code, out = run(['check', led, self.write('d.md', 'A total of 1.97M.')])
        self.assertEqual(code, 1)
        self.assertIn('must be read from its file', out)

    def test_ledger_value_that_disagrees_with_its_cell(self):
        led = self.base([{'id': 'x', 'value': 1966250, 'source': 'f', 'locate': {'where': {'k': 'a'}, 'column': 'v'},
                          'anchors': ['total of 1.97M']}])
        code, out = run(['check', led, self.write('d.md', 'A total of 1.97M.')])
        self.assertEqual(code, 1)
        self.assertIn('ledger says 1966250 but t.csv says 1966205', out)

    def test_bare_number_anchor_is_rejected(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'},
                          'anchors': ['7']}])
        code, out = run(['check', led, self.write('d.md', 'We found 7 stores.')])
        self.assertEqual(code, 1)
        self.assertIn('is a bare number', out)

    def test_clean_deliverable_passes_and_says_it_is_mechanical(self):
        led = self.base([{'id': 'x', 'value': 7, 'source': 'f', 'locate': {'where': {'k': 'b'}, 'column': 'v'},
                          'anchors': ['7 stores']}], exempt=['1200 Brickell Ave'])
        code, out = run(['check', led, self.write('d.md', 'We found 7 stores near 1200 Brickell Ave.')])
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
        self.write('t.csv', 'k,v\na,1966205\nb,7\n')
        code, out = run(['scaffold', os.path.join(self.dir, 't.csv'), '--source', 'f', '--key', 'k'])
        self.assertEqual(code, 0)
        claims = json.loads(out[:out.rindex(']') + 1])
        self.assertEqual(claims[0], {'id': 'v_a', 'value': 1966205, 'source': 'f',
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
                 'entity': 'Mojitos Cuban Cuisine, Calle 8'},
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
        self.assertEqual(self.check(self.led([claim]), 'La Trova is #42 on the 50 Best list.')[0], 1)
        claim.update({'quote': 'No. 42, North America 50 Best', 'labels': [42, 50]})
        code, out = self.check(self.led([claim]), 'La Trova is #42 on the 50 Best list.')
        self.assertEqual(code, 0, out)
        claim['labels'] = [42, 51]
        code, out = self.check(self.led([claim]), 'La Trova is #42 on the 50 Best list.')
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
        code, out = self.check(self.led([], exempt=['(305) 555-0100']), 'Call (305) 555-0100.')
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
                      'entity': 'Bar X, Miami'}}
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


if __name__ == '__main__':
    unittest.main()
