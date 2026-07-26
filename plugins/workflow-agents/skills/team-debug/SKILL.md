---
name: team-debug
description: >
  Evidence-first debugging for test failures, incidents, and unexpected behavior. Establishes a
  reproduction and root cause before the smallest fix, then verifies the regression and affected
  pattern without shotgun changes.
---

# /team-debug — Reproduce, explain, fix

Read `../shared/workflow-contract.md` first.

## Process

1. Read the exact symptom, error, inputs, and relevant logs in full. Establish a minimal reliable
   reproduction before editing code.
2. Trace backward to the earliest divergence between expected and actual behavior. State one
   falsifiable root-cause hypothesis and the evidence supporting it.
3. Test the hypothesis. A focused regression test is preferred when practical; confirm it fails
   for the predicted reason. If it fails differently, revise the hypothesis instead of patching.
4. Search the affected pattern to determine whether this is one instance or a systematic defect.
5. Implement the smallest root-cause fix. Do not bundle unrelated cleanup.
6. Re-run the reproduction, affected tests, and proportional regression checks. Inspect the diff
   and verify error paths or alternate inputs.
7. Report root cause, evidence, files changed, fresh commands/results, pattern scope, and remaining
   risk. When inside a planned workflow, append this evidence to `run.md`.

If repeated fixes fail, stop changing code. Reassess whether the model, boundary, or test premise
is wrong and bring that evidence forward. Complexity is justified only by the external failure
boundary, not by failed patches.
