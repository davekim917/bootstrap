# Domain-Specific Completion Gates

Apply these gates when a task group includes any of these artifact types. These supplement (not replace) the standard acceptance criteria checks. A group with a dbt model must pass both the general acceptance criteria AND `dbt test`. If no domain-specific gate applies, skip this check.

| Task type | Required before marking group complete |
|---|---|
| **dbt model** (analytics-engineering) | `dbt test --select <model_name>` passes — unique, not_null, relationships, and any custom tests defined in the spec |
| **Airflow / Dagster / Prefect DAG** (data-engineering) | `airflow dags test <dag_id> <date>` (or framework equivalent) runs without error; idempotency verified if spec asserts it |
| **ML training script** (data-science) | Eval metric gate logged (e.g., `val_auc ≥ threshold`) — check the spec's ASSERT for the specific threshold; MLflow / W&B run exists |
| **LLM prompt pipeline / eval** (llm-engineering) | Eval suite passes — `pytest evals/` or equivalent meets the ≥ N/M threshold stated in the spec; token cost within stated budget |
| **Agent loop / MCP tool** (agentic-systems) | Tool contract tests pass; verify structured error returns (no raw Python exceptions propagated); MAX_ITERATIONS cap present in agent loops |
| **Financial GL model** (financial-analytics) | Reconciliation check passes within stated tolerance (typically ≤ $0.01 variance); accepted_values tests for categorical columns pass |
