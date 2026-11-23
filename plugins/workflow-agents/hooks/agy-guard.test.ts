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
        ['a command with no command line', call('run_command', {}), /no CommandLine/],
        ['an MCP call with no server', call('call_mcp_tool', { ToolName: 'search' }), /names no server or tool/],
    ])('%s', (_name, payload, reason) => {
        expect(reasonOf(payload)).toMatch(reason);
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
});
