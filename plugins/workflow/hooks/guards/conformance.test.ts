import { describe, it, expect } from 'bun:test';
import {
  evaluateBashCommand,
  evaluateGitCloneDestination,
  evaluateSelfApproval,
  evaluateSnowflakeConnector,
} from './block-destructive-core';
import { evaluateEmailSend } from './email-gate-core';
import { checkEditProtection } from './file-protection-core';

/**
 * CROSS-SURFACE PARITY CONTRACT.
 *
 * Every runtime adapter routes through these two shared cores:
 *   - Claude:        block-destructive.ts + file-protection.ts
 *   - OpenCode:      opencode-guard.ts
 *   - Codex (host):  workflow-agents/hooks/codex-guard.ts
 *   - Codex (cont.): nanoclaw runner.ts (imports the vendored cores)
 *
 * This manifest is the single readable source of expected verdicts for the
 * canonical destructive set. If it holds, all surfaces agree by construction;
 * per-adapter wiring tests (opencode-guard.test, runner.test, codex-app-server,
 * block-destructive.test) confirm each adapter maps the core verdict faithfully
 * to its own I/O (native ask or exit-2 / throw / stdout-JSON / decision-object).
 *
 * Dispatch-first scope is NOT here, and no longer exists anywhere: the guard was
 * deleted when automatic delegation pressure was turned off fleet-wide. Only the
 * safety guards remain, and they are unaffected by that.
 */

// Hard-block (never allowed): file-deletion primitives, shell-wrapper bypass,
// protected-path rm.
const BASH_BLOCK = [
  // A backslash in the command name is removed by bash before lookup (`\\rm` skips an alias).
  '\\rm -rf ~',
  'r\\m -rf ~',
  'sudo \\rm -rf ~',
  // The command exec, xargs and find -exec run, past their options and spelled by any path.
  'exec rm -rf ~',
  'exec -a x rm -rf ~',
  '/opt/homebrew/bin/rm -rf ~',
  'xargs -0 rm -rf < list',
  'xargs -I{} rm -rf {} < list',
  'xargs -n1 /bin/rm -f < list',
  'xargs -0 sudo rm < list',
  'find . -exec /bin/rm -rf {} \\;',
  'find . -execdir /usr/bin/rm {} +',
  'xargs --eof rm < list',
  'xargs sudo -u root rm < list',
  'xargs nice -n 5 rm < list',
  'find . -exec sudo -u root rm {} +',
  'find . -exec env FOO=1 rm {} +',
  'exec -ca ignored rm -rf ~',
  'xargs -J % rm % < list',
  'xargs sudo -p prompt rm < list',
  'sudo -nu root rm -rf ~',
  'sudo -uroot rm -rf ~',
  'xargs -0a list rm',
  'find . -exec sudo -uroot rm {} +',
  'sudo FOO=1 rm -rf ~',
  'xargs sudo FOO=1 rm < list',
  'xargs --arg-f list rm',
  'sudo --login rm -rf ~',
  'xargs --max-lines rm < list',
  // What xargs or find -exec runs is hard-blocked on the same terms as at top level.
  `xargs sh -c 'rm "$@"' _ < list`,
  "find . -name '*.bak' -exec sh -c 'rm \"$1\"' _ {} \\;",
  // A shell's -c script: -c anywhere in a cluster, after --, or running its positional words.
  "sh -ce 'rm -rf /etc'",
  "bash -xc 'rm -rf /etc'",
  "fish -C 'echo init' -c 'rm -rf /etc'",
  "xargs -I{} sh -c -- 'rm {}' < list",
  `printf 'target\n' | xargs sh -c '"$@"' _ rm`,
  `printf 'target\n' | xargs sh -c '"$0" "$@"' rm`,
  "bash -C -c 'rm -rf /etc'",
  "fish --command='rm -rf /etc'",
  "fish --command 'rm -rf /etc'",
  "fish -d 3 -c 'rm -rf /etc'",
  `printf x | xargs sh -c '"$0" -c "rm -rf /etc"' sh`,
  `printf x | xargs sh -c 'find . "$1"' _ -delete`,
  "printf target | xargs fish -c '$argv' rm",
  `printf 'rm target\n' | xargs sh -c '"$@"' _`,
  "printf x | xargs bash -c -x 'rm -rf /etc'",
  "fish --init 'echo init' -c 'rm -rf /etc'",
  "fish -D 3 -c 'rm -rf /etc'",
  "fish -c'rm -rf /etc'",
  "bash -Oc extglob 'rm -rf /etc'",
  "bash -oO pipefail extglob -c 'rm -rf /etc'",
  `printf 'target\n' | xargs sh -c '"$0"/rm "$@"' /bin`,
  `printf x | xargs sh -c 'find . "-$1"' _ delete`,
  'xargs unlink < list',
  'find . -exec shred -u {} +',
  'eval echo x',
  'unlink secret',
  'shred -u f',
  'bash -c "rm -rf /etc"',
  'rm -rf /home/ubuntu/Documents',
  'rm -rf /',
  'find . -delete',
  'xargs rm < list',
];

