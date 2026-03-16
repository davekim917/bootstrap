---
name: financial-analytics
description: >
  Financial analytics patterns for GL modeling, reconciliation, control totals, period-close
  validation, dimensional modeling for finance, SaaS metrics, revenue recognition, budget vs
  actuals, and regulatory reporting. Covers ASC 606, IFRS 15, ARR/MRR, churn, cohort revenue,
  multi-currency, SOX compliance, accounts payable/receivable, and audit-compliant reporting.
  Use when building financial data models, billing systems, close processes, SaaS finance
  dashboards, or audit-compliant reporting. Do not use for general analytics dashboards,
  non-financial data models, or data pipeline engineering.
---

# Financial Analytics Practice

Domain-specific patterns for financial data models, SaaS metrics, reconciliation, and period-close validation.

## When to Apply

- General Ledger (GL) models and chart-of-accounts tables
- Reconciliation checks and control total validation
- Period-close validation and fiscal calendar logic
- SaaS metrics: ARR, MRR, churn, NRR, LTV, CAC
- Revenue recognition (ASC 606 / IFRS 15)
- Budget vs actuals analysis
- Accounts payable / accounts receivable modeling
- Multi-currency reporting
- Regulatory and audit-compliant reporting (SOX, GAAP, IFRS)

## Core Quality Gates

Before shipping any financial calculation:

1. **Reconciliation check:** Compare calculated totals against a known source (GL, prior period, regulatory filing). No financial model ships without a reconciliation pass.
2. **Control total assertion:** Define expected total upfront. Write the check before the calculation — this is RED in financial TDD.
3. **Variance tolerance:** Define the acceptable variance threshold upfront (≤ $0.01 for currency, ≤ 0.001% for rates). Unexplained variance above threshold is a blocker.
4. **Period-end scenarios:** For close-process models, run period-end scenarios (month-end, quarter-end, year-end) as part of the test suite.

## TDD for Finance

**RED:** Write a reconciliation check that compares calculated total against known correct source. It fails because the model doesn't exist yet.
**GREEN:** Build GL model, calculation, or transformation until reconciliation passes within tolerance.
**REFACTOR:** Optimize performance, tighten tolerance, improve period logic. Re-run reconciliation.

```sql
-- Example reconciliation check (write FIRST — before the model)
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
    case when abs(calc_total - source_total) <= 0.01 then 'PASS' else 'FAIL' end as status
from calculated cross join known_source
```

## SaaS Metrics

### ARR / MRR
```sql
-- Monthly Recurring Revenue — one row per subscription per month
with active_subscriptions as (
    select
        customer_id,
        subscription_id,
        monthly_amount,
        start_date,
        end_date,
        month_date
    from {{ ref('dim_subscriptions') }}
    cross join {{ ref('dim_months') }}
    where month_date >= start_date
      and (end_date is null or month_date < end_date)
)
select
    month_date,
    sum(monthly_amount) as mrr,
    sum(monthly_amount) * 12 as arr,
    count(distinct customer_id) as paying_customers
from active_subscriptions
group by month_date
```

### MRR Movement (Waterfall)
```sql
-- Classify every MRR change into: new, expansion, contraction, churn, reactivation
with mrr_changes as (
    select
        customer_id,
        month_date,
        mrr as current_mrr,
        lag(mrr) over (partition by customer_id order by month_date) as prior_mrr,
        mrr - lag(mrr) over (partition by customer_id order by month_date) as mrr_delta
    from monthly_mrr_by_customer
)
select
    month_date,
    case
        when prior_mrr is null then 'new'
        when prior_mrr = 0 and current_mrr > 0 then 'reactivation'
        when current_mrr = 0 then 'churned'
        when mrr_delta > 0 then 'expansion'
        when mrr_delta < 0 then 'contraction'
        else 'flat'
    end as movement_type,
    sum(mrr_delta) as mrr_impact
from mrr_changes
group by month_date, movement_type
```

### Net Revenue Retention (NRR)
```sql
-- NRR: what % of last period's ARR do we retain (including expansions) from the same cohort?
-- NRR = (Starting ARR + Expansions - Contractions - Churn) / Starting ARR
select
    cohort_month,
    starting_arr,
    expansions,
    contractions,
    churn,
    (starting_arr + expansions - contractions - churn) / starting_arr as nrr
from mrr_movement_cohorts
```

### Churn Rate
```sql
-- Monthly logo churn rate
select
    month_date,
    churned_customers / lag(paying_customers) over (order by month_date) as logo_churn_rate,
    churned_mrr / lag(mrr) over (order by month_date) as revenue_churn_rate
from monthly_metrics
```

## Revenue Recognition (ASC 606 / IFRS 15)

Revenue is recognized when (or as) performance obligations are satisfied — not when cash is received.

