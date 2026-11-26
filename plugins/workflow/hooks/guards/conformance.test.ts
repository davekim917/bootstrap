import { describe, it, expect } from 'bun:test';
import { SQL_WRITE,
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
  // A step refused outright stays refused behind an earlier gated step; the gate must not make it approvable.
  "trash-rm key.p8; psql -c 'drop database prod'",
  "git clean -f; psql -c 'drop database prod'",
  'trash-empty; snow sql -f missing.sql',
  'trash-rm key.p8; rm secrets/key.p8',
  'git clean -f; rm secrets/key.p8',
  'rm\\\n -rf /home/x',
  'rm \\\n -rf /home/x',
  'r\\\nm -rf /home/x',
  'sudo\\\n rm -rf /home/x',
  "bash\\\n -c 'rm -rf /'",
  // Bash brace-expands a word before running it, the command name included.
  'rm -rf {/etc,x}',
  '{rm,-rf,/etc}',
  'rm -rf /{e,}tc',
  // Past the expansion cap the guard can't follow it, so it is refused.
  'rm -rf x{1..2000}{,/etc}',
  'echo {9007199254740992..9007199254740993}',
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
  // git submodule foreach runs its command in each submodule, on the same terms.
  "git submodule foreach 'rm -rf /etc'",
];