// Gated (require approval): destructive infra/DB/cloud/IaC/containers/dbt.
const BASH_GATE = [
  '\\git push --force origin main',
  'sudo --login git push --force origin main',
  '\\psql -c "DROP TABLE x"',
  'terraform destroy -auto-approve',
  'psql -c "DROP TABLE users"',
  'snow sql -q "DROP TABLE prod.orders"',
  'aws s3 rb s3://prod --force',
  'gcloud compute instances delete vm-1',
  'kubectl delete deployment api',
  'docker rm -f db',
  'helm uninstall app',
  'dbt run --full-refresh',
  // Git remote history mutation (fleet-hardening P2): force push in every
  // spelling, mirror push, remote-ref deletion / per-ref force refspecs —
  // including behind git's global options (-C).
  'git push --force origin main',
  // git clean deletes untracked files outside the trash; only a dry run passes.
  'git clean -fdx',
  'git clean -f',
  'git -C repo clean -xdf',
  'git -c clean.requireForce=false clean -d',
  'git clean -f -e .env',
  'git clean -n --no-dry-run -f',
  'git clean -n --no-dry-r -f',
  'git clean -n --no-d -f',
  'git clean -f --ex -npattern',
  'git clean -f --e -npattern',
  'git -c clean.requireForce=false --attr-source HEAD clean',
  '/usr/lib/git-core/git-clean -fd',
  'git -c clean.requireForce=false --shallow-file /dev/null clean',
  'X=--no-dry-run; git clean -n $X -f',
  'git clean -n * -f',
  'git clean -n {a,b} -f',
  'git clean -n ./--no-dry-r[u]n -f',
  'git clean -f -e -npattern',
  'git clean -fe -n',
  'ENV=false git --config-env clean.requireForce=ENV clean',
  'git push -f',
  'git -C /workspace/worktrees/APP push -f origin develop',
  // Spellings that once slipped through: a clustered short flag, AWS global
  // options before the service, a command inside $(…) or an assignment's value,
  // and SQL in a multi-line quoted argument.
  'git push -uf origin main',
  'git push -fo note origin main',
  'git push -- -o +main',
  'aws --profile prod s3 rm s3://bucket/key',
  'echo $(psql -c "DROP TABLE users")',
  'X=$(snow sql -q "DROP TABLE prod.orders")',
  'snow sql -q "select 1;\ndrop table prod.orders"',
  // Places bash runs a command that the walker once skipped: if/while/until
  // conditions, case arms and subjects, redirect targets, unquoted heredoc
  // bodies, ${x:-…} operands, array elements, [[ ]], $(( )) and the command
  // name itself.
  'if psql -c "DROP TABLE users"; then :; fi',
  'while psql -c "DROP TABLE users"; do :; done',
  'until psql -c "DROP TABLE users"; do :; done',
  'case x in a) psql -c "DROP TABLE users";; esac',
  'case $(psql -c "DROP TABLE users") in a) :;; esac',
  'echo > "$(psql -c "DROP TABLE users")"',
  'while read l; do :; done < <(psql -c "DROP TABLE users")',
  'cat <<EOF\n$(psql -c "DROP TABLE users")\nEOF',
  'x=${y:-$(psql -c "DROP TABLE users")}',
  'a=( $(psql -c "DROP TABLE users") )',
  '[[ -n $(psql -c "DROP TABLE users") ]]',
  'echo $(( $(psql -c "DROP TABLE users") ))',
  'if $(psql -c "DROP TABLE users"); then :; fi',
  // SQL the scanner once could not see: glued option values, stdin, files
  // written in the same command, includes, templates, scripting blocks.
  'snow sql --query="drop table prod.orders"',
  'snow sql -q"drop table prod.orders"',
  'psql -c"drop table users"',
  'mysql -e"drop table users"',
  'psql <<EOF\ndrop table users;\nEOF',
  'psql <<< "drop table users"',
  'echo "drop table users" > x.sql; psql -f x.sql',
  "cat > x.sql <<'EOF'\ndrop table users;\nEOF\nsnow sql -f x.sql",
  'snow sql -q "&{x}" -D "x=drop table prod.orders"',
  'snow sql -q "drop &{k} prod.orders" -D k=table',
  'snow sql -q "begin drop table prod.orders; end"',
  'psql -c "DO $$ BEGIN DROP TABLE users; END $$"',
  'snow sql -q "alter table prod.orders swap with prod.orders_new"',
  'snow sql -q "alter table prod.orders rename to prod.orders_old"',
  'snow sql -q "grant ownership on table prod.orders to role r"',
  'git push --prune origin',
  'echo "drop table users" | psql',
  'psql -c "DO LANGUAGE plpgsql $$ BEGIN DROP TABLE users; END $$"',
  'psql -cDROP\\ TABLE\\ users',
  "psql -c \"DO $$ BEGIN RAISE EXCEPTION 'x'; EXCEPTION WHEN OTHERS THEN DROP TABLE users; END $$\"",
  "sql='DROP TABLE users'; psql <<< \"$sql\"",
  'psql -c "-- note; with a semicolon\ndrop table users"',
  'git push --mirror backup',
  'git push origin --delete feature-x',
  'git push origin :feature-x',
  'git push origin +main',
  // What xargs or find -exec runs needs approval on the same terms as at top level.
  'find . -name repo -exec git push --force origin main \\;',
  'xargs -I{} git push --force origin {} < branches',
  "xargs -I{} sh -c 'git push --force origin {}' < list",
  "find . -name '*.sql' -exec psql -c 'DROP TABLE users' \\;",
  'xargs -n1 terraform destroy -auto-approve < dirs',
  "printf 'main\\n' | xargs bash -c 'git push --force origin \"$1\"' _",
  "printf 'destroy\\n' | xargs terraform",
  "printf \"'-c' 'rm -rf /tmp/x'\\n\" | xargs sh",
  "find destroy -maxdepth 0 -exec terraform {} \\;",
  "find . -name '*.sh' -exec bash {} \\;",
  "printf '%s\\n' --force | xargs git push origin main",
  // An appended branch name of `+main` or `--force` force-pushes, so pushing what xargs reads needs approval.
  'xargs -r git push origin < branches',
  "printf '%s\\n' 'push --force origin main' | xargs git -C /prod",
  "printf x | xargs bash -O extglob",
  "printf '%sI' --force | xargs -dI git push origin main",
  "printf '%s\\n' 'rm s3://prod --recursive' | xargs aws s3",
  // xargs input, or a find match, that names the command: a wrapper or executor left without one, or `{}` in its place.
  "printf '%s\\n' rm /home/user/data | xargs xargs -a /dev/null",
  "printf '%s\\n' rm -rf /home/user/data | xargs env",
  "printf '%s\\n' rm -rf /home/user/data | xargs sudo -u app",
  "printf '%s\\n' rm -rf /home/user/data | xargs timeout 5",
  "printf '%s\\n' x | xargs -I{} {} rm -rf /home/user/data",
  "printf '%s\\n' rm | xargs -I{} env {} -rf /home/user/data",
  "printf -- '-delete\\n' | xargs find /home/user/data",
  "find . -name x -exec env {} \\;",
  // xargs adds what it reads to a shell's positional words, so `"$@"` there is filled at run time.
  "printf '%s\\n' destroy | xargs sh -c 'terraform \"$@\"' _",
  "printf '%s\\n' destroy | xargs sh -c 'terraform $1' _",
  "printf '%s\\n' --force | xargs sh -c 'git push origin main \"$@\"' _",
  "printf '%s\\n' --force | xargs -I{} sh -c 'git push {} origin main'",
  "printf '%s\\n' --force | xargs -I{} git push {} origin main",
  'xargs -n1 terraform fmt < dirs',
  // Appending, xargs input can complete a multi-word CLI operation; substituted, it can put --force in place.
  'xargs -I{} git push origin {} < branches',
  'xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null terraform destroy',
  "printf 'x' | xargs -I{} xargs psql -c 'DROP TABLE users'",
  "find . -name x -exec xargs git push --force origin main \\;",
];

