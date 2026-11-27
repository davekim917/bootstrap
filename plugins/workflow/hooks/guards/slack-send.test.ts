import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LITERAL_CREDENTIAL_REASON, SEND_SCOPE_FILE_ENV, evaluateSlackPost, gateReceiptOf, gateRequestContent, parseSendScope, payloadChangedSince } from './block-destructive-core';

/**
 * SLACK WRITES IN A PERSON'S NAME. In a listed workgroup's session, or on a line naming a listed OneCLI agent, a line
 * that names a Slack API method other than a read, or leaves the method to the shell, stops for that person's OK. Its
 * card shows the message only when that text is exactly what goes out.
 */

let dir = '';
let scopeFile = '';
let saved: string | undefined;
// The client config files the guard looks for live under these; the tests give them an empty home.
const HOME_NAMES = ['HOME', 'XDG_CONFIG_HOME', 'CURL_HOME'] as const;
const savedHome: Partial<Record<(typeof HOME_NAMES)[number], string>> = {};

const POST = `curl -sS https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data '{"channel":"C1","text":"Numbers are in."}'`;
const BODY = `--json '{"channel":"C1","text":"hello"}'`;
// A read helper of the shape agents write: the Slack method is the function's first argument.
const FN = 'S(){ onecli run --agent ag-acme -- curl -s -G "https://slack.com/api/$1" "${@:2}"; }';

beforeAll(() => {
    saved = process.env[SEND_SCOPE_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'send-scope-test-'));
    for (const name of HOME_NAMES) {
        savedHome[name] = process.env[name];
        delete process.env[name];
    }
    mkdirSync(join(dir, 'home'));
    process.env.HOME = join(dir, 'home');
    scopeFile = join(dir, 'send-scope.local.json');
    writeFileSync(scopeFile, JSON.stringify({ slack: { workgroups: ['acme'], onecliAgents: ['ag-acme'] } }));
    process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
});

afterAll(() => {
    if (saved === undefined) delete process.env[SEND_SCOPE_FILE_ENV];
    else process.env[SEND_SCOPE_FILE_ENV] = saved;
    for (const name of HOME_NAMES) {
        if (savedHome[name] === undefined) delete process.env[name];
        else process.env[name] = savedHome[name];
    }
    rmSync(dir, { recursive: true, force: true });
});

const verdict = (command: string, workgroup?: string) => evaluateSlackPost(command, workgroup, { nanoclaw: false }).action;

