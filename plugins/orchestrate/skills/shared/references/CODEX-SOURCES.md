# Codex adversarial-review mirrors

The shared cross-model review contract (`skills/shared/cross-model-review.md`) sends this prompt
verbatim to Codex when Claude is primary, so the review runs OpenAI's own adversarial-review prompt
rather than a hand-written substitute. The Codex workflow plugin carries the same files so both
runtime packages share one review contract.

These files are byte-identical mirrors from
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). Do not edit them locally.

## Pinned upstream SHAs

NanoClaw's `/update-container` command and its scheduled package audit read this table to detect
upstream drift. Each pinned SHA is the latest commit that changed the corresponding upstream path
when the mirror was last verified.

| Local file | Upstream path | Pinned SHA | Last synced |
|---|---|---|---|
| `codex-adversarial-prompt.md` | `plugins/codex/prompts/adversarial-review.md` | `bc8fa661a50998ead1c1164a94339fc9cab1d742` | 2026-08-27 |
| `codex-review-output.schema.json` | `plugins/codex/schemas/review-output.schema.json` | `c69527eb18d0bdab92080487708381f95cf4c291` | 2026-08-27 |

## Resyncing

When `/update-container` reports drift:

1. Fetch each upstream file at the reported commit.
2. Review the upstream diff and update both runtime copies:
   - `plugins/workflow/skills/shared/references/`
   - `plugins/workflow-agents/skills/shared/references/`
3. Verify the prompt still contains all four substitution markers:
   - `{{TARGET_LABEL}}`
   - `{{USER_FOCUS}}`
   - `{{REVIEW_COLLECTION_GUIDANCE}}`
   - `{{REVIEW_INPUT}}`
4. Update the pinned SHA and sync date in both copies of this manifest.
5. Run `node scripts/check-plugin-boundaries.mjs`; it checks mirror parity, placeholder coverage,
   and the Claude-to-Codex handoff contracts.
6. Bump both workflow plugin patch versions.

The workflow supplies `{{REVIEW_COLLECTION_GUIDANCE}}` at runtime. That keeps the vendored prompt
byte-identical while allowing the reviewer to scope repository reads to the supplied diff and its
direct callers/contracts.