// Allowed: safe / ephemeral. The git rows pin the DELIBERATE non-gates:
// lease-protected force pushes (the sanctioned recovery the MCP git_push tool
// uses), plain pushes, local branch ops, and `git stash push -f` (not a push).
const BASH_ALLOW = [
  'ls -la',
  'xargs echo < list',
  'xargs -r git add < list',
  'bash deploy.sh -xc value',
  // find's own expression resumes after -exec's terminator.
  'find . -exec echo -exec rm {} \\;',
  'find . -exec echo + -exec rm {} \\;',
  // A shell that xargs or find -exec runs is judged by its script.
  "ls | xargs -I{} sh -c 'grep -o x {} | head -1'",
  "find . -name f -exec sh -c 'echo == $1; cat $1' _ {} \\;",
  'find . -exec chmod 644 {} +',
  'find . -exec echo {} +',
  // Routine commands xargs and find run still pass.
  "find . -name '*.sql' -exec psql -c 'SELECT 1' \\;",
  'xargs -I{} git -C {} status < repos',
  'xargs -n1 git fetch origin < branches',
  "xargs -I{} sh -c 'git -C {} pull --ff-only' < repos",
  "printf x | xargs -I{} xargs echo",
  'exec bash-completion-loader',
  'git status',
  'git clean -n',
  'git clean -ndx',
  'git clean --dry-run -fdx',
  'git clean -e keep -n',
  'git clean --dry -fdx',
  'git clean -h',
  'git clean --help',
  'rm -rf node_modules',
  'echo hello',
  'cat README.md',
  'rm -rf dist',
  'git push origin main',
  'git push --force-with-lease origin feat/x',
  'git push --force-if-includes --force-with-lease',
  'git stash push -f',
  'git push origin refs/heads/a:refs/heads/b',
  'git commit -m "force push docs"',
  // `-o` takes a value, so the letters after it in a cluster are its operand.
  'git push -of origin main',
  'git push -odelete origin main',
  'git push -o :note origin main',
  'git push -- -f/repo main',
  'if git status; then :; fi',
  'snow sql -q "alter table prod.orders rename column a to b"',
  'psql -c "select \'drop table t\'"',
  'snow sql -q "select 1" -D x=y',
  'echo "drop table t"; psql -c "select 1"',
  'git fetch --prune',
  'git remote prune origin',
  // Text the command writes elsewhere is not the SQL a client reads from a file.
  'psql -f migration.sql && echo "dropped the old users table"',
  'echo "DROP TABLE users"; psql < safe.sql',
  "printf 'DROP TABLE %s\\n' users; mysql < safe.sql",
  'cat drop.sql; psql < safe.sql',
  // A shell under xargs that passes what it reads to a command without operation or modifier power.
  "git ls-files -z | xargs -0 sh -c 'git add \"$@\"' _",
  "printf '%s\\n' a.txt | xargs sh -c 'wc -l \"$@\"' _",
  "printf '%s\\n' a | xargs sh -c 'echo \"$1\"' _",
  // Bare xargs runs echo, and a wrapper that names its own command passes.
  "printf '%s\\n' a b | xargs",
  "printf '%s\\n' a b | xargs -n1 env FOO=1 echo",
  // A dry run whose words are all literal, and git's global help for clean, delete nothing.
  'git clean -n -d -x -- build/',
  'git --help clean',
];

