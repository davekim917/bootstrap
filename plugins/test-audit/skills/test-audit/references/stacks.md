# Stack notes

These notes cover where each stack hides assertions, cases, and ways to weaken
a test. They are not a tutorial. If a construct isn't listed and you can't
tell what it asserts, classify the test **unknown**.

## Contents

- [TypeScript with vitest](#typescript-with-vitest)
- [Bun test](#bun-test)
- [Python with pytest](#python-with-pytest)
- [dbt](#dbt)

## TypeScript with vitest

- **Cases:** each row of `test.each` / `describe.each` is one case. Mark rows
  separately when they carry different risks.
- **Markers:** `.skip`, `.todo`, `.skipIf`, `.runIf`, and `.fails` all change
  what runs or what passing means. `.only` narrows the whole run. Vitest
  refuses it only when `allowOnly` is false, which by default means only in
  CI, so don't rely on that setting.
- **Assertions hide in:** snapshots (`toMatchSnapshot`, inline snapshots),
  custom matchers, helper functions, and `expect.assertions(n)` /
  `expect.hasAssertions()` in async tests. Updating a snapshot with `-u` is an
  assertion change. Review the snapshot diff.
- **Mocks:** `vi.mock` is hoisted and applies to the whole file. Check that a
  mock doesn't implement the behavior being asserted.
- **Safe seams:** `vi.useFakeTimers()` / `vi.setSystemTime()` for clocks, and
  injected clients or fetch functions.
- **Floors:** `coverage.thresholds` in the config is a floor. Don't lower it.
  `autoUpdate` only ever raises it.

## Bun test

- **API:** `bun:test` is Jest-compatible: `test.each`, `.skip`, `.todo`,
  `.only`, `.if` / `.skipIf` / `.todoIf`, and `.failing`. Read these the same
  way as the vitest markers above.
- **Mocks:** `mock.module()` replaces a module even after it has been
  imported, and there is no API to remove one module mock, so it lasts for
  the rest of the file. `mock.restore()` resets function mocks and spies, not
  module mocks. A test can pass because an earlier test in the file mocked
  its subject.
- **Preload:** `[test] preload` in `bunfig.toml`, or `--preload`, runs setup
  before every file. Environment scrubbing, containment guards, and global
  mocks often live there, so read it before judging containment. Running a
  file without the repository's preload is not the same test.
- **Clock:** use `setSystemTime()` from `bun:test`. Call it with no argument
  to restore real time.

## Python with pytest

- **Fixtures:** read the fixture chain as part of the test. That means
  `conftest.py` at each directory level, the fixture's scope (`function`,
  `module`, `session`), and `autouse=True` fixtures, which apply without
  appearing in the test's signature. A wider scope shares state across tests.
  A yield fixture's teardown is where cleanup and containment happen.
- **Cases:** `@pytest.mark.parametrize` rows are separate cases, and `ids=`
  names them. Stacked parametrize decorators multiply. Removing a row removes
  a case.
- **Assertions:** plain `assert` gets rewritten for detailed failure output
  only in test modules, `conftest.py`, and registered plugins. Helper modules
  need `pytest.register_assert_rewrite`. Also look for `pytest.raises(...,
  match=...)`: dropping `match` loosens it. `pytest.approx` tolerances are
  part of the assertion.
- **Markers:** `skip`, `skipif`, and `xfail` change what passing means. An
  `xfail` without `strict=True` passes whether the test fails or not.
- **Mocks:** `unittest.mock` assertion methods (`assert_called_once_with`) are
  real assertions, but a misspelled one on a plain `Mock` can silently pass
  on older Python versions. `autospec=True` stops a mock from accepting calls
  the real API would reject.
- **Safe seams:** the `tmp_path` and `monkeypatch` fixtures (including
  `monkeypatch.delenv` to scrub the environment), plus injected clocks and
  clients.

## dbt

dbt has three kinds of test, and each fails at a different moment.

- **Data tests** run after a model builds. Generic ones (`unique`,
  `not_null`, `accepted_values`, `relationships`, or package tests) are
  declared in YAML under `data_tests:` (older projects use `tests:`).
  Singular ones are SQL files that fail when they return rows.
- **Unit tests** (`unit_tests:` in YAML) check one model's exact output for
  fixed `given` inputs before it builds.
- **Model contracts** (`contract: {enforced: true}`) check column names and
  data types while the model builds. Constraints go further, but many
  warehouses record key and check constraints without enforcing them. Check
  your adapter's documentation before counting a constraint as a test.

Changes that can weaken a test without touching its SQL:

- `severity: warn`, or a looser `error_if` / `warn_if` threshold;
- a `where` config that filters out the failing rows;
- `enabled: false`, or a `tags` or selector change that stops a test from
  running in CI;
- a value added to `accepted_values`, which widens what passes;
- a unit test case dropped, or `given` and `expect` rows removed together so
  that fewer inputs are checked;
- turning off contract enforcement or dropping a column's `data_type`.

Coverage tools don't measure dbt tests well. Classify by the column or model
contract each test guards. A duplicate is a test on the same column with the
same predicate at the same point in the DAG, not the same test name.
