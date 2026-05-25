# Eval harness — runner

Implements DESIGN.md. Runs an agent eval `(target, case) → verdict` headlessly,
scores it gate-ordered, aggregates trials per tier.

## Usage

```bash
node harness/run.mjs --suite <suite> --target <target> [--case <case>] \
     [--tier smoke|done|release] [--trials N] [--out <dir>]
```

- `--suite` dir under `evals/suites/`; omit `--case` to run all `case-*` in it.
- `--target` a config in `harness/targets/<id>.json` (adapter + model + env).
- `--tier` overrides the case's `rubric.tier`. Tier sets trial count + pass bar.

Exit 0 iff every case aggregated to PASS. Per-trial transcripts are written under
the out dir for inspection.

## Tiers (DESIGN.md "Stochasticity")

| tier | trials | bar |
|------|--------|-----|
| smoke | 3 | hard gates 3/3 |
| done | 5 | hard gates 5/5, semantic ≥0.8 |
| release | 10 | hard gates 10/10, semantic ≥0.8 |

Hard gates must pass **every** trial at every tier. `ENV_ERROR`/`TIMEOUT` trials
are infra outcomes, never counted as behavioral quality.

## ⚠️ OpenCode adapter: warm-template requirement (operational)

A **fresh** opencode XDG dir triggers a one-time SQLite migration ("Performing one
time database migration, may take a few minutes…") that runs *before* the model and
will eat your run timeout — every early eval here failed with `exit=124` for exactly
this reason. The adapter therefore keeps a **warm (already-migrated) XDG template**
and **clones** it per run (auth + a migrated `opencode.db`), so runs start at the
model immediately. Never point an adapter at a fresh XDG per run.

The template is created once by running any trivial `opencode run` against a dir until
`opencode/opencode.db` exists, then that dir is the clone source.

## Adapter contract

`adapters/<name>.mjs` default-exports:

```js
{
  id: 'opencode',
  async preflight(target) → { ok, missing[], detail },   // env gap ⇒ ENV_ERROR
  async run(target, { input, fixtureDir, timeoutMs }) → NormalizedTranscript,
}
```

`run` MUST return a transcript that passes `transcript.assertConformant` — the
normalizer (raw runtime events → the one normalized shape) is the load-bearing,
highest-risk piece. Each adapter ships against *captured real events*, not assumed
shapes.
