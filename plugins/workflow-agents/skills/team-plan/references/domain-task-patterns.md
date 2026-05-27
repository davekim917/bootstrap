# Domain-Specific Task Pattern Examples

Canonical task spec patterns for each domain. Use these as templates when writing task specs
in `/team-plan` Step 4 — transcribe the relevant pattern directly rather than linking to it.

---

## analytics-engineering (dbt / SQL models)

```
Task B1: Add weekly revenue fact model
File: models/marts/fct_user_revenue_weekly.sql [CREATE]
Companion: models/marts/_marts__models.yml [MODIFY — add schema entry]
Approach: Aggregate payments to user-week grain. Follows analytics-engineering skill mart conventions.
          Materialization: table (not incremental — <1M rows). Prefix: fct_.

Interface / signature (schema.yml):
  - name: fct_user_revenue_weekly
    description: Revenue aggregated at user-week grain. One row per user per ISO week.
    columns:
      - name: user_id       # FK to dim_users; not_null; relationships test
      - name: week_start    # grain: one row per user per week (Monday); unique(user_id, week_start)
      - name: revenue_usd   # null-safe: source nulls → 0.00; not_null test

ASSERT: aggregation is at user-week grain (dbt unique test: user_id + week_start)
ASSERT: revenue_usd is NULL-safe (source nulls → 0.00, not dropped)
ASSERT: model has unique, not_null, and relationships tests in schema.yml

Test cases:
  test_fct_weekly_grain:
    Setup:  stg_payments has 3 rows for user_1 in the same week
    Assert: fct_user_revenue_weekly has exactly 1 row for user_1 + that week; revenue_usd = sum of 3

Acceptance criteria:
  - [ ] dbt test: unique user_id + week_start passes
  - [ ] dbt test: not_null revenue_usd passes
  - [ ] Row count reconciles with stg_payments control total
  - [ ] schema.yml entry includes model description and all column descriptions
```

---

## data-engineering (pipelines / DAGs)

```
Task C1: Add Snowflake orders ingestion DAG
File: pipelines/ingestion/snowflake/orders_dag.py [CREATE]
Approach: Daily incremental load from source Snowflake → landing zone S3.
          Watermark-based: reads `max(updated_at)` from metadata table, loads newer records only.
          Idempotent: overwrites partition `date=YYYY-MM-DD` on each run.
          Follows data-engineering skill idempotency pattern.

Interface / signature:
  DAG ID: snowflake_orders_daily
  Schedule: 0 6 * * *   (06:00 UTC daily)
  Tasks: extract → validate → load
    extract  → XCom: {"row_count": int, "watermark_start": str, "watermark_end": str}
    validate → XCom: {"passed": bool, "failures": list[str]}
    load     → XCom: {"rows_written": int, "partition": str}
  SLA: 07:00 UTC (1hr tolerance)
  Alerts: on_failure_callback → Slack #data-alerts

ASSERT: DAG is idempotent — re-running with same date produces identical output
ASSERT: DAG has catchup=False unless historical backfill is required
ASSERT: Failed validation step raises AirflowException (halts load, no partial write)
ASSERT: extract task outputs row_count > 0 or raises on empty result (configurable threshold)

Test cases:
  test_dag_loads_correctly:
    Setup:  mock source with 100 orders updated after watermark
    Assert: load task writes 100 rows to S3 partition; watermark advances

  test_dag_is_idempotent:
    Setup:  run DAG for date X once; note row count
    Action: run DAG for same date X again
    Assert: S3 partition for date X contains same rows (no duplicates)

Acceptance criteria:
  - [ ] DAG passes `airflow dags test snowflake_orders_daily 2024-01-01`
  - [ ] Idempotency verified: re-run produces same partition output
  - [ ] Validation task halts pipeline on schema or volume failures
  - [ ] SLA and failure alert configured
```

---

## data-science (ML / notebooks)

