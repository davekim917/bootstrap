---
name: analytics
description: Analytics practice patterns for dashboards, reports, metrics, KPIs, and business intelligence. Covers Looker, Tableau, Power BI, Metabase, SQL analysis, metric definitions, and data visualization best practices. Use when reviewing or building dashboards, reports, metrics, or analytical queries. Do not use for dbt/SQL data transformation (use analytics-engineering), data pipeline engineering (use data-engineering), or ML model development (use data-science).
---

# Analytics Practice

Domain-specific patterns and checklists for analytics and BI work.

## Scope

- Dashboards and reports
- Metric definitions and KPIs
- Ad-hoc analysis
- Data visualization
- Self-service analytics
- Stakeholder communication

## Code Review Checklist

### SQL Queries
- [ ] Query is readable (formatted, commented)
- [ ] Joins are correct (inner vs left vs full)
- [ ] Aggregations at correct grain
- [ ] Filters applied correctly
- [ ] Date ranges appropriate
- [ ] No accidental cross joins
- [ ] Performance acceptable (no full scans on large tables)
- [ ] Results validated against known values

### Metric Definitions
- [ ] Clear business definition documented
- [ ] Calculation logic explicit
- [ ] Grain/granularity defined
- [ ] Edge cases handled (nulls, zeros, divisions)
- [ ] Time zone handling explicit
- [ ] Consistent with other metrics
- [ ] Source of truth identified

### Dashboards
- [ ] Clear title and description
- [ ] Filters work correctly
- [ ] Date ranges make sense
- [ ] Visualizations appropriate for data type
- [ ] Color usage accessible and meaningful
- [ ] Mobile/responsive if needed
- [ ] Performance acceptable (load time)
- [ ] Drill-down paths logical

### Data Visualization
- [ ] Chart type matches data (bar for comparison, line for trend)
- [ ] Axes labeled with units
- [ ] Legend clear and positioned well
- [ ] Colors accessible (colorblind-friendly)
- [ ] No misleading scales (truncated axes noted)
- [ ] Context provided (benchmarks, targets)

## Architecture Patterns

### Metric Definition Template
```yaml
metric:
  name: monthly_active_users
  display_name: Monthly Active Users (MAU)

  definition: >
    Count of unique users who performed at least one
    qualifying action in the trailing 28 days.

  calculation:
    sql: |
      COUNT(DISTINCT user_id)
      WHERE event_date >= DATEADD(day, -28, CURRENT_DATE)
        AND event_type IN ('login', 'purchase', 'view')

  grain: daily snapshot

  dimensions:
    - region
    - platform
    - user_segment

  owner: analytics-team

  notes:
    - Excludes bot traffic
    - Includes both free and paid users
    - 28-day rolling window, not calendar month
```

### Dashboard Structure
```
Dashboard: [Business Area] Overview

Section 1: KPI Summary
  - Metric cards with sparklines
  - Period comparison (vs prior period, vs target)

Section 2: Trends
  - Time series of key metrics
  - Appropriate granularity (daily, weekly, monthly)

Section 3: Breakdown
  - Dimension analysis (by segment, region, product)
  - Tables or bar charts

Section 4: Details
  - Drill-through to underlying data
  - Filters for exploration
```

### SQL Analysis Template
```sql
/*
Analysis: [Title]
Author: [Name]
Date: [Date]
Purpose: [What question are we answering?]

Key Findings:
- [Finding 1]
- [Finding 2]
*/

-- Step 1: Define base population
WITH base AS (
    SELECT *
    FROM source_table
    WHERE date_column BETWEEN '2024-01-01' AND '2024-12-31'
),

-- Step 2: Calculate metrics
metrics AS (
    SELECT
        dimension,
        COUNT(*) as count,
        SUM(revenue) as total_revenue,
        AVG(value) as avg_value
    FROM base
    GROUP BY dimension
),

-- Step 3: Add comparisons/context
final AS (
    SELECT
        *,
        total_revenue / SUM(total_revenue) OVER () as pct_of_total
    FROM metrics
)

SELECT * FROM final
ORDER BY total_revenue DESC
```

## Visualization Guidelines

### Chart Type Selection
| Data Type | Recommended Chart |
|-----------|------------------|
| Trend over time | Line chart |
| Category comparison | Bar chart (horizontal if many categories) |
| Part of whole | Stacked bar, pie (≤5 slices) |
| Distribution | Histogram, box plot |
| Correlation | Scatter plot |
| Geographic | Map |
| KPI/single number | Scorecard with context |

### Color Usage
- Use consistent color palette across dashboards
- Reserve red/green for good/bad (with patterns for accessibility)
- Limit to 5-7 distinct colors
- Use sequential colors for continuous values
- Use diverging colors for positive/negative

### Axis Guidelines
- Start y-axis at zero for bar charts
- Label axes with units
- Use appropriate scale (linear vs log)
- Note if axis is truncated
- Use consistent scales across related charts

## Common Anti-Patterns

- ❌ Vanity metrics without actionability
- ❌ Inconsistent metric definitions across reports
- ❌ Dashboards with no clear purpose
- ❌ Too many metrics (cognitive overload)
- ❌ Missing date context (when was this?)
- ❌ Pie charts with too many slices
- ❌ Truncated axes without noting it
- ❌ No drill-down capability
- ❌ Stale data without freshness indicator

## Metric Categories

### North Star Metrics
- Primary success measure
- Aligned with business value
- Actionable and understandable
- Example: Monthly Active Users, Revenue

### Input Metrics
- Leading indicators
- Controllable by teams
- Drive North Star
- Example: Sign-ups, Feature adoption

### Health Metrics
- Guardrails to prevent harm
- Example: Error rate, Churn rate

## Technology-Specific Notes

### Looker/LookML
- Use explores for self-service
- Define metrics in LookML (single source of truth)
- Use derived tables for complex logic
- Document dimensions and measures

### Tableau
- Use extracts for performance
- Organize worksheets logically
- Use parameters for interactivity
- Publish data sources for reuse

### Metabase
- Use models for complex queries
- Set up questions with filters
- Use dashboards for narratives
- Archive unused questions

### SQL Performance
- Add indexes for filter columns
- Use approximate counts for large tables
- Materialize frequently-used aggregations
- Limit date ranges by default
