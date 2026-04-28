---
name: architecture-advisor
description: Invoke the architecture-advisor sub-agent for design review of new database tables, API routes, dependency changes, and changes affecting multiple files.
---

Invoke the `bootstrap-workflow:architecture-advisor` sub-agent via the Task tool. Pass the
user's request verbatim as the task `prompt`. Use `subagent_type: "bootstrap-workflow:architecture-advisor"`.

User's request: $ARGUMENTS
