Run /review-swarm on this changed dbt model. It is the only change in the diff.

File: `models/marts/fct_customer_revenue.sql`

```sql
{{ config(materialized='table') }}

with customers as (
    select customer_id, customer_name, region
    from {{ ref('dim_customers') }}
),

orders as (
    select order_id, customer_id, order_total, order_date
    from {{ ref('stg_orders') }}
),

payments as (
    select payment_id, order_id, payment_amount, payment_method
    from {{ ref('stg_payments') }}
)

select
    c.customer_id,
    c.customer_name,
    c.region,
    sum(o.order_total) as total_revenue,
    sum(p.payment_amount) as total_paid
from customers c
left join orders o on c.customer_id = o.customer_id
join payments p on o.order_id = p.order_id
group by 1, 2, 3
```

Context: an order can have multiple payments (installments). `dim_customers` is one row
per customer. Downstream dashboards read `total_revenue` as the source of truth for
revenue per customer.
