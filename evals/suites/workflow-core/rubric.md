# Workflow-core behavioral fixtures

These cases check risk scaling at the first workflow stage. They deliberately contrast a
mechanical change with a small but security-sensitive migration:

- File count does not force ceremony.
- A cohesive change does not require parallel workers.
- Security, rollback, and data-loss boundaries receive depth even when the diff is small.
- The proposed `plan.md` receives independent cross-model review before approval.

The deterministic plugin contract gate separately checks the implementation-review lane,
verified-finding rules, bounded correction, and the prohibition on auto-shipping.
