import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGY_APPROVAL_HANDOFF, BUILT_IN_SUBAGENTS, decideAgyCall } from './agy-guard';

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
        ['a shell write to an ordinary file', call('run_command', { CommandLine: 'echo note > notes.txt' })],
        ['a source write', call('write_file', { Path: 'src/app.ts', Content: 'x' })],
        ['an MCP call that sends nothing', call('call_mcp_tool', { ServerName: 'docs', ToolName: 'search', Arguments: { q: 'x' } })],
        ['a read-only tool', call('read_file', { Path: 'README.md' })],
        ['a question with no /team-auto run active', call('ask_question', { Question: 'Which branch?' }, tmpdir())],
        ['a subagent with no workspace of its own', call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: 'self' })],
        ['an image saved under a plain name', call('generate_image', { Prompt: 'a red circle', ImageName: 'red_circle', AspectRatio: '1:1' })],
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
        ['run_command', { CommandLine: 'echo EXAMPLE=1 > .env' }],
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

    test('a .agents link protects the directory it points to, named by its own path', () => {
        const root = scratch();
        const real = scratch();
        const other = scratch();
        symlinkSync(real, join(root, '.agents'));
        expect(reasonOf(call('write_file', { Path: join(real, 'hooks.json'), Content: '{}' }, root))).toMatch(/hook-config location/);
        expect(reasonOf(call('run_command', { CommandLine: `printf '{}' > ${join(real, 'hooks.json')}` }, root))).toMatch(/where hook configs live/);
        expect(reasonOf(call('edit_file', { Path: join(real, 'hooks.json'), Target: 'a', Replacement: 'b' }, root))).toMatch(/hook-config location/);
        expect(decideAgyCall(call('write_file', { Path: join(other, 'hooks.json'), Content: '{}' }, root))).toEqual({ action: 'allow' });
    });

    test('a shell write that only names a hook-config path, with a redirect elsewhere, is denied as for .agents itself', () => {
        const root = scratch();
        const real = scratch();
        symlinkSync(real, join(root, '.agents'));
        expect(reasonOf(call('run_command', { CommandLine: "printf '%s' .agents/hooks.json > notes.txt" }, root))).toMatch(/where hook configs live/);
        expect(reasonOf(call('run_command', { CommandLine: `printf '%s' ${join(real, 'hooks.json')} > notes.txt` }, root))).toMatch(/where hook configs live/);
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
        ['an image name that is a path', call('generate_image', { Prompt: 'p', ImageName: '../../config/hooks.json' }), /plain file name/],
        ['reference images that are not a list of paths', call('generate_image', { Prompt: 'p', ImagePaths: 'ref.png' }), /not a list of file paths/],
        ['a reference image path that is not a string', call('generate_image', { Prompt: 'p', ImagePaths: ['ref.png', 7] }), /not a list of file paths/],
        ['a workflow script, whose Python effects reach no hook', call('run_workflow', { Description: 'd', Script: 'print(1)' }), /'run_workflow' is not on this guard's allowlist/],
        ['killing a swarm worker, which deletes its checkout', call('swarm', { action: 'kill', name: 'probe' }), /'swarm' is not on this guard's allowlist/],
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

describe('a subagent that does not inherit customizations would run without these hooks, so it is denied', () => {
    function agentDef(dir: string, file: string, frontmatter: string): void {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n# System Prompt\nWrite what you are asked to.\n`);
    }
    function invoke(root: string, typeName: string): unknown {
        return { ...(call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: typeName }) as object), workspacePaths: [root] };
    }
    function homeAndRoot(): { home: string; root: string } {
        return { home: scratch(), root: scratch() };
    }

    test.each([
        ['inheritCustomizations', false], ['inheritCustomizations', 'false'], ['inheritCustomizations', 0], ['inheritCustomizations', null],
        ['inheritCustomizations', 'no'], ['InheritCustomizations', false], ['inherit_customizations', false],
        ['inheritScopes', 'none'], ['inheritScopes', 'repo_and_org'], ['inheritScopes', null],
    ])('define_subagent with %s %j', (key, value) => {
        const args = { Name: 'helper', Description: 'd', SystemPrompt: 's', EnableWriteTools: true, [key]: value };
        expect(reasonOf(call('define_subagent', args))).toMatch(/define_subagent sets inherit(Customizations|Scopes)/);
    });

    test.each([
        ['inheritCustomizations true', { inheritCustomizations: true }],
        ['inheritScopes all', { inheritScopes: 'all' }],
        ['neither', {}],
        ['a key that only an object prototype has', { constructor: false, toString: 0 }],
    ])('define_subagent with %s is allowed', (_name, extra) => {
        const args = { Name: 'helper', Description: 'd', SystemPrompt: 's', EnableWriteTools: true, ...extra };
        expect(decideAgyCall(call('define_subagent', args))).toEqual({ action: 'allow' });
    });

    test.each([
        ['a workspace agent file', 'workspace', 'writer.md', 'name: writer\ninheritCustomizations: false'],
        ['a workspace agent directory', 'workspace', 'writer/agent.md', 'name: writer\ninheritCustomizations: false'],
        ['a global agent file', 'home', 'writer.md', 'name: writer\ninheritCustomizations: false'],
        ['a global agent directory', 'home', 'writer/agent.md', 'name: writer\ninheritScopes: none'],
        ['a definition whose name differs from its file', 'workspace', 'other.md', 'name: writer\ninheritCustomizations: "false"'],
    ])('invoke_subagent of an agent defined by %s', (_name, where, file, frontmatter) => {
        const { home, root } = homeAndRoot();
        const dir = where === 'home' ? join(home, '.gemini', 'config', 'agents') : join(root, '.agents', 'agents');
        agentDef(dir, file, frontmatter);
        const verdict = decideAgyCall(invoke(root, 'writer'), { home });
        expect(verdict.action).toBe('deny');
        expect(verdict.action === 'deny' ? verdict.reason : '').toMatch(/agent 'writer' .* sets inherit(Customizations|Scopes)/);
    });

    test('a definition named only by its file is no match, and is denied as unknown', () => {
        const { home, root } = homeAndRoot();
        agentDef(join(root, '.agents', 'agents'), 'writer.md', 'description: d\ninheritScopes: repo_and_org');
        const verdict = decideAgyCall(invoke(root, 'writer'), { home });
        expect(verdict.action === 'deny' ? verdict.reason : 'allowed').toMatch(/no agent definition named 'writer'/);
    });

    test('invoke_subagent through a Subagents list entry', () => {
        const { home, root } = homeAndRoot();
        agentDef(join(root, '.agents', 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
        const listed = { ...(call('invoke_subagent', { Subagents: [{ Prompt: 'a', TypeName: 'self' }, { Prompt: 'b', TypeName: 'writer' }] }) as object), workspacePaths: [root] };
        const verdict = decideAgyCall(listed, { home });
        expect(verdict.action === 'deny' ? verdict.reason : 'allowed').toMatch(/agent 'writer'/);
    });

    test.each([
        ['no frontmatter', 'Write what you are asked to.\n'],
        ['frontmatter that is not YAML', '---\nname: [writer\n---\n'],
        ['frontmatter that is not a mapping', '---\n- writer\n---\n'],
    ])('a definition with %s fails closed', (_name, text) => {
        const { home, root } = homeAndRoot();
        mkdirSync(join(root, '.agents', 'agents'), { recursive: true });
        writeFileSync(join(root, '.agents', 'agents', 'writer.md'), text);
        const verdict = decideAgyCall(invoke(root, 'writer'), { home });
        expect(verdict.action === 'deny' ? verdict.reason : 'allowed').toMatch(/cannot be read as an agent definition/);
    });

    test.each([
        ['without the field', 'name: writer'],
        ['with inheritCustomizations true', 'name: writer\ninheritCustomizations: true'],
        ['with inheritScopes all', 'name: writer\ninheritScopes: all'],
    ])('invoke_subagent of an agent %s is allowed', (_name, frontmatter) => {
        const { home, root } = homeAndRoot();
        agentDef(join(root, '.agents', 'agents'), 'writer.md', frontmatter);
        agentDef(join(home, '.gemini', 'config', 'agents'), 'writer/agent.md', frontmatter);
        expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
    });

    test('an agent that drops inheritance does not block invoking a different one', () => {
        const { home, root } = homeAndRoot();
        agentDef(join(root, '.agents', 'agents'), 'loner.md', 'name: loner\ninheritCustomizations: false');
        agentDef(join(root, '.agents', 'agents'), 'writer.md', 'name: writer');
        expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
        expect(decideAgyCall(invoke(root, 'self'), { home })).toEqual({ action: 'allow' });
    });

    test('the installed guard reads the global agents of the HOME it runs with', async () => {
        const { home, root } = homeAndRoot();
        agentDef(join(home, '.gemini', 'config', 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
        const proc = Bun.spawn(['bun', GUARD], {
            stdin: new Blob([JSON.stringify(invoke(root, 'writer'))]),
            stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        });
        expect(await proc.exited).toBe(0);
        const reply = JSON.parse(await new Response(proc.stdout).text());
        expect(reply.decision).toBe('deny');
        expect(reply.reason).toMatch(/agent 'writer' .* sets inheritCustomizations/);
    });
});

describe('generate_image uploads its reference images, so each must be an image file reached through no link', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    function edit(root: string, paths: string[]): unknown {
        return { ...(call('generate_image', { Prompt: 'make it blue', ImageName: 'blue_circle', ImagePaths: paths }) as object), workspacePaths: [root] };
    }
    function reason(payload: unknown): string {
        const verdict = decideAgyCall(payload, { home: scratch() });
        return verdict.action === 'deny' ? verdict.reason : 'allowed';
    }

    test('real images of each type, relative or absolute, are allowed', () => {
        const root = scratch();
        mkdirSync(join(root, 'art'));
        writeFileSync(join(root, 'art', 'red.png'), PNG);
        writeFileSync(join(root, 'photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
        writeFileSync(join(root, 'anim.gif'), 'GIF89a\x01\x00');
        writeFileSync(join(root, 'pic.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]));
        expect(reason(edit(root, ['art/red.png', join(root, 'photo.JPG'), 'anim.gif', 'pic.webp']))).toBe('allowed');
    });

    test.each([
        ['a .env file', '.env', 'API_KEY=example\n', /is not a \.png, \.jpg/],
        ['a .json file', 'service-account.json', '{"type": "service_account"}\n', /is not a \.png, \.jpg/],
        ['a text file renamed .png', 'notes.png', 'token=example\n', /does not start with the bytes of a \.png image/],
        ['a png named .jpg', 'swapped.jpg', PNG, /does not start with the bytes of a \.jpg image/],
        ['a file whose extension names an inherited object key', 'creds.constructor', 'token=example\n', /is not a \.png, \.jpg/],
        ['another inherited-key extension', 'creds.__proto__', 'token=example\n', /is not a \.png, \.jpg/],
    ])('%s is refused', (_name, file, content, expected) => {
        const root = scratch();
        writeFileSync(join(root, file), content);
        expect(reason(edit(root, [file]))).toMatch(expected);
    });

    test('a link to an image, an image inside a linked directory, a directory, a missing file and an oversize file are refused', () => {
        const root = scratch();
        const elsewhere = scratch();
        writeFileSync(join(elsewhere, 'red.png'), PNG);
        symlinkSync(join(elsewhere, 'red.png'), join(root, 'linked.png'));
        symlinkSync(elsewhere, join(root, 'linkdir'));
        mkdirSync(join(root, 'folder.png'));
        writeFileSync(join(root, 'huge.png'), PNG);
        truncateSync(join(root, 'huge.png'), 20 * 1024 * 1024 + 1);
        expect(reason(edit(root, ['linked.png']))).toMatch(/'linked\.png' is a link/);
        expect(reason(edit(root, ['linkdir/red.png']))).toMatch(/is reached through a link/);
        expect(reason(edit(root, ['folder.png']))).toMatch(/is not a regular file/);
        expect(reason(edit(root, ['missing.png']))).toMatch(/cannot be opened \(ENOENT\)/);
        expect(reason(edit(root, ['huge.png']))).toMatch(/larger than 20 MiB/);
    });

    test('a named pipe with an image name is refused without waiting for a writer', () => {
        const root = scratch();
        expect(Bun.spawnSync(['mkfifo', join(root, 'pipe.png')]).exitCode).toBe(0);
        expect(reason(edit(root, ['pipe.png']))).toMatch(/'pipe\.png' is not a regular file/);
    }, 5000);
});

describe('invoke_subagent resolves a TypeName to the one definition agy would load', () => {
    function agentDef(dir: string, file: string, frontmatter: string): string {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n# System Prompt\nWrite what you are asked to.\n`);
        return join(dir, file);
    }
    function invoke(root: string, typeName: string): unknown {
        return { ...(call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: typeName }) as object), workspacePaths: [root] };
    }
    function setup(): { home: string; root: string; workspaceAgents: string; globalAgents: string } {
        const home = scratch();
        const root = scratch();
        return { home, root, workspaceAgents: join(root, '.agents', 'agents'), globalAgents: join(home, '.gemini', 'config', 'agents') };
    }
    function reason(payload: unknown, home: string): string {
        const verdict = decideAgyCall(payload, { home });
        return verdict.action === 'deny' ? verdict.reason : 'allowed';
    }

    test.each([['self'], ['research'], ['image-generator']])('the built-in %s is allowed beside an unrelated README and a broken agent file', (builtIn) => {
        const { home, root, workspaceAgents } = setup();
        mkdirSync(workspaceAgents, { recursive: true });
        writeFileSync(join(workspaceAgents, 'README.md'), 'Agents for this repository.\n');
        writeFileSync(join(workspaceAgents, 'broken.md'), '---\nname: [broken\n---\n');
        expect(decideAgyCall(invoke(root, builtIn), { home })).toEqual({ action: 'allow' });
    });

    test('a valid named agent is allowed beside a README and a broken file', () => {
        const { home, root, workspaceAgents } = setup();
        agentDef(workspaceAgents, 'writer.md', 'name: writer');
        writeFileSync(join(workspaceAgents, 'README.md'), 'Agents for this repository.\n');
        writeFileSync(join(workspaceAgents, 'broken.md'), '---\nname: [broken\n---\n');
        expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
    });

    test('a custom name no definition carries is denied', () => {
        const { home, root, workspaceAgents } = setup();
        agentDef(workspaceAgents, 'writer.md', 'name: writer');
        expect(reason(invoke(root, 'reviewer'), home)).toMatch(/no agent definition named 'reviewer'/);
    });

    test('every built-in the capture recorded is allowed with no definition anywhere', () => {
        const { home, root } = setup();
        expect(BUILT_IN_SUBAGENTS.size).toBeGreaterThan(0);
        for (const builtIn of BUILT_IN_SUBAGENTS) expect(decideAgyCall(invoke(root, builtIn), { home })).toEqual({ action: 'allow' });
    });

    test('browser, which agy 1.5.16 does not offer in the container and whose children were never seen reach this hook, is denied without a definition', () => {
        const { home, root } = setup();
        expect(reason(invoke(root, 'browser'), home)).toMatch(/no agent definition named 'browser'/);
    });

    test('a made-up name with no definition anywhere is denied, naming the built-ins and where they came from', () => {
        const { home, root } = setup();
        const text = reason(invoke(root, 'zz-nonexistent-agent'), home);
        expect(text).toMatch(/no agent definition named 'zz-nonexistent-agent'/);
        expect(text).toContain('image-generator');
        expect(text).toMatch(/captured from agy \d+\.\d+\.\d+/);
        expect(text).toContain('agy-builtins-capture.ts');
    });

    test.each([
        ['by file name, which agy does not read', 'writer.md', 'name: author', 'writer'],
        ['with other letter case, which agy does not match', 'writer.md', 'name: Writer', 'writer'],
        ['two directories deep, which agy does not load', 'team/writer/agent.md', 'name: writer', 'writer'],
    ])('a definition reachable only %s is not a match', (_name, file, frontmatter, typeName) => {
        const { home, root, workspaceAgents } = setup();
        agentDef(workspaceAgents, file, frontmatter);
        expect(reason(invoke(root, typeName), home)).toMatch(new RegExp(`no agent definition named '${typeName}'`));
    });

    test('a workspace definition takes precedence over a global one of the same name', () => {
        const { home, root, workspaceAgents, globalAgents } = setup();
        agentDef(workspaceAgents, 'writer.md', 'name: writer\ninheritCustomizations: true');
        agentDef(globalAgents, 'writer.md', 'name: writer\ninheritCustomizations: false');
        expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
        agentDef(workspaceAgents, 'writer.md', 'name: writer\ninheritCustomizations: false');
        agentDef(globalAgents, 'writer.md', 'name: writer');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritCustomizations/);
    });

    test('a definition whose file resolves outside its agents directory is denied', () => {
        const { home, root, workspaceAgents } = setup();
        const elsewhere = agentDef(scratch(), 'writer.md', 'name: writer');
        mkdirSync(workspaceAgents, { recursive: true });
        symlinkSync(elsewhere, join(workspaceAgents, 'writer.md'));
        expect(reason(invoke(root, 'writer'), home)).toMatch(/resolves outside its agents directory/);
    });

    test('a lookup error on the path to the definitions is denied', () => {
        const { home, root } = setup();
        writeFileSync(join(root, '.agents'), 'not a directory');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/cannot be (listed|resolved)/);
        expect(reason(invoke(root, 'self'), home)).toMatch(/cannot be (listed|resolved)/);
    });

    test('a definition agy may read under the requested name but the guard cannot parse is denied', () => {
        const { home, root, workspaceAgents } = setup();
        mkdirSync(workspaceAgents, { recursive: true });
        writeFileSync(join(workspaceAgents, 'writer.md'), '---\nname: writer\ninheritCustomizations: [false\n---\n');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/defines agent 'writer' but cannot be read/);
    });
});

describe('a lookup error on any candidate denies the call, with no fallback to a global definition or a built-in', () => {
    const asRoot = process.getuid?.() === 0;
    function agentDef(dir: string, file: string, frontmatter: string): string {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n# System Prompt\nWrite what you are asked to.\n`);
        return join(dir, file);
    }
    function invoke(root: string, typeName: string): unknown {
        return { ...(call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: typeName }) as object), workspacePaths: [root] };
    }
    function withValidGlobal(): { home: string; root: string; workspaceAgents: string } {
        const home = scratch();
        const root = scratch();
        agentDef(join(home, '.gemini', 'config', 'agents'), 'writer.md', 'name: writer');
        return { home, root, workspaceAgents: join(root, '.agents', 'agents') };
    }
    function reasonWhileLocked(path: string, payload: unknown, home: string): string {
        chmodSync(path, 0o000);
        try {
            const verdict = decideAgyCall(payload, { home });
            return verdict.action === 'deny' ? verdict.reason : 'allowed';
        } finally {
            chmodSync(path, 0o755);
        }
    }

    test.skipIf(asRoot).each([['writer'], ['self'], ['research'], ['browser']])('an unreadable workspace agent file denies %s', (typeName) => {
        const { home, root, workspaceAgents } = withValidGlobal();
        const locked = agentDef(workspaceAgents, 'writer.md', 'name: writer');
        expect(reasonWhileLocked(locked, invoke(root, typeName), home)).toMatch(/cannot be read/);
    });

    test.skipIf(asRoot)('an unreadable <subdir>/agent.md denies the call', () => {
        const { home, root, workspaceAgents } = withValidGlobal();
        const locked = agentDef(workspaceAgents, 'team/agent.md', 'name: writer');
        expect(reasonWhileLocked(locked, invoke(root, 'writer'), home)).toMatch(/cannot be read/);
    });

    test.skipIf(asRoot)('a <subdir> that cannot be listed denies the call', () => {
        const { home, root, workspaceAgents } = withValidGlobal();
        agentDef(workspaceAgents, 'team/agent.md', 'name: writer');
        expect(reasonWhileLocked(join(workspaceAgents, 'team'), invoke(root, 'writer'), home)).toMatch(/cannot be (read|listed|checked)/);
    });

    test('an entry whose link target is missing denies the call', () => {
        const { home, root, workspaceAgents } = withValidGlobal();
        mkdirSync(workspaceAgents, { recursive: true });
        symlinkSync(join(root, 'missing.md'), join(workspaceAgents, 'ghost.md'));
        expect(decideAgyCall(invoke(root, 'writer'), { home }).action).toBe('deny');
    });

    test('a <subdir>/agent.md link whose target is missing denies the call', () => {
        const { home, root, workspaceAgents } = withValidGlobal();
        mkdirSync(join(workspaceAgents, 'team'), { recursive: true });
        symlinkSync(join(root, 'missing.md'), join(workspaceAgents, 'team', 'agent.md'));
        expect(decideAgyCall(invoke(root, 'writer'), { home }).action).toBe('deny');
    });

    test.each([['.agents'], ['.agents/agents']])('a workspace %s link whose target is missing denies the call', (link) => {
        const { home, root } = withValidGlobal();
        mkdirSync(join(root, link, '..'), { recursive: true });
        symlinkSync(join(root, 'missing-dir'), join(root, link));
        expect(decideAgyCall(invoke(root, 'writer'), { home }).action).toBe('deny');
        expect(decideAgyCall(invoke(root, 'self'), { home }).action).toBe('deny');
    });

    test('a global agents directory link whose target is missing denies a built-in', () => {
        const home = scratch();
        const root = scratch();
        mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
        symlinkSync(join(home, 'missing-dir'), join(home, '.gemini', 'config', 'agents'));
        expect(decideAgyCall(invoke(root, 'self'), { home }).action).toBe('deny');
    });

    test('an agents directory that is simply absent under an existing parent denies nothing', () => {
        const home = scratch();
        const root = scratch();
        mkdirSync(join(root, '.agents'), { recursive: true });
        mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
        expect(decideAgyCall(invoke(root, 'self'), { home })).toEqual({ action: 'allow' });
        const linked = scratch();
        mkdirSync(join(linked, 'shared'));
        symlinkSync(join(linked, 'shared'), join(linked, '.agents'));
        expect(decideAgyCall(invoke(linked, 'self'), { home })).toEqual({ action: 'allow' });
    });

    test('a readable README or another agent\'s broken frontmatter still denies nothing', () => {
        const { home, root, workspaceAgents } = withValidGlobal();
        mkdirSync(workspaceAgents, { recursive: true });
        writeFileSync(join(workspaceAgents, 'README.md'), 'Agents for this repository.\n');
        writeFileSync(join(workspaceAgents, 'other.md'), '---\nname: other\ninheritCustomizations: [true\n---\n');
        expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
        expect(decideAgyCall(invoke(root, 'self'), { home })).toEqual({ action: 'allow' });
    });
});

describe('agy reads the .agent, _agents and _agent customization roots the same as .agents', () => {
    function agentDef(dir: string, file: string, frontmatter: string): void {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n# System Prompt\nWrite what you are asked to.\n`);
    }
    function invoke(root: string, typeName: string): unknown {
        return { ...(call('invoke_subagent', { Prompt: 'p', Role: 'r', TypeName: typeName }) as object), workspacePaths: [root] };
    }
    function reason(payload: unknown, home: string): string {
        const verdict = decideAgyCall(payload, { home });
        return verdict.action === 'deny' ? verdict.reason : 'allowed';
    }

    describe.each([['.agent'], ['_agents'], ['_agent']])('%s', (alias) => {
        test('a write_file to its hooks.json is denied', () => {
            expect(reasonOf(call('write_file', { Path: `${alias}/hooks.json`, Content: '{}' }))).toMatch(/hook-config location/);
        });

        test('a shell write to its hooks.json is denied', () => {
            expect(reasonOf(call('run_command', { CommandLine: `mkdir -p ${alias} && printf '{}' > ${alias}/hooks.json` }))).toMatch(/where hook configs live/);
        });

        test('a read-only shell command on it is allowed', () => {
            expect(decideAgyCall(call('run_command', { CommandLine: `cat ${alias}/hooks.json` }))).toEqual({ action: 'allow' });
        });

        test('invoke_subagent of a definition under it that drops inheritance is denied', () => {
            const home = scratch();
            const root = scratch();
            agentDef(join(root, alias, 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
            expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritCustomizations/);
        });

        test('invoke_subagent of a plugin agent under it that drops inheritance is denied', () => {
            const home = scratch();
            const root = scratch();
            agentDef(join(root, alias, 'plugins', 'kit', 'agents'), 'writer.md', 'name: writer\ninheritScopes: none');
            expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritScopes/);
        });

        test('a definition under it that keeps inheritance is allowed', () => {
            const home = scratch();
            const root = scratch();
            agentDef(join(root, alias, 'agents'), 'writer.md', 'name: writer');
            expect(decideAgyCall(invoke(root, 'writer'), { home })).toEqual({ action: 'allow' });
        });
    });

    test('every workspace root is one scope: a clean .agents definition does not hide a bypass in .agent', () => {
        const home = scratch();
        const root = scratch();
        agentDef(join(root, '.agents', 'agents'), 'writer.md', 'name: writer');
        agentDef(join(root, '.agent', 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritCustomizations/);
    });

    test('a global plugin agent that drops inheritance is denied', () => {
        const home = scratch();
        const root = scratch();
        agentDef(join(home, '.gemini', 'config', 'plugins', 'kit', 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritCustomizations/);
    });

    test('a workspace plugin agent under .agents that drops inheritance is denied', () => {
        const home = scratch();
        const root = scratch();
        agentDef(join(root, '.agents', 'plugins', 'kit', 'agents'), 'writer.md', 'name: writer\ninheritCustomizations: false');
        expect(reason(invoke(root, 'writer'), home)).toMatch(/agent 'writer' .* sets inheritCustomizations/);
    });
});

describe('the .agent, _agents and _agent rules apply only at the roots agy loads them from', () => {
    test.each([['docs/_agent/README.md'], ['src/_agents/x.ts'], ['notes/.agent/plan.md']])('write_file to %s, below the root, is allowed', (path) => {
        const root = scratch();
        expect(decideAgyCall(call('write_file', { Path: path, Content: 'x' }, root))).toEqual({ action: 'allow' });
    });

    test.each([['docs/_agent/README.md'], ['src/_agents/x.ts']])('a shell write to %s, below the root, is allowed', (path) => {
        const root = scratch();
        const command = `mkdir -p ${dirname(path)} && printf 'x' > ${path}`;
        expect(decideAgyCall(call('run_command', { CommandLine: command }, root))).toEqual({ action: 'allow' });
    });

    test('a link in a subdirectory that points at the root .agent/ is still a hook-config location', () => {
        const root = scratch();
        mkdirSync(join(root, '.agent'));
        mkdirSync(join(root, 'sub'));
        symlinkSync(join(root, '.agent'), join(root, 'sub', 'cfg'));
        expect(reasonOf(call('write_file', { Path: 'sub/cfg/hooks.json', Content: '{}' }, root))).toMatch(/hook-config location/);
        expect(reasonOf(call('run_command', { CommandLine: "printf '{}' > sub/cfg/hooks.json" }, root))).toMatch(/where hook configs live/);
        expect(reasonOf(call('write_file', { Path: 'docs/../_agent/hooks.json', Content: '{}' }, root))).toMatch(/hook-config location/);
    });

    test("the git top level of the hook's cwd is a root too", () => {
        const repo = scratch();
        mkdirSync(join(repo, '.git'));
        mkdirSync(join(repo, 'pkg'));
        const payload = { ...(call('write_file', { Path: join(repo, '_agents', 'hooks.json'), Content: '{}' }, join(repo, 'pkg')) as object), workspacePaths: [join(repo, 'pkg')] };
        expect(reasonOf(payload)).toMatch(/hook-config location/);
        const below = { ...(call('write_file', { Path: join(repo, 'pkg', 'lib', '_agents', 'x.ts'), Content: 'x' }, join(repo, 'pkg')) as object), workspacePaths: [join(repo, 'pkg')] };
        expect(decideAgyCall(below)).toEqual({ action: 'allow' });
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