// git-clone into a managed dir is blocked (must use clone_repo/create_worktree);
// pure /tmp clones and non-clone commands are allowed. Order-independent: a
// managed-dir reference ANYWHERE alongside `git clone` blocks the whole command.
const GIT_CLONE_BLOCK = [
  'git clone https://github.com/a/b /workspace/agent/b',
  'git clone https://github.com/a/b /workspace/agent/repos/b',
  'git clone https://github.com/a/b /workspace/worktrees/b',
  'git clone https://github.com/a/b /workspace/workgroup/b',
  'git clone https://github.com/a/b /tmp/x && mv /tmp/x /workspace/agent/stolen',
];
const GIT_CLONE_ALLOW = [
  'git clone https://github.com/a/b /tmp/scratch',
  'git status',
  'git pull origin main',
  'echo git clone',
];

// Edits blocked / allowed by file-protection.
const EDIT_BLOCK = ['.env', 'app/.env.local', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.git/config', 'terraform/main.tf', 'infra/terraform/prod.tf'];
const EDIT_ALLOW = ['src/index.ts', '.env.example', '.gitignore', 'README.md', 'lib/util.js'];

// Self-approval (writing the .claude-destructive-gate marker yourself) is a
// hard block; everything else allows. Pure on `command`.
const SELF_APPROVAL_BLOCK = [
  'touch .claude-destructive-gate',
  'echo ok > .claude-destructive-gate',
  'echo /tmp/.claude-destructive-gate/abc',
];
const SELF_APPROVAL_ALLOW = ['ls -la', 'git status', 'echo hello'];

// Ad-hoc Python snowflake.connector exec is blocked (steer to `snow sql`);
// the snow CLI, grep, pip, and bare echoes allow. Pure on `command`.
const SNOWFLAKE_BLOCK = [
  "python -c 'import snowflake.connector'",
  'python3 -c "from snowflake.connector import connect"',
  'python -c "import snowflake_connector"',
];
const SNOWFLAKE_ALLOW = [
  'snow sql -q "select 1"',
  'grep snowflake.connector requirements.txt',
  'pip install snowflake-connector-python',
  'echo snowflake.connector',
];

// Outbound email sends via the gws CLI are GATED when interactive; a non-email
// command allows, and a scheduled-task send bypasses the gate (allow) — both
// faithful to evaluateEmailSend's policy. The gate verdict depends on the env
// snapshot, so each row pins the (command, env) pair.
const EMAIL_GATE = [
  'gws gmail +send --to a@example.com --subject hi',
  'gws gmail +reply --to a@example.com',
  'gws gmail users messages send --json \'{"raw":"x"}\'',
];
const EMAIL_ALLOW = ['ls -la', 'git status', 'gws gmail +send --to a@example.com --dry-run'];

describe('parity contract — destructive bash', () => {
  for (const cmd of BASH_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('block'));
  }
  for (const cmd of BASH_GATE) {
    it(`gates: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('gate'));
  }
  for (const cmd of BASH_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('allow'));
  }
});

describe('destructive bash — mktemp variable provenance', () => {
  for (const cmd of [
    'log=$(mktemp)\nrm -f "$log"',
    'log="$(mktemp)"\nrm -f "${log}"',
    'log=$(mktemp)\npnpm test >"$log" 2>&1\nstatus=$?\ncat "$log"\nif [ "$status" -ne 0 ]; then exit "$status"; fi\nrm -f "$log"',
  ]) {
    it(`allows rm of an unchanged zero-argument mktemp variable: ${JSON.stringify(cmd)}`, () => {
      expect(evaluateBashCommand(cmd).action).toBe('allow');
    });
  }

  for (const cmd of [
    'rm -f "$log"',
    'log=$(mktemp)\nlog=important.txt\nrm -f "$log"',
    'log=$(mktemp)\nexport log=important.txt\nrm -f "$log"',
    'log=$(mktemp)\nprintf -v log %s important.txt\nrm -f "$log"',
    'log=$(mktemp)\nsource ./mutate-log.sh\nrm -f "$log"',
    'TMPDIR=./artifacts\nlog=$(mktemp)\nrm -f "$log"',
    'log=$(mktemp ./important.XXXXXX)\nrm -f "$log"',
    'log=$(mktemp)\nrm -f "$log/suffix"',
    'log=$(mktemp)\nrm -f "$log" important.txt',
  ]) {
    it(`keeps blocking without safe, exclusive mktemp provenance: ${JSON.stringify(cmd)}`, () => {
      expect(evaluateBashCommand(cmd).action).toBe('block');
    });
  }
});

describe('parity contract — git-clone destination', () => {
  for (const cmd of GIT_CLONE_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateGitCloneDestination(cmd).action).toBe('block'));
  }
  for (const cmd of GIT_CLONE_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateGitCloneDestination(cmd).action).toBe('allow'));
  }
});

describe('parity contract — file-protection edits', () => {
  for (const p of EDIT_BLOCK) {
    it(`protects: ${p}`, () => expect(checkEditProtection('Write', { file_path: p })).toBe(p));
  }
  for (const p of EDIT_ALLOW) {
    it(`allows edit: ${p}`, () => expect(checkEditProtection('Write', { file_path: p })).toBeNull());
  }
});

// ── Manifest rows added for the migrated command-guards (Group C / C1). ──
// These three guards (self-approval, snowflake, email-gate) were ported into the
// shared cores alongside the destructive + git-clone set above. Pinning their
// verdicts here keeps the cross-surface contract complete: opencode-guard.ts and
// the Codex runner both consume these same evaluators, so if this manifest holds,
// every surface agrees by construction.

describe('parity contract — self-approval', () => {
  for (const cmd of SELF_APPROVAL_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateSelfApproval(cmd).action).toBe('block'));
  }
  for (const cmd of SELF_APPROVAL_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateSelfApproval(cmd).action).toBe('allow'));
  }
});

describe('parity contract — snowflake connector', () => {
  for (const cmd of SNOWFLAKE_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateSnowflakeConnector(cmd).action).toBe('block'));
  }
  for (const cmd of SNOWFLAKE_ALLOW) {
    it(`allows: ${cmd}`, () => expect(evaluateSnowflakeConnector(cmd).action).toBe('allow'));
  }
});

describe('parity contract — email gate', () => {
  // Interactive send (isScheduledTask:false) → gate. The scheduled-task bypass is
  // verified separately below.
  for (const cmd of EMAIL_GATE) {
    it(`gates (interactive): ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: false }).action).toBe('gate'));
  }
  // Non-email commands always allow, regardless of schedule context.
  for (const cmd of EMAIL_ALLOW) {
    it(`allows: ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: false }).action).toBe('allow'));
  }
  // A real send bypasses (allow) when it originates from a scheduled task —
  // faithful to evaluateEmailSend's v1-parity policy.
  for (const cmd of EMAIL_GATE) {
    it(`allows (scheduled bypass): ${cmd}`, () =>
      expect(evaluateEmailSend(cmd, { isScheduledTask: true }).action).toBe('allow'));
  }
});