describe('which lines wait for the person whose Slack token they use', () => {
    test.each([
        ['a post from a listed workgroup', 'acme', POST],
        ['an edit', 'acme', `curl https://slack.com/api/chat.update -d channel=C1 -d ts=1 -d text=x`],
        ['a delete', 'acme', `curl https://slack.com/api/chat.delete -d channel=C1 -d ts=1`],
        ['a file share', 'acme', `curl -F file=@a.png https://slack.com/api/files.upload`],
        ['a reaction, a method that is not a read', 'acme', `curl https://slack.com/api/reactions.add -d channel=C1 -d name=eyes -d timestamp=1`],
        ['a post to a URL held in a variable named for Slack', 'acme', `curl -s -X POST "$SLACK_POST_URL" --json @payload.json`],
        ['a variable named for Slack in a --url= value', 'acme', `curl -s -X POST --url="$SLACK_POST_URL" --json @payload.json`],
        ['a variable named for Slack inside a URL', 'acme', `curl -s -X POST "https://hooks.example.com/$SLACK_PATH" -d text=hi`],
        ['a write URL a variable holds, used under a listed --agent', 'other', `URL=https://slack.com/api/chat.postMessage; onecli run --agent ag-acme -- curl "$URL" -d channel=C1 -d text=hi`],
        ['a write URL an array holds, used under a listed --agent', 'other', `args=(https://slack.com/api/chat.postMessage -d text=hi); onecli run --agent ag-acme -- curl "\${args[@]}"`],
        ['a write URL in a variable the line never uses', 'acme', `URL=https://slack.com/api/chat.postMessage; echo done`],
        ['a URL variable named for Slack in an array', 'acme', `args=("\${SLACK_WEBHOOK}" -d text=hi); curl "\${args[@]}"`],
        ['curl reading a config file under a listed identity', undefined, `onecli run --agent ag-acme -- curl -s -K request.cfg`],
        ['curl reading a config file in a clustered option', 'acme', `curl -sK request.cfg`],
        ['an --agent held in a variable the line does not set', 'other', `onecli run --agent "$AGENT" -- curl https://slack.com/api/chat.postMessage -d text=hi`],
        ['an --agent a Python program holds in a variable', 'other', `python3 - <<'EOF'\nimport subprocess\nA = "ag-acme"\nsubprocess.run(["onecli", "run", "--agent", A, "--", "curl", "https://slack.com/api/chat.postMessage", "-d", "text=hi"])\nEOF`],
        ['an --agent in a script the line writes and then runs', 'other', `cat > /tmp/send.py <<'EOF'\nimport subprocess\nA = "ag-acme"\nsubprocess.run(["onecli", "run", "--agent", A, "--", "curl", "https://slack.com/api/chat.postMessage", "-d", "text=hi"])\nEOF\npython3 /tmp/send.py`],
        ['a listed --agent a Python program passes to onecli', 'other', `python3 -c "import subprocess; subprocess.run(['onecli','run','--agent','ag-acme','--','curl','https://slack.com/api/chat.postMessage','-d','text=hi'])"`],
        ['a post on a workspace subdomain', 'acme', `curl https://acme.slack.com/api/chat.postMessage -d text=x`],
        ['a post to the Slack host with its port', 'acme', `curl https://slack.com:443/api/chat.postMessage -d text=x`],
        ['a post to the Slack host spelled with a trailing dot', 'acme', `curl https://slack.com./api/chat.postMessage -d text=x`],
        ['a post with a doubled slash before api', 'acme', `curl https://slack.com//api/chat.postMessage -d text=x`],
        ['a post after a read in the same curl', 'acme', `curl https://slack.com/api/conversations.list --next https://slack.com/api/chat.postMessage -d text=x`],
        ['a post run by a shell', 'acme', `bash -lc 'curl https://slack.com/api/chat.postMessage -d text=hello'`],
        ['an HTTPie post', 'acme', `http POST https://slack.com/api/chat.postMessage text=hi`],
        ['a request target that turns a Slack read into a post', 'acme', `curl https://slack.com/api/conversations.list --request-target /api/chat.postMessage -d text=hi`],
        ['a path that climbs out of a read method', 'acme', `curl https://slack.com/api/conversations.history/../chat.postMessage -d text=x`],
        ['an ANSI-C quoted URL', 'acme', `curl $'https://slack.com/api/chat.postMessage' -d text=hi`],
        ['a URL split across quotes', 'acme', `curl "https://slack.com/api/chat.post"'Message' -d text=hi`],
        ['a listed OneCLI identity outside any workgroup', undefined, `onecli run --agent ag-acme -- ${POST}`],
        ['a listed OneCLI identity given with --agent=', undefined, `onecli run --agent=ag-acme -- curl https://slack.com/api/chat.postMessage -d text=hello`],
        ['onecli running its command after its options with no --', undefined, `onecli run --agent ag-acme curl https://slack.com/api/chat.postMessage -d text=hi`],
        ['a listed identity held in a variable the line sets', 'other', `A=ag-acme; onecli run --agent "$A" -- curl https://slack.com/api/chat.postMessage -d text=hi`],
        ['an unwrapped post in a container beside a wrapped read', 'acme', `onecli run --agent ag-other -- curl https://slack.com/api/conversations.list; docker exec worker curl https://slack.com/api/chat.postMessage ${BODY}`],
        // A literal write anywhere on the line, wherever the shell would carry it.
        ['a write URL in an array', 'acme', `args=(https://slack.com/api/chat.postMessage --json @payload.json); curl "\${args[@]}"`],
        ['a write URL in a loop list', 'acme', `for u in https://slack.com/api/chat.postMessage; do curl "$u" -d text=hi; done`],
        ['a Slack host xargs completes with a method', 'acme', `printf 'chat.postMessage\n' | xargs -I{} curl https://slack.com/api/{} -d text=hi`],
        ['a write URL a script is given', 'acme', `bash send.sh https://slack.com/api/chat.postMessage`],
        ['a write URL in a function the line never calls', 'acme', `post(){ curl https://slack.com/api/chat.postMessage -d text=hi; }`],
        ['a wrapper function for a listed identity called with JSON', 'other', `send(){ onecli run --agent ag-acme -- curl "$@"; }; send https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"hi"}'`],
        ['a Slack API base whose target comes from the environment', 'acme', `URL=https://slack.com/api; curl "$URL" --request-target "$TARGET" --json @payload.json`],
        ['a Python one-liner naming a write URL', 'acme', `python3 -c "import urllib.request as u; u.urlopen('https://slack.com/api/chat.postMessage', data=b'text=hi')"`],
        ['a Node one-liner naming a write URL under a listed identity', undefined, `onecli run --agent ag-acme -- node -e 'fetch("https://slack.com/api/chat.postMessage", { method: "POST" })'`],
        // The Slack API with a method the shell fills in.
        ['a method held in a variable', 'acme', `curl -s "https://slack.com/api/$M" -d text=hi`],
        ['a read method a variable completes', 'acme', `curl "https://slack.com/api/conversations.list$X"`],
        // A function on the line takes its method from the calls the line makes to it.
        ['a function called with a write method', undefined, `${FN}; S chat.postMessage -d text=hi`],
        ['a function called with a method the shell fills in', undefined, `${FN}; S "$M" --data-urlencode channel=C1`],
        ['a function called once to read and once to write', undefined, `${FN}; S conversations.history; S chat.update -d ts=1 -d text=x`],
        ['a function the line also exports', undefined, `${FN}; export -f S; S conversations.history`],
        ['a function the line also runs through eval', undefined, `${FN}; eval "S chat.postMessage"; S conversations.history`],
        ['a function read call carrying a request target to a write', undefined, `${FN}; S conversations.history --request-target /api/chat.postMessage`],
        ['a listed identity posting with the method held in a variable', undefined, `METHOD=chat.postMessage; onecli run --agent ag-acme -- curl "$SLACK_API/$METHOD" ${BODY}`],
        ['a post with the method held in a variable', 'acme', `METHOD=chat.postMessage\ncurl "$SLACK_API/$METHOD" ${BODY}`],
        ['a post through a Slack host the environment already holds', 'acme', `curl "$SLACK_HOST/api/chat.postMessage" ${BODY}`],
        ['a listed identity posting through a trimmed base URL', undefined, `onecli run --agent ag-acme -- curl "\${SLACK_API%/}/chat.postMessage" ${BODY}`],
        ['a listed identity posting through a quoted base URL', undefined, `onecli run --agent ag-acme -- curl "$SLACK_API"/chat.postMessage ${BODY}`],
        // A variable named for Slack in the slot a client reads its URL from, by its option table.
        ['a Slack variable after an attached method', 'acme', `curl -XPOST "$SLACK_POST_URL" --json @payload.json`],
        ['a Slack variable after a clustered method under a listed identity', undefined, `onecli run --agent ag-acme -- curl -sSXPOST "$SLACK_POST_URL" -d @payload.json`],
        ['a Slack variable after an unquoted expansion, which leaves the slots unread', 'acme', `curl $FLAGS -H "$SLACK_WEBHOOK"`],
        ['a Slack variable a shell runs from -c', 'acme', `bash -c 'curl -XPOST "$SLACK_POST_URL" -d @payload.json'`],
        ['a Slack variable a function passes to its URL', 'acme', `post(){ curl -d @payload.json "$1"; }; post "$SLACK_WEBHOOK"`],
        ['a Slack variable in a loop list', 'acme', `for u in "$SLACK_WEBHOOK"; do curl -d @payload.json "$u"; done`],
        ['a Slack variable after HTTPie\'s valued option and method', 'acme', `http -a user:pass POST "$SLACK_WEBHOOK" text=hi`],
        ['a Slack variable after xh\'s valued option and method', 'acme', `xh -o out.json post "$SLACK_WEBHOOK" text=hi`],
        ['curl reading a config file by a prefix of --config', 'acme', `curl --conf request.cfg`],
        ['a Slack variable after HTTPie\'s method on a continued line', 'acme', `http POST \\\n "$SLACK_WEBHOOK" text=hi`],
        ['a Slack variable an indexed array holds', 'acme', `urls=("$SLACK_POST_URL"); curl -XPOST "\${urls[0]}" --json @payload.json`],
        ['a Slack variable at a later index of an array', 'acme', `args=(-H "$SLACK_POST_URL"); curl "\${args[1]}"`],
        ['a Slack variable appended to an array', 'acme', `args=(-s -X POST); args+=("$SLACK_WEBHOOK" -d @payload.json); curl "\${args[@]}"`],
        ['a Slack variable assigned to an array element', 'acme', `a[0]="$SLACK_POST_URL"; curl -d @payload.json "\${a[0]}"`],
        ['a Slack variable appended to a URL', 'acme', `U=https://hooks.example.com; U+="/$SLACK_PATH"; curl -d @payload.json "$U"`],
        ['a Slack variable at the end of a long array', 'acme', `a=(e1 e2 e3 e4 e5 e6 e7 e8 e9 e10 e11 e12 e13 e14 e15 e16 e17 e18 e19 "$SLACK_POST_URL"); curl -d @payload.json "\${a[19]}"`],
        // Text a shell runs: a shell's script, a substitution, a heredoc fed to a shell, a script the line writes and then runs.
        ['a Slack variable in a script printf writes and the line runs', 'acme', `printf '%s\\n' 'curl "$SLACK_POST_URL"' > send.sh; bash send.sh`],
        ['a Slack variable in a heredoc fed to a shell', 'acme', `bash <<'EOF'\ncurl -d @payload.json "$SLACK_WEBHOOK"\nEOF`],
        ['a Slack variable in a substitution inside a printed string', 'acme', `echo "result: $(curl -s -d x "$SLACK_WEBHOOK")"`],
        ['a Slack variable in su\'s -c command', 'acme', `su -c 'curl -d @payload.json "$SLACK_WEBHOOK"' app`],
        ['a Slack variable in what watch runs', 'acme', `watch -n 5 'curl -s -d x "$SLACK_WEBHOOK"'`],
        ['a Slack variable in a script tee writes and the line runs', 'acme', `tee send.sh <<'EOF' >/dev/null\ncurl -d @payload.json "$SLACK_WEBHOOK"\nEOF\nbash send.sh`],
        ['a Slack variable in a heredoc fed to su', 'acme', `su - app <<'EOF'\ncurl -d @payload.json "$SLACK_WEBHOOK"\nEOF`],
        ['a Slack variable in a heredoc sourced from stdin', 'acme', `source /dev/stdin <<'EOF'\ncurl -d @payload.json "$SLACK_WEBHOOK"\nEOF`],
        // A Slack user token on the line posts as its person, in any workgroup; onecli is onecli by any path.
        ['a post with a Slack user token written out, outside any listed workgroup', 'other', `curl -H 'Authorization: Bearer xoxp-EXAMPLE' --json '{"channel":"C1","text":"hi"}' https://slack.com/api/chat.postMessage`],
        ['a post with a variable that holds a Slack user token', undefined, `curl -H "Authorization: Bearer $SLACK_USER_TOKEN" -d text=hi https://slack.com/api/chat.postMessage`],
        ['a listed identity run by onecli from its path', 'other', `/opt/tools/bin/onecli run --agent ag-acme -- ${POST}`],
        // Text that names the Slack API still counts where something runs or sends it.
        ['a write on a base URL a variable holds', 'acme', `S=https://slack.com/api; curl -X POST "$S/chat.postMessage" -d text=hi`],
        ['a base URL the line exports to a script it runs', 'acme', `export S=https://slack.com/api; ./post.sh`],
        ['a write URL in a heredoc fed to a shell', 'acme', `cat <<'EOF' | bash\ncurl -X POST https://slack.com/api/chat.postMessage -d @payload.json\nEOF`],
        ['a write URL in a script a heredoc writes and the line runs', 'acme', `cat > send.sh <<'EOF'\ncurl -X POST https://slack.com/api/chat.postMessage -d @payload.json\nEOF\nbash send.sh`],
        ['a write URL echo hands to xargs', 'acme', `echo https://slack.com/api/chat.postMessage | xargs curl -X POST -d @payload.json`],
        ['a write URL echo writes to a file xargs reads', 'acme', `echo https://slack.com/api/chat.postMessage > urls.txt; xargs curl -d @payload.json < urls.txt`],
        ['a write URL a loop reads from a file echo writes', 'acme', `echo https://slack.com/api/chat.postMessage > urls.txt; while read -r u; do curl -X POST "$u" -d @payload.json; done < urls.txt`],
        ['a post in a substitution inside echo\'s argument', 'acme', `echo "$(curl -s -X POST https://slack.com/api/chat.postMessage -d @payload.json)"`],
        ['a post in a substitution inside another program\'s argument', 'acme', `notes-cli add --text "$(curl -s -X POST https://slack.com/api/chat.postMessage -d @payload.json)"`],
        ['a post in a substitution inside an unquoted heredoc written to a file', 'acme', `cat <<EOF > notes.md\nresult: $(curl -s -X POST https://slack.com/api/chat.postMessage -d @payload.json)\nEOF`],
        ['a write URL printf -v assigns', 'acme', `printf -v U 'https://slack.com/api/%s' chat.postMessage; curl -X POST "$U" -d @payload.json`],
        ['a write URL a function echoes to a client', 'acme', `f(){ echo https://slack.com/api/chat.postMessage; }; curl -X POST "$(f)" -d @payload.json`],
        ['a Python script a heredoc writes and the line runs', 'acme', `cat > /tmp/pull.py <<'EOF'\nimport urllib.request\nurllib.request.urlopen("https://slack.com/api/" + m)\nEOF\npython3 /tmp/pull.py`],
        ['a post echo pipes through a wrapper into a shell', 'acme', `echo 'curl -X POST https://slack.com/api/chat.postMessage -d @payload.json' | timeout 30 bash`],
    ] as Array<[string, string | undefined, string]>)('%s gates', (_label, workgroup, command) => {
        expect(verdict(command, workgroup)).toBe('gate');
    });

    test.each([
        ['the same post from another workgroup', 'other', POST],
        ['a post under an unlisted OneCLI identity', 'other', `onecli run --agent ag-other -- ${POST}`],
        ['onecli with no --agent outside a listed workgroup', 'other', `onecli run -- curl https://slack.com/api/chat.postMessage -d text=hi`],
        ['a read', 'acme', `curl -G https://slack.com/api/conversations.replies --data-urlencode channel=C1`],
        ['a read with a query string', 'acme', `curl -s "https://slack.com/api/conversations.history?channel=$C&limit=5"`],
        ['a search whose query holds a Slack permalink', 'acme', `curl -s -G https://slack.com/api/search.messages --data-urlencode 'query=https://acme.slack.com/archives/C1/p1'`],
        ['a read under a listed identity', undefined, `onecli run --agent ag-acme -- curl -s "https://slack.com/api/search.messages?query=deploy"`],
        ['a function called with a literal read method', undefined, `${FN}; S conversations.history --data-urlencode channel=C1`],
        ['a function called with a literal read method inside a substitution', undefined, `${FN}; result=$(S conversations.history --data-urlencode channel=C1); echo "$result"`],
        ['a variable named for Slack in a header to another host', 'acme', `curl -s -H "Authorization: Bearer $SLACK_TOKEN" https://api.example.com/v1/x`],
        ['an auth.test read with a Slack token header', 'acme', `curl -s -H "Authorization: Bearer $SLACK_TOKEN" https://slack.com/api/auth.test`],
        ['a write URL a variable holds, used under an unlisted --agent in a listed session', 'acme', `URL=https://slack.com/api/chat.postMessage; onecli run --agent ag-other -- curl "$URL" -d text=hi`],
        ['a search whose quoted query holds an API path among other words', 'acme', `curl -s -G https://slack.com/api/search.messages --data-urlencode 'query=error from /api/chat.postMessage'`],
        ['a document the line writes that quotes a listed --agent', 'other', `cat >> notes.md <<'EOF'\nTo post, run onecli run --agent ag-acme -- curl https://slack.com/api/chat.postMessage -d text=hi\nEOF`],
        ['a post whose message text quotes a listed --agent', 'other', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"run onecli run --agent ag-acme to see it"}'`],
        ['a search whose query holds an API path', 'acme', `curl -s -G https://slack.com/api/search.messages --data-urlencode 'query=/api/chat.postMessage'`],
        ['a post under an explicit unlisted --agent in a listed session', 'acme', `onecli run --agent ag-other -- ${POST}`],
        ['an --agent variable the line sets to an unlisted identity', 'other', `A=ag-other; onecli run --agent "$A" -- ${POST}`],
        ['a listed identity named only in the message text', 'other', `onecli run -- curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"ag-acme is set up"}'`],
        ['curl reading a config file under an unlisted --agent', 'other', `onecli run --agent ag-other -- curl -s -K request.cfg`],
        ['a function called with literal read methods in a loop', undefined, `${FN}; for c in C1 C2; do S conversations.replies --data-urlencode channel=$c; S users.info --data-urlencode user=U1; done`],
        ['a function the line defines and never calls', undefined, FN],
        ['opening a direct message', 'acme', `curl -s -X POST https://slack.com/api/conversations.open --data-urlencode users=U1`],
        ['a permalink read', 'acme', `curl https://slack.com/api/chat.getPermalink -d channel=C1 -d message_ts=1`],
        ['a scheduled-message listing', 'acme', `curl -s https://slack.com/api/chat.scheduledMessages.list`],
        ['a Slack file download with an escaped name', 'acme', `curl -sL -o a.png "https://files.slack.com/files-pri/T1-F1/a%20b.png"`],
        ['a Python script that reads Slack history', 'acme', `python3 - <<'EOF'\nimport json, subprocess\nout = subprocess.run(["curl", "-s", "https://slack.com/api/conversations.history?channel=C1"], capture_output=True)\nprint(json.loads(out.stdout)["ok"])\nEOF`],
        // Lines that name the Slack API nowhere run as they would with no send scope.
        ['a call whose whole URL is a variable', 'acme', `curl -s "$URL"`],
        ['a base URL from the environment', 'acme', `API="$EXAMPLE_API_URL/v2"; curl -s -H "Authorization: Token $EXAMPLE_TOKEN" "$API/runs/"`],
        ['a Python program a listed identity starts', undefined, `onecli run --agent ag-acme -- python3 -c 'print(1)'`],
        ['a Node program a listed identity starts', undefined, `onecli run --agent ag-acme -- node -e 'fetch(process.env.U)'`],
        ['a call to another host under a listed identity', undefined, `onecli run --agent ag-acme -- curl -s https://api.example.com/v1/me`],
        ['a container run whose environment value mentions onecli', 'other', `docker run --rm -e TOKEN=onecli-managed alpine true`],
        ['ordinary commands', 'acme', `ls -la && git status`],
        // A variable named for Slack that no HTTP client takes as its URL.
        ['a Slack variable jq takes as an argument', 'acme', `jq -n --arg channel "$SLACK_CHANNEL" '{channel: $channel}' > payload.json`],
        ['a Slack token in a header given by a unique prefix', 'acme', `curl --heade "Authorization: Bearer $SLACK_TOKEN" https://api.example.com/v1/x`],
        ['a Slack variable in wget\'s body', 'acme', `wget --body-data "text=$SLACK_MESSAGE" https://api.example.com/v1/x`],
        ['a Slack variable in an HTTPie request item', 'acme', `http POST https://api.example.com/v1/x channel=$SLACK_CHANNEL`],
        ['a Slack token in an xh header item', 'acme', `xh https://api.example.com/v1/x "Authorization:Bearer $SLACK_TOKEN"`],
        ['a Slack variable a function passes to a data option', 'acme', `post(){ curl -d "$1" https://api.example.com/v1/x; }; post "$SLACK_MESSAGE"`],
        ['a function called with a literal read method and a Slack variable in its data', undefined, `${FN}; S conversations.history --data-urlencode "channel=$SLACK_CHANNEL"`],
        ['a Slack token in a header on a continued line', 'acme', `curl -H \\\n "Authorization: Bearer $SLACK_TOKEN" https://api.example.com/v1/x`],
        ['a script printf writes and the line never runs', 'acme', `printf '%s\\n' 'curl "$SLACK_POST_URL"' > send.sh`],
        ['a document a heredoc writes', 'acme', `cat > notes.md <<'EOF'\ncurl -d @payload.json "$SLACK_WEBHOOK"\nEOF`],
        ['text echo writes to a file', 'acme', `echo "curl $SLACK_WEBHOOK" > notes.txt`],
        ['a substitution in single quotes', 'acme', `echo '$(curl -s "$SLACK_WEBHOOK")'`],
        ['a read with a Slack user token', 'other', `curl -H "Authorization: Bearer $SLACK_USER_TOKEN" https://slack.com/api/conversations.history`],
        ['a post whose text names the user-token prefix', 'other', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"Paste the User OAuth Token (xoxp-) here"}'`],
        ['an app manifest call with an app configuration token', 'other', `curl -s https://slack.com/api/apps.manifest.export -H 'Authorization: Bearer xoxe.xoxp-EXAMPLE' -d app_id=A1`],
        ['a post under an unlisted identity run by onecli from its path', 'acme', `/opt/tools/bin/onecli run --agent ag-other -- ${POST}`],
        // A Slack URL is a call only where an HTTP client takes it as its URL, not in the values its options take.
        ['a search whose query holds a Slack API URL', 'acme', `curl -G https://slack.com/api/search.messages --data-urlencode 'query=https://slack.com/api/chat.postMessage'`],
        ['a Slack API URL in a header to another host', 'acme', `curl -H 'Referer: https://slack.com/api/chat.postMessage' https://api.example.com/v1/x`],
        // A base URL a variable holds is judged where the line uses it.
        ['a read on a base URL a variable named for Slack holds', 'acme', `SLACK_API=https://slack.com/api; curl "$SLACK_API/conversations.list"`],
        ['a read on a base URL another variable holds', 'acme', `S=https://slack.com/api; curl -G "\${S%/}/conversations.history" --data-urlencode channel=C1`],
        ['a base URL the line sets and never sends to', 'acme', `S=https://slack.com/api; echo "$S"`],
        ['a read on a base URL ending in a slash, joined with no slash', 'acme', `S=https://slack.com/api/; curl "\${S}conversations.list"`],
        ['a read joined to a base a variable named for Slack holds', 'acme', `SLACK_API=https://slack.com/api/; curl "\${SLACK_API}conversations.list"`],
        // Text nothing runs or sends: a pattern, a printed string, a document or JSON a heredoc writes, another program's argument.
        ['a grep pattern that names the Slack API', 'acme', `grep -n "slack.com/api" notes.sh | head -20`],
        ['an rg pattern for a write URL', 'acme', `rg 'slack\\.com/api/chat\\.postMessage' src/`],
        ['echo\'s argument naming a write URL', 'acme', `echo "post with curl https://slack.com/api/chat.postMessage"`],
        ['printf writing a write URL to a file the line never runs', 'acme', `printf '%s\\n' 'https://slack.com/api/chat.postMessage' > notes.txt`],
        ['JSON a heredoc writes that names a write URL', 'acme', `cat > claims.json <<'EOF'\n{"slack": {"ref": "readable with curl https://slack.com/api/chat.postMessage"}}\nEOF`],
        ['a prompt a heredoc pipes through a wrapper to another program', 'acme', `{ cat brief.md; cat <<'EOF'\nPost with curl https://slack.com/api/chat.postMessage\nEOF\n} | timeout 600 review-cli run`],
        ['a prompt file a heredoc writes and another program reads', 'acme', `cat > prompt.md <<EOF\nPost with curl https://slack.com/api/chat.postMessage\nEOF\ntimeout 600 review-cli run < prompt.md`],
        ['a heredoc in a substitution inside another program\'s argument', 'acme', `notes-cli add --text "$(cat <<'EOF'\nPost with curl https://slack.com/api/chat.postMessage\nEOF\n)"`],
        ['a document that names the API with a placeholder method', 'acme', `cat > notes.md <<'EOF'\nRead Slack with curl https://slack.com/api/<method> and no auth header.\nEOF`],
        ['an ellipsis where the method goes, in a program\'s text', 'acme', `python3 - <<'EOF'\nimport json\njson.dump({"ref": "readable with curl https://slack.com/api/... and no auth"}, open("claims.json", "w"))\nEOF`],
    ] as Array<[string, string | undefined, string]>)('%s is allowed', (_label, workgroup, command) => {
        expect(verdict(command, workgroup)).toBe('allow');
    });
});

