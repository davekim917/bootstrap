---
name: analytics-engineering
description: Analytics engineering practice patterns for dbt, SQL modeling, data transformation, dimensional modeling, metrics layers, and semantic models. Covers dbt Core, dbt Cloud, Jinja, YAML configuration, testing, documentation, and data modeling best practices. Use when reviewing or building dbt projects, SQL transformations, or data models. Do not use for BI dashboards or visualization (use analytics), data pipeline infrastructure (use data-engineering), or ML model development (use data-science).
---

# Analytics Engineering Practice

Domain-specific patterns and checklists for analytics engineering work.

## Scope

- dbt projects and models
- SQL transformations
- Data modeling (dimensional, OBT, normalized)
- Testing and documentation
- Metrics layers and semantic models
- Data contracts and governance

## Code Review Checklist

### SQL Style
- [ ] Consistent formatting (lowercase keywords or uppercase, pick one)
- [ ] CTEs preferred over subqueries
- [ ] Explicit column selection (no SELECT *)
- [ ] Meaningful aliases
- [ ] Comments on complex logic
- [ ] No hardcoded values (use variables/macros)
- [ ] Appropriate use of window functions

### dbt Models
- [ ] Correct materialization (view, table, incremental, ephemeral)
- [ ] Unique and not_null tests on primary keys
- [ ] Foreign key relationships tested
- [ ] Accepted values tests on categorical columns
- [ ] Model documented with description
- [ ] Column descriptions for business context
- [ ] Appropriate model naming (stg_, int_, fct_, dim_)

### Project Structure
- [ ] Clear staging → intermediate → marts flow
- [ ] Sources defined with freshness checks
- [ ] Exposures for downstream dependencies
- [ ] Consistent file naming conventions
- [ ] YAML files organized (one per model or directory)
- [ ] Macros documented and tested

### Performance
- [ ] Incremental models for large tables
- [ ] Appropriate clustering/partitioning
- [ ] No full table scans in joins
- [ ] CTEs not repeated (use ephemeral or intermediate models)
- [ ] Warehouse-specific optimizations applied

## Architecture Patterns

### dbt Project Structure
```
models/
  staging/
    source_name/
      _source_name__sources.yml
      _source_name__models.yml
      stg_source_name__table.sql
  intermediate/
    domain/
      int_domain__purpose.sql
  marts/
    domain/
      _domain__models.yml
      dim_entity.sql
      fct_events.sql

tests/
  generic/
    test_custom.sql
  singular/
    assert_specific_condition.sql

macros/
  generate_schema_name.sql
  custom_macros.sql
```

### Model Naming Convention
| Prefix | Layer | Purpose |
|--------|-------|---------|
| stg_ | Staging | 1:1 with source, clean and rename |
| int_ | Intermediate | Business logic, joins, aggregations |
| dim_ | Marts | Dimension tables (entities) |
| fct_ | Marts | Fact tables (events, transactions) |
| rpt_ | Reports | Pre-aggregated for BI tools |

### Staging Model Template
```sql
with source as (
    select * from {{ source('source_name', 'table_name') }}
),

renamed as (
    select
        -- Primary key
        id as entity_id,

        -- Foreign keys
        related_id as related_entity_id,

        -- Dimensions
        name as entity_name,
        type as entity_type,

        -- Dates
        created_at,
        updated_at

    from source
)

select * from renamed
```

### Incremental Model Template
```sql
{{
    config(
        materialized='incremental',
        unique_key='event_id',
        incremental_strategy='merge'
    )
}}

with source_data as (
    select *
    from {{ ref('stg_events') }}

    {% if is_incremental() %}
    where updated_at > (select max(updated_at) from {{ this }})
    {% endif %}
)

select * from source_data
```

## Testing Framework

### Required Tests
```yaml
models:
  - name: fct_orders
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: customer_id
        tests:
          - not_null
          - relationships:
              to: ref('dim_customers')
              field: customer_id
      - name: status
        tests:
          - accepted_values:
              values: ['pending', 'completed', 'cancelled']
```

### Custom Tests
```sql
-- tests/assert_total_revenue_positive.sql
select *
from {{ ref('fct_orders') }}
where total_revenue < 0
```

