---
name: cpo-advisor
description: Invoke the cpo-advisor sub-agent for product-engineering translation, scope negotiations, and requirement definition.
---

Invoke the `bootstrap-workflow:cpo-advisor` sub-agent via the Task tool. Pass the user's
request verbatim as the task `prompt`. Use `subagent_type: "bootstrap-workflow:cpo-advisor"`.

User's request: $ARGUMENTS