// A token of its issuer's shape, built here so no whole token is written in the source.
const random = (n: number) => 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(4).slice(0, n);
const issued = (prefix: string) => prefix.startsWith('xoxe') ? `${prefix}1-${random(40)}`
    : prefix.startsWith('xox') ? `${prefix}1234567890-0987654321-${random(24)}`
    : prefix === 'github_pat_' ? `${prefix}${random(22)}_${random(59)}` : prefix === 'glpat-' ? prefix + random(20) : prefix + random(36);

describe('a Slack post that writes out a credential', () => {
    test.each([
        ['a user token in a form field', 'acme', `curl -s -X POST https://slack.com/api/chat.postMessage -d token=${issued('xoxp-')} -d channel=C1 -d text=hi`],
        ['a user token in the query', 'acme', `curl -s -X POST "https://slack.com/api/chat.postMessage?token=${issued('xoxp-')}&channel=C1&text=hi"`],
        ['a bot token in a JSON body', 'acme', `curl -s -X POST https://slack.com/api/chat.postMessage --json '{"token":"${issued('xoxb-')}","channel":"C1","text":"hi"}'`],
        ['a bearer token in a post', 'acme', `curl -s -X POST https://slack.com/api/chat.postMessage -H 'Authorization: Bearer xoxp-0000-0000-EXAMPLE' -d @payload.json`],
        ['a bearer token in a post under a listed identity', undefined, `onecli run --agent ag-acme -- curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer xoxb-0000-EXAMPLE" -d @payload.json`],
        ['an app configuration token, which the credential reader counts like any other header value', 'acme', `curl -s https://slack.com/api/apps.manifest.update -H 'Authorization: Bearer xoxe.xoxp-1-EXAMPLE' -d app_id=A1`],
    ] as Array<[string, string | undefined, string]>)('%s is refused with fixed text and no card', (_label, workgroup, command) => {
        const v = evaluateSlackPost(command, workgroup, { nanoclaw: true });
        expect([v.action, v.deny, v.summary, v.sendParts]).toEqual(['gate', LITERAL_CREDENTIAL_REASON, undefined, undefined]);
    });

    test.each([
        ['a token in the message text of a payload file', () => JSON.stringify({ channel: 'C1', text: `use ${issued('xoxb-')}` })],
        ['a token in another field of a payload file', () => JSON.stringify({ channel: 'C1', text: 'Numbers are in.', token: issued('xoxp-') })],
        ['a token in a Markdown code span in a payload file', () => JSON.stringify({ channel: 'C1', text: `use \`${issued('xoxb-')}\`` })],
    ] as Array<[string, () => string]>)('%s is refused with fixed text and no card', (_label, payload) => {
        const cwd = mkdtempSync(join(dir, 'cred-'));
        writeFileSync(join(cwd, 'payload.json'), payload());
        const v = evaluateSlackPost(`curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @payload.json`, 'acme', { cwd, nanoclaw: true });
        expect([v.action, v.deny, v.summary, v.sendParts]).toEqual(['gate', LITERAL_CREDENTIAL_REASON, undefined, undefined]);
    });

    test('a token the JSON escapes spell out in the message text is refused with fixed text and no card', () => {
        const escaped = JSON.stringify({ channel: 'C1', text: `use ${issued('xoxb-')}` }).replace('xoxb-', '\\' + 'u0078oxb-');
        const v = evaluateSlackPost(`curl https://slack.com/api/chat.postMessage --json '${escaped}'`, 'acme', { nanoclaw: true });
        expect([v.action, v.deny, v.summary, v.sendParts]).toEqual(['gate', LITERAL_CREDENTIAL_REASON, undefined, undefined]);
    });

    test('a write joined to a base a variable named for Slack holds is one call, decided at its use', () => {
        const v = evaluateSlackPost(`SLACK_API=https://slack.com/api/; curl -X POST "\${SLACK_API}chat.postMessage" -d text=hi`, 'acme', { nanoclaw: true });
        expect([v.action, v.deny, v.label]).toEqual(['gate', undefined, 'Slack post in your name (chat.postMessage)']);
        expect(v.summary).not.toContain('more than one Slack call');
    });

    test.each([
        'Add an X-API-Key header to the request.',
        'Set the Authorization: header to your token.',
        'Authorization: OAuth2/OIDC only. API keys are disabled.',
        'debug output:\nX-API-Key: 7f3a9c2e5b1d4f6a8c0e2b4d',
        'the call sent Authorization: Bearer 7f3a9c2e5b1d4f6a8c0e2b4d and failed',
        'send `X-API-Key: 7f3a9c2e5b1d4f6a8c0e2b4d` with the request',
    ])('message text with a header and no issuer-shaped token gets its card, with the text exactly: %j', (text) => {
        const cwd = mkdtempSync(join(dir, 'prose-'));
        writeFileSync(join(cwd, 'payload.json'), JSON.stringify({ channel: 'C1', text }));
        const v = evaluateSlackPost(`curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @payload.json`, 'acme', { cwd, nanoclaw: true });
        expect([v.action, v.deny, v.sendParts]).toEqual(['gate', undefined, [text]]);
    });

    test('message text that names a credential option still gets its card, with the text', () => {
        const cwd = mkdtempSync(join(dir, 'prose-'));
        writeFileSync(join(cwd, 'payload.json'), JSON.stringify({ channel: 'C1', text: 'The --api-key flag is optional.' }));
        const v = evaluateSlackPost(`curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @payload.json`, 'acme', { cwd, nanoclaw: true });
        expect([v.action, v.deny, v.sendParts]).toEqual(['gate', undefined, ['The --api-key flag is optional.']]);
    });

    test('message text that names the token prefix still gets a card', () => {
        const v = evaluateSlackPost(`curl -s -X POST https://slack.com/api/chat.postMessage -d channel=C1 -d 'text=Paste your xoxp- token, the one that looks like xoxp-…'`, 'acme', { nanoclaw: true });
        expect([v.action, v.deny]).toEqual(['gate', undefined]);
    });

    test('a token held in a variable still gets a card', () => {
        const v = evaluateSlackPost(`curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_TOKEN" -d @payload.json`, 'acme', { nanoclaw: true });
        expect([v.action, v.deny]).toEqual(['gate', undefined]);
        expect(v.summary).toContain('The agent wants to post');
    });
});