// Gated (require approval): destructive infra/DB/cloud/IaC/containers/dbt.
const BASH_GATE = [
  // Bash joins a backslash-newline before reading the word, inside a command name or argument alike.
  'terraform\\\n destroy',
  'terraform \\\n destroy',
  'terraform\\\n\\\n destroy',
  'ter\\\nraform destroy',
  'terraform des\\\ntroy',
  'sudo\\\n terraform destroy',
  'x=$(terraform\\\n destroy)',
  'git\\\n push --force',
  'git push\\\n --force',
  'git pu\\\nsh --force',
  'git push --for\\\nce origin main',
  'curl\\\n -X DELETE https://api.render.com/v1/postgres/dpg-example',
  'curl -X\\\n DELETE https://api.render.com/v1/postgres/dpg-example',
  'curl -X DELE\\\nTE https://api.render.com/v1/postgres/dpg-example',
  'curl -X DELETE https://api.ren\\\nder.com/v1/postgres/dpg-example',
  'wget\\\n --method=DELETE https://api.render.com/v1/postgres/dpg-example',
  'snow sql -c prod -q "DROP TAB\\\nLE t"',
  // Single-quoted, the backslash-newline stays as written: nothing destructive, but a statement led by DROP on a
  // connection not proven dev is a write.
  "snow sql -c prod -q 'DROP TAB\\\nLE t'",
  // Not destructive, but a write on a connection not proven dev.
  'snow sql -c prod -q "alter table prod.orders rename column a to b"',
  'curl -X DELETE https://api.render.com/v1/postgres/dpg-example',
  'git push --force{,}',
  'git push origin {main,--force}',
  "psql -h db.example -c {'drop table t',x}",
  "snow sql -c prod -q {'drop table t',x}",
  `sql='DROP TABLE t'; psql -h db.example -c "$sql" -v x{1,2}=1`,
  '\\git push --force origin main',
  'sudo --login git push --force origin main',
  '\\psql -h db.example -c "DROP TABLE x"',
  'terraform destroy -auto-approve',
  'psql -h db.example -c "DROP TABLE users"',
  'snow sql -c prod -q "DROP TABLE prod.orders"',
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
  // trash-cli's trash-rm and trash-empty delete from the trash for good. trash-rm parses no options, so its --help
  // still deletes; only trash-empty's help, version and dry run pass.
  'trash-rm /workspace/agent/key.p8',
  'trash-rm key.p8',
  'trash-rm key.p8 --help',
  'trash-rm --help',
  'trash-empty',
  'trash-empty 30',
  '/usr/bin/trash-empty -f',
  'trash key.p8 && trash-rm "$PWD/key.p8"',
  'X=--dry-run; trash-empty $X',
  'trash-empty --trash-dir /workspace/agent/.Trash-1001 --help',
  'trash-empty --trash X --version',
  'trash-empty -h --trash-dir=/x',
  'find . -name key.p8 -exec trash-rm {} +',
  'git -c clean.requireForce=false --shallow-file /dev/null clean',
  'X=--no-dry-run; git clean -n $X -f',
  // git submodule foreach runs its command in each submodule.
  "git submodule foreach --recursive 'git clean -fdx'",
  'git submodule foreach git clean -fdx',
  "git submodule --quiet foreach 'git push --force origin main'",
  'git clean -n * -f',
  'git clean -n {--no-dry-run,a} -f',
  'git clean -n ./--no-dry-r[u]n -f',
  'git clean -f -e -npattern',
  'git clean -fe -n',
  'ENV=false git --config-env clean.requireForce=ENV clean',
  // A global option's value is not git's own -h.
  'git --namespace -h clean -fd',
  // A subcommand git doesn't ship runs an alias, however it was defined.
  "git -c alias.wipe='clean -fd' wipe",
  "git config alias.p 'push --force' && git p origin main",
  'git -p wipe',
  'git --bare --no-pager wipe',
  // A moved exec path decides what even git's own script commands run (an alias where one is missing).
  'GIT_EXEC_PATH=/tmp/empty git submodule update',
  'git --exec-path=/tmp/empty submodule x',
  // Config that changes what a later, ordinary-looking git command runs, written by git or handed to it.
  "git config alias.p 'push --force'",
  "git config --global alias.wipe '!git clean -fdx'",
  'git config set alias.st status',
  'git config --rename-section stash alias',
  'git config remote.origin.mirror true',
  "git config remote.origin.push '+refs/heads/*:refs/heads/*'",
  "git config core.sshCommand 'ssh -i key'",
  'git config core.pager less',
  'git -c remote.origin.mirror=true push origin',
  "git -c core.sshCommand='ssh -i key' fetch",
  'git -c core.pager=less log',
  'git --config-env=core.pager=PAGER_CMD log',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push origin',
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true; git push origin',
  'declare -x GIT_CONFIG_KEY_0=remote.origin.mirror; git push origin',
  'GIT_CONFIG_KEY_0=remote.origin.mirror; export GIT_CONFIG_KEY_0; git push origin',
  'export GIT_CONFIG_KEY_0=$(cat key.txt); git push origin',
  "export GIT_CONFIG_PARAMETERS=\"'remote.origin.mirror'='true'\"; git push origin",
  'git remote add --mirror=push backup https://example.com/r.git',
  'git clone --mirror https://example.com/r.git',
  'git clone -c remote.origin.mirror=true https://example.com/r.git',
  'git clone --config=alias.st=status https://example.com/r.git',
  'git remote -v add --mirror=push backup https://example.com/r.git',
  // Options read as git's parse-options reads them: a short one in a cluster, a long one abbreviated.
  'git clone -4c remote.origin.mirror=true https://example.com/r.git',
  'git clone --conf=alias.st=status https://example.com/r.git',
  'git clone --mirr https://example.com/r.git',
  'git remote add --mirr=push backup https://example.com/r.git',
  // A value that starts with a dash is still the value.
  "git config set alias.x '-c core.pager=less log'",
  "git config set core.pager '-R'",
  // The key comes first in every git config write.
  'git config --replace-all alias.x status old',
  // A word the guard can't resolve before the first name may shift the key, so every name is read as the key.
  'git config $OPT user.name alias.x',
  'git config "$F" core.pager less',
  'git config set $OPT user.name alias.x',
  // An option's value from a variable doesn't move the key.
  'git config -f "$F" core.pager less',
  // An option the line doesn't show may be --add, so one name alone isn't known to be a read.
  'git config -$X alias.x',
  // A command substitution in an option's value can split into the key, so the words it shows are read as names.
  "git config --type $(printf 'path alias.x') '!cmd'",
  "git config --type `printf 'path alias.x'` '!cmd'",
  "git -c $(printf 'core.sshCommand=evil') fetch",
  // git config whose words a runner fills in where the guard can't see them.
  "printf '%s\\n' 'alias.st status' 'alias.co checkout' | xargs -n2 git config --local",
  "find . -name '*.cfg' -exec git config {} status \\;",
  // parallel quotes each replacement string into one word, so a write takes two of them, or -X.
  'parallel git config --local {1} {2} ::: alias.st ::: status',
  'parallel -X git config --local {} ::: alias.st status',
  // More than one argument a run: -m, or -n above 1, even with -n1 before -m.
  'parallel -n2 git config --local ::: alias.st status',
  'parallel -m git config --local ::: alias.st status',
  'parallel -n1 -m git config --local ::: alias.st status',
  // An unquoted variable, or an array's elements, can be a key and its value.
  "printf '%s\\n' user.name | while read -r key; do git config --local $key; done",
  'mapfile -t keys < keys.txt; git config --local "${keys[@]}"',
  // Unbounded, xargs hands git config a key and a value, and so does one line under -L1.
  "printf '%s\\n' 'alias.st status' | xargs git config --local",
  "printf '%s\\n' 'alias.st status' | xargs -L1 git config --local",
  // Neither the agent container's git nor this host's has these, so git runs an alias of that name.
  'git p4 sync',
  'git svn x',
  'git refs verify',
  'git backfill',
  'printf "alias.st status\\n" | while read k v; do git config --local "$k" "$v"; done',
  // An alias takes -h as one more argument.
  'git wipe -h',
  'git push -f',
  'git -C /workspace/worktrees/APP push -f origin develop',
  // Spellings that once slipped through: a clustered short flag, AWS global
  // options before the service, a command inside $(…) or an assignment's value,
  // and SQL in a multi-line quoted argument.
  'git push -uf origin main',
  'git push -fo note origin main',
  'git push -- -o +main',
  'aws --profile prod s3 rm s3://bucket/key',
  'echo $(psql -h db.example -c "DROP TABLE users")',
  'X=$(snow sql -c prod -q "DROP TABLE prod.orders")',
  'snow sql -c prod -q "select 1;\ndrop table prod.orders"',
  // Places bash runs a command that the walker once skipped: if/while/until
  // conditions, case arms and subjects, redirect targets, unquoted heredoc
  // bodies, ${x:-…} operands, array elements, [[ ]], $(( )) and the command
  // name itself.
  'if psql -h db.example -c "DROP TABLE users"; then :; fi',
  'while psql -h db.example -c "DROP TABLE users"; do :; done',
  'until psql -h db.example -c "DROP TABLE users"; do :; done',
  'case x in a) psql -h db.example -c "DROP TABLE users";; esac',
  'case $(psql -h db.example -c "DROP TABLE users") in a) :;; esac',
  'echo > "$(psql -h db.example -c "DROP TABLE users")"',
  'while read l; do :; done < <(psql -h db.example -c "DROP TABLE users")',
  'cat <<EOF\n$(psql -h db.example -c "DROP TABLE users")\nEOF',
  'x=${y:-$(psql -h db.example -c "DROP TABLE users")}',
  'a=( $(psql -h db.example -c "DROP TABLE users") )',
  '[[ -n $(psql -h db.example -c "DROP TABLE users") ]]',
  'echo $(( $(psql -h db.example -c "DROP TABLE users") ))',
  'if $(psql -h db.example -c "DROP TABLE users"); then :; fi',
  // SQL the scanner once could not see: glued option values, stdin, files
  // written in the same command, includes, templates, scripting blocks.
  'snow sql -c prod --query="drop table prod.orders"',
  'snow sql -c prod -q"drop table prod.orders"',
  'psql -h db.example -c"drop table users"',
  'mysql -e"drop table users"',
  'psql -h db.example <<EOF\ndrop table users;\nEOF',
  'psql -h db.example <<< "drop table users"',
  'echo "drop table users" > x.sql; psql -h db.example -f x.sql',
  "cat > x.sql <<'EOF'\ndrop table users;\nEOF\nsnow sql -c prod -f x.sql",
  'snow sql -c prod -q "&{x}" -D "x=drop table prod.orders"',
  'snow sql -c prod -q "drop &{k} prod.orders" -D k=table',
  'snow sql -c prod -q "begin drop table prod.orders; end"',
  'psql -h db.example -c "DO $$ BEGIN DROP TABLE users; END $$"',
  'snow sql -c prod -q "alter table prod.orders swap with prod.orders_new"',
  'snow sql -c prod -q "alter table prod.orders rename to prod.orders_old"',
  'snow sql -c prod -q "grant ownership on table prod.orders to role r"',
  'git push --prune origin',
  'echo "drop table users" | psql -h db.example',
  'psql -h db.example -c "DO LANGUAGE plpgsql $$ BEGIN DROP TABLE users; END $$"',
  'psql -h db.example -cDROP\\ TABLE\\ users',
  "psql -h db.example -c \"DO $$ BEGIN RAISE EXCEPTION 'x'; EXCEPTION WHEN OTHERS THEN DROP TABLE users; END $$\"",
  "sql='DROP TABLE users'; psql -h db.example <<< \"$sql\"",
  'psql -h db.example -c "-- note; with a semicolon\ndrop table users"',
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
  // Appending, xargs input can complete a multi-word CLI operation; substituted, it can put --force in place.
  'xargs -I{} git push origin {} < branches',
  'xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null xargs -a /dev/null terraform destroy',
  "printf 'x' | xargs -I{} xargs psql -c 'DROP TABLE users'",
  "find . -name x -exec xargs git push --force origin main \\;",
  // A word xargs reads or find matches is tried in every place it lands, as any word that makes the command need
  // approval: part of a word, a shell positional, a whole operation, or the environment.
  "printf '%s\\n' force | xargs -I{} git push --{} origin main",
  "printf '%s\\n' 'system prune' | xargs docker",
  'printf FLUSHALL | xargs redis-cli',
  "find destroy -maxdepth 0 -exec sh -c 'terraform \"$1\"' _ {} \\;",
  'printf -- --no-dry-run | xargs git clean -n',
  "xargs -I{} psql -c 'select count(*) from {}' < tables",
  "find . -name '*.sql' -exec psql -f {} \\;",
  "printf '%s\\n' x | xargs -I{} env PATH={} git status",
  "xargs -I{} sh -c '{}' < cmds",
  "printf ALL | xargs -I{} redis-cli FLUSH{}",
  "printf ce | xargs -I{} git push --for{} origin main",
  // The words xargs appends may first fill a wrapper's option values, then name the command.
  "printf '5 rm -rf /etc\\n' | xargs timeout",
  "printf '%s\\n' '/ rm -rf /etc' | xargs env -C",
  "printf '%s\\n' 'root rm -rf /etc' | xargs sudo -u",
  "printf '%s\\n' 'KILL 5 rm -rf /etc' | xargs timeout -s",
];