```
Task D1: Train churn prediction model
File: src/models/train_churn.py [CREATE]
Companion: configs/churn_model_config.yaml [MODIFY — add model params]
Approach: XGBoost classifier on customer feature set v3.
          Train/val/test split: 60/20/20, stratified on churn label.
          All preprocessing in sklearn Pipeline to prevent leakage.
          Log experiment to MLflow. Gate: AUC ≥ 0.80 on val set before training continues to test.

Interface / signature:
  def train_churn_model(config_path: str, data_path: str) -> TrainResult
    config_path: path to churn_model_config.yaml
    data_path:   path to features/customer_features_v3.parquet
    returns: TrainResult(model_path, val_auc, test_auc, run_id, data_version)

  Preprocessing pipeline (fitted on train only):
    1. StandardScaler on continuous features
    2. OrdinalEncoder on categorical features
    3. XGBClassifier(n_estimators=500, max_depth=6, learning_rate=0.01)

ASSERT: train/val/test split happens BEFORE any preprocessing
ASSERT: scaler.fit() is called only on X_train — never on X_test or X_val
ASSERT: AUC ≥ 0.80 on val set before logging model to registry
ASSERT: MLflow run logs: params (model_type, n_estimators, feature_set), metrics (val_auc, test_auc), artifact (model), tag (data_version)

Test cases:
  test_no_data_leakage:
    Setup:  run full pipeline on synthetic data
    Assert: scaler.mean_ computed from train only; not recalculated on test

  test_quality_gate_enforced:
    Setup:  configure model to produce AUC < 0.80 (low n_estimators=1)
    Assert: TrainResult raises ModelQualityError, model not logged to registry

Acceptance criteria:
  - [ ] val_auc ≥ 0.80 before test set evaluation
  - [ ] Pipeline is end-to-end: preprocessing + model in one sklearn Pipeline
  - [ ] Experiment logged to MLflow with all required params, metrics, artifacts
  - [ ] No data leakage: verified by test_no_data_leakage
```

---

## llm-engineering (prompt pipelines / evals)

```
Task E1: Add entity extraction prompt with eval
File: src/extraction/entity_extractor.py [CREATE]
Companion: evals/test_entity_extraction.eval.py [CREATE]
Approach: Anthropic tool_use for structured extraction. Uses tool_choice={"type":"tool","name":"extract"}
          for guaranteed structured output (no JSON parsing needed).
          Follows llm-engineering skill structured output pattern.

Interface / signature:
  def extract_entities(text: str, model: str = DEFAULT_MODEL) -> ExtractionResult
    text:   input document (max 10,000 chars — validate at boundary)
    model:  default "claude-sonnet-4-6"; override via constant only
    returns: ExtractionResult(entities: list[Entity], model_used: str, input_tokens: int, output_tokens: int)

  Entity: {name: str, type: Literal["person","org","location","product"], confidence: float}

ASSERT: user-provided text goes in user role message, NEVER interpolated into system prompt
ASSERT: tool_choice forces structured output — no JSON parsing fallback needed
ASSERT: input_tokens + output_tokens logged for every call (cost tracking)
ASSERT: eval suite asserts ≥ 3 of 5 test cases pass before feature ships

Test cases (evals/test_entity_extraction.eval.py):
  test_extracts_known_entities:
    Input:  "Apple acquired Beats Electronics in 2014."
    Assert: "Apple" type=org, "Beats Electronics" type=org in result.entities

  test_handles_no_entities:
    Input:  "The weather is nice today."
    Assert: result.entities == [] (empty list, not error)

  test_token_cost_within_budget:
    Input:  100-word test document
    Assert: result.input_tokens + result.output_tokens ≤ 1500

Acceptance criteria:
  - [ ] All 3 eval assertions pass (run: pytest evals/test_entity_extraction.eval.py)
  - [ ] User input never in system prompt (code review: no f-string in system param)
  - [ ] Token cost logged per call
  - [ ] ExtractionResult is Pydantic model with validation
```

---

## agentic-systems (agents / tools / MCP)

