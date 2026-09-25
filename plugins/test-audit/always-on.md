# Test audit (always on)

When you write or change tests, load the `test-audit` skill and run its authoring gate
first. Never weaken or delete an existing test's assertions, cases, or fixtures to make
a change pass. If an existing test fails, fix the code, or say why the contract changed.