test('a post under a Slack user token says so on its card', () => {
    const v = evaluateSlackPost(`curl -H "Authorization: Bearer $SLACK_USER_TOKEN" -d text=hi https://slack.com/api/chat.postMessage`, 'other', { nanoclaw: false });
    expect(v.summary).toContain('to Slack as you, with a Slack user token the line sends');
});

describe('a post made as a listed OneCLI identity', () => {
    const AS_AGENT = `onecli run --agent ag-acme -- ${POST}`;
    const withScope = (scope: unknown, run: () => void) => {
        const file = join(dir, `scope-${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(file, JSON.stringify(scope));
        process.env[SEND_SCOPE_FILE_ENV] = file;
        try {
            run();
        } finally {
            process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
        }
    };

    // With no person mapping, NanoClaw can't tell whose identity a post uses, so the group's sender sees it on the card.
    test.each([
        ['named with --agent', AS_AGENT],
        ['held in a variable the line sets', `A=ag-acme; onecli run --agent "$A" -- ${POST}`],
        ['held in a variable the line does not set', `onecli run --agent "$AGENT" -- ${POST}`],
    ])('in NanoClaw with no person mapping, a post as an identity %s gets a card naming it', (_label, command) => {
        const v = evaluateSlackPost(command, 'acme', { nanoclaw: true });
        expect(v.action).toBe('gate');
        expect(v.deny).toBeUndefined();
        expect(v.summary).toContain('through the OneCLI identity');
    });

    test.each([
        ['the workgroup maps to another person refuses', { slack: { workgroups: [{ id: 'acme', person: 'pat' }], onecliAgents: [{ id: 'ag-acme', person: 'lee' }] } }, 'refuse'],
        ['the workgroup maps to nobody gets a card', { slack: { workgroups: ['acme'], onecliAgents: [{ id: 'ag-acme', person: 'lee' }] } }, 'card'],
        ['the workgroup maps to the same person gets a card', { slack: { workgroups: [{ id: 'acme', person: 'pat' }], onecliAgents: [{ id: 'ag-acme', person: 'pat' }] } }, 'card'],
    ] as Array<[string, unknown, string]>)('in NanoClaw, a post as an identity mapped to a person when %s', (_label, scope, outcome) => {
        withScope(scope, () => {
            const v = evaluateSlackPost(AS_AGENT, 'acme', { nanoclaw: true });
            expect(v.action).toBe('gate');
            if (outcome === 'refuse') expect(v.deny).toContain("someone other than this group's sender");
            else expect(v.deny).toBeUndefined();
        });
    });

    test.each([
        ['the scope maps to the operator', { slack: { onecliAgents: [{ id: 'ag-acme', person: 'pat' }], operator: 'pat' } }],
        ['the scope maps to nobody', { slack: { onecliAgents: [{ id: 'ag-other', person: 'lee' }, 'ag-acme'], operator: 'pat' } }],
        ['an old-format scope lists', { slack: { workgroups: ['acme'], onecliAgents: ['ag-acme'] } }],
    ])('at a terminal, a post as an identity %s asks its operator', (_label, scope) => {
        withScope(scope, () => {
            const v = evaluateSlackPost(AS_AGENT, undefined, { nanoclaw: false });
            expect(v.deny).toBeUndefined();
            expect(v.summary).toContain('post this to Slack as you, through the OneCLI identity `ag-acme`');
        });
    });

    test.each([
        ['mapped to another person', AS_AGENT, { slack: { onecliAgents: [{ id: 'ag-acme', person: 'lee' }], operator: 'pat' } }],
        ['mapped to a person while the scope names no operator', AS_AGENT, { slack: { onecliAgents: [{ id: 'ag-acme', person: 'lee' }] } }],
        ['a script names alone, mapped to another person', `python3 -c "import subprocess; subprocess.run(['onecli','run','--agent','ag-lee','--','curl','https://slack.com/api/chat.postMessage','-d','text=hi'])"`, { slack: { onecliAgents: [{ id: 'ag-lee', person: 'lee' }], operator: 'pat' } }],
        ['a statement before the post sets, mapped to another person', `AGENT=ag-lee; onecli run --agent "$AGENT" -- ${POST}`, { slack: { onecliAgents: [{ id: 'ag-lee', person: 'lee' }], operator: 'pat' } }],
        ['an && chain sets ahead of the post, mapped to another person', `AGENT=ag-lee && onecli run --agent "$AGENT" -- ${POST}`, { slack: { onecliAgents: [{ id: 'ag-lee', person: 'lee' }], operator: 'pat' } }],
    ] as Array<[string, string, unknown]>)('at a terminal, a post as an identity %s is refused', (_label, command, scope) => {
        withScope(scope, () => {
            const v = evaluateSlackPost(command, undefined, { nanoclaw: false });
            expect(v.action).toBe('gate');
            expect(v.deny).toContain("maps to someone other than this terminal's operator");
        });
    });

    test('in NanoClaw a session-identity post after a listed identity\'s read gets a card, not that identity\'s refusal', () => {
        const v = evaluateSlackPost(`onecli run --agent ag-acme -- curl -s https://slack.com/api/conversations.list; ${POST}`, 'acme', { nanoclaw: true });
        expect(v.action).toBe('gate');
        expect(v.deny).toBeUndefined();
        expect(v.summary).toContain('wants to post to Slack as you (');
    });

    test('at a terminal, two posts refuse when the second is another person\'s, though the first is the operator\'s', () => {
        withScope({ slack: { onecliAgents: [{ id: 'ag-acme', person: 'pat' }, { id: 'ag-lee', person: 'lee' }], operator: 'pat' } }, () => {
            const v = evaluateSlackPost(`${AS_AGENT}; onecli run --agent ag-lee -- ${POST}`, undefined, { nanoclaw: false });
            expect(v.deny).toContain('posts as the OneCLI identity `ag-lee`');
        });
    });

    // An unresolved selector, or one of several a script names, can't be pinned on another person, so its operator judges it.
    test.each([
        ['the line doesn\'t fix, though another person\'s is listed', `onecli run --agent "$AGENT" -- ${POST}`],
        // Bash expands the selector before a command's own assignments apply, so only a statement that ran first fixes it.
        ['the line sets only as the command\'s prefix', `AGENT=ag-lee onecli run --agent "$AGENT" -- ${POST}`],
        ['env sets only for onecli', `env AGENT=ag-lee onecli run --agent "$AGENT" -- ${POST}`],
        ['the line sets only if an earlier step succeeds', `cd /tmp && AGENT=ag-lee; onecli run --agent "$AGENT" -- ${POST}`],
        ['the line sets only after the post', `onecli run --agent "$AGENT" -- ${POST}; AGENT=ag-lee`],
        ['the line sets in a subshell', `(AGENT=ag-lee); onecli run --agent "$AGENT" -- ${POST}`],
        ['a loop sets after the line assigns', `AGENT=ag-lee; for AGENT in ag-acme; do onecli run --agent "$AGENT" -- ${POST}; done`],
        ['the line also sets from another variable', `AGENT=ag-lee; AGENT="$OTHER"; onecli run --agent "$AGENT" -- ${POST}`],
        ['a script names beside another', `python3 -c "import subprocess; subprocess.run(['onecli','run','--agent','ag-acme','--','curl','https://slack.com/api/chat.postMessage','-d','text=hi']); subprocess.run(['onecli','run','--agent','ag-lee','--','curl','-s','https://slack.com/api/conversations.list'])"`],
    ])('at a terminal, a post as an identity %s asks', (_label, command) => {
        withScope({ slack: { onecliAgents: [{ id: 'ag-acme', person: 'pat' }, { id: 'ag-lee', person: 'lee' }], operator: 'pat' } }, () => {
            const v = evaluateSlackPost(command, undefined, { nanoclaw: false });
            expect(v.action).toBe('gate');
            expect(v.deny).toBeUndefined();
        });
    });

    test('at a terminal, a post as an identity the line doesn\'t fix asks while no other person is mapped', () => {
        const v = evaluateSlackPost(`onecli run --agent "$AGENT" -- ${POST}`, undefined, { nanoclaw: false });
        expect(v.deny).toBeUndefined();
        expect(v.summary).toContain('through the OneCLI identity in `$AGENT`');
    });

    test('the gate request marks text rendered from blocks as flattened', () => {
        const staged = JSON.parse(gateRequestContent('gate-1', 'Slack post in your name (chat.postMessage)', 's', POST, 'request_send_gate', { sendParts: ['• Report is live'], textFlattened: true }));
        expect(staged).toMatchObject({ sendParts: ['• Report is live'], textFlattened: true });
    });

    test('the gate request hands the host the post kind and its text', () => {
        const staged = JSON.parse(gateRequestContent('gate-1', 'Slack post in your name (chat.postMessage)', 's', POST, 'request_send_gate', { sendParts: ['Numbers are in.'] }));
        expect(staged).toEqual({
            action: 'request_send_gate',
            requestId: 'gate-1',
            label: 'Slack post in your name (chat.postMessage)',
            summary: 's',
            command: POST,
            sendParts: ['Numbers are in.'],
        });
    });
});