## Documentation Standards

### Model Description
```yaml
models:
  - name: fct_orders
    description: >
      Order transactions at the order level. One row per order.
      Includes order totals, status, and timestamps.
      Grain: one row per order_id.

    columns:
      - name: order_id
        description: Primary key. Unique identifier for the order.
      - name: total_revenue
        description: >
          Total revenue for the order in USD.
          Excludes tax and shipping.
```

## Common Anti-Patterns

- ❌ SELECT * in production models
- ❌ Business logic in staging models (keep staging 1:1 with source)
- ❌ Missing tests on primary keys
- ❌ Hardcoded dates or values
- ❌ Deeply nested CTEs (extract to intermediate models)
- ❌ Duplicated SQL logic (use macros)
- ❌ Missing documentation on business-critical models
- ❌ Overly complex single models (split into layers)

## Technology-Specific Notes

### dbt Core vs Cloud
- Use dbt Cloud for scheduling and CI/CD if available
- Environment-specific configurations in profiles.yml
- Use dbt build over dbt run + dbt test separately

### Warehouse-Specific
**Snowflake:**
- Use transient tables for intermediate models
- Cluster by common filter columns
- Use COPY grants for view permissions

**BigQuery:**
- Partition by date columns
- Cluster by high-cardinality filter columns
- Use require_partition_filter for large tables

**Redshift:**
- Use DISTSTYLE and SORTKEY
- Vacuum and analyze regularly
- Use late binding views for dependencies

### Jinja Best Practices
- Keep Jinja logic readable
- Document macros with descriptions
- Use consistent variable naming
- Test macros with dbt compile

## Data Modeling & Architecture

Architecture decisions and dimensional modeling patterns in the context of analytics engineering tooling.

### Dimensional Modeling Decisions

| Pattern | When to use | Trade-off |
|---|---|---|
| Star schema (fact + dim tables) | BI tools, standard analytics, join performance matters | More joins; simpler business logic per table |
| Wide / OBT (one big table) | Embedded analytics, columnar warehouse, denormalized BI | Faster queries; harder to maintain, schema drift |
| Normalized (3NF-adjacent) | Source-aligned staging, data contracts, high write volume | Fewer redundant columns; more joins downstream |

**Decision rule:** Start with star schema in the mart layer. Denormalize (OBT) only when you have empirical evidence of join performance issues at scale.

### Lakehouse Architecture Patterns (Medallion)

```
Bronze (raw) → Silver (cleaned/conformed) → Gold (business-level)
```

- **Bronze:** Exact copy of source data. No transformations. Preserve all fields including errors. Partition by ingest date.
- **Silver:** Deduplicated, type-cast, renamed. One row per entity or event. Conforms to data contracts.
- **Gold:** Aggregated, dimensional, business-ready. Equivalent to dbt mart layer.

**dbt mapping:** Staging models ≈ Silver boundary. Mart models = Gold layer. Bronze is source-system tables.

### Data Contracts and Schema Registry

A data contract is a schema + SLA agreement between a producer and a consumer. Minimum contract fields:
- `schema`: column names, types, nullability
- `grain`: what one row represents
- `sla`: freshness expectation (e.g., updated within 6 hours of period close)
- `owner`: team or person responsible for the producing model

In dbt: document contracts in `schema.yml` with `constraints` and `data_tests`. Use `dbt source freshness` for SLA monitoring.

### Platform Selection Trade-offs

| Workload | Snowflake | BigQuery | Databricks |
|---|---|---|---|
| Standard SQL analytics, BI | ✓ Strong | ✓ Strong | Adequate |
| Large-scale ML + analytics | Adequate | Adequate | ✓ Strong |
| Streaming + batch unified | Limited | ✓ (via Dataflow) | ✓ Strong |
| Cost predictability | ✓ (credit model) | Variable (on-demand) | Variable |
| dbt compatibility | ✓ Native | ✓ Native | ✓ Native |

**Decision rule:** Default to the warehouse your data team already operates. Migration costs exceed optimization gains in most cases. Adopt Databricks if you have significant ML workloads that need the same data as your analytics.
