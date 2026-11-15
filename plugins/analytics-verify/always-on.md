# Analytics verify (always on)

Before you send a figure or factual finding you derived from data or research (a query
result, a metric, a count from a dataset, a sourced external fact) that someone will use
to decide or will pass on, load the `analytics-verify` skill and run its loop. That
covers a report, deck, PDF, CSV, a draft for someone else, or a chat answer. It does not
cover reporting the state of your own work (what you changed, what a command printed,
PR, CI or deploy status, counts of files or tests), or relaying a number someone else
gave you unchanged. If you're unsure whether a data claim needs it, it does. Rereading
your own work in the same context is not verification. When asked to validate or
cross-check an analysis, load it as the verifier: you're checking that it answers the
question asked, with the right measure, sources, period and population, not only that
its arithmetic is right.
