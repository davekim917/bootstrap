---
name: data-engineering
description: Data engineering practice patterns for data pipelines, ETL/ELT, orchestration, data quality, and infrastructure. Covers Airflow, Dagster, Prefect, Spark, dbt, data lakes, warehouses, streaming, Kafka, and batch processing. Use when reviewing or building data pipelines, ingestion systems, or data infrastructure. Do not use for SQL modeling or dbt projects (use analytics-engineering), business dashboards (use analytics), or ML model training (use data-science).
---

# Data Engineering Practice

Domain-specific patterns and checklists for data engineering work.

## Scope

- Data pipelines (batch and streaming)
- ETL/ELT processes
- Orchestration (Airflow, Dagster, Prefect)
- Data quality and validation
- Data lakes and warehouses
- Schema management and evolution

## Code Review Checklist

### Pipeline Design
- [ ] Idempotent operations (safe to re-run)
- [ ] Atomic writes (all-or-nothing)
- [ ] Backfill strategy defined
- [ ] Failure handling and retry logic
- [ ] Appropriate granularity (not too monolithic)
- [ ] Dependencies explicitly declared
- [ ] No hardcoded dates or paths

### Data Quality
- [ ] Schema validation on ingestion
- [ ] Null handling explicit
- [ ] Data type validation
- [ ] Uniqueness constraints where needed
- [ ] Freshness checks (data not stale)
- [ ] Volume anomaly detection
- [ ] Data quality tests defined

### Orchestration
- [ ] DAG structure is clear and documented
- [ ] Task dependencies make sense
- [ ] Appropriate task granularity
- [ ] Timeouts configured
- [ ] Alerts on failure
- [ ] SLAs defined for critical pipelines
- [ ] Concurrency limits set

### Performance
- [ ] Partitioning strategy appropriate
- [ ] Incremental processing where possible
- [ ] No full table scans on large tables
- [ ] Appropriate file formats (Parquet, Delta, Iceberg)
- [ ] Compression enabled
- [ ] Resource allocation appropriate

## Architecture Patterns

### Pipeline Structure
```
pipelines/
  ingestion/
    source_name/
      extract.py        # Pull from source
      validate.py       # Schema/quality checks
      load.py           # Write to landing zone
  transformation/
    domain/
      staging.sql       # Clean, dedupe
      intermediate.sql  # Business logic
      marts.sql         # Final models
  orchestration/
    dags/
      source_name_dag.py
```

### Idempotency Pattern
```python
# Good: Idempotent with partition overwrite
def load_data(date: str):
    df = extract(date)
    df.write.mode("overwrite").partitionBy("date").parquet(path)

# Bad: Append can create duplicates
def load_data(date: str):
    df = extract(date)
    df.write.mode("append").parquet(path)
```

### Incremental Processing
```python
# Track watermark for incremental loads
last_processed = get_watermark("source_table")
new_data = source.filter(col("updated_at") > last_processed)
write_data(new_data)
set_watermark("source_table", current_timestamp())
```

## Data Quality Framework

### Validation Layers
1. **Schema validation** - Column names, types, nullability
2. **Semantic validation** - Value ranges, formats, referential integrity
3. **Statistical validation** - Volume, distribution, anomalies

### Quality Checks Template
```python
checks = [
    # Completeness
    {"check": "not_null", "columns": ["id", "created_at"]},

    # Uniqueness
    {"check": "unique", "columns": ["id"]},

    # Validity
    {"check": "accepted_values", "column": "status",
     "values": ["active", "inactive", "pending"]},

    # Freshness
    {"check": "freshness", "column": "updated_at", "max_age_hours": 24},

    # Volume
    {"check": "row_count", "min": 1000, "max": 1000000},
]
```

## Common Anti-Patterns

- ❌ Non-idempotent pipelines (duplicates on re-run)
- ❌ Hardcoded credentials (use secrets manager)
- ❌ No backfill capability
- ❌ Monolithic DAGs (split by domain/source)
- ❌ Silent failures (missing alerts)
- ❌ Full refreshes when incremental is possible
- ❌ No data quality checks
- ❌ Tight coupling between extraction and transformation

## Technology-Specific Notes

### Airflow
- Use TaskFlow API (Airflow 2.x+)
- Prefer dynamic DAGs over repetition
- Use XCom sparingly (for metadata only)
- Set `catchup=False` unless backfill needed
- Use pools for resource management

### Spark
- Avoid collect() on large datasets
- Use broadcast joins for small tables
- Partition by high-cardinality columns
- Cache intermediate results if reused
- Monitor shuffle operations

### Streaming (Kafka, Kinesis)
- Handle late-arriving data
- Define watermarks for event time
- Use checkpointing for exactly-once
- Size windows appropriately
- Handle schema evolution

### Data Warehouse (Snowflake, BigQuery, Redshift)
- Cluster keys on common filter columns
- Use materialized views for frequent queries
- Partition large tables by date
- Monitor query costs
- Use appropriate warehouse sizes
