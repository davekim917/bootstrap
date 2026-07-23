# Codex adversarial-review mirrors

`/team-qa` runs a real cross-model review from Claude by calling `codex exec` directly. The
Claude workflow therefore carries the Codex adversarial prompt and output schema without depending
on the Codex plugin command being mounted in that session. The Codex workflow plugin carries the
same files so both runtime packages share one review contract.

These files are byte-identical mirrors from
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). Do not edit them locally.

## Pinned upstream SHAs

NanoClaw's `/update-container` command and its scheduled package audit read this table to detect
upstream drift. Each pinned SHA is the latest commit that changed the corresponding upstream path
when the mirror was last verified.

| Local file | Upstream path | Pinned SHA | Last synced |
|---|---|---|---|
| `codex-adversarial-prompt.md` | `plugins/codex/prompts/adversarial-review.md` | `bc8fa661a50998ead1c1164a94339fc9cab1d742` | 2026-07-23 |
| `codex-review-output.schema.json` | `plugins/codex/schemas/review-output.schema.json` | `c69527eb18d0bdab92080487708381f95cf4c291` | 2026-07-23 |

## Resyncing

When `/update-container` reports drift:

1. Fetch each upstream file at the reported commit.
2. Review the upstream diff and update both runtime copies:
   - `plugins/workflow/skills/team-qa/references/`
   - `plugins/workflow-agents/skills/team-qa/references/`
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
byte-identical while allowing Validator E to scope repository reads to the supplied diff and its
direct callers/contracts.
