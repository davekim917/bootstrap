# Workflow-core behavioral fixtures

These cases check risk scaling at the first workflow stage. They deliberately contrast a
mechanical change with a small but security-sensitive migration:

- File count does not force ceremony.
- A cohesive change does not require parallel workers.
- Security, rollback, and data-loss boundaries receive depth even when the diff is small.
- Consequential plans receive independent cross-model review; routine work does not automatically require both gates.
- The retained frontier owner carries technical context; review is fresh and selected from the artifact author family.

The deterministic plugin contract gate separately checks the implementation-review lane,
verified-finding rules, bounded corrective rounds, and the prohibition on silently adding deploy authority.