describe('the message a card shows', () => {
    const shown = (command: string, cwd?: string, nanoclaw = true) => evaluateSlackPost(command, 'acme', { cwd, nanoclaw });
    const inDir = (files: Record<string, string>, run: (cwd: string) => void) => {
        const cwd = mkdtempSync(join(dir, 'post-'));
        for (const [name, text] of Object.entries(files)) {
            mkdirSync(join(cwd, name, '..'), { recursive: true });
            writeFileSync(join(cwd, name), text);
        }
        run(cwd);
    };
    const MESSAGE = JSON.stringify({ channel: 'C1', text: 'Numbers are in.' });
    const SEND = `curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @payload.json`;

    test.each([
        ['a lone JSON post', POST, ['Numbers are in.']],
        ['a lone post through curl -q', `curl -q -s https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"Numbers are in."}'`, ['Numbers are in.']],
        ['a --json body', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"a\\nb"}'`, ['a\nb']],
        ['a post that names its URL with --url', `curl -q --url https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"Numbers are in."}'`, ['Numbers are in.']],
        ['a post whose text names a Slack API URL', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"See https://slack.com/api/chat.update"}'`, ['See https://slack.com/api/chat.update']],
    ] as Array<[string, string, string[]]>)('%s shows its text and hands it to the host', (_label, command, parts) => {
        const v = shown(command);
        expect(v.summary).toContain(`> ${parts[0].split('\n')[0]}`);
        expect(v.sendParts).toEqual(parts);
        expect(v.textFlattened).toBeUndefined();
    });

    test('a post followed by a call to another host shows its text', () => {
        const v = shown(`${POST} > resp.json; curl -s https://api.example.com/v1/notify`);
        expect(v.summary).toContain('> Numbers are in.');
        expect(v.sendParts).toBeUndefined();
    });

    test('a post read back after it shows its text', () => {
        const v = shown(`${POST} > resp.json; curl -s 'https://slack.com/api/conversations.replies?channel=C1&ts=1'`);
        expect(v.summary).toContain('> Numbers are in.');
    });

    test('a post beside another command shows its text, but offers none to the host', () => {
        const v = shown(`cd /tmp && ${POST}`);
        expect(v.summary).toContain('> Numbers are in.');
        expect(v.sendParts).toBeUndefined();
    });

    test.each([
        ['a body before a second request', `curl https://api.example.com/v1/x --json @first.json --next https://slack.com/api/chat.postMessage ${BODY}`, 'more than one request'],
        ['a Slack read before the post', `curl -s 'https://slack.com/api/conversations.replies?channel=C1&ts=1'; ${POST}`, 'a Slack call runs before the post'],
        ['a second write after the post', `${POST}; curl -s https://slack.com/api/chat.update -d channel=C1 -d ts=1 -d text=x`, 'more than one Slack call'],
        ['a form field', `curl https://slack.com/api/chat.postMessage -d channel=C1 -d 'text=hello%20there'`, 'no body, or more than one'],
        ['a body holding a variable', `curl https://slack.com/api/chat.postMessage --data "{\"channel\":\"C1\",\"text\":\"$T\"}"`, 'only known when it runs'],
        ['a Host header', `curl https://slack.com/api/chat.postMessage -H 'Host: example.com' ${BODY}`, 'request method or host'],
        ['blocks beside the text', `curl https://slack.com/api/chat.postMessage --json '{"channel":"C1","text":"ok","blocks":[{"type":"image"}]}'`, 'single-quoted Slack message'],
        ['a method the shell fills in', `curl -s "https://slack.com/api/$M" -d text=hi`, 'the shell fills in the method'],
        ['a file share', `curl -F file=@a.png https://slack.com/api/files.upload`, 'only for chat.postMessage and chat.update'],
        ['a command that runs first and may add a curl config', `printf 'next\\n' >> ~/.curlrc; ${POST}`, 'another command runs before the post'],
    ])('%s: message text not shown', (_label, command, reason) => {
        const v = shown(command);
        expect(v.action).toBe('gate');
        expect(v.summary).toContain('Message text not shown');
        expect(v.summary).toContain(reason);
        expect(v.sendParts).toBeUndefined();
    });

    test('a curlrc that can add requests: message text not shown', () => {
        const rc = join(process.env.HOME!, '.curlrc');
        writeFileSync(rc, 'url = "https://slack.com/api/chat.postMessage"\n');
        try {
            const v = shown(POST);
            expect(v.summary).toContain('Message text not shown');
            expect(v.summary).toContain('.curlrc');
        } finally {
            rmSync(rc);
        }
    });

    test.each([
        ['--data @file', SEND],
        ['a -d cluster', `curl -sSd @payload.json -H 'Content-Type: application/json' https://slack.com/api/chat.postMessage`],
        ['--data-binary', `curl -s --data-binary @payload.json -H 'Content-Type: application/json' https://slack.com/api/chat.postMessage`],
    ])('a payload file sent with %s shows its text, bound to the file', (_label, command) => {
        inDir({ 'payload.json': MESSAGE }, cwd => {
            const v = shown(command, cwd);
            expect(v.summary).toContain('read from `payload.json`');
            expect(v.summary).toContain('> Numbers are in.');
            expect(v.sendParts).toEqual(['Numbers are in.']);
            expect(v.payload).toMatchObject({ path: join(cwd, 'payload.json'), real: realpathSync(join(cwd, 'payload.json')) });
        });
    });

    describe('the destination', () => {
        // Conversation ids of Slack's shape, built here so no whole id is written in the source.
        const DM = 'D' + '0123ABCDE';
        const CHANNEL = 'C' + '0123ABCDE';
        const receipt = (v: ReturnType<typeof shown>) => gateReceiptOf(gateRequestContent('gate-1', v.label!, v.summary!, SEND, 'request_send_gate', { sendParts: v.sendParts }));
        const post = (fields: Record<string, unknown>) => {
            let v: ReturnType<typeof shown> | undefined;
            inDir({ 'payload.json': JSON.stringify({ text: 'Numbers are in.', ...fields }) }, cwd => { v = shown(SEND, cwd); });
            return v!;
        };

        test('the same text to a direct message and to a channel are different approvals', () => {
            const dm = post({ channel: DM });
            const channel = post({ channel: CHANNEL });
            expect(dm.sendParts).toEqual(['Numbers are in.', `channel=${DM}`]);
            expect(channel.sendParts).toEqual(['Numbers are in.', `channel=${CHANNEL}`]);
            expect(dm.summary).toContain(`Destination: the direct message \`${DM}\`.`);
            expect(channel.summary).toContain(`Destination: the channel \`${CHANNEL}\`.`);
            expect(receipt(dm)).not.toBe(receipt(channel));
        });

        test('a reply binds its thread', () => {
            const reply = post({ channel: CHANNEL, thread_ts: '1700000000.000100' });
            const top = post({ channel: CHANNEL });
            expect(reply.sendParts).toEqual(['Numbers are in.', `channel=${CHANNEL}`, 'thread_ts=1700000000.000100']);
            expect(reply.summary).toContain(`Destination: the channel \`${CHANNEL}\`, in the thread \`1700000000.000100\`.`);
            expect(receipt(reply)).not.toBe(receipt(top));
        });

        test('a channel name the payload gives is shown and bound', () => {
            const v = post({ channel: '#general' });
            expect(v.sendParts).toEqual(['Numbers are in.', 'channel=#general']);
            expect(v.summary).toContain('Destination: the channel `#general`.');
        });

        test('a channel the payload holds as a variable is not shown, and nothing binds it', () => {
            const v = post({ channel: '$SLACK_CHANNEL' });
            expect(v.summary).toContain("Destination not shown: the payload's channel `$SLACK_CHANNEL` is not a channel id or name.");
            expect(v.sendParts).toEqual(['Numbers are in.']);
        });

        test('a payload the guard cannot read shows no destination either', () => {
            let v: ReturnType<typeof shown> | undefined;
            inDir({}, cwd => { v = shown(SEND, cwd); });
            expect(v!.summary).toContain('Destination not shown, for the same reason.');
            expect(v!.sendParts).toBeUndefined();
        });
    });

    test('a payload in a directory an &&-chain cds to is read from there', () => {
        inDir({ 'out/payload.json': JSON.stringify({ channel: 'C1', text: 'From the subdirectory.' }) }, cwd => {
            expect(shown(`cd out && ${SEND}`, cwd).summary).toContain('> From the subdirectory.');
        });
    });

    test('a payload file holding blocks it can\'t render: message text not shown', () => {
        inDir({ 'payload.json': JSON.stringify({ channel: 'C1', text: 'ok', blocks: [{ type: 'image', image_url: 'https://example.com/a.png', alt_text: 'a' }] }) }, cwd => {
            const v = shown(SEND, cwd);
            expect(v.summary).toContain('Message text not shown: `payload.json` holds blocks or attachments');
            expect(v.payload).toBeUndefined();
        });
    });

    test.each([
        ['after a cd that may not run', `cd out; ${SEND}`, 'a cd that may not run'],
        ['written earlier on the line', `jq . draft.json > payload.json; ${SEND}`, 'another command runs before the post'],
        ['written later on the line', `${SEND}; jq . draft.json > payload.json`, 'also names `payload.json`'],
        ['written by a program run first', `python3 build.py && ${SEND}`, 'another command runs before the post'],
        ['copied over by a glob first', `cp new.json pay*.json; ${SEND}`, 'another command runs before the post'],
        ['outside NanoClaw, which does not check it again', SEND, 'outside NanoClaw'],
        ['missing', `curl -s https://slack.com/api/chat.postMessage --data @missing.json`, 'is missing'],
        ['through a path that climbs with ..', `curl -s https://slack.com/api/chat.postMessage --data @out/../payload.json`, 'climbs with'],
    ])('a payload file %s: message text not shown', (label, command, reason) => {
        inDir({ 'payload.json': MESSAGE, 'out/payload.json': MESSAGE }, cwd => {
            const v = shown(command, cwd, !label.startsWith('outside'));
            expect(v.summary).toContain('Message text not shown');
            expect(v.summary).toContain(reason);
            expect(v.payload).toBeUndefined();
        });
    });

    // Each line is given the post as `post`, so bash can run the same line with `true` in its place.
    const WRITTEN: Array<[string, (post: string) => string, string]> = [
        ['a quoted heredoc', post => `cat > payload.json <<'EOF'\n${MESSAGE}\nEOF\n${post}`, `${MESSAGE}\n`],
        ['a quoted heredoc chained to the post', post => `cat > payload.json <<'EOF' && ${post}\n${MESSAGE}\nEOF`, `${MESSAGE}\n`],
        ['a printf of a literal argument', post => `printf '%s\\n' '${MESSAGE}' > payload.json; ${post}`, `${MESSAGE}\n`],
        ['a printf of a literal format', post => `printf '${MESSAGE}' > payload.json; ${post}`, MESSAGE],
        ['a heredoc in a directory an &&-chain cds to', post => `cd out && cat > payload.json <<'EOF' && ${post}\n${MESSAGE}\nEOF`, `${MESSAGE}\n`],
    ];

    test.each(WRITTEN)('a payload the line writes with %s shows that text, bound to what bash writes', (label, line, text) => {
        inDir({ 'out/keep.txt': '' }, cwd => {
            const v = shown(line(SEND), cwd);
            expect(v.summary).toContain('(the line writes it to `payload.json` before posting)');
            expect(v.summary).toContain('> Numbers are in.');
            const file = join(realpathSync(cwd), label.includes('cds to') ? 'out' : '', 'payload.json');
            expect(v.payload).toMatchObject({ real: file, written: true, sha256: createHash('sha256').update(text).digest('hex') });
            const ran = Bun.spawnSync(['bash', '-c', line('true')], { cwd, env: { PATH: '/usr/bin:/bin' } });
            expect(ran.exitCode).toBe(0);
            expect(createHash('sha256').update(readFileSync(file, 'utf-8')).digest('hex')).toBe(v.payload!.sha256);
        });
    });

    test.each([
        ['an unquoted heredoc', `cat > payload.json <<EOF\n${MESSAGE}\nEOF\n${SEND}`, 'another command runs before the post'],
        ['a printf directive that takes an argument', `printf '{"channel":"C1","text":"%d"}' 5 > payload.json; ${SEND}`, 'another command runs before the post'],
        ['a printf of a variable', `printf '%s' "$MSG" > payload.json; ${SEND}`, 'another command runs before the post'],
        ['a printf with an argument left over', `printf '%s' '${MESSAGE}' extra > payload.json; ${SEND}`, 'another command runs before the post'],
        ['an append', `printf '%s' '${MESSAGE}' >> payload.json; ${SEND}`, 'another command runs before the post'],
        ['a heredoc to another file', `cat > draft.json <<'EOF'\n${MESSAGE}\nEOF\n${SEND}`, 'another command runs before the post'],
        ['a heredoc to the same name in another directory', `cat > out/payload.json <<'EOF'\n${MESSAGE}\nEOF\n${SEND}`, 'another command runs before the post'],
        ['a write in the background', `cat > payload.json <<'EOF' &\n${MESSAGE}\nEOF\n${SEND}`, 'may not run, or runs beside the post'],
        ['a write the post runs after only if it fails', `cat > payload.json <<'EOF' || ${SEND}\n${MESSAGE}\nEOF`, 'may not run, or runs beside the post'],
        ['a write piped into the post', `cat > payload.json <<'EOF' | ${SEND}\n${MESSAGE}\nEOF`, 'may not run, or runs beside the post'],
    ])('a payload written by %s: message text not shown', (_label, command, reason) => {
        inDir({ 'out/keep.txt': '' }, cwd => {
            const v = shown(command, cwd);
            expect(v.summary).toContain('Message text not shown');
            expect(v.summary).toContain(reason);
            expect(v.payload).toBeUndefined();
        });
    });

    test('a post captured in a substitution and read back after shows its text', () => {
        inDir({ 'payload.json': MESSAGE }, cwd => {
            const post = `curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @${cwd}/payload.json`;
            const v = shown(`R=$(${post}); echo "$R" | jq .ok; TS=$(echo "$R" | jq -r .ts); curl -s "https://slack.com/api/conversations.replies?channel=C1&ts=$TS"`, cwd);
            expect(v.summary).toContain('> Numbers are in.');
        });
    });

    test('a post in a substitution beside a command that writes its payload first: message text not shown', () => {
        inDir({ 'payload.json': MESSAGE }, cwd => {
            const post = `curl -s https://slack.com/api/chat.postMessage -H 'Content-Type: application/json' --data @${cwd}/payload.json`;
            const v = shown(`R=$(jq -c . draft.json > ${cwd}/payload.json; ${post}); echo "$R"`, cwd);
            expect(v.summary).toContain('Message text not shown: another command runs before the post');
        });
    });

    test('a payload the line writes over a file holding other text: message text not shown', () => {
        inDir({ 'payload.json': JSON.stringify({ channel: 'C1', text: 'An older draft.' }) }, cwd => {
            const v = shown(`cat > payload.json <<'EOF'\n${MESSAGE}\nEOF\n${SEND}`, cwd);
            expect(v.summary).toContain('Message text not shown: `payload.json` already holds other text');
            expect(v.payload).toBeUndefined();
        });
    });

    test('an ordered list that starts later keeps its numbers', () => {
        const blocks = [{ type: 'rich_text', elements: [
            { type: 'rich_text_list', style: 'ordered', indent: 0, offset: 2, elements: [
                { type: 'rich_text_section', elements: [{ type: 'text', text: 'Third step' }] },
                { type: 'rich_text_section', elements: [{ type: 'text', text: 'Fourth step' }] },
            ] },
        ] }];
        inDir({ 'payload.json': JSON.stringify({ channel: 'C1', text: 'Third step Fourth step', blocks }) }, cwd => {
            const v = shown(SEND, cwd);
            expect(v.summary).toContain('> 3. Third step\n> 4. Fourth step');
            expect(v.sendParts).toEqual(['3. Third step\n4. Fourth step']);
        });
    });

    test('a long message says how much of it the card shows', () => {
        inDir({ 'payload.json': JSON.stringify({ channel: 'C1', text: 'x'.repeat(1500) }) }, cwd => {
            expect(shown(SEND, cwd).summary).toContain('Text truncated: the first 1000 of 1500 characters are shown.');
        });
    });

    test('blocks show as the text a reader sees, beside a notification text that differs', () => {
        const blocks = [{ type: 'rich_text', elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Two updates for ' }, { type: 'user', user_id: 'U1' }, { type: 'text', text: ':\n' }] },
            { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [
                { type: 'rich_text_section', elements: [{ type: 'text', text: 'Report is live' }] },
                { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.com/r', text: 'details' }] },
            ] },
        ] }];
        inDir({ 'payload.json': JSON.stringify({ channel: 'C1', text: 'Something else entirely', blocks }) }, cwd => {
            const v = shown(SEND, cwd);
            expect(v.summary).toContain('Two updates for ‹@U1>:');
            expect(v.summary).toContain('> • Report is live');
            expect(v.summary).toContain('> • details (https://example.com/r)');
            expect(v.summary).toContain('Message text (formatting simplified):\n> Two updates for');
            expect(v.summary).toContain('Notification text (shown in alerts and search):\n> Something else entirely');
            // A block payload goes to a background card as the text its blocks show.
            expect(v.sendParts).toEqual(['Two updates for <@U1>:\n\n• Report is live\n• details (https://example.com/r)']);
            expect(v.textFlattened).toBe(true);
        });
    });
});