// Allowed: safe / ephemeral. The git rows pin the DELIBERATE non-gates:
// lease-protected force pushes (the sanctioned recovery the MCP git_push tool
// uses), plain pushes, local branch ops, and `git stash push -f` (not a push).
const BASH_ALLOW = [
  'gi\\\nt status',
  'terraform\\\n plan',
  'curl https://api.render.com/v1/postgres/dpg-example',
  'mkdir -p src/{a,b}',
  'git clean -n {a,b} -f',
  'ls -la',
  'xargs echo < list',
  'xargs -r git add < list',
  // Input that can't turn the written operation into one needing approval passes.
  'xargs -n1 terraform fmt < dirs',
  'xargs -n1 kubectl logs < pods',
  'xargs -I{} gh api {} < endpoints',
  // A shell running a script file it names gets what xargs reads as that script's arguments.
  "printf '%s\\n' a b | xargs -P 4 -I{} bash tools/review.sh {}",
  'xargs -L 1 bash run.sh < jobs',
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
  'trash key.p8',
  'trash-list',
  'trash-empty --help',
  'trash-empty --version',
  'trash-empty --dry-run',
  'trash-empty --dry-run 30',
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
  // A dry run whose words are all literal, and a git global option that prints and exits, run nothing.
  'git clean -n -d -x -- build/',
  'git --help clean',
  'git --version clean -fd',
  'git --help wipe',
  'git -v wipe',
  'git --html-path wipe',
  'git --exec-path clean -fd',
  'git --list-cmds=main wipe',
  // Options held in a variable are not an alias, and git <word> --help only shows help.
  'C="-c user.name=t"; git $C commit -m x',
  'git co --help',
  'git push --help -f',
  // A global option left without its value runs nothing.
  'git --exec-path',
  'git -C',
  'git --namespace',
  // Reading risky config, and writing other config, change nothing a later command runs.
  'git config alias.st',
  'git config --get remote.origin.push',
  'git config user.name t',
  'git -c user.name=t commit -m x',
  'git -c core.pager=cat log',
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=t; git commit -m x',
  'git remote add backup https://example.com/r.git',
  'git clone -c user.name=t https://example.com/r.git',
  // git config stops reading options at the first name, so a value like this one is not -e.
  "git config set gui.diffopts '-U5 --ignore-space-change'",
  "git config gui.diffopts '-U5 --ignore-space-change'",
  // A value or value-pattern that looks like a key is not the key.
  'git config --replace-all user.name new alias.x',
  'git config --replace-all example.flags -f core.hooksPath',
  'git config set user.name core.hooksPath',
  // One name alone is read, whatever file an option's value names.
  'git config --file "$CONFIG_FILE" core.hooksPath',
  'git config --file "$(git rev-parse --show-toplevel)/.gitmodules" submodule.x.url https://example.com/x',
  'git ls-files -m | xargs git add',
  // One key per run under xargs -n1 (the last of -n and -L wins), and reads under any runner.
  "printf '%s\\n' user.name user.email | xargs -n1 git config --local",
  "printf '%s\\n' user.name | xargs --max-args=1 git config --local",
  "printf '%s\\n' user.name | xargs -rn1 git config --local",
  "printf '%s\\n' 'alias.st status' | xargs -L1 -n1 git config --local",
  'parallel git -C {} config --get user.email ::: repo-a repo-b',
  'parallel git config get user.{} ::: name email',
  "parallel 'git config --list' ::: a",
  'printf "user.name\\n" | while read k; do git config --get "$k"; done',
  // One argument a run under parallel -n1 or -N1, and a quoted variable that read sets stays one word.
  'parallel -n 1 git config --local ::: user.name user.email',
  'parallel -n1 git config --local ::: user.name',
  'parallel --max-args=1 git config --local ::: user.name',
  'parallel -N1 git config --local ::: user.name',
  "printf '%s\\n' user.name | while read -r key; do git config --local \"$key\"; done",
  "printf '%s\\n' user.name | while read -r key; do git config --local \"${key}\"; done",
  // An installed contrib command, and -h after one of git's own commands, which prints its usage.
  'git subtree -h',
  'git subtree split --prefix=lib',
  'git clean -h -fdx',
  'git config -f "$F" core.hooksPath',
  // Removing config can't add an alias, a mirror or a program to run.
  'git config --unset alias.st',
  'git config --remove-section remote.old',
  // Built into both installs' git, or shipped with it as a script.
  'git annotate README.md',
  'git merge-octopus HEAD -- HEAD topic',
  'git merge-resolve HEAD -- HEAD topic',
  "git clean -n -- 'dir with spaces'",
  "git clean -n 'dir with spaces'",
  "git submodule foreach --recursive 'git status --short'",
  "git submodule foreach 'git fetch origin && git checkout main'",
];

