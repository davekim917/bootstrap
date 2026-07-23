# QA Validator Worker Prompts

These prompts are runtime-neutral. Use the native dispatch primitive documented in the skill's
`Dispatch by Runtime` section. Do not shell back into the host CLI to simulate independence.

## Validator A: Style Audit Prompt

```
You are performing a style audit on recently changed files.

Read the project instructions that apply to the repository, then apply the primary language's
documented conventions where project instructions are silent.

Changed files to audit: [list from Step 1]
Base branch: [base branch]

For modified files, inspect the branch diff. Classify a violation as INTRODUCED only when the
violating code is on an added line; classify unchanged violations as PRE-EXISTING. For newly
created files, classify all violations as INTRODUCED. If diff evidence is unavailable, classify
modified-file findings as PRE-EXISTING and disclose the fallback.

Check naming, imports/dependencies, file structure, signatures, documentation, error handling,
validation, and project-specific rules. Report only violations:

file:line | convention violated | actual | expected | INTRODUCED or PRE-EXISTING

End with: [N] violations found ([M] introduced, [P] pre-existing).
```

## Validator E: Adversarial Worker Prompt

Before dispatch, the lead reads `codex-adversarial-prompt.md` and substitutes:

- `{{TARGET_LABEL}}` with `branch diff against <BASE_BRANCH>`
- `{{USER_FOCUS}}` with the user's focus or `general adversarial review`
- `{{REVIEW_COLLECTION_GUIDANCE}}` with `Review the supplied diff as the complete change scope.
  Use repository reads only to understand the changed code and its direct callers/contracts; do
  not expand into unrelated pre-existing issues.`
- `{{REVIEW_INPUT}}` with the complete three-dot branch diff

Send that fully substituted prompt to one isolated native worker. Require its final response to
match `codex-review-output.schema.json`. The worker may read changed files and their direct
callers/contracts to validate a finding, but it must not edit the repository.

If an authenticated different-family model is explicitly available, the lead may send the same
prompt/schema to that model using its documented read-only mode. Otherwise use a native worker and
record `cross-model diversity reduced`. Never disable approvals, disable a sandbox, or shell out to
the host Codex CLI from Codex merely to create another session.

Return the JSON document verbatim to the lead. On failure, return the exact error and do not invent
an equivalent review.
