# Shared cross-model review contract

Cross-model review is mandatory:

- in `/team-plan`, on the raw proposed `plan.md` before approval;
- in `/team-review --implementation`, on the approved plan plus raw implementation diff.

Use one independent reviewer from another model family by default. Add reviewers or specialist
lenses only when a changed trust boundary or domain risk justifies them. The reviewer receives the
source bundle, not the lead model's conclusions, and must not mutate the target.

## Required transports

When Claude is primary, invoke Codex with settings that do not inherit any host or container
`config.toml`:

```sh
codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo
```

When Codex or OpenCode is primary, invoke Claude with:

```sh
claude -p --model claude-opus-5 --effort high --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json
```

Pass the review prompt and source bundle on stdin. Run each external reviewer in the foreground and
set the invoking Bash or process timeout to `3600000` milliseconds (a 60-minute ceiling). Do not
background or detach the child process: keeping it attached preserves lifecycle, cancellation, and
complete output. A review that needs more than ten minutes is still healthy; classify it as
`timeout` only if the 60-minute ceiling is actually reached.

`--yolo` is required because Codex's inner sandbox cannot create its namespaces inside nested
Docker. NanoClaw's container is the external isolation boundary for that invocation. This transport
choice does not change the reviewer contract: review only the supplied source bundle, do not edit
files or invoke side-effecting tools, and return the requested verdict. Do not change the command's
model, effort, execution mode, permissions, or persistence flags.

## Prompt and verdict

Ask for exactly one JSON object:

```json
{
  "verdict": "clear | must_fix | degraded",
  "findings": [
    {
      "severity": "MUST-FIX | SHOULD-FIX",
      "requirement": "violated requirement or invariant",
      "evidence": "artifact section or file:line",
      "failure_mode": "concrete failure",
      "smallest_fix": "bounded correction"
    }
  ]
}
```

Reject empty output, malformed or invalid JSON, a missing/unknown verdict, or findings without the required
fields. The lead verifies every finding against the supplied artifact and repository source before
accepting it.

## Review rubric

Send the reviewer the rubric items for the selected lenses. Every finding must ground in one of
them or in a named external invariant — the `requirement` field is where it goes. This exists so
two reviewers judge the same change against the same bar instead of each re-deriving one from a
lens name.

A rubric item is a hypothesis generator, never a verdict. The lead still traces every finding to
source before it can become `MUST-FIX`; a rubric match alone does not block.

Always applied:

- **Correctness** — behavior matches the stated acceptance criteria; empty, boundary, and error
  inputs are handled; no silently swallowed failure; repeated or concurrent invocation is safe
  wherever reachable.
- **Simplicity** — no abstraction with one implementation, no configuration for a value that never
  varies, no scaffolding for unrequested futures; an existing project primitive or the standard
  library would not have done the job.
- **Plan fidelity** — every acceptance criterion is implemented; nothing outside approved scope
  rides along; deviations are recorded in `run.md` rather than silent.
- **Failure handling** — failures surface rather than swallow; partial writes cannot strand
  inconsistent state; retries are bounded; an error path that loses user data is a blocker.
- **Verification quality** — tests exercise the criteria, not the implementation's shape, and would
  fail if the logic broke; evidence in `run.md` is fresh output, not restated intent.

Applied when the changed surface warrants:

- **Security** — trust boundaries validate input; authorization is checked at the boundary, not
  assumed from the caller; credentials never reach logs, chat, or disk in usable form; destructive
  operations are gated or reversible.
- **State and rollback** — migrations are reversible, or one-way with stated justification;
  lifecycle transitions are total; persisted shape changes stay readable by in-flight consumers.
- **Performance** — a scale claim is measured rather than asserted; the hot path adds no unbounded
  scan, N+1, or per-item process spawn.
- **Product and accessibility** — user-visible behavior matches stated intent; keyboard reachability
  and contrast basics hold for new UI.
- **External currency** — any claim about an external API, framework, or standard is checked against
  a current authoritative source rather than model memory.

## Preflight and evidence

Record in `run.md`:

- review stage and primary runtime/model family;
- target runtime plus requested and effective model/effort enforced by the explicit CLI arguments;
- exact command and timeout;
- one of: `completed`, `missing-cli`, `unauthenticated`, `unsupported-flags`, `timeout`,
  `nonzero-exit`, `empty-output`, or `invalid-output`;
- raw verdict, each accepted/rejected finding with lead evidence, and resulting coverage.

When process metadata reports model or effort, record and cross-check it against the explicit
settings; a mismatch is `invalid-output`. Do not depend on ambient configuration or ask the
reviewer to self-report its identity.

Do not retry automatically. An explicitly configured safe target from a different model family may
substitute once, with its actual transport and model recorded. A same-family review may add
coverage but never counts as diversity.

When no other-family reviewer succeeds, label coverage `degraded`. A manual workflow asks the user
whether to proceed. `/team-auto` records the evidence, removes its sentinel, and stops.