describe('a payload the line writes, checked again when the post is approved', () => {
    test('absent or holding the card\'s text, the post goes ahead; other text, or a link to another file, refuses it', () => {
        const cwd = mkdtempSync(join(dir, 'written-'));
        const text = '{"channel":"C1","text":"Numbers are in."}\n';
        const path = join(cwd, 'payload.json');
        const binding = { path, real: join(realpathSync(cwd), 'payload.json'), sha256: createHash('sha256').update(text).digest('hex'), written: true };
        expect(payloadChangedSince(binding)).toBeNull();
        writeFileSync(path, text);
        expect(payloadChangedSince(binding)).toBeNull();
        writeFileSync(path, '{"channel":"C1","text":"Something else."}\n');
        expect(payloadChangedSince(binding)).toContain('changed after the card showed it');
        rmSync(path);
        writeFileSync(join(cwd, 'elsewhere.json'), text);
        symlinkSync(join(cwd, 'elsewhere.json'), path);
        expect(payloadChangedSince(binding)).toContain('changed after the card showed it');
    });
});

describe('send-scope files', () => {
    const withScope = (file: string, run: () => void) => {
        process.env[SEND_SCOPE_FILE_ENV] = file;
        try {
            run();
        } finally {
            process.env[SEND_SCOPE_FILE_ENV] = scopeFile;
        }
    };

    test('no file lists no identity', () => {
        withScope(join(dir, 'missing.json'), () => expect(verdict(POST, 'acme')).toBe('allow'));
    });

    test('a malformed file lists every identity', () => {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"slack": ');
        withScope(broken, () => expect(verdict(POST, 'other')).toBe('gate'));
    });

    test('a file that loops back on itself lists every identity', () => {
        const loop = join(dir, 'loop.json');
        symlinkSync(loop, loop);
        withScope(loop, () => expect(verdict(POST, 'other')).toBe('gate'));
    });

    // Root reads through any directory mode, so there the directory can't be made unreadable.
    test.skipIf(process.getuid?.() === 0)('a file in a directory the guard may not enter lists every identity', () => {
        const locked = join(dir, 'locked');
        mkdirSync(locked);
        const file = join(locked, 'send-scope.local.json');
        writeFileSync(file, JSON.stringify({ slack: { workgroups: ['acme'] } }));
        chmodSync(locked, 0o000);
        try {
            expect(() => readFileSync(file)).toThrow(/EACCES/);
            withScope(file, () => expect(verdict(POST, 'other')).toBe('gate'));
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    test.each([
        [{ slack: { workgroups: ['acme'] } }, true],
        [{ slack: { onecliAgents: ['ag-1'] } }, true],
        [{ slack: { workgroups: 'acme' } }, false],
        [{ slack: [{ workgroups: ['acme'] }] }, false],
        [{ slack: { workgroups: ['has space'] } }, false],
        [{ slack: { onecliAgents: ['ag-1', { id: 'ag-2', person: 'lee' }], operator: 'pat' } }, true],
        [{ slack: { onecliAgents: [{ id: 'ag-2' }] } }, false],
        [{ slack: { onecliAgents: [{ id: 'ag-2', person: 'has space' }] } }, false],
        [{ slack: { onecliAgents: [{ id: 'ag-2', person: 'lee', role: 'x' }] } }, false],
        [{ slack: { onecliAgents: ['ag-1'], operator: ['pat'] } }, false],
        [{}, false],
    ])('%j parses: %p', (scope, ok) => {
        expect(parseSendScope(JSON.stringify(scope)) !== null).toBe(ok);
    });
});
