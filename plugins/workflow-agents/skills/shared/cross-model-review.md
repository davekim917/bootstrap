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

### When Codex is the external reviewer

This path is Codex-only. Never route the vendored prompt to a Claude or OpenCode reviewer, and
never generalize this section to other reviewers. Its second line asserts a fixed identity —
`You are Codex performing an adversarial software review.` — the only model-specific line in all 84
lines of the prompt; sending it to a different model asserts a false identity, and editing it would
break the byte-identical mirror `references/CODEX-SOURCES.md` exists to protect. When Codex or
OpenCode is primary and Claude is the reviewer, use the composed prompt in "When Claude is the
external reviewer" below, unchanged.

Send the vendored prompt at `references/codex-adversarial-prompt.md` verbatim, filling only its
four substitution markers (below), and enforce its schema at the CLI boundary rather than in prose:

```sh
codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo \
  --output-schema references/codex-review-output.schema.json \
  --output-last-message <path-to-write-the-final-JSON-response>
```

`--output-schema` and `--output-last-message` (`-o`) are native `codex exec` flags (confirmed
against the installed CLI's `--help`) — the response shape is enforced by Codex itself, not by
asking nicely in the prompt.

The vendored prompt is a different layer than the rubric below, not a competing contract: OpenAI's
is stance and attack surface (how to think, where to look); bootstrap's is criteria and adjudication
(what counts as a finding, who decides). Inject the workflow's own lenses through the prompt's
placeholders rather than rewriting or replacing it:

- `{{TARGET_LABEL}}` — what is under review (e.g. `plan.md` for `/team-plan`, or the implementation
  diff for `/team-review --implementation`).
- `{{USER_FOCUS}}` — the user-specified focus area, followed by the rubric lenses that have no
  analog in the vendored prompt's `<attack_surface>`: **plan fidelity**, **verification quality**,
  and **simplicity** (see Review rubric below for their definitions). The vendored prompt has never
  seen `plan.md` and cannot on its own check scope adherence or whether a test would fail if the
  logic broke, so the workflow supplies those checks here instead of trying to fold them into a
  rewritten prompt. If the repo under review defines a review policy file (`docs/review-policy.md`
  or `REVIEW.md`), append its severity semantics and do-not-report list here too — that file is the
  project's contract for what a finding is for, and this slot is the only channel that reaches the
  reviewer. Also inject: for race, TOCTOU, and ownership findings — already in the vendored prompt's
  own `<attack_surface>` — report the finding class once with every affected call site and name the
  primitive (the writer, the spawner, the migrator) where the invariant belongs, never one call site
  per round.
- `{{REVIEW_COLLECTION_GUIDANCE}}` — scope-limiting instructions: read only the supplied diff and
  its direct callers/contracts; do not edit files or run side-effecting commands. `--yolo` disables
  sandboxing entirely, so — unlike the read-only-sandboxed invocation this guidance was originally
  written for — nothing at the OS level stops Codex from reading or touching files outside the
  change. This text is the only thing enforcing scope; do not weaken it.
- `{{REVIEW_INPUT}}` — the source bundle: the raw plan, or the approved plan plus implementation diff.

Reject empty output, malformed or invalid JSON, a verdict outside `approve`/`needs-attention`, or
findings missing any schema-required field (`severity`, `title`, `body`, `file`, `line_start`,
`line_end`, `confidence`, `recommendation`).

#### Recording the result in run.md

Composition means there is no schema to translate — Codex's findings keep their own shape
(`severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`) in
`run.md` rather than being renamed into the Claude-reviewer field names below. Only the top-level
verdict needs a bookkeeping label for the rest of the workflow:

| Codex output | Recorded as |
|---|---|
| `verdict: "approve"`, empty `findings` | `clear` |
| `verdict: "needs-attention"`, non-empty `findings` | `must_fix` |
| `verdict: "approve"` with findings, or `verdict: "needs-attention"` with none, or anything failing the reject-conditions above | `invalid-output` |

The lead still verifies every finding against the supplied artifact and repository source before
accepting it — same as for a Claude reviewer — and a finding that doesn't hold up is dropped and
recorded as rejected in `run.md`.

### When Claude is the external reviewer

Ask for exactly one JSON object, and enforce it at the CLI boundary — `--output-format json` alone
only shapes the response envelope, it does not constrain content to a schema:

```sh
claude -p --model claude-opus-5 --effort high --safe-mode --no-session-persistence --permission-mode plan --tools "" --strict-mcp-config --output-format json \
  --json-schema '{"type":"object","required":["verdict","findings"],"properties":{"verdict":{"enum":["clear","must_fix","degraded"]},"findings":{"type":"array","items":{"type":"object","required":["severity","requirement","evidence","failure_mode","smallest_fix","confidence"],"properties":{"severity":{"enum":["MUST-FIX","SHOULD-FIX"]},"requirement":{"type":"string"},"evidence":{"type":"string"},"failure_mode":{"type":"string"},"smallest_fix":{"type":"string"},"confidence":{"type":"number","minimum":0,"maximum":1}}}}}}'
```

The requested object shape:

```json
{
  "verdict": "clear | must_fix | degraded",
  "findings": [
    {
      "severity": "MUST-FIX | SHOULD-FIX",
      "requirement": "violated requirement or invariant",
      "evidence": "artifact section or file:line",
      "failure_mode": "concrete failure",
      "smallest_fix": "bounded correction",
      "confidence": "0-1, how certain the reviewer is this finding is real and material"
    }
  ]
}
```

Reject empty output, malformed or invalid JSON, a missing/unknown verdict, or findings without the required
fields. The lead verifies every finding against the supplied artifact and repository source before
accepting it.

## Review rubric

Send a Claude reviewer the rubric items for the selected lenses directly, as part of its prompt. A
Codex reviewer instead gets its own vendored `<attack_surface>`/`<review_method>` sections plus the
**Plan fidelity**, **Verification quality**, and **Simplicity** lenses via `{{USER_FOCUS}}` (see
above); this rubric then serves as the grounding bar the lead checks every finding against,
Codex's included. Every finding must ground in one of them or in a named external invariant — for a
Claude reviewer, the `requirement` field is where it goes. This exists so two reviewers judge the
same change against the same bar instead of each re-deriving one from a lens name.

A rubric item is a hypothesis generator, never a verdict. The lead still traces every finding to
source before it can become `MUST-FIX`; a rubric match alone does not block.

**Calibration:** prefer one strong finding over several weak ones; do not dilute a serious issue
with filler. If the change looks safe, say so directly and return no findings — an empty finding
list is a complete, valid review, not a sign the reviewer didn't try.

Always applied:

- **Correctness** — behavior matches the stated acceptance criteria; empty, boundary, and error
  inputs are handled; no silently swallowed failure; repeated or concurrent invocation is safe
  wherever reachable.
- **Invariant ownership** — every stated invariant names the one primitive that enforces it (the
  writer, the spawner, the migrator); a plan that enforces an invariant by re-checking at call
  sites, or by awaiting between a check and its write, is a design defect — reject with the
  primitive named.
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
