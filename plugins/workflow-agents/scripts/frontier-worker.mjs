#!/usr/bin/env node
/** Foreground frontier CLI fallback. Prompt in stdin; native JSON events out. */
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EFFORTS = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  codex: new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
};
const MODELS = {
  claude: { default: 'claude-fable-5-1[1m]', allowed: new Set(['claude-fable-5-1[1m]', 'claude-fable-5-1', 'claude-opus-5[1m]', 'claude-opus-5']) },
  codex: { default: 'gpt-6-astra', allowed: new Set(['gpt-6-astra', 'gpt-5.6-sol']) },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKER_CONTEXT = 'You are the assigned premium technical worker, not the coordinator. Own the following task through investigation, technical design, implementation, relevant verification and fixes. Follow repository rules and the task scope. Do not launch another orchestration layer or delegate unless the user explicitly requests it. Return concise results with evidence and any unresolved limits. The original task follows unchanged.\n\n';

export function invocation(argv, inheritedEnv = process.env) {
  const options = {};
  const allowed = new Set(['runtime', 'cwd', 'effort', 'model', 'resume', 'timeout-seconds', 'human-directed-ultra']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : '';
    const value = argv[i + 1];
    if (!allowed.has(key) || key in options || !value || value.startsWith('--')) {
      throw new Error(`Invalid or duplicate option: ${argv[i]}`);
    }
    options[key] = value;
  }
  const runtime = options.runtime;
  if (!EFFORTS[runtime]) throw new Error('--runtime must be claude or codex');
  const effort = options.effort ?? 'medium';
  if (!EFFORTS[runtime].has(effort)) throw new Error(`Unsupported ${runtime} effort: ${effort}`);
  const humanDirectedUltra = options['human-directed-ultra'];
  if (humanDirectedUltra !== undefined && humanDirectedUltra !== 'true') {
    throw new Error('--human-directed-ultra must be true when supplied');
  }
  if (effort === 'ultra' && !(runtime === 'codex' && humanDirectedUltra === 'true')) {
    throw new Error('Codex ultra requires direct human direction and --human-directed-ultra true');
  }
  if (effort !== 'ultra' && humanDirectedUltra !== undefined) {
    throw new Error('--human-directed-ultra is valid only with --effort ultra');
  }
  const model = options.model ?? MODELS[runtime].default;
  if (!MODELS[runtime].allowed.has(model)) throw new Error(`Unsupported ${runtime} worker model: ${model}`);
  if (!options.cwd) throw new Error('--cwd is required');
  const cwd = realpathSync(options.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error('--cwd must name a directory');
  if (options.resume && !UUID.test(options.resume)) {
    throw new Error('--resume requires the exact recorded session UUID, never a name or --last');
  }
  const seconds = Number(options['timeout-seconds'] ?? 3600);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('--timeout-seconds must be an integer from 1 to 3600');
  }
  const env = { ...inheritedEnv };
  let args;
  if (runtime === 'claude') {
    // Claude frontmatter overrides --effort, but this per-process variable overrides frontmatter.
    // https://code.claude.com/docs/en/model-config#set-the-effort-level
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    args = ['-p', '--model', model, '--effort', effort,
      '--output-format', 'stream-json', '--verbose'];
    if (options.resume) args.push('--resume', options.resume);
  } else {
    args = ['exec', '--model', model, '-c', `model_reasoning_effort="${effort}"`,
      '--json'];
    if (options.resume) args.push('resume', options.resume);
    args.push('-');
  }
  return { command: runtime, args, cwd, env, timeoutMs: seconds * 1000 };
}

export function run(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'inherit', 'inherit'], shell: false,
      // Own a POSIX process group so cancellation reaches tools started by the CLI.
      // The child stays foreground-supervised: streams attached, awaited, never unref'd.
      detached: process.platform !== 'win32',
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') console.error(`frontier-worker stdin: ${error.message}`);
    });
    child.stdin.write(WORKER_CONTEXT);
    process.stdin.pipe(child.stdin);
    let interruptedCode;
    let killTimer;
    const signalTree = signal => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill(signal));
      } else {
        try { process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const stop = (signal, code) => {
      if (interruptedCode !== undefined) return;
      interruptedCode = code;
      signalTree(signal);
      killTimer = setTimeout(() => signalTree('SIGKILL'), 5000);
      killTimer.unref();
    };
    const onInt = () => stop('SIGINT', 130);
    const onTerm = () => stop('SIGTERM', 143);
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const timer = setTimeout(() => {
      console.error('frontier-worker: worker timed out; session may be resumed by its recorded ID');
      stop('SIGTERM', 124);
    }, spec.timeoutMs);
    child.once('error', (error) => {
      console.error(`frontier-worker: ${error.message}`);
    });
    child.once('close', (code, signal) => {
      // A CLI may exit on TERM while one of its tools ignores TERM. Do not abandon that tool.
      if (interruptedCode !== undefined) signalTree('SIGKILL');
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(interruptedCode ?? code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node frontier-worker.mjs --runtime claude|codex --cwd DIR [--effort medium] [--model MODEL] [--resume UUID] [--timeout-seconds 3600]\nAutonomous efforts: low, medium, high, xhigh, max. Codex ultra requires a direct current human instruction and --human-directed-ultra true. Default workers: Fable 5.1 / GPT-6 Astra. Approved worker floor: Fable or Opus on Claude; Astra or Sol on Codex. Prompt: stdin. Results and session IDs: native JSON events on stdout. Resume only this helper\'s own CLI UUID, never a native subagent handle. Keep transport, exact model, effort and session ID in run.md. This helper adds no sandbox or approval bypass.');
  } else {
    try {
      process.exitCode = await run(invocation(process.argv.slice(2)));
    } catch (error) {
      console.error(`frontier-worker: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
