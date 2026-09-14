import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Claude adapter wiring: drives guards/dispatch-first.ts as Claude Code does
// (stdin JSON in, exit code + stdout JSON / stderr out) against a transcript
// fixture on disk. Verdict logic itself is pinned in dispatch-first-core.test.ts.

const HOOK_PATH = join(import.meta.dir, 'dispatch-first.ts');
const SONNET = 'claude-sonnet-5';
const FABLE = 'claude-fable-5-1';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function line(obj: unknown): string {
    return JSON.stringify(obj);
}
function userTurn(): string {
    return line({ type: 'user', message: { role: 'user', content: 'go' } });
}
function investigation(model: string, n: number, withAgent = false): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = `toolu_${++seq}`;
        const content: unknown[] = [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/src/f${i}.ts` } }];
        if (withAgent && i === 0) content.push({ type: 'tool_use', id: `toolu_a${seq}`, name: 'Agent', input: { prompt: 'x' } });
        out.push(line({ type: 'assistant', message: { role: 'assistant', model, content } }));
        out.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
    }
    return out;
}
function writeTranscript(lines: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-first-'));
    roots.push(root);
    const p = join(root, 'transcript.jsonl');
    writeFileSync(p, `${lines.join('\n')}\n`);
    return p;
}

interface HookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    parsed: any;
}

async function runHook(input: unknown, env: Record<string, string> = {}): Promise<HookResult> {
    const proc = Bun.spawn(['bun', 'run', HOOK_PATH], {
        stdin: new Blob([typeof input === 'string' ? input : JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
            ...process.env,
            BOOTSTRAP_DISPATCH_FIRST: '',
            BOOTSTRAP_DISPATCH_FIRST_WARN: '',
            BOOTSTRAP_DISPATCH_FIRST_BLOCK: '',
            ...env,
        },
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stdout, stderr, parsed: stdout.trim() ? JSON.parse(stdout) : undefined };
}

function hookInput(transcript_path: string, extra: Record<string, unknown> = {}) {
    return {
        session_id: 'test',
        cwd: '/tmp/test',
        hook_event_name: 'PreToolUse',
        transcript_path,
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/next.ts' },
        tool_use_id: 'toolu_current',
        ...extra,
    };
}

describe('dispatch-first Claude adapter', () => {
    test('3 prior calls → allowed, no output', async () => {
        const r = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(SONNET, 2)])));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
    });

    test('4th call → allowed with additionalContext and NO permissionDecision', async () => {
        const r = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(SONNET, 3)])));
        expect(r.exitCode).toBe(0);
        expect(r.parsed).toEqual({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: expect.stringMatching(/^GATED: dispatch-first — 4 investigation calls/),
            },
        });
        expect(r.parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
        expect(r.stderr).toContain('[dispatch-first] warn model=claude-sonnet-5 count=4');
        expect(r.stderr).toContain('Read:/repo/src/f0.ts');
    });

    test('9th call → blocked (exit 2, BLOCKED on stderr, counted calls logged)', async () => {
        const r = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(SONNET, 8)])));
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe('');
        expect(r.stderr).toContain('BLOCKED: dispatch-first — 9 investigation calls');
        expect(r.stderr).toContain('[dispatch-first] block model=claude-sonnet-5 count=9');
        expect(r.stderr).toContain('Read:/repo/src/f7.ts');
    });

    test('builder model with 8 prior calls → no-op', async () => {
        const r = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(FABLE, 8)])));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
    });

    test('Agent dispatched this turn → no-op at 8 prior calls', async () => {
        const r = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(SONNET, 8, true)])));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
    });

    test('a logistical Bash call is not counted', async () => {
        const path = writeTranscript([userTurn(), ...investigation(SONNET, 8)]);
        const r = await runHook(hookInput(path, { tool_name: 'Bash', tool_input: { command: 'gh pr view 12 --json headRefOid' } }));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
    });

    test('a subagent (agent_id present) is never gated', async () => {
        const path = writeTranscript([userTurn(), ...investigation(SONNET, 8)]);
        const r = await runHook(hookInput(path, { agent_id: 'abc123' }));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
    });

    test('env: BOOTSTRAP_DISPATCH_FIRST=off disables; _WARN/_BLOCK retune', async () => {
        const path = writeTranscript([userTurn(), ...investigation(SONNET, 8)]);
        const off = await runHook(hookInput(path), { BOOTSTRAP_DISPATCH_FIRST: 'off' });
        expect(off.exitCode).toBe(0);
        expect(off.stdout).toBe('');

        const loose = await runHook(hookInput(path), { BOOTSTRAP_DISPATCH_FIRST_WARN: '20', BOOTSTRAP_DISPATCH_FIRST_BLOCK: '30' });
        expect(loose.exitCode).toBe(0);
        expect(loose.stdout).toBe('');

        const tight = await runHook(hookInput(writeTranscript([userTurn(), ...investigation(SONNET, 1)])), {
            BOOTSTRAP_DISPATCH_FIRST_WARN: '0',
            BOOTSTRAP_DISPATCH_FIRST_BLOCK: '1',
        });
        expect(tight.exitCode).toBe(2);
    });

    test('missing transcript or malformed payload fails OPEN with a logged skip', async () => {
        const missing = await runHook(hookInput('/nonexistent/transcript.jsonl'));
        expect(missing.exitCode).toBe(0);
        expect(missing.stdout).toBe('');

        const malformed = await runHook('{not json');
        expect(malformed.exitCode).toBe(0);
        expect(malformed.stderr).toContain('[dispatch-first] skipped (fail-open)');
    });
});
