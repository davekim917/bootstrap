import { describe, expect, test } from 'bun:test';

import { evaluateBashCommand } from './block-destructive-core';

const SAFE = 'onecli agents list --fields id,identifier,name';
const DEFAULT_SAFE = 'onecli agents get-default --fields id,identifier,name';
const CREATE_SAFE = 'onecli agents create --name <name> --identifier <id> > /dev/null && onecli agents list --fields id,identifier,name';
const REGENERATE_SAFE = 'onecli agents regenerate-token --id <id> > /dev/null';
const AUTH_SAFE = 'onecli auth status';
const RUN_SAFE = 'onecli run --agent <id> --dry-run -- true';
const verdict = (command: string) => evaluateBashCommand(command, { cwd: '/workspace/invented' });

describe('every onecli command that prints a credential is refused, naming its safe form', () => {
    test.each([
        ['the default agent', 'onecli agents get-default', DEFAULT_SAFE],
        ['the default agent with the token field', 'onecli agents get-default --fields accessToken', DEFAULT_SAFE],
        ['creating an agent, which prints its token', 'onecli agents create --name Invented --identifier invented-agent', CREATE_SAFE],
        ['creating an agent, output to a file', 'onecli agents create --name Invented --identifier invented-agent > agent.json', CREATE_SAFE],
        ['regenerating a token, which prints it', 'onecli agents regenerate-token --id agent-invented-1', REGENERATE_SAFE],
        ['regenerating a token, into a variable', 'T=$(onecli agents regenerate-token --id agent-invented-1)', REGENERATE_SAFE],
        ['the account API key', 'onecli auth api-key', AUTH_SAFE],
        ['regenerating the account API key', 'onecli auth regenerate-api-key', AUTH_SAFE],
        ['a subcommand this guard does not know', 'onecli agents export-tokens', 'onecli agents export-tokens > /dev/null'],
        ['a command group this guard does not know', 'onecli tokens list', 'onecli tokens list > /dev/null'],
        ['env under onecli run', 'onecli run --agent invented -- env', RUN_SAFE],
        ['printenv under onecli run with no --', 'onecli run printenv HTTPS_PROXY', RUN_SAFE],
        ['env under onecli run --agent with no --', 'onecli run --agent invented env', RUN_SAFE],
        ['the process environment under onecli run with no --', 'onecli run --gateway localhost:10255 cat /proc/self/environ', RUN_SAFE],
        ['a script piped to a shell onecli run starts', "printf 'printenv HTTPS_PROXY\\n' | onecli run -- bash", RUN_SAFE],
        ['a script the line writes, then runs under onecli run', "cat > s.sh <<'EOF'\ncat /proc/self/environ\nEOF\nonecli run -- bash s.sh", RUN_SAFE],
        ['a shell inside a script a shell under onecli run reads', "printf 'sh -c env\\n' | onecli run -- bash", RUN_SAFE],
        ['a script the line writes, fed on stdin to a shell under onecli run', "printf 'printenv HTTPS_PROXY\\n' > s.sh && onecli run bash < s.sh", RUN_SAFE],
        ['a script the line writes, fed on stdin to a shell', "cat > s.sh <<'EOF'\nonecli agents get-default\nEOF\nbash < s.sh", DEFAULT_SAFE],
        ['printenv under onecli run', 'onecli run --agent invented -- printenv HTTPS_PROXY', RUN_SAFE],
        ['the process environment under onecli run', 'onecli run -- cat /proc/self/environ', RUN_SAFE],
        ['the process environment read from stdin under onecli run', "onecli run -- tr '\\0' '\\n' < /proc/self/environ", RUN_SAFE],
        ['stdout discarded, then duplicated onto stderr', 'onecli agents create --name Invented --identifier invented-agent >/dev/null 1>&2', CREATE_SAFE],
        ['stdout duplicated onto stderr', 'onecli agents regenerate-token --id agent-invented-1 >&2', REGENERATE_SAFE],
        ['stdout discarded, then reopened read-write on stderr', 'onecli agents regenerate-token --id agent-invented-1 >/dev/null 1<>/dev/stderr', REGENERATE_SAFE],
        ['a dry run a later flag turns off', 'onecli agents regenerate-token --id agent-invented-1 --dry-run --dry-run=false', REGENERATE_SAFE],
        ['an onecli run dry run a later flag turns off', 'onecli run --dry-run --dry-run=false -- env', RUN_SAFE],
        ['a thread environment under onecli run', 'onecli run -- cat /proc/self/task/1/environ', RUN_SAFE],
        ['the environment read by dd under onecli run', 'onecli run -- dd if=/proc/self/environ', RUN_SAFE],
        ['a quoted later flag that turns the dry run off', "onecli run --dry-run '--dry-run=false' -- env", RUN_SAFE],
        ['the environment under a doubled slash', 'onecli run -- cat //proc/self/environ', RUN_SAFE],
        ['the environment by a glob', 'onecli run -- cat /proc/self/env*', RUN_SAFE],
        ['the environment through .. from /dev', 'onecli run -- cat /dev/../proc/self/environ', RUN_SAFE],
        ['the environment through the /dev/fd link', 'onecli run -- cat /dev/fd/../environ', RUN_SAFE],
        ['the environment through the /dev/fd link on stdin', "onecli run -- tr '\\0' '\\n' < //dev/fd/../environ", RUN_SAFE],
        ['a script whose quotes split the word onecli', "echo 'one''cli agents regenerate-token --id agent-invented-1' | bash", REGENERATE_SAFE],
    ])('%s', (_name, command, safe) => {
        const result = verdict(command);
        expect(result.action).toBe('block');
        expect(result.reason).toContain(safe);
    });
});

