import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreshTeamAutoSentinel } from './codex-guard';

const GUARD = join(import.meta.dir, 'codex-guard.ts');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface GuardResult {
  status: number;
  stderr: string;
  output: any;
}

async function runGuard(input: unknown, env: Record<string, string> = {}): Promise<GuardResult> {
  const proc = Bun.spawn(['bun', 'run', GUARD, 'PreToolUse'], {
    stdin: new Blob([typeof input === 'string' ? input : JSON.stringify(input)]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const status = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { status, stderr, output: JSON.parse(stdout) };
}

function shell(command: string | string[]): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { command },
  };
}

function expectDecision(result: GuardResult, decision: 'ask' | 'deny', reason: RegExp): void {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  expect(result.output.hookSpecificOutput?.permissionDecision).toBe(decision);
  expect(result.output.hookSpecificOutput?.permissionDecisionReason).toMatch(reason);
}

describe('Codex local approval transport', () => {
  test('allows safe commands', async () => {
    expect((await runGuard(shell('git status'))).output).toEqual({ continue: true });
  });

  test('asks through the native protocol for destructive commands', async () => {
    expectDecision(await runGuard(shell('terraform destroy')), 'ask', /terraform/i);
  });

  test('denies git mutations inside read-only repo snapshots', async () => {
    expectDecision(
      await runGuard(shell('git -C /workspace/workgroup/APOLLO checkout -b feature')),
      'deny',
      /snapshot/i,
    );
    expect(
      (await runGuard(shell('git -C /workspace/workgroup/.worktrees/shared commit -m x'))).output,
    ).toEqual({ continue: true });
  });

  test('asks through the native protocol for outbound email', async () => {
    expectDecision(
      await runGuard(shell('gws gmail +send --to ops@example.com --subject report')),
      'ask',
      /email send to ops@example.com/i,
    );
  });

  test.each([
    ['send_email', { to: 'ops@example.com', subject: 'Report', body: 'secret body' }],
    ['mcp__gmail__reply_email', { recipient: 'ops@example.com', subject: 'Re: Report' }],
    ['gmail_send_draft_email', { to_email: 'ops@example.com' }],
  ])('asks through the native protocol for %s', async (toolName, toolInput) => {
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
    expectDecision(result, 'ask', /email (?:send|reply) to ops@example.com/i);
    expect(result.output.hookSpecificOutput.permissionDecisionReason).not.toContain('secret body');
  });

  test.each(['gmail_create_draft_reply', 'gmail_search_emails', 'read_email_thread', 'send_message'])(
    'allows non-delivering native tool %s',
    async (toolName) => {
      const result = await runGuard({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: {},
      });
      expect(result.output).toEqual({ continue: true });
    },
  );

  test('allows scheduled native email sends under the existing automation policy', async () => {
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'send_email',
      tool_input: { to: 'ops@example.com' },
    }, { NANOCLAW_IS_SCHEDULED_TASK: '1' });
    expect(result.output).toEqual({ continue: true });
  });

  test('discloses destructive and email effects in one approval', async () => {
    const result = await runGuard(
      shell('terraform destroy && gws gmail +send --to ops@example.com --subject done'),
    );
    expectDecision(result, 'ask', /also requires outbound-email approval/i);
    expect(result.output.hookSpecificOutput.permissionDecisionReason).toContain('ops@example.com');
  });

  test('accepts array-form command inputs', async () => {
    expectDecision(await runGuard(shell(['terraform', 'destroy'])), 'ask', /terraform/i);
  });
});

describe('Codex hard blocks', () => {
  test.each([
    ['touch /tmp/.claude-destructive-gate/abc', /self-approval/i],
    ["python -c 'import snowflake.connector'", /snowflake\.connector/i],
    ['git clone https://github.com/a/b /workspace/agent/b', /managed/i],
    ['rm -rf ~/.agents/skills', /blocked/i],
    ['rm -rf ~/.codex/skills', /blocked/i],
  ])('%s', async (command, reason) => {
    expectDecision(await runGuard(shell(command)), 'deny', reason);
  });

  test('fails closed on malformed hook input', async () => {
    expectDecision(await runGuard('{not-json'), 'deny', /blocked/i);
  });
});

describe('Codex team-auto input guard', () => {
  function teamAutoFixture(): { root: string; sentinel: string } {
    const root = mkdtempSync(join(tmpdir(), 'codex-team-auto-hook-'));
    temporaryRoots.push(root);
    const featureDir = join(root, 'docs', 'specs', 'auth');
    mkdirSync(featureDir, { recursive: true });
    const sentinel = join(featureDir, '.team-auto-active');
    writeFileSync(sentinel, '');
    return { root, sentinel };
  }

  test('denies native user-input requests while a fresh sentinel exists', async () => {
    const { root, sentinel } = teamAutoFixture();
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [] },
      cwd: join(root, 'packages', 'app'),
    });

    expectDecision(result, 'deny', /request_user_input is disabled/i);
    expect(result.output.hookSpecificOutput.permissionDecisionReason).toContain(sentinel);
  });

  test('recognizes namespaced user-input tool names', async () => {
    const { root } = teamAutoFixture();
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'functions.request_user_input',
      tool_input: { questions: [] },
      cwd: root,
    });

    expectDecision(result, 'deny', /team-auto/i);
  });

  test('allows user-input requests only after the sentinel is stale for two hours', async () => {
    const { root, sentinel } = teamAutoFixture();
    const stale = new Date(Date.now() - 121 * 60 * 1000);
    utimesSync(sentinel, stale, stale);

    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [] },
      cwd: root,
    });
    expect(result.output).toEqual({ continue: true });
  });

  test('names run.md and no retired recovery artifacts', async () => {
    const { root } = teamAutoFixture();
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [] },
      cwd: root,
    });

    const reason = result.output.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('docs/specs/<feature>/run.md');
    expect(reason).not.toContain('auto-pause.md');
    expect(reason).not.toContain('decisions.yaml');
  });

  test('allows non-input tools and exposes the sentinel lookup for direct checks', async () => {
    const { root, sentinel } = teamAutoFixture();
    expect(findFreshTeamAutoSentinel(root)).toBe(sentinel);

    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
      cwd: root,
    });
    expect(result.output).toEqual({ continue: true });
  });

  test('supports the explicit debugging bypass', async () => {
    const { root } = teamAutoFixture();
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [] },
      cwd: root,
    }, { SKIP_TEAM_AUTO_ASKBLOCK: '1' });
    expect(result.output).toEqual({ continue: true });
  });
});

describe('Codex protected edits', () => {
  test.each([
    ['apply_patch', { patch: '*** Update File: /workspace/repo/terraform/main.tf\n' }, /terraform\/main\.tf/],
    ['write_file', { path: 'C:\\repo\\infra\\terraform\\prod.tf' }, /infra\\terraform\\prod\.tf/],
    ['write_file', { path: '.env' }, /\.env/],
  ])('blocks %s input', async (toolName, toolInput, reason) => {
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
    });
    expectDecision(result, 'deny', reason);
  });

  test('allows ordinary edits', async () => {
    const result = await runGuard({
      hook_event_name: 'PreToolUse',
      tool_name: 'write_file',
      tool_input: { path: 'src/index.ts' },
    });
    expect(result.output).toEqual({ continue: true });
  });
});
