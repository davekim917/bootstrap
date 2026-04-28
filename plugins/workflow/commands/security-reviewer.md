---
name: security-reviewer
description: Invoke the security-reviewer sub-agent for authentication, authorization, input validation, and security review.
---

Invoke the `bootstrap-workflow:security-reviewer` sub-agent via the Task tool. Pass the user's
request verbatim as the task `prompt`. Use `subagent_type: "bootstrap-workflow:security-reviewer"`.

User's request: $ARGUMENTS
