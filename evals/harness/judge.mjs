/**
 * LLM-as-judge (DESIGN.md "Score" gate 2). Scores SEMANTIC quality only — recall
 * of must-catch findings, false-BUG rate, severity accuracy — where a regex
 * can't decide "did it catch the fanout bug". Deterministic transcript
 * assertions (gate 1, score.mjs) stay separate.
 *
 * The judge is a strict, tool-less `claude -p` call: it sees ONLY the ground
 * truth + the agent's report (it did NOT see the run), and MUST cite evidence —
 * a finding counts as caught only if the report identifies the same issue, and
 * verbosity is not rewarded (listing 20 findings to "cover" 3 fails precision).
 */
import { sh } from './lib.mjs';

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'claude-sonnet-4-6';

function buildPrompt(expect, transcript) {
  const findings = (expect.findings || expect.expect?.findings || []).map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    must_catch: !!f.must_catch,
    where: f.where,
    why: f.rationale,
  }));
  const traps = expect.false_positive_traps || [];
  return [
    'You are a STRICT code-review eval judge. You did NOT watch the run; judge only from the data below.',
    'Score how well the agent REPORT matches the GROUND TRUTH. A truth finding counts as "caught" only if the report identifies the SAME underlying issue (semantic match, not keyword). One reported finding matches at most one truth finding.',
    '',
    'PRECISION — populate "false_bugs" with ONLY reported [BUG]s that are actually false:',
    '  (a) it flags one of the FALSE-POSITIVE TRAPS below (a known non-issue), OR',
    '  (b) it is affirmatively INCORRECT — the described defect does not exist in the code shown, or is vague/duplicative padding.',
    'A reported finding that is a TRUE, distinct, code-grounded issue is NOT a false bug, EVEN IF it is absent from GROUND TRUTH. The truth list enumerates the must-catch issues + traps; it is NOT an exhaustive list of every valid finding. Do not penalize a reviewer for surfacing a real additional issue — that is thoroughness, not imprecision.',
    'SEVERITY has two tiers, split on finding KIND:',
    '  • SECURITY / DATA-CORRECTNESS findings: severity is AUTHORITATIVE — they are unambiguously must-fix. A security/data must-catch finding that the report MISSES *or* reports but DOWNGRADES to [SUGGESTION] is dangerous (it may ship) — list its truth_id in "security_or_data_must_catch_missed" (a downgrade counts the same as a miss).',
    '  • All other kinds (performance, style, maintainability): BUG-vs-SUGGESTION is a genuinely DEBATABLE judgment call — competent reviewers and the truth author can disagree. Do NOT treat a defensible severity choice here as an error. (Over-escalating an optional finding to [BUG], or downgrading a debatable performance finding to [SUGGESTION], is acceptable.)',
    '  severity_judged / severity_correct: compute ADVISORY agreement over matched must-catch findings (informational only). Severity mis-labeling is never a false bug.',
    '',
    'GROUND TRUTH findings:',
    JSON.stringify(findings, null, 2),
    'False-positive traps (reporting any of these as a BUG is a false bug — criterion a):',
    JSON.stringify(traps, null, 2),
    '',
    'AGENT REPORT (final output):',
    '"""',
    (transcript.finalOutput || '').slice(0, 12000),
    '"""',
    '',
    'Output ONLY a JSON object (no prose, no code fence) with exactly these keys:',
    '{',
    '  "matched": [{"truth_id": "...", "evidence": "quote from report"}],',
    '  "must_catch_caught": <int>, "must_catch_total": <int>,',
    '  "security_or_data_must_catch_missed": [<truth_id>...],   // security/data must-catch findings MISSED *or* downgraded to [SUGGESTION]',
    '  "false_bugs": [{"text": "...", "why_wrong": "..."}],',
    '  "reported_bug_count": <int>,',
    '  "severity_correct": <int>, "severity_judged": <int>,',
    '  "notes": "one line"',
    '}',
  ].join('\n');
}

export function extractJson(text) {
  // strip code fences, then take the first balanced {...}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Judge one case. Returns metrics + a derived semantic verdict against the
 * rubric's judge thresholds (recall, false-BUG rate, severity, hard security gate).
 * @returns {{metrics:object, semanticPass:boolean, evidence:object, error?:string}}
 */
export async function judgeCase({ expect, transcript, rubric }) {
  const jr = rubric?.judge || {};
  const minRecall = jr.minRecall ?? 0.8;
  const maxFalseBugRate = jr.maxFalseBugRate ?? 0.2;
  const minSeverityAcc = jr.minSeverityAccuracy ?? 0.8;

  const { out, code, timedOut } = await sh(
    'claude',
    ['-p', buildPrompt(expect, transcript), '--output-format', 'json', '--model', JUDGE_MODEL],
    { timeoutMs: 180_000 },
  );
  if (timedOut || code !== 0) return { metrics: {}, semanticPass: false, evidence: {}, error: `judge call failed (code=${code}, timedOut=${timedOut})` };

  let resultText = out;
  try {
    resultText = JSON.parse(out).result ?? out;
  } catch {
    /* out wasn't the wrapper json; use raw */
  }
  const j = extractJson(resultText);
  if (!j) return { metrics: {}, semanticPass: false, evidence: { raw: resultText.slice(0, 500) }, error: 'judge returned non-JSON' };

  const recall = j.must_catch_total ? j.must_catch_caught / j.must_catch_total : 1;
  const falseBugRate = j.reported_bug_count ? (j.false_bugs?.length || 0) / j.reported_bug_count : 0;
  const severityAcc = j.severity_judged ? j.severity_correct / j.severity_judged : 1;
  const secDataMissed = (j.security_or_data_must_catch_missed || []).length;

  const metrics = { recall, falseBugRate, severityAcc, secDataMissed, reportedBugs: j.reported_bug_count };
  // Gating metrics are the CONSEQUENTIAL ones: no security/data finding missed-or-downgraded
  // (secDataMissed), all must-catch caught (recall), no false/trap BUGs (falseBugRate).
  // severityAcc is ADVISORY (reported, not gated): BUG-vs-SUGGESTION for performance/style is a
  // debatable judgment call, and the dangerous case (downgrading a security/data bug) is already
  // folded into secDataMissed. minSeverityAcc is retained for reference but no longer gates.
  void minSeverityAcc;
  const semanticPass = secDataMissed === 0 && recall >= minRecall && falseBugRate <= maxFalseBugRate;
  return { metrics, semanticPass, evidence: { matched: j.matched, false_bugs: j.false_bugs, notes: j.notes } };
}