// git-clone into a managed dir is blocked (must use clone_repo/create_worktree);
// pure /tmp clones and non-clone commands are allowed. Order-independent: a
// managed-dir reference ANYWHERE alongside `git clone` blocks the whole command.
const GIT_CLONE_BLOCK = [
  "cat > clone.sh <<'EOF'\ngit clone https://github.com/x/y /workspace/agent/y\nEOF\nbash clone.sh",
  'git clone https://github.com/a/b /workspace/agent/b',
  'git clone https://github.com/a/b /workspace/agent/repos/b',
  'git clone https://github.com/a/b /workspace/worktrees/b',
  'git clone https://github.com/a/b /workspace/workgroup/b',
  'git clone https://github.com/a/b /tmp/x && mv /tmp/x /workspace/agent/stolen',
];
const GIT_CLONE_ALLOW = [
  "cat >> STATE.md <<'EOF'\ngit clone https://github.com/x/y /workspace/agent/y\nEOF",
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
  "cat > run.sh <<'EOF'\npython3 -c 'import snowflake.connector'\nEOF\nbash run.sh",
  "python -c 'import snowflake.connector'",
  'python3 -c "from snowflake.connector import connect"',
  'python -c "import snowflake_connector"',
];
const SNOWFLAKE_ALLOW = [
  "cat >> STATE.md <<'EOF'\npython3 -c 'import snowflake.connector'\nEOF",
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
  "cat <<'EOF' | bash\ngws gmail +send --to a@example.com --subject hi\nEOF",
  'cat >> STATE.md <<EOF\n$(gws gmail +send --to a@example.com --subject hi)\nEOF',
  'gws gmail +send --to a@example.com --subject hi',
  'gws gmail +reply --to a@example.com',
  'gws gmail users messages send --json \'{"raw":"x"}\'',
];
const EMAIL_ALLOW = [
  'ls -la',
  'git status',
  'gws gmail +send --to a@example.com --dry-run',
  "cat >> STATE.md <<'EOF'\ngws gmail +send --to a@example.com --subject hi\nEOF\necho ok",
];

describe('parity contract — destructive bash', () => {
  for (const cmd of BASH_BLOCK) {
    it(`blocks: ${cmd}`, () => expect(evaluateBashCommand(cmd).action).toBe('block'));
  }
  // A gated row is held by the rule it was written for: only these two are held as writes, so a broken destructive rule
  // can't pass behind the card every write takes.
  const WRITE_ONLY = new Set(["snow sql -c prod -q 'DROP TAB\\\nLE t'", 'snow sql -c prod -q "alter table prod.orders rename column a to b"']);
  for (const cmd of BASH_GATE) {
    it(`gates: ${cmd}`, () => {
      const verdict = evaluateBashCommand(cmd);
      expect(verdict.action).toBe('gate');
      expect(verdict.reason?.includes(SQL_WRITE) ?? false).toBe(WRITE_ONLY.has(cmd));
    });
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
