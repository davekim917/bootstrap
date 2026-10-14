# Where a verify skill lives, what binds it, and who holds it

The one statement of the placement, binding, evidence, lock and publishing rules for every `verify-<project>` skill. `create-verification-skill` and `maintain-verification-skill` cite these sections and keep only their own steps.

## Where it lives

A skill is always created private. A repository that receives a `verify-*` directory has received a visible change, so a skill moves into the project repo only on the user's explicit request, never inferred from who owns the repo (`maintain-verification-skill`, Promote to the repo).

The private directory:

- **NanoClaw container:** `/workspace/workgroup/.claude/skills/verify-<project>/`. The workgroup tree is the one directory every sibling agent (Claude, Codex, OpenCode) mounts, and it outlives the container; a group's own folder is private to one sibling. No runtime discovers skills there yet, so the skill is used by reading its `SKILL.md` by path. If `/workspace/workgroup` is missing, stop and ask the operator rather than writing somewhere a sibling cannot read.
- **Host session:** `~/.agents/skills/verify-<project>/`, plus an absolute symlink to it at `~/.claude/skills/verify-<project>`. Codex and OpenCode read the first, Claude reads the second.

A promoted skill lives in the repo at `.claude/skills/verify-<project>/`, with the relative symlink `.agents/skills/verify-<project>` → `../../.claude/skills/verify-<project>` (Claude reads the first path, Codex the second, OpenCode reads both and keeps one). Its private directory still exists on every host that runs it, holding the evidence root and the lock, created on that host's first run. Once the promotion has merged, the promoting host's private directory holds only `evidence/` and a one-line `PROMOTED` file naming the repo and path; one copy stays live, because two would drift.

`<project>` is `<owner>-<repo>` from the remote (the directory name for a repo with no remote); if that path already holds a skill bound to a different project, add a short suffix.

**Finding the skill:** the current repo's `.claude/skills/verify-*/` first, then the private directory. Pick the skill whose binding names the current checkout. One skill per project: when one exists, use it (or run `maintain-verification-skill` when it has drifted) instead of generating a second. Several candidates → ask which one.

## Binding

Each skill's `Project` section records: the repository's remote URL with any credentials stripped (no `user:token@`), or its absolute path when it has none; the checkout it was proven against; the directory the skill lives in; and its private directory. In a promoted copy these are repo-relative, and the private directory is named as the location above, outside the repository. Before any run, the agent confirms the current checkout's remote (or path, without a remote) matches, and stops on a mismatch.

## Evidence root

`<private directory>/evidence/`, so evidence is exactly as private and as shared as the skill, and never inside a checkout. Each run creates its own directory there, `<UTC YYYYMMDDTHHMMSSZ>-<short revision>-<random suffix>/`, with a create that fails if the path exists (never `mkdir -p`). Cleanup never removes the evidence root.

## The `.inuse` lock

`<private directory>/.inuse`. One holder at a time: every run, and every pass that creates, edits or promotes the skill, holds it for its whole duration, so no recipe changes under a drive. Take it with a create that fails if the file exists, writing a holder id (your session name and the UTC time); if it exists, wait. Release it only if it still holds your id. A lock more than two hours old may be replaced only once its holder is confirmed gone; otherwise ask. Runs a holder starts itself run under its hold and leave the lock to that holder.

## Publishing rule

For the promotion pull request and every later pull request to the project repo: the files, commit messages and PR text carry no absolute host paths, hostnames, credentials, session names, fleet-only notes or evidence artifacts.
