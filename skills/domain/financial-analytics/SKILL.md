---
name: financial-analytics
description: >
  Financial analytics patterns for GL modeling, reconciliation, control totals, period-close
  validation, dimensional modeling for finance, and regulatory reporting. Use when building
  financial data models, billing systems, close processes, or audit-compliant reporting.
  Do not use for general analytics dashboards, non-financial data models, or data pipeline engineering.
---

# Financial Analytics Practice

Domain-specific patterns for financial data models, reconciliation, and period-close validation.

## When to Apply

- General Ledger (GL) models and chart-of-accounts tables
- Reconciliation checks and control total validation
- Period-close validation and fiscal calendar logic
- Billing models and revenue recognition
- Financial KPIs and reporting
- Regulatory and audit-compliant reporting
- Budget vs. actuals analysis

## Core Quality Gates

Before shipping any financial calculation or model:

1. **Reconciliation check:** Compare calculated totals against a known source (GL, prior period
   balance, regulatory filing). No financial model ships without a reconciliation pass.
2. **Control total assertion:** Define the expected total upfront. Write the check before
   building the calculation. This is the RED step in TDD for finance.
3. **Variance tolerance:** Define the acceptable variance threshold upfront (e.g., ≤ $0.01 for
   currency, ≤ 0.001% for percentage metrics). Unexplained variance above threshold is a
   blocker — do not waive it without documented explanation.
4. **Period-end close tests:** For any model used in close processes, run period-end scenarios
   (month-end, quarter-end, year-end) as part of the test suite.

## TDD for Finance

The RED-GREEN-REFACTOR cycle maps directly to financial analytics:

- **RED:** Write a reconciliation check that compares the calculated total against a known
  correct source. It fails because the model/calculation doesn't exist yet.
- **GREEN:** Build the GL model, financial calculation, or transformation until the
  reconciliation passes within tolerance.
- **REFACTOR:** Optimize query performance, tighten tolerance, improve period logic.
  Re-run reconciliation checks to confirm they still pass.

```sql
-- Example reconciliation check (RED — write this first)
with calculated as (
    select sum(amount) as calc_total
    from {{ ref('fct_gl_entries') }}
    where fiscal_period = '{{ var("target_period") }}'
    and account_type = 'revenue'
),
known_source as (
    select 1250000.00 as source_total  -- from GL trial balance export
)
select
    calc_total,
    source_total,
    abs(calc_total - source_total) as variance,
    case
        when abs(calc_total - source_total) <= 0.01 then 'PASS'
        else 'FAIL'
    end as reconciliation_status
from calculated
cross join known_source
```

## Security Surface

- **PII in compensation data:** Salary, bonus, and equity compensation tables contain sensitive
  PII. Apply column-level masking on `salary`, `bonus`, `equity_value`, `comp_total` for all
  roles except authorized HR/finance users. Test that masked queries return `null` or `***`
  for unauthorized roles.
- **Org hierarchy data:** Role-based or row-level security on GL data by cost center, department,
  or subsidiary. Verify with cross-role tests that users cannot see data outside their org scope.
- **Audit trail requirements:** Financial transaction tables should not have `DELETE` permissions
  in production. Use soft deletes (`is_deleted`, `void_reason`). Test that DELETE attempts
  are rejected.
- **GL access controls:** Chart-of-accounts and posting permissions should be controlled by the
  GL system, not by data model logic. Don't replicate authorization logic in SQL — report on
  access violations instead.
- **Regulatory data handling:** For SOX, GAAP, or IFRS reporting, changes to financial
  calculation logic require approval trails. Document what changed and why in the model
  description, not just the code.

## Performance

- **Incremental materialization on transaction tables:** Multi-year GL transaction history should
  use incremental models partitioned by `fiscal_period` or `transaction_date`. Avoid full
  refreshes on tables with >1M rows.
- **Pre-aggregation for period summaries:** Don't compute period summaries on the fly in BI
  tools. Build pre-aggregated period rollup models (`rpt_period_summary`) as intermediate
  or mart models.
- **Avoid full-table scans on transaction history:** Always filter on `fiscal_period`,
  `account_code`, or `transaction_date` in GL queries. Unfiltered GL queries are expensive
  and will timeout in large deployments.
- **Indexing:** Cluster/partition on `fiscal_period` and `account_code` (the two most common
  filter dimensions in financial queries).

## Anti-Patterns

| Anti-pattern | Why it's wrong | What to do instead |
|---|---|---|
| Hardcoded fiscal year in WHERE clause | `WHERE fiscal_year = 2024` breaks every year | Use dbt vars: `{{ var("fiscal_year") }}` or a fiscal calendar model |
| Unreconciled totals shipped without variance explanation | Silent financial errors reach stakeholders | Reconcile before every release; document any known variance |
| No primary key tests on GL entries | Duplicate entries inflate totals silently | `unique` + `not_null` tests on `journal_entry_id`, `line_item_id` |
| Single-period queries that won't generalize | Hard-coded period logic fails on close cycles | Parameterize all period logic via fiscal calendar model |
| Mixing accounting periods with calendar periods | `fiscal_period` ≠ `calendar_month` without conversion | Always join through a `dim_fiscal_calendar` model to convert |
| No tolerance threshold defined | "Close enough" is not a financial standard | Define and document variance tolerance per metric upfront |
| Using `DELETE` for financial corrections | Destroys audit trail | Use soft deletes with `void_reason` and `voided_at` fields |

## Fiscal Calendar Pattern

```sql
-- dim_fiscal_calendar.sql — always reference through this model
select
    calendar_date,
    fiscal_year,
    fiscal_quarter,
    fiscal_period,           -- "FY2024-P03" format
    fiscal_week,
    is_period_end_date,
    is_quarter_end_date,
    is_year_end_date
from {{ source('finance_system', 'fiscal_calendar') }}
```
