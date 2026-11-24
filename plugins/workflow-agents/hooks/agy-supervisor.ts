#!/usr/bin/env bun
/**
 * Runs agy-guard.ts for one agy PreToolUse call and prints exactly one reply. agy runs the tool on empty output and
 * its handling of anything but a decision is not something to rely on, so a crash, a non-zero exit, output that is
 * not a decision, a stall past the deadline and a cancel all become a deny. The guard runs in its own process group,
 * so nothing it starts outlives the reply or keeps agy's pipes open. Only builtins are imported: after the wrapper's
 * exec there is no shell left to deny if a module fails to load.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeSync } from 'node:fs';
import { join } from 'node:path';

/** Above the guard's one-hour approval wait, below the 3660 s timeout agy's registration sets for this hook. */
export const WATCHDOG_SECONDS = 3630;
const MINIMUM_BUN = [1, 3, 3];
/** What a shell reads at startup; the guard's children must not inherit a caller's. */
const SHELL_STARTUP_VARIABLES = ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE'];

export type Reply = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** A plain release number at or above 1.3.3, the first bun that honours --no-env-file (older ones ignore the flag). */
export function bunSupported(version: string): boolean {
    const parts = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version)?.slice(1).map(Number);
    if (!parts) return false;
    for (let i = 0; i < MINIMUM_BUN.length; i += 1) {
        if (parts[i] !== MINIMUM_BUN[i]) return parts[i] > MINIMUM_BUN[i];
    }
    return true;
}

/** The guard's output as agy's decision, or null unless it is exactly one decision of that shape in valid UTF-8. */
export function replyOf(output: Uint8Array): Reply | null {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    const keys = Object.keys(fields).sort().join(',');
    if (fields.decision === 'allow' && keys === 'decision') return { decision: 'allow' };
    if (fields.decision === 'deny' && typeof fields.reason === 'string' && keys === 'decision,reason') {
        return { decision: 'deny', reason: fields.reason.toWellFormed() };
    }
    return null;
}

function denial(reason: string): Reply {
    return { decision: 'deny', reason: `BLOCKED: ${reason}` };
}

const NOT_RUN = 'so the call was not run. Tell the user; do not retry or work around it.';

function main(): void {
    let guard: ChildProcess | undefined;
    let replied = false;
    const stopGuard = () => {
        if (guard?.pid === undefined) return;
        try {
            process.kill(-guard.pid, 'SIGKILL');
        } catch {
            // The group is already gone.
        }
    };
    const reply = (verdict: Reply): void => {
        if (!replied) {
            replied = true;
            stopGuard();
            writeSync(1, JSON.stringify(verdict));
        }
        process.exit(0);
    };

    setTimeout(() => reply(denial(`The tool guard did not finish within ${WATCHDOG_SECONDS} seconds, ${NOT_RUN}`)), WATCHDOG_SECONDS * 1000);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        process.on(signal, () => reply(denial(`The tool guard was cancelled (${signal}), ${NOT_RUN}`)));
    }

    try {
        if (!bunSupported(Bun.version)) {
            reply(denial("bun is older than 1.3.3 or reports a version this guard cannot read, so the guard cannot keep the agent's .env out."));
            return;
        }
        const env = { ...process.env };
        for (const name of SHELL_STARTUP_VARIABLES) delete env[name];
        const child = spawn(process.execPath, ['--no-env-file', '--config=/dev/null', join(import.meta.dir, 'agy-guard.ts'), ...process.argv.slice(2)], {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        guard = child;
        const output: Buffer[] = [];
        child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
        child.stdin!.on('error', () => {});
        process.stdin.pipe(child.stdin!);
        child.on('error', (error) => reply(denial(`The tool guard could not start (${error.message}), ${NOT_RUN}`)));
        // Whatever the guard left running would hold its pipes open; its exit ends them.
        child.on('exit', stopGuard);
        child.on('close', (code, signal) => {
            const verdict = code === 0 ? replyOf(Buffer.concat(output)) : null;
            reply(verdict ?? denial(`The tool guard did not finish with a decision (exit ${code ?? signal}), ${NOT_RUN}`));
        });
    } catch (error) {
        reply(denial(`The tool guard failed to start (${error instanceof Error ? error.message : String(error)}), ${NOT_RUN}`));
    }
}

if (import.meta.main) main();
