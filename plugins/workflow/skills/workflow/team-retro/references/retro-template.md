# Retro Template

Use this template when writing `.context/retros/<feature>/retro.md`.

---

```markdown
# Retro: [Feature Name]

**Date:** [YYYY-MM-DD]
**Feature:** [feature name]
**Branch:** [branch name]
**Artifacts location:** `.context/specs/[feature]/`

## Stage-by-Stage Findings

| Stage | Worked Well | Missed / Wrong | Root Cause |
|-------|-------------|----------------|------------|
| /team-brief | [what the brief got right] | [requirements that surfaced later] | [why they were missed] |
| /team-design | [sound decisions] | [invalidated assumptions] | [what wasn't validated] |
| /team-review | [issues caught early] | [issues that escaped to build/QA] | [reviewer blind spot or scope gap] |
| /team-plan | [well-specified tasks] | [under-specified areas] | [missing context or premature decomposition] |
| /team-build | [smooth execution areas] | [blockers, failed fix cycles] | [spec gap, tooling issue, or assumption] |
| /team-qa | [valid findings] | [false positives or missed issues] | [validator gap or routing miss] |
| /team-drift | [caught real issues] | [missed real issues] | [SOT/target scope gap] |

## Key Learnings

1. Next time, [action] because [evidence from this feature].
2. Next time, [action] because [evidence from this feature].
3. Next time, [action] because [evidence from this feature].

## Recommended Updates

### CLAUDE.md
- **Section:** [exact section name]
- **Change:** [what to add/modify/remove]
- **Reason:** [cite retro finding]

### Workflow Skills
- **Skill:** [skill name] § [section name]
- **Change:** [what to add/modify/remove]
- **Reason:** [cite retro finding]

### Project Skills
- **Skill:** [skill name]
- **Change:** [what to add/modify/remove]
- **Reason:** [cite retro finding]
```
