import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGY_APPROVAL_HANDOFF, decideAgyCall } from './agy-guard';

const GUARD = join(import.meta.dir, 'agy-guard.ts');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), 'agy-guard-'));
    roots.push(root);
    return root;
}

function call(name: string, args: Record<string, unknown>, cwd?: string): unknown {
    return { hookEventName: 'PreToolUse', toolCall: { name, args, id: 'call-1' }, ...(cwd ? { cwd } : {}) };
}

function reasonOf(payload: unknown): string {
    const verdict = decideAgyCall(payload);
    expect(verdict.action).toBe('deny');
    return verdict.action === 'deny' ? verdict.reason : '';
}

describe('agy tool calls reach the shared policy under the names the cores read', () => {
    test.each([
        ['a safe shell command', call('run_command', { CommandLine: 'git status' })],
        ['a source write', call('write_file', { Path: 'src/app.ts', Content: 'x' })],
        ['an MCP call that sends nothing', call('call_mcp_tool', { ServerName: 'docs', ToolName: 'search', Arguments: { q: 'x' } })],
        ['a read-only tool', call('read_file', { Path: 'README.md' })],
        ['a question with no /team-auto run active', call('ask_question', { Question: 'Which branch?' }, tmpdir())],
        ['a subagent with no workspace of its own', call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: 't' })],
    ])('%s is allowed', (_name, payload) => {
        expect(decideAgyCall(payload)).toEqual({ action: 'allow' });
    });

    test('run_command is judged as a shell command, with the local hand-off on an approval-tier one', () => {
        const reason = reasonOf(call('run_command', { CommandLine: 'terraform destroy' }));
        expect(reason).toContain('Destroys every resource this Terraform state manages.');
        expect(reason).toContain(AGY_APPROVAL_HANDOFF);
    });

    test.each([
        ['write_file', { Path: '.env', Content: 'x' }],
        ['edit_file', { Path: '.env', Target: 'a', Replacement: 'b' }],
        ['replace_file_content', { TargetFile: 'pnpm-lock.yaml' }],
    ])('%s reaches file protection', (name, args) => {
        expect(reasonOf(call(name, args))).toMatch(/file-protection/);
    });

    test('call_mcp_tool reaches the email gate as mcp__<server>__<tool>', () => {
        const reason = reasonOf(call('call_mcp_tool', {
            ServerName: 'gmail',
            ToolName: 'send_email',
            Arguments: { to: 'pat@example.com', subject: 'Hi', body: 'Short note.' },
        }));
        expect(reason).toContain('mcp__gmail__send_email');
        expect(reason).toContain(AGY_APPROVAL_HANDOFF);
    });
});

describe('hook configs agy hot-reloads cannot be changed by the agent', () => {
    test.each([
        ['write_file', { Path: '.agents/hooks.json', Content: '{}' }],
        ['write_file', { Path: '/home/example/.gemini/config/hooks.json', Content: '{}' }],
        ['edit_file', { Path: '/etc/antigravity/admin_settings.json', Target: 'a', Replacement: 'b' }],
        ['write_to_file', { TargetFile: 'sub/.agents/plugins.json' }],
    ])('%s %j', (name, args) => {
        expect(reasonOf(call(name, args))).toMatch(/hook-config location/);
    });

    test("relative paths resolve against the session's workspaces, not the directory the hook runs from", () => {
        const root = scratch();
        mkdirSync(join(root, '.agents'));
        symlinkSync(join(root, '.agents'), join(root, 'innocent-dir'));
        const payload = { ...(call('write_file', { Path: 'innocent-dir/hooks.json', Content: '{}' }, '/') as object), workspacePaths: [root] };
        expect(reasonOf(payload)).toMatch(/hook-config location/);
    });

    test('a symlink into .agents is followed, for an existing file and for a new one', () => {
        const root = scratch();
        mkdirSync(join(root, '.agents'));
        writeFileSync(join(root, '.agents', 'hooks.json'), '{}');
        symlinkSync(join(root, '.agents', 'hooks.json'), join(root, 'innocent.json'));
        symlinkSync(join(root, '.agents'), join(root, 'innocent-dir'));
        expect(reasonOf(call('write_file', { Path: 'innocent.json', Content: '{}' }, root))).toMatch(/hook-config location/);
        expect(reasonOf(call('write_file', { Path: 'innocent-dir/new.json', Content: '{}' }, root))).toMatch(/hook-config location/);
    });

    test.each([
        ["echo '{}' > .agents/hooks.json"],
        ['python3 -c "open(\'.gemini/config/hooks.json\', \'w\').write(\'{}\')"'],
        ['cp evil.json ~/.gemini/hooks.json'],
        ['rm -rf /etc/antigravity'],
        ['cat .agents/hooks.json > .agents/backup.json'],
        ['ls 2> .agents/listing.log'],
        ['git diff --output=.agents/review.patch'],
    ])('the shell command %s', (command) => {
        expect(reasonOf(call('run_command', { CommandLine: command }))).toMatch(/hook configs live/);
    });

    test('a shell command run from inside .agents', () => {
        const root = scratch();
        mkdirSync(join(root, '.agents'));
        expect(reasonOf(call('run_command', { CommandLine: 'touch fixture.txt', Cwd: join(root, '.agents') }, root))).toMatch(/hook configs live/);
    });

    test.each([
        ['cat .agents/skills/example/SKILL.md'],
        ['cat ~/.gemini/config/hooks.json | head -n 5'],
        ['git log --oneline -- .agents'],
    ])('a read-only shell command %s is allowed', (command) => {
        expect(decideAgyCall(call('run_command', { CommandLine: command }))).toEqual({ action: 'allow' });
    });
});

