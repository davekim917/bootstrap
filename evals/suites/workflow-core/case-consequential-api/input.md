Use `/team-plan` for this task:

Three background job runners each wrap their outbound HTTP calls in a hand-written retry loop with
different backoff constants, and one of them retries non-idempotent POST requests. Replace the three
loops with one shared retry primitive that every outbound call in the service will route through.

No source code is provided, so do not search for it or delegate a search; work from this
description. Reply with the design section you would put in `plan.md`, including the primitive's
interface.