### Recognized vs Deferred Revenue
```sql
-- For a 12-month subscription starting April 15:
-- Cash received: $1,200 on April 15
-- Recognized per day: $1,200 / 365 = ~$3.29/day
-- April recognized: $3.29 * 16 days = $52.60 (April 15-30)
-- Deferred: $1,200 - $52.60 = $1,147.40 (to be recognized May-April)

with daily_recognition as (
    select
        subscription_id,
        contract_amount / date_diff('day', start_date, end_date) as daily_rate,
        generate_series(start_date, end_date, interval '1 day') as recognition_date
    from subscriptions
)
select
    date_trunc('month', recognition_date) as period,
    sum(daily_rate) as recognized_revenue
from daily_recognition
group by period
```

**ASC 606 Model Checklist:**
- [ ] Each contract has identified performance obligations
- [ ] Transaction price allocated to each obligation
- [ ] Recognition triggered on obligation satisfaction (not payment)
- [ ] Variable consideration (discounts, refunds) estimated and constrained
- [ ] Contract modifications tracked and re-allocated

## Budget vs Actuals

```sql
-- Budget vs actuals variance by department and account
select
    d.department_name,
    a.account_name,
    b.budget_amount,
    a.actual_amount,
    a.actual_amount - b.budget_amount as variance,
    (a.actual_amount - b.budget_amount) / nullif(b.budget_amount, 0) as variance_pct,
    case
        when abs((a.actual_amount - b.budget_amount) / nullif(b.budget_amount, 0)) > 0.10
        then 'REVIEW REQUIRED'
        else 'OK'
    end as flag
from {{ ref('fct_actuals') }} a
join {{ ref('fct_budget') }} b
    on a.department_id = b.department_id
    and a.account_code = b.account_code
    and a.fiscal_period = b.fiscal_period
join {{ ref('dim_departments') }} d on a.department_id = d.department_id
join {{ ref('dim_chart_of_accounts') }} coa on a.account_code = coa.account_code
```

## Multi-Currency Handling

```sql
-- Always store transaction amounts in both original and functional currency
-- Never calculate multi-currency totals from original currency + hardcoded rates

-- dim_exchange_rates: one row per (from_currency, to_currency, rate_date)
-- Join at reporting time — don't bake rates into transactions

select
    t.transaction_date,
    t.amount_original_currency,
    t.currency_code,
    t.amount_original_currency * r.exchange_rate as amount_usd,
    r.exchange_rate,
    r.rate_type  -- 'spot', 'average', 'eom'
from transactions t
join dim_exchange_rates r
    on t.currency_code = r.from_currency
    and r.to_currency = 'USD'
    and r.rate_date = t.transaction_date
    and r.rate_type = 'average'  -- Use consistent rate type per reporting standard
```

**Multi-Currency Rules:**
- Store `amount_local` and `amount_functional` (USD) on every transaction at post time
- Use month-average rate for P&L; period-end rate for balance sheet (GAAP)
- Never mix rate types in the same calculation
- Store the rate used alongside the converted amount for audit traceability

## Fiscal Calendar Pattern

```sql
-- Always reference dates through dim_fiscal_calendar — never hardcode fiscal logic
select
    calendar_date,
    fiscal_year,           -- FY2025
    fiscal_quarter,        -- Q1
    fiscal_period,         -- FY2025-P01 (use this for parameterization)
    fiscal_week,
    is_period_end_date,
    is_quarter_end_date,
    is_year_end_date,
    days_in_period,        -- For prorated calculations
    is_leap_year
from {{ source('finance_system', 'fiscal_calendar') }}
```

**Fiscal Calendar Rules:**
- Every date filter goes through `dim_fiscal_calendar` — no `DATE_TRUNC('month', date)` for fiscal periods
- `fiscal_period` is the canonical join key for period-level reports
- Hardcoded `WHERE fiscal_year = 2024` breaks every year — use `{{ var("fiscal_year") }}`

## Security Surface

| Risk | Control |
|---|---|
| PII in compensation data | Column-level masking on `salary`, `bonus`, `equity_value` for all roles except HR/finance. Test masking works. |
| GL access by cost center | Row-level security by org hierarchy. Test cross-boundary access is denied. |
| Audit trail integrity | No `DELETE` on financial transaction tables. Soft delete with `void_reason`, `voided_at`. Test that DELETE attempts fail. |
| Calculation changes (SOX) | Document what changed and why in model description. Approval trail for logic changes. |

## Anti-Patterns

| Anti-pattern | Fix |
|---|---|
| Hardcoded fiscal year in WHERE clause | Use `{{ var("fiscal_year") }}` or join through fiscal calendar |
| Unreconciled totals shipped | Reconcile before every release; document variance |
| No primary key tests on GL entries | `unique` + `not_null` on `journal_entry_id`, `line_item_id` |
| Calendar month used as fiscal period | Always join through `dim_fiscal_calendar` |
| Mixing rate types in currency conversion | Pick one rate type per report; document it |
| NRR calculated without cohort isolation | NRR must be same-cohort — don't mix new customers in |
| MRR waterfall without movement classification | Every delta must be classified: new/expansion/contraction/churn |
| `DELETE` for financial corrections | Soft delete with void markers only |
| No tolerance threshold defined | Define and document variance tolerance per metric upfront |