describe('an onecli agents listing that would print access tokens is refused', () => {
    test.each([
        ['the incident: the whole listing piped to head', 'onecli agents list | head -60'],
        ['the bare listing', 'onecli agents list'],
        ['agents get', 'onecli agents get --id agent-invented-1'],
        ['--fields naming the token', 'onecli agents list --fields id,accessToken'],
        ['--fields= naming the token', 'onecli agents list --fields=name,accessToken'],
        ['an empty --fields, which prints every field', "onecli agents list --fields ''"],
        ['a later --fields, which replaces the safe one', 'onecli agents list --fields id --fields accessToken'],
        ['--quiet printing the token', 'onecli agents list --quiet accessToken'],
        ['a field the guard does not know', 'onecli agents list --fields id,secretValue'],
        ['fields from a variable', 'onecli agents list --fields "$F"'],
        ['the subcommand from a variable', 'onecli agents "$SUB"'],
        ['onecli by its path', '/usr/local/bin/onecli agents list'],
        ['under onecli run', 'onecli run --agent invented -- onecli agents list'],
        ['under sudo and env', 'sudo env HOME=/root onecli agents list'],
        ['in a substitution', 'echo "$(onecli agents list)"'],
        ['through xargs', 'echo list | xargs onecli agents'],
        ['through find -exec', 'find . -maxdepth 0 -exec onecli agents list ;'],
        ['a script piped to sh', "echo 'onecli agents list' | sh"],
        ['a heredoc piped to bash', "cat <<'EOF' | bash\nonecli agents list | head\nEOF"],
        ['a script the line writes, then runs', "cat > ls.sh <<'EOF'\nonecli agents list\nEOF\nbash ls.sh"],
    ])('%s', (_name, command) => {
        const result = verdict(command);
        expect(result.action).toBe('block');
        expect(result.reason).toContain(SAFE);
    });
});

describe('a listing limited to safe fields, and other onecli commands, run as before', () => {
    test.each([
        ['safe --fields', 'onecli agents list --fields id,identifier,name'],
        ['safe --fields= with spaces', "onecli agents list --fields='id, name, isDefault, createdAt'"],
        ['--quiet naming a safe field', 'onecli agents list --quiet name --max 5'],
        ['the default agent with safe fields', 'onecli agents get-default --fields id,identifier'],
        ['help', 'onecli agents list --help'],
        ['an agent\'s secret names', 'onecli agents secrets --id agent-invented-1 --fields id,name'],
        ['secrets list', 'onecli secrets list'],
        ['creating an agent with its output discarded', 'onecli agents create --name Invented --identifier invented-agent > /dev/null'],
        ['regenerating a token with its output discarded', 'onecli agents regenerate-token --id agent-invented-1 >/dev/null 2>&1'],
        ['a command onecli run starts', 'onecli run --agent invented -- curl -s https://api.invented.example/v1/me'],
        ['a command onecli run starts with no --', 'onecli run --agent invented curl https://api.invented.example/v1/me'],
        ['onecli run --dry-run', 'onecli run --agent invented --dry-run -- curl -s https://api.invented.example'],
        ['the dry run the env refusal names', 'onecli run --agent invented --dry-run -- true'],
        ['stdout duplicated, then discarded', 'onecli agents create --name Invented --identifier invented-agent 1>&2 >/dev/null'],
        ['creating an agent as a dry run', 'onecli agents create --name Invented --identifier invented-agent --dry-run'],
        ['regenerating a token as a dry run', 'onecli agents regenerate-token --id agent-invented-1 --dry-run'],
        ['env outside onecli run', 'env | grep PATH'],
        ['a script piped to a shell onecli run starts, that prints no environment', "printf 'curl -s https://api.invented.example/v1/me\\n' | onecli run -- bash"],
        ['a script piped to a plain shell that runs printenv', "printf 'printenv PATH\\n' | bash"],
        ['a shell under onecli run, then a plain shell that runs printenv', "onecli run -- true; printf 'printenv PATH\\n' | bash"],
        ['a /dev path under onecli run', 'onecli run -- cat /dev/null'],
        ['auth status', 'onecli auth status'],
        ['version', 'onecli version'],
        ['a commit message naming the command', 'git commit -m "refuse onecli agents list without --fields"'],
        ['a note naming the command', 'echo "onecli agents list prints tokens" > note.md'],
        ['a heredoc note naming the command', "cat > note.md <<'EOF'\nonecli agents list | head\nEOF"],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toEqual({ action: 'allow' });
    });
});
