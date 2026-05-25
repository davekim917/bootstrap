#!/usr/bin/env node
/**
 * Agent eval harness — runner CLI.
 *
 *   run.mjs --suite <s> --case <c> --target <t> [--tier smoke|done|release]
 *           [--trials N] [--out <dir>] [--keep]
 *
 * Orchestration (DESIGN.md): load case+target+adapter → materialize fixture →
 * capability preflight (env gap ⇒ ENV_ERROR) → N trials of
 * adapter.run → assertConformant → gate-ordered score → aggregate per tier.
 *
 * Adapter contract (adapters/<name>.mjs default export):
 *   { id, async preflight(target) → {ok, missing[], detail},
 *        async run(target, {input, fixtureDir, timeoutMs}) → NormalizedTranscript }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConformant } from './transcript.mjs';
import { scoreHardGates, VERDICT } from './score.mjs';
import { judgeCase } from './judge.mjs';
import { resolveSkillDir } from './lib.mjs';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(HARNESS_DIR, '..');

// Tier policy (DESIGN.md "Stochasticity"). hardGatesEvery: hard gates must pass
// EVERY trial. semanticMin: fraction of trials meeting the judge threshold.
const TIERS = {
  smoke: { trials: 3, hardGatesEvery: true, semanticMin: null, timeoutMs: 240_000 },
  done: { trials: 5, hardGatesEvery: true, semanticMin: 0.8, timeoutMs: 600_000 },
  release: { trials: 10, hardGatesEvery: true, semanticMin: 0.8, timeoutMs: 600_000 },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        a[key] = next;
        i++;
      } else a[key] = true;
    }
  }
  return a;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Materialize a fresh fixture dir from case.setup.files; returns its path. */
function materializeFixture(truth, outRoot) {
  const dir = fs.mkdtempSync(path.join(outRoot, 'fixture-'));
  for (const f of truth.setup?.files ?? []) {
    const dst = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.content ?? '');
  }
  return dir;
}

/**
 * Provision the skill-under-test from the WORKING TREE into the fixture dir, so
 * every runtime evaluates THIS branch's content via one mechanism (rather than a
 * stale installed plugin, and free of each runtime's discovery quirks — that
 * removes the discovery confound from parity). Returns a loader instruction to
 * prepend to the input, or '' when the suite declares no skill (self-contained
 * cases like tool-smoke). `prefer` routes the baseline (claude → original
 * `workflow/`) vs the ports (codex/opencode → augmented `workflow-codex/`).
 * Throws if a declared skill is absent from the tree (→ ENV_ERROR, never a
 * silent behavioral FAIL).
 */
