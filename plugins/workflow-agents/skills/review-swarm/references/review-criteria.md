# Review Criteria by Domain

Each reviewer applies only the criteria relevant to their role and the detected domain. Criteria ownership is noted in parentheses.

## Universal Criteria

### Error Handling (adversarial-reviewer)
- Are errors propagated appropriately? (silent catch vs throw vs warn)
- Are critical path failures distinguishable from non-critical ones?
- Could an unhandled error leave the system in an inconsistent state?

### Input Validation (adversarial-reviewer, security-reviewer)
- Is user input validated at system boundaries?
- Could malformed input cause unexpected behavior downstream?
- Are type assumptions enforced, not just hoped for?

### Regex & String Patterns (adversarial-reviewer)
- Are word boundaries (`\b`) placed correctly for the intended match?
- Could the pattern match inside URLs, email addresses, or code blocks?
- For `replace()` callbacks: is the match position reliable?

### Project Conventions (domain-reviewer)
- Does the code follow patterns established in CLAUDE.md?
- Are naming conventions consistent with the rest of the codebase?
- Does the change match the project's testing expectations?

---

## SWE / Full-Stack / Backend

### API Design (contract-reviewer, domain-reviewer)
- Are new endpoints consistent with existing API patterns?
- Are request/response schemas documented or typed?
- Is error response format consistent?
- Are breaking changes to existing endpoints avoided or versioned?

### State Management (concurrency-reviewer, arch-reviewer)
- Are in-memory caches/maps cleared or repopulated correctly on restart?
- Could a restart between two operations leave inconsistent state?
- Are database transactions used where atomicity is required?

### Authentication & Authorization (security-reviewer)
- Are auth checks applied consistently across all code paths?
- Could a missing middleware allow unauthorized access?
- Are tokens/credentials stored securely (not in logs, URLs, or client state)?

---

## Frontend

### Rendering & Performance (performance-reviewer)
- Are expensive computations memoized or deferred?
- Could re-renders cause layout thrashing or jank?
- Are images/assets appropriately sized and lazy-loaded?

### Accessibility (domain-reviewer)
- Are interactive elements keyboard-accessible?
- Are ARIA attributes used correctly?
- Is color contrast sufficient?

### Component Design (arch-reviewer)
- Is state lifted to the appropriate level?
- Are components reasonably sized and focused?
- Are side effects contained in appropriate lifecycle hooks?

---

## Data Engineering

### Pipeline Correctness (data-reviewer, adversarial-reviewer)
- Is the pipeline idempotent? (re-running produces the same result)
- Are late-arriving records handled?
- Is backfill logic correct and safe?
- Are task dependencies and execution order correct?
- Could a partial failure leave intermediate state that poisons the next run?

### Orchestration Patterns (data-reviewer, arch-reviewer)
- Are retry policies appropriate (idempotent tasks only)?
- Is the DAG structure clean (no hidden temporal dependencies)?
- Are SLAs/timeouts configured for long-running tasks?

### Schema & Contract (contract-reviewer)
- Are upstream schema changes handled gracefully?
- Are data contracts enforced at ingestion boundaries?
- Could a schema drift silently corrupt downstream tables?

### Warehouse & Resource Management (data-reviewer, performance-reviewer)
- Are partitions/clustering keys appropriate for query patterns?
- Could a full-table scan occur where incremental is expected?
- Are connections/sessions properly closed?
- Is warehouse sizing appropriate for the workload?
- Are transient/temporary objects cleaned up?

---

## Analytics Engineering (dbt / SQL)

### Model Correctness (data-reviewer)
- Are joins at the correct grain? Could fanout occur?
- Are null values handled explicitly (not silently dropped)?
- Is the model idempotent across incremental and full-refresh?
- Are surrogate keys deterministic?
- Is the materialization strategy appropriate (table vs view vs incremental vs ephemeral)?
- Are CTEs vs subqueries used appropriately for the warehouse?

### Jinja & Macro Usage (data-reviewer, adversarial-reviewer)
- Could a macro produce unexpected SQL with edge-case inputs?
- Are `ref()` and `source()` used correctly (not hardcoded table names)?
- Is `is_incremental()` logic correct in all execution modes?
- Are macro arguments validated or defaulted safely?
- Could compile-time vs runtime behavior diverge?

### dbt Config & Testing (data-reviewer, domain-reviewer)
- Do schema tests cover uniqueness, not-null, and accepted-values?
- Are source freshness tests configured?
- Are model descriptions and column docs present?
- Are tags, grants, and access controls applied correctly?
- Is the model in the right directory/layer (staging, intermediate, mart)?

### Warehouse-Specific SQL (data-reviewer)
- Are dialect-specific functions used correctly (e.g., Snowflake FLATTEN, LATERAL, QUALIFY)?
- Are clustering keys aligned with common filter/join columns?
- Could a query benefit from result caching or materialized views?
- Are COPY/MERGE patterns correct for the target warehouse?

---

## Data Science / ML

### Experiment Integrity (adversarial-reviewer, domain-reviewer)
- Is there data leakage between train and test sets?
- Are random seeds set for reproducibility?
- Are evaluation metrics appropriate for the problem?

### Feature Engineering (data-reviewer)
- Could feature computation introduce look-ahead bias?
- Are missing values handled consistently between training and inference?
- Are feature transformations invertible where needed?
- Are feature definitions consistent between training pipeline and serving?

### Model Deployment (arch-reviewer)
- Is model versioning tracked?
- Are inference dependencies pinned?
- Is the serving path tested with realistic data volumes?

---

## SQL (standalone queries, stored procedures, migrations)

### Query Correctness (adversarial-reviewer, data-reviewer)
- Could the query produce duplicates due to join fanout?
- Are window function partitions and ordering correct?
- Are CTEs reused appropriately (not recomputed)?
- Are QUALIFY / HAVING filters applied at the right stage?
- Could implicit type coercion cause silent data loss?

### Migration Safety (contract-reviewer)
- Is the migration reversible?
- Could it lock tables for an unacceptable duration?
- Are default values set for new non-nullable columns?

### Performance (performance-reviewer)
- Are appropriate indexes in place for WHERE/JOIN columns?
- Could the query scan more data than necessary?
- Are there opportunities for pushdown or materialization?

---

## Agentic / LLM Systems

### Agent Loop Correctness (adversarial-reviewer, domain-reviewer)
- Could a tool failure leave the agent in an unrecoverable state?
- Is prompt construction safe from injection via user-supplied content?
- Are context window limits respected (message history truncation, large tool results)?

### Tool & MCP Design (contract-reviewer)
- Are tool schemas well-formed and unambiguous?
- Is MCP server lifecycle managed correctly (startup, shutdown, reconnection)?
- Are tool results validated before being passed to the model?

### Cost & Safety (performance-reviewer, security-reviewer)
- Are token costs bounded? (no unbounded loops with large contexts)
- Are human-in-the-loop gates present for destructive actions?
- Are model outputs validated before executing side effects?