```
Task F1: Add document search MCP tool
File: mcp_server/tools/document_search.py [CREATE]
Companion: mcp_server/server.py [MODIFY — register new tool]
Approach: Vector search over indexed documents. Tool returns top-k chunks with source metadata.
          Follows agentic-systems skill tool contract pattern.
          Error behavior: returns structured error dict (not Python exception) so agent can reason about failure.

Interface / signature:
  Tool name: search_documents
  Description: "Search indexed documents for relevant content. Returns up to {limit} chunks with source
               metadata. Returns empty list if nothing found — do not assume failure."
  Input schema:
    query: string (required) — natural language search query
    limit: integer (optional, default 5, max 20)
  Output: {"status": "success"|"error", "results": [{"text": str, "source": str, "score": float}] | "error": str}

ASSERT: tool returns {"status": "success", "results": []} for no-match queries (not an error state)
ASSERT: tool returns {"status": "error", "error": "..."} on exception (never raises Python exception)
ASSERT: tool description tells the agent what empty results mean ("do not assume failure")
ASSERT: input schema has additionalProperties: false to reject unknown fields

Test cases:
  test_search_returns_results:
    Setup:  index contains 10 documents about "revenue recognition"
    Action: search_documents(query="how is revenue recognized?")
    Assert: status="success", len(results) > 0, each result has text + source + score

  test_search_handles_no_match:
    Action: search_documents(query="xyzzy123nonexistent")
    Assert: status="success", results=[]

  test_search_handles_db_error:
    Setup:  mock vector store raises exception
    Assert: returns {"status": "error", "error": "..."}, no Python exception propagated

Acceptance criteria:
  - [ ] Tool registered in mcp_server/server.py list_tools() handler
  - [ ] Empty result returns success, not error
  - [ ] All exceptions caught and returned as structured error dicts
  - [ ] Input schema validation: unknown fields rejected
  - [ ] All 3 test cases pass
```

---

## financial-analytics (GL models / reconciliation)

```
Task G1: Add revenue recognition model
File: models/marts/fct_recognized_revenue.sql [CREATE]
Companion: models/marts/_finance__models.yml [MODIFY — add schema entry]
Approach: Daily revenue recognized from active subscriptions. One row per subscription per day.
          Follows financial-analytics skill reconciliation pattern.
          Write reconciliation check FIRST (TDD for finance).

Interface / signature (schema.yml):
  - name: fct_recognized_revenue
    description: Daily recognized revenue per subscription. Grain: one row per subscription_id + recognition_date.
    columns:
      - name: subscription_id   # FK to dim_subscriptions; not_null
      - name: recognition_date  # Date revenue is recognized; not_null
      - name: recognized_amount_usd  # Daily prorated amount; not_null; >= 0
      - name: contract_amount_usd    # Total contract value for audit traceability
      - name: rate_type              # 'daily_prorate'; accepted_values test

ASSERT: grain is subscription_id + recognition_date (unique test required)
ASSERT: recognized_amount_usd >= 0 (no negative recognition without explicit void logic)
ASSERT: sum(recognized_amount_usd) for any subscription reconciles with contract_amount_usd
ASSERT: No hardcoded fiscal year cutoffs (use dim_fiscal_calendar for all date logic)

Reconciliation check (write first — this is the RED test):
  SELECT
    SUM(recognized_amount_usd) as total_recognized,
    1250000.00 as expected_total,  -- from GL trial balance for period FY2024-P03
    ABS(SUM(recognized_amount_usd) - 1250000.00) as variance,
    CASE WHEN ABS(SUM(recognized_amount_usd) - 1250000.00) <= 0.01 THEN 'PASS' ELSE 'FAIL' END
  FROM {{ ref('fct_recognized_revenue') }}
  WHERE fiscal_period = '{{ var("target_period") }}'

Acceptance criteria:
  - [ ] dbt test: unique subscription_id + recognition_date passes
  - [ ] dbt test: not_null recognized_amount_usd passes
  - [ ] Reconciliation check passes within $0.01 tolerance for test period
  - [ ] No hardcoded fiscal year in WHERE clauses — uses fiscal calendar model
  - [ ] schema.yml entry includes grain description and all column descriptions
```