function provisionSkill(fixtureDir, skillName, prefer) {
  if (!skillName) return '';
  const src = resolveSkillDir(skillName, prefer);
  if (!src) throw new Error(`skill-under-test "${skillName}" not found in plugins tree (prefer=${prefer})`);
  const skillsRoot = path.join(fixtureDir, '.skills');
  fs.cpSync(src, path.join(skillsRoot, skillName), { recursive: true, dereference: true });
  // Skills may link sibling `../shared/*` docs (e.g. codex-workflow-primitives.md).
  // Provision that sibling dir too so the relative link resolves inside the fixture.
  const sharedSrc = path.join(path.dirname(src), 'shared');
  if (fs.existsSync(sharedSrc)) fs.cpSync(sharedSrc, path.join(skillsRoot, 'shared'), { recursive: true, dereference: true });
  return (
    `The \`${skillName}\` skill you must use for this task is at ` +
    `\`.skills/${skillName}/SKILL.md\` (its references/ are alongside it). ` +
    `Read that SKILL.md and follow it exactly, loading any references it directs you to.\n\n---\n\n`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const suite = args.suite;
  // Parity mode: --compare a,b,c runs the suite on each target and tabulates.
  // Single mode: --target t.
  const targets = args.compare ? String(args.compare).split(',').map((s) => s.trim()).filter(Boolean) : args.target ? [args.target] : [];
  if (!suite || targets.length === 0) {
    console.error('usage: run.mjs --suite <s> [--case <c>] (--target <t> | --compare a,b,c) [--tier ...] [--trials N] [--out dir]');
    process.exit(2);
  }

  const suiteDir = path.join(EVALS_DIR, 'suites', suite);
  const caseNames = args.case
    ? [args.case]
    : fs.readdirSync(suiteDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('case-')).map((d) => d.name);

  const outRoot = expandHome(args.out) ?? fs.mkdtempSync(path.join(os.tmpdir(), 'eval-out-'));
  fs.mkdirSync(outRoot, { recursive: true });

  const resultsByTarget = {};
  let anyFail = false;
  for (const targetId of targets) {
    const { results, failed } = await runTarget(targetId, suiteDir, caseNames, args, outRoot);
    resultsByTarget[targetId] = results;
    if (failed) anyFail = true;
  }

  // Parity comparison (DESIGN.md): baseline = first target. Report cross-target
  // verdicts per case; flag any target that regresses vs the baseline.
  if (targets.length > 1) console.log(parityReport(resultsByTarget, caseNames, targets));

  console.log(`\nartifacts: ${outRoot}`);
  process.exit(anyFail ? 1 : 0);
}

/** Run every case of a suite against one target; returns per-case aggregate verdicts. */
async function runTarget(targetId, suiteDir, caseNames, args, outRoot) {
  const targetCfg = loadJson(path.join(HARNESS_DIR, 'targets', `${targetId}.json`));
  targetCfg.env = targetCfg.env ?? {};
  if (targetCfg.env.auth) targetCfg.env.auth = expandHome(targetCfg.env.auth);
  const adapter = (await import(path.join(HARNESS_DIR, 'adapters', `${targetCfg.adapter}.mjs`))).default;
  const provenance = { target: targetCfg.id, adapter: targetCfg.adapter, model: targetCfg.model, when: new Date().toISOString() };
  // The suite declares the skill-under-test (anchors.json `skill`); the target
  // declares which family to draw it from (env.skillSource). Suites without an
  // anchors.json are self-contained (no skill provisioned).
  const anchorsPath = path.join(suiteDir, 'anchors.json');
  const skillUnderTest = fs.existsSync(anchorsPath) ? loadJson(anchorsPath).skill : null;
  const skillSource = targetCfg.env.skillSource ?? (targetCfg.adapter === 'claude' ? 'workflow' : 'workflow-codex');

  const results = {};
  let failed = false;
  for (const caseName of caseNames) {
    const caseDir = path.join(suiteDir, caseName);
    const truth = loadJson(path.join(caseDir, 'truth.json'));
    const tierName = args.tier ?? truth.rubric?.tier ?? 'smoke';
    const tier = { ...TIERS[tierName] };
    if (args.trials !== undefined) {
      // Validate: a positive integer. `--trials 0` would otherwise run zero iterations and
      // the aggregate (hardPasses === tier.trials → 0 === 0) would PASS without executing.
      const n = Number(args.trials);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--trials must be a positive integer (got ${JSON.stringify(args.trials)})`);
        process.exit(2);
      }
      tier.trials = n;
    }
    // Per-target timeout override: runtimes differ in speed (e.g. opencode/Kimi review
    // swarms run ~2× slower than codex and time out at the default tier ceiling). A target
    // may declare env.timeoutMs to raise its own ceiling without inflating it for everyone.
    // Validate first — a malformed value would coerce to NaN and disable the kill timer in
    // sh() (NaN is falsy), letting a run hang indefinitely.
    if (targetCfg.env.timeoutMs != null) {
      const ov = Number(targetCfg.env.timeoutMs);
      if (Number.isFinite(ov) && ov > 0) tier.timeoutMs = Math.max(tier.timeoutMs, ov);
      else console.error(`[warn] ignoring invalid env.timeoutMs for ${targetId}: ${JSON.stringify(targetCfg.env.timeoutMs)}`);
    }
    const input = fs.readFileSync(path.join(caseDir, 'input.md'), 'utf8');

    const pre = await adapter.preflight(targetCfg);
    if (!pre.ok) {
      console.log(report(caseName, tierName, VERDICT.ENV_ERROR, [], provenance, `preflight: ${pre.detail} (missing: ${(pre.missing || []).join(', ')})`));
      results[caseName] = { agg: VERDICT.ENV_ERROR, passes: 0, trials: 0 };
      failed = true;
      continue;
    }

    const trials = [];
    for (let i = 0; i < tier.trials; i++) {
      const fixtureDir = materializeFixture(truth, outRoot);
      let transcript, hardVerdict, gates;
      let semantic = null; // {semanticPass, metrics, evidence} when rubric.judge present
      let semanticPass = null; // null = judge did not run for this trial; else true/false
      try {
        // provisionSkill throws on a missing declared skill → caught as ENV_ERROR below.
        const loader = provisionSkill(fixtureDir, skillUnderTest, skillSource);
        const caseInput = loader + input.replaceAll('{{FIXTURE_DIR}}', fixtureDir);
        transcript = await adapter.run(targetCfg, { input: caseInput, fixtureDir, timeoutMs: tier.timeoutMs });
        assertConformant(transcript, targetCfg.adapter);
        ({ verdict: hardVerdict, gates } = scoreHardGates(truth.rubric, transcript));
        // Gate 2 (semantic) runs only when hard gates passed and the rubric asks for it.
        // It is NOT folded into the per-trial hard verdict — it aggregates as a pass-RATE.
        if (hardVerdict === VERDICT.PASS && truth.rubric?.judge) {
          semantic = await judgeCase({ expect: truth, transcript, rubric: truth.rubric });
          semanticPass = !!semantic.semanticPass;
        }
      } catch (e) {
        hardVerdict = VERDICT.ENV_ERROR;
        gates = [];
        transcript = { error: String(e && e.message ? e.message : e) };
      }
      // Per-trial verdict = the deterministic hard-gate result; semanticPass is reported
      // alongside (the semantic gate is a rate applied at aggregate, not a per-trial pass/fail).
      trials.push({ i, verdict: hardVerdict, semanticPass, gates, semantic, error: transcript.error });
      fs.writeFileSync(path.join(outRoot, `${targetId}.${caseName}.trial${i}.json`), JSON.stringify({ hardVerdict, semanticPass, gates, semantic, transcript }, null, 2));
    }

    // Aggregate per tier (per evals/README.md): HARD gates must PASS every trial; the
    // SEMANTIC pass-RATE — over the trials where the judge actually ran — must clear
    // tier.semanticMin (stochastic-aware; a single judge miss does not fail the run).
    const envErr = trials.some((t) => t.verdict === VERDICT.ENV_ERROR);
    const hardFail = trials.some((t) => t.verdict === VERDICT.FAIL);
    const timeouts = trials.filter((t) => t.verdict === VERDICT.TIMEOUT).length;
    const hardPasses = trials.filter((t) => t.verdict === VERDICT.PASS).length;
    const judged = trials.filter((t) => t.semanticPass !== null);
    const semPasses = judged.filter((t) => t.semanticPass === true).length;
    const semRate = judged.length ? semPasses / judged.length : 1;
    const semOk = tier.semanticMin == null || semRate >= tier.semanticMin;
    let agg;
    if (envErr) agg = VERDICT.ENV_ERROR;
    else if (hardFail) agg = VERDICT.FAIL; // hard gates must pass every trial
    else if (timeouts > 0 && hardPasses + timeouts === tier.trials) agg = VERDICT.TIMEOUT;
    else if (hardPasses === tier.trials) agg = semOk ? VERDICT.PASS : VERDICT.FAIL;
    else agg = VERDICT.FAIL;
    if (agg !== VERDICT.PASS) failed = true;
    results[caseName] = { agg, hardPasses, semRate, trials: tier.trials };
    const note =
      `hard ${hardPasses}/${tier.trials}` +
      (judged.length ? `, semantic ${semPasses}/${judged.length}${tier.semanticMin == null ? '' : ` (min ${tier.semanticMin})`}` : '');
    console.log(report(caseName, tierName, agg, trials, provenance, note));
  }
  return { results, failed };
}

/** Cross-target parity table. Baseline = first target; flag regressions. */
function parityReport(resultsByTarget, caseNames, targets) {
  const baseline = targets[0];
  const lines = ['\n══ PARITY ══  (baseline: ' + baseline + ')'];
  lines.push('case'.padEnd(28) + targets.map((t) => t.padEnd(16)).join(''));
  let regressions = 0;
  for (const c of caseNames) {
    const base = resultsByTarget[baseline]?.[c]?.agg;
    const cells = targets.map((t) => {
      const v = resultsByTarget[t]?.[c]?.agg ?? '—';
      // regression = baseline PASS but this target not PASS
      const reg = t !== baseline && base === VERDICT.PASS && v !== VERDICT.PASS;
      if (reg) regressions++;
      return (reg ? `${v}!` : v).padEnd(16);
    });
    lines.push(c.padEnd(28) + cells.join(''));
  }
  lines.push(regressions === 0 ? '\nparity: OK (no target regresses below baseline)' : `\nparity: ${regressions} REGRESSION(S) vs ${baseline}`);
  return lines.join('\n');
}

function report(caseName, tier, verdict, trials, provenance, note) {
  const lines = [];
  lines.push(`\n━━ ${caseName} [${tier}] → ${verdict} ${note ? `(${note})` : ''}`);
  lines.push(`   ${provenance.adapter}/${provenance.model}`);
  for (const t of trials) {
    const gateStr = (t.gates || []).map((g) => `${g.pass ? '✓' : '✗'} ${g.id}`).join('  ');
    const sem = t.semanticPass == null ? '' : `  sem:${t.semanticPass ? '✓' : '✗'}`;
    lines.push(`   trial ${t.i}: ${t.verdict}${sem}  ${gateStr}${t.error ? `  err=${t.error}` : ''}`);
  }
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
