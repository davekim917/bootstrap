---
name: team-build
description: Build, test and repair authorized work in the retained frontier session.
---

# /team-build — Complete the authorized change

Read `../shared/workflow-contract.md` first. Read the plan if present and ground implementation
authority in the conversation. Stop dependent work only for a missing scope, product, trust or
irreversible decision. Keep the same frontier owner through build, tests and fixes.

1. Inspect git state and preserve unrelated changes. Record existing authority and owner settings.
2. Inspect current source; implement the smallest complete change. The owner uses tools directly.
   Only brief logistical or mechanical actions execute directly; substantive work uses the frontier owner.
3. Add meaningful acceptance/regression tests when practical. Confirm the expected failure before
   the fix when useful; use proportional alternatives for mechanical edits or unisolatable behavior.
4. Diagnose unexpected failures with `/team-debug`; apply the shared maximum of 3 corrective rounds
   across the task. Reconsider a repeated failure signature once, and stop on no progress.
5. Inspect the complete diff and run affected checks. Reuse exact unchanged evidence under the shared
   artifact/environment/command rule; do not repeat checks merely to satisfy stage names.
6. Record changes, decisions, evidence, repairs and limitations in `run.md` when used. Obtain the
   risk-appropriate implementation review before shipping, honoring explicit review requests.

No automatic builder swarm, context reset, or cheap-worker handoff. Any independently authorized
work must have exclusive ownership and converge under this owner.
