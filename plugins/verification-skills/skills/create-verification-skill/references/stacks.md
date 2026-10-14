# Stack notes

Generic recipes for the Drive, Evidence and Cleanup sections, used only after the repo's own harness has been ruled out. Each one names what a generated skill must pin down for that stack.

## dbt / Snowflake

The user-facing surface is the data: the models, marts, metrics and exposures people query or a dashboard reads. Verifying means building the change against a development target and asserting on the data it produced. Production is never built, refreshed or written by a verification run.

- **Launch:** `dbt deps`, then `dbt build --target <dev target> --select <changed models>+`. Ready means `dbt debug --target <dev target>` passes and the build finished, not that the connection opened.
- **Doctor:** resolve the target's database, schema, role and warehouse (`dbt debug`, the profile) and refuse to drive when any of them is production, when the target is the project's production target, or when the role could write production objects. A run never passes `--target` for a production target, and never `--full-refresh` into a schema someone else builds.
- **Drive:** run the selected models and their tests, then the assertions each feature file names: row counts against the source, key uniqueness, null rates on required columns, and a control total that must reconcile. A read-only comparison against production data is allowed only when the project's own instructions permit it.
- **Evidence:** `target/run_results.json`, the compiled SQL of every asserted model, each assertion query with its result, and the target, database and schema the run used.
- **Cleanup:** record every schema and relation the run creates as it creates it, and drop only those. Never drop a shared development schema.
- **Gotchas:** an incremental model built once in dev proves only the full-build path; drive the incremental path separately when the change touches it. A test that passes on an empty model proves nothing, so assert row counts first.

## Web apps

- **Launch:** the repo's dev server on its own port, with a disposable data directory and a fresh browser profile.
- **Drive:** the runtime's browser tool, else Playwright. Select by ARIA role and accessible name, then data attributes; never coordinates or tab order. Wait for a named element or status, never a fixed sleep.
- **Evidence:** an accessibility snapshot and a screenshot with the app identity visible, for both the action and the resulting state, plus the network or DB side effect behind it.
- **Cleanup:** close the browser and stop the server this run started. Browsers are memory-heavy; never leave one open between drives.

## CLIs and TUIs

- **Launch:** build the binary or install dependencies once. Each drive is its own process with a temporary `HOME` or config directory, so a run never reads or writes the user's real config. Use a PTY or tmux session only for a TUI or a program that checks for a terminal, since a PTY merges stdout and stderr.
- **Drive:** literal commands from the repo's docs or `--help`; prefer a machine-readable output flag (`--format json`, `--json`) for assertions.
- **Evidence:** the command, stdout, stderr and exit code, plus any file the command wrote.
- **Cleanup:** kill the sessions this run started and remove its temporary directories.

## Services and APIs

- **Launch:** start the service on its own port with its own data directory or database, and wait for a readiness endpoint that exercises its dependencies, not a bare liveness check.
- **Drive:** plain HTTP (`curl`, the repo's client) against documented routes, authenticated as a test identity the run created.
- **Evidence:** each request and response with status code, and a read-only second view of any state the request changed.
- **Cleanup:** stop the process the run started (by PID, never by name) and drop the data it created.