describe('calls agy could otherwise use to step around the guard are denied', () => {
    test('a command asking to run outside the sandbox', () => {
        expect(reasonOf(call('run_command', { CommandLine: 'ls', BypassSandbox: true }))).toMatch(/BypassSandbox/);
    });

    test('a subagent workspace other than the session root, nested ones and list entries included', () => {
        const root = scratch();
        mkdirSync(join(root, 'nested'));
        for (const workspace of [tmpdir(), join(root, 'nested'), 'nested']) {
            expect(reasonOf(call('invoke_subagent', { Prompt: 'p', Workspace: workspace }, root))).toMatch(/only work in this session's workspace/);
        }
        const listed = { Subagents: [{ Prompt: 'a', Workspace: root }, { Prompt: 'b', Workspace: tmpdir() }] };
        expect(reasonOf(call('invoke_subagent', listed, root))).toMatch(/only work in this session's workspace/);
        expect(decideAgyCall(call('invoke_subagent', { Subagents: [{ Prompt: 'a', Workspace: root }] }, root))).toEqual({ action: 'allow' });
        expect(decideAgyCall(call('define_subagent', { Workspace: root }, root))).toEqual({ action: 'allow' });
    });

    test('a question while a /team-auto run is active, as the shared policy refuses user input then', () => {
        const root = scratch();
        mkdirSync(join(root, 'docs', 'specs', 'demo'), { recursive: true });
        writeFileSync(join(root, 'docs', 'specs', 'demo', '.team-auto-active'), '');
        expect(reasonOf(call('ask_question', { Question: 'Which branch?' }, root))).toMatch(/team-auto is active/);
        const second = { ...(call('ask_question', { Question: 'Which branch?' }) as object), workspacePaths: [scratch(), root] };
        expect(reasonOf(second)).toMatch(/team-auto is active/);
    });

    test.each([
        ['a tool off the allowlist', call('browser_click_element', {}), /not on this guard's allowlist/],
        ['a payload with no tool', { hookEventName: 'PreToolUse' }, /names no tool/],
        ['a write naming no file', call('write_file', { Content: 'x' }), /names no file/],
        ['a command with no command line', call('run_command', {}), /no command line/],
        ['an MCP call with no server', call('call_mcp_tool', { ToolName: 'search' }), /names no server or tool/],
    ])('%s', (_name, payload, reason) => {
        expect(reasonOf(payload)).toMatch(reason);
    });

    test.each([
        ['null', null],
        ['missing', undefined],
        ['not a string', 7],
    ])('an event name that is %s gets the full checks', (_name, hookEventName) => {
        const sandbox = { hookEventName, toolCall: { name: 'run_command', args: { CommandLine: 'pwd', BypassSandbox: true } } };
        expect(reasonOf(sandbox)).toMatch(/BypassSandbox/);
        const destructive = { hookEventName, toolCall: { name: 'run_command', args: { CommandLine: 'terraform destroy' } } };
        expect(reasonOf(destructive)).toMatch(/Terraform state/);
    });

    test('a named event other than PreToolUse is not this guard\'s to judge', () => {
        expect(decideAgyCall({ hookEventName: 'PostToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'terraform destroy' } } })).toEqual({ action: 'allow' });
    });
});

describe('paths are judged where the filesystem puts them', () => {
    test('a .. after a symlink into .agents lands in .agents, not back in the workspace', () => {
        const root = scratch();
        mkdirSync(join(root, '.agents', 'nested'), { recursive: true });
        symlinkSync(join(root, '.agents', 'nested'), join(root, 'alias'));
        expect(reasonOf(call('write_file', { Path: 'alias/../fixture.txt', Content: 'x' }, root))).toMatch(/hook-config location/);
        expect(reasonOf(call('write_file', { Path: `${root}/alias/../fixture.txt`, Content: 'x' }, root))).toMatch(/hook-config location/);
    });

    test.each([
        ['through a directory link', 'touch alias/hooks.json'],
        ['through a file link', 'cp fixture.json hooks-link'],
        ['as a redirect target', 'printf x | tee alias/plugins.json'],
        ['through a stderr redirect', 'ls 2> hooks-link'],
        ['through a redirect of both streams', 'ls &> hooks-link'],
        ['through another descriptor', 'ls 3> hooks-link'],
        ['through an appending redirect', 'ls >> hooks-link'],
        ['through an appending stderr redirect', 'ls 2>> hooks-link'],
        ['through a read-write redirect', 'ls 4<> hooks-link'],
        ['through a redirect in a subshell', '(ls 2> alias/fixture.log)'],
        ['through a redirect in a command substitution', "printf '%s' \"$(true >> hooks-link)\""],
        ['through a redirect in backticks', 'echo `true 2> hooks-link`'],
        ['through a redirect in a nested command substitution', 'echo "$(echo "$(true 2> hooks-link)")"'],
        ['through a redirect in an output process substitution', 'echo x > >(cat > hooks-link)'],
        ['through a redirect in an input process substitution', 'cat <(true 3> hooks-link)'],
        ['through a subshell\'s own redirect', '(ls) 2> hooks-link'],
        ['through a group\'s own redirect', '{ ls; } > hooks-link'],
        ['through a loop\'s own redirect', 'for i in a; do ls; done 2> hooks-link'],
        ['through a redirect on an if', 'if true; then ls; fi 2>> hooks-link'],
        ['through a redirect on a case', 'case a in a) ls ;; esac &> hooks-link'],
    ])('a shell write %s into .agents is denied', (_name, command) => {
        const root = scratch();
        mkdirSync(join(root, '.agents'));
        writeFileSync(join(root, '.agents', 'hooks.json'), '{}');
        symlinkSync(join(root, '.agents'), join(root, 'alias'));
        symlinkSync(join(root, '.agents', 'hooks.json'), join(root, 'hooks-link'));
        expect(reasonOf(call('run_command', { CommandLine: command }, root))).toMatch(/hook configs live/);
    });

    test('a stderr redirect to /dev/null and a descriptor copy stay allowed', () => {
        const root = scratch();
        expect(decideAgyCall(call('run_command', { CommandLine: 'ls 2> /dev/null >&2' }, root))).toEqual({ action: 'allow' });
    });

    test('a shell write through an ordinary link stays allowed', () => {
        const root = scratch();
        mkdirSync(join(root, 'src'));
        symlinkSync(join(root, 'src'), join(root, 'alias'));
        expect(decideAgyCall(call('run_command', { CommandLine: 'touch alias/app.ts' }, root))).toEqual({ action: 'allow' });
    });

    test('a subagent workspace is compared where it resolves', () => {
        const root = scratch();
        const elsewhere = scratch();
        mkdirSync(join(elsewhere, 'nested'));
        symlinkSync(join(elsewhere, 'nested'), join(root, 'alias'));
        symlinkSync(root, join(elsewhere, 'root-link'));
        expect(reasonOf(call('invoke_subagent', { Prompt: 'p', Workspace: `${root}/alias/..` }, root))).toMatch(/only work in this session's workspace/);
        expect(decideAgyCall(call('invoke_subagent', { Prompt: 'p', Workspace: join(elsewhere, 'root-link') }, root))).toEqual({ action: 'allow' });
    });
});

describe('input is never sent to a running task', () => {
    test.each([
        ['list', { Action: 'list' }],
        ['status', { Action: 'status', TaskId: 't1' }],
        ['kill', { Action: 'kill', TaskId: 't1' }],
        ['status with an empty input', { Action: 'status', TaskId: 't1', Input: '' }],
    ])('%s is allowed', (_name, args) => {
        expect(decideAgyCall(call('manage_task', args))).toEqual({ action: 'allow' });
    });

    test.each([
        ['send_input of a safe command', { Action: 'send_input', TaskId: 't1', Input: 'git status\n' }, /send_input is not allowed.*cannot know which directory/],
        ['send_input that would touch a file in a task already in .agents', { Action: 'send_input', TaskId: 't1', Input: 'touch fixture.txt\n' }, /send_input is not allowed/],
        ['an approval-tier command', { Action: 'send_input', TaskId: 't1', Input: 'terraform destroy\n' }, /send_input is not allowed/],
        ['a write to a hook config', { Action: 'send_input', TaskId: 't1', Input: "echo '{}' > .agents/hooks.json\n" }, /send_input is not allowed/],
        ['no input', { Action: 'send_input', TaskId: 't1' }, /send_input is not allowed/],
        ['an action the guard does not know', { Action: 'restart', TaskId: 't1' }, /not one this guard can check/],
        ['a read action carrying input', { Action: 'status', TaskId: 't1', Input: 'rm -rf build\n' }, /not one this guard can check/],
    ])('%s is denied', (_name, args, reason) => {
        expect(reasonOf(call('manage_task', args))).toMatch(reason);
    });
});

describe('MCP tool names reach the email gate in the token form it reads', () => {
    test.each([['sendEmail'], ['SendEmail'], ['sendHTMLEmail']])('gmail %s gates as a send', (tool) => {
        const reason = reasonOf(call('call_mcp_tool', {
            ServerName: 'gmail',
            ToolName: tool,
            Arguments: { to: 'pat@example.com', subject: 'Hi', body: 'Short note.' },
        }));
        expect(reason).toContain(AGY_APPROVAL_HANDOFF);
    });

    test.each([
        ['gmail', 'send_message'],
        ['Gmail', 'send_message'],
        ['GMail', 'send_message'],
        ['workspace', 'GMail_send'],
        ['MyEmail', 'send'],
        ['MyGMail', 'send_message'],
        ['workspace', 'GMailAPISend'],
        ['workspace', 'sendGmail'],
        ['workspace', 'GMAIL_SEND'],
        ['workspace', 'EMailSend'],
    ])('server %s, tool %s gates as a send, whether its word is found split or as written', (server, tool) => {
        const reason = reasonOf(call('call_mcp_tool', {
            ServerName: server,
            ToolName: tool,
            Arguments: { to: 'pat@example.com', subject: 'Hi', body: 'Short note.' },
        }));
        expect(reason).toContain('Email send to pat@example.com');
        expect(reason).toContain(AGY_APPROVAL_HANDOFF);
    });

    test('a draft tool still passes', () => {
        expect(decideAgyCall(call('call_mcp_tool', { ServerName: 'gmail', ToolName: 'createDraft', Arguments: {} }))).toEqual({ action: 'allow' });
    });
});

describe('any BypassSandbox value but false is a request to leave the sandbox', () => {
    test.each([[true], ['true'], [1], ['yes'], [null]])('%j is denied', (value) => {
        expect(reasonOf(call('run_command', { CommandLine: 'pwd', BypassSandbox: value }))).toMatch(/BypassSandbox/);
    });

    test('false is allowed', () => {
        expect(decideAgyCall(call('run_command', { CommandLine: 'pwd', BypassSandbox: false }))).toEqual({ action: 'allow' });
    });
});

describe('the adapter answers agy on stdout with an explicit decision', () => {
    async function run(stdin: string): Promise<{ status: number; stdout: string }> {
        const proc = Bun.spawn(['bun', GUARD], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
        const status = await proc.exited;
        return { status, stdout: await new Response(proc.stdout).text() };
    }

    test('allow', async () => {
        expect(await run(JSON.stringify(call('run_command', { CommandLine: 'git status' })))).toEqual({ status: 0, stdout: '{"decision":"allow"}' });
    });

    test.each([
        ['a deny', JSON.stringify(call('run_command', { CommandLine: 'ls', BypassSandbox: true })), /BypassSandbox/],
        ['input that is not JSON', 'not json {', /failed closed/],
        ['empty input', '', /not a JSON object/],
    ])('%s', async (_name, stdin, reason) => {
        const result = await run(stdin);
        expect(result.status).toBe(0);
        const reply = JSON.parse(result.stdout);
        expect(reply.decision).toBe('deny');
        expect(reply.reason).toMatch(reason);
    });

    test('a gate reason holding a lone surrogate leaves as a well-formed string', async () => {
        const subject = 'Hi ' + String.fromCharCode(0xD800) + ' there';
        const result = await run(JSON.stringify(call('call_mcp_tool', {
            ServerName: 'gmail', ToolName: 'send_email', Arguments: { to: 'pat@example.com', subject, body: 'Short note.' },
        })));
        const reply = JSON.parse(result.stdout);
        expect(reply.decision).toBe('deny');
        expect(reply.reason).toContain('Email send to pat@example.com');
        expect(reply.reason.isWellFormed()).toBe(true);
    });
});
