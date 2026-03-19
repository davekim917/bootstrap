---
name: cortex-code
description: >
  Invoke Snowflake Cortex Code CLI for complex Snowflake-native workflows: deploying Streamlit apps,
  creating Cortex Agents, building Snowflake Intelligence agents, generating dbt models, schema
  discovery, and catalog exploration. Use when the task requires Snowflake-native capabilities beyond
  raw SQL. Do not use for simple SQL queries (use snow sql instead). Triggers on "cortex", "cortex
  code", "cortex agent", "streamlit deploy", "snowflake intelligence", "snowflake agent".
---

# Cortex Code CLI Integration

Cortex Code is Snowflake's AI coding agent CLI (built on Claude Code). It has native access to
Snowflake schema introspection, SQL execution, Streamlit deployment, Cortex Agent creation, dbt
model generation, and Airflow DAG optimization.

## When to Use Cortex Code vs snow CLI

| Task | Tool |
|------|------|
| Run a SQL query | `snow sql -q "SELECT ..."` |
| List/manage Snowflake objects | `snow object list ...` |
| Deploy a Streamlit app | `cortex` |
| Create a Cortex Agent | `cortex` |
| Build a Snowflake Intelligence agent | `cortex` |
| Generate dbt models from schema | `cortex` |
| Explore schema, lineage, RBAC | `cortex` |
| Optimize Airflow DAGs | `cortex` |
| Complex multi-step Snowflake workflows | `cortex` |

**Rule of thumb:** If it's a single SQL statement or object operation, use `snow`. If it requires
Snowflake-native AI capabilities, schema awareness, or multi-step orchestration, use `cortex`.

## Invocation Pattern

### Non-interactive (single prompt, get result)

```bash
cortex -p "your prompt here" -c <connection> --dangerously-allow-all-tool-calls
```

### Non-interactive with JSON output (for parsing)

```bash
cortex -p "your prompt here" -c <connection> --dangerously-allow-all-tool-calls --output-format stream-json
```

### With a working directory (for file creation like Streamlit apps)

```bash
cortex -p "your prompt here" -c <connection> -w /workspace/group --dangerously-allow-all-tool-calls
```

## Key Flags

| Flag | Purpose |
|------|---------|
| `-p "prompt"` | Non-interactive: pass prompt, print response, exit |
| `-c <connection>` | Select Snowflake connection from connections.toml |
| `-w <path>` | Working directory for file operations |
| `--dangerously-allow-all-tool-calls` | Skip permission prompts (required for non-interactive use) |
| `--output-format stream-json` | JSON output for scripting/parsing |
| `-m <model>` | Override AI model (default: auto) |
| `--continue` | Resume most recent conversation |
| `-r <session-id>` | Resume specific session |

## Connection Selection

Cortex Code reads connections from `~/.snowflake/connections.toml` (same as snow CLI). Always
specify `-c <connection>` to target the correct Snowflake account. Available connections depend
on which are configured for your environment.

## Example Workflows

### Create a Cortex Agent

```bash
cortex -p "Create a Cortex Agent for inventory management that can answer questions about stock levels, reorder points, and supplier lead times using the INVENTORY schema in the ANALYTICS database. Deploy it to Snowflake Intelligence." -c apollo -w /workspace/group --dangerously-allow-all-tool-calls
```

### Deploy a Streamlit App

```bash
cortex -p "Build an interactive Streamlit dashboard showing revenue by region with date filters using the SALES_MART.REVENUE table. Deploy it to Snowflake." -c apollo -w /workspace/group --dangerously-allow-all-tool-calls
```

### Generate dbt Models

```bash
cortex -p "Create dbt staging models for all tables in the RAW.STRIPE schema. Follow the dbt style guide with proper materialization configs and tests." -c apollo -w /workspace/group --dangerously-allow-all-tool-calls
```

### Schema Discovery

```bash
cortex -p "List all tables tagged with PII=TRUE and show their data lineage" -c apollo --dangerously-allow-all-tool-calls
```

## Important Notes

- Cortex Code is a nested AI agent — it runs its own Claude session. This means additional LLM
  cost and latency on top of the outer agent. Use it surgically for workflows it's uniquely good
  at, not as a general-purpose Snowflake interface.
- Cortex Code creates files in its working directory. Always use `-w` to control where files land.
- Sessions are stored in `~/.snowflake/cortex/conversations/`. Use `--continue` or `-r` to resume.
- For long-running tasks (Streamlit deploy, agent creation), expect 30-120 seconds of execution.
