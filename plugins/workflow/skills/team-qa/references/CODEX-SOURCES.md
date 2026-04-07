# Codex prompt + schema — verbatim copies

The following files in this directory are verbatim copies from the
`@openai/codex-plugin-cc` plugin, used by `/team-qa` Validator E to run
adversarial reviews via `codex exec --yolo --output-schema` without depending
on the codex plugin being mounted or bypassing its `disable-model-invocation: true`
constraint.

Upstream: https://github.com/openai/codex-plugin-cc

## Pinned upstream SHAs

The `/update-container` Discord command and the `task-container-package-updates`
scheduled task both read this table to detect drift against upstream. When you
resync, update the SHA and `Last synced` columns to match.

| Local file | Upstream path | Pinned SHA | Last synced |
|---|---|---|---|
| `codex-adversarial-prompt.md` | `plugins/codex/prompts/adversarial-review.md` | `c69527e` | 2026-04-07 |
| `codex-review-output.schema.json` | `plugins/codex/schemas/review-output.schema.json` | `c69527e` | 2026-04-07 |

To check the latest upstream SHA for any of these paths:

```bash
gh api "repos/openai/codex-plugin-cc/commits?path=<upstream-path>&per_page=1" \
  --jq '.[0].sha[0:7]'
```

If it differs from the pinned SHA above, the file has drifted.

## Resyncing

If the upstream plugin updates the prompt or schema and we want to pull the changes:

```bash
# Assuming ~/plugins/codex exists as a clone of codex-plugin-cc
cp ~/plugins/codex/plugins/codex/prompts/adversarial-review.md \
   plugins/workflow/skills/team-qa/references/codex-adversarial-prompt.md
cp ~/plugins/codex/plugins/codex/schemas/review-output.schema.json \
   plugins/workflow/skills/team-qa/references/codex-review-output.schema.json
git diff plugins/workflow/skills/team-qa/references/
```

After copying:
1. Verify the prompt still contains all template placeholders
   (`{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, `{{REVIEW_INPUT}}`) — Validator E
   depends on these markers.
2. Update the **Pinned SHA** and **Last synced** columns above with the new
   values.
3. Bump `plugin.json` version (patch bump for resync).

The files are kept verbatim so Codex's behavior matches exactly what the
upstream plugin would produce — do not edit the content directly.

## Template placeholders

The prompt template uses three substitution markers that `/team-qa` Validator E
fills in before passing to Codex:

- `{{TARGET_LABEL}}` — e.g., `"branch diff against main"` or `"working tree changes"`
- `{{USER_FOCUS}}` — optional focus area from the user, or `"general adversarial review"` as a default
- `{{REVIEW_INPUT}}` — the git diff content, placed inside the `<repository_context>` block

See the team-qa SKILL.md Validator E section for the exact substitution logic.
