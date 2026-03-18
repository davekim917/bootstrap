---
name: agentic-systems
description: >
  Agentic systems design patterns for autonomous AI agents, multi-agent architectures,
  tool design, MCP integration, memory systems, and agent safety. Covers agent loop design,
  ReAct patterns, orchestrator/worker patterns, tool definitions, human-in-the-loop workflows,
  agent evaluation, LangGraph, CrewAI, AutoGen, Claude agent SDK, and production agent
  deployment. Use when designing or building agents that make decisions and take actions,
  multi-agent pipelines, tool-using systems, MCP servers/clients, or autonomous workflows.
  Use when user mentions "agent", "agentic", "autonomous", "multi-agent", "MCP server",
  "tool use", "orchestrator", "subagent", "memory system", or "agent loop". Do not use
  for LLM API integration without agent behavior (use llm-engineering), general software
  engineering, or analytics work.
---

# Agentic Systems

Design patterns for autonomous agents, multi-agent architectures, tool design, and agent safety.

## Mental Model

An agent is a system where **an LLM decides what to do next** — selecting tools, calling
subagents, or producing a final answer — in a loop. The key distinction from LLM engineering:
the LLM has **agency over its own execution path**, not just its output.

## Scope

- Agent loop design (ReAct, plan-and-execute, reflection)
- Multi-agent architectures (orchestrator/worker, peer-to-peer, hierarchical)
- Tool design and MCP server/client implementation
- Memory systems (short-term, long-term, episodic, semantic)
- Human-in-the-loop checkpoints
- Agent safety and guardrails
- Agent evaluation and observability
- Orchestration frameworks: LangGraph, CrewAI, AutoGen, Claude Code Agent SDK

## Agent Loop Patterns

### ReAct (Reason + Act) — Standard Pattern
```python
MAX_ITERATIONS = 10

def run_agent(goal: str, tools: list) -> str:
    messages = [{"role": "user", "content": goal}]
    for i in range(MAX_ITERATIONS):
        response = client.messages.create(
            model=DEFAULT_MODEL,
            tools=tools,
            messages=messages,
        )
        if response.stop_reason == "end_turn":
            return extract_final_answer(response)
        if response.stop_reason == "tool_use":
            tool_results = execute_tool_calls(response)
            messages = append_tool_results(messages, response, tool_results)
    raise AgentLoopError(f"Agent did not complete in {MAX_ITERATIONS} iterations")
```

**Every agent loop must have:**
- Explicit `MAX_ITERATIONS` cap — never unbounded
- Explicit exit on `end_turn` and `tool_use` only
- Error handling for tool failures that doesn't silently continue
- Logging of every tool call and result for observability

### Plan-and-Execute Pattern
```python
# Step 1: Generate a plan (separate LLM call)
plan = planner_llm.generate_plan(goal)  # Returns list of steps

# Step 2: Execute each step with a worker agent
for step in plan.steps:
    result = worker_agent.execute(step, context=accumulated_context)
    accumulated_context.append(result)
    if result.requires_replanning:
        plan = planner_llm.replan(goal, accumulated_context)

# Step 3: Synthesize
return synthesizer_llm.summarize(goal, accumulated_context)
```

### Reflection Pattern
```python
def agent_with_reflection(goal: str) -> str:
    draft = worker_agent.execute(goal)
    critique = critic_llm.evaluate(goal, draft)  # Separate LLM call as critic
    if critique.needs_revision:
        return worker_agent.revise(draft, critique.feedback)
    return draft
```

## Multi-Agent Architecture Patterns

### Orchestrator / Worker

```
Orchestrator (decision-making LLM)
├── Worker A: specialized task
├── Worker B: specialized task
└── Worker C: specialized task
```

- Orchestrator breaks goals into tasks, assigns to workers, synthesizes results
- Workers receive bounded tasks with explicit output contracts
- Workers do NOT call other workers directly — all routing through orchestrator
- Use when: tasks are parallelizable, domain expertise varies across subtasks

### Peer-to-Peer (Debate / Review)

```
Agent 1 ←→ Agent 2 ←→ Agent 3
```

- Agents review each other's work, challenge assumptions
- Produces higher-quality outputs for adversarial review, red-teaming, design review
- Termination: consensus reached, N rounds complete, or human judgment requested
- Use when: output quality matters more than speed, adversarial review improves outcome

### Hierarchical (Nested Agents)

```
Lead Agent
└── Sub-orchestrator A
    ├── Worker A1
    └── Worker A2
└── Sub-orchestrator B
    ├── Worker B1
    └── Worker B2
```

- Use when: task scope is very large and requires domain decomposition
- Risk: context fragmentation, coordination overhead, difficult debugging
- Rule: max 3 levels deep. Deeper hierarchies are architecture smell.

## Tool Design

### Tool Contract
```python
# Every tool must define:
# 1. What it does (description — the LLM reads this)
# 2. Input schema (JSON Schema — strict types, required fields)
# 3. Output schema (document in description)
# 4. Failure behavior (what the LLM sees on error)

SEARCH_TOOL = {
    "name": "search_knowledge_base",
    "description": (
        "Search the internal knowledge base for information. "
        "Returns up to 5 relevant chunks with source metadata. "
        "Returns empty list if nothing found — do not assume failure."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural language search query"},
            "limit": {"type": "integer", "description": "Max results, default 5", "default": 5},
        },
        "required": ["query"]
    }
}
```

### Tool Error Handling
```python
def execute_tool(tool_name: str, tool_input: dict) -> dict:
    try:
        result = TOOL_REGISTRY[tool_name](**tool_input)
        return {"status": "success", "result": result}
    except Exception as e:
        # Return error to agent — don't raise — let agent decide next step
        return {
            "status": "error",
            "error": str(e),
            "suggestion": "Try a different approach or report to the user"
        }
```

### Tool Evaluation
Every tool must have tests before the agent uses it:
```python
def test_search_tool_returns_results():
    result = search_knowledge_base(query="revenue recognition rules")
    assert result["status"] == "success"
    assert len(result["result"]) > 0

def test_search_tool_handles_empty_results():
    result = search_knowledge_base(query="xyzzy123nonexistent")
    assert result["status"] == "success"
    assert result["result"] == []
```

## MCP (Model Context Protocol)

### MCP Server Structure
```python
from mcp.server import Server
from mcp.types import Tool, TextContent

server = Server("my-mcp-server")

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(name="get_customer", description="Fetch customer by ID",
             inputSchema={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]})
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "get_customer":
        customer = await db.get_customer(arguments["id"])
        return [TextContent(type="text", text=customer.model_dump_json())]
    raise ValueError(f"Unknown tool: {name}")
```

**MCP Server Checklist:**
- [ ] All tools have descriptions the LLM can reason from
- [ ] Input schemas are strict (use `required` and `additionalProperties: false`)
- [ ] Errors return TextContent with clear explanation, not Python exceptions
- [ ] No side effects in list_tools (it's called frequently)
- [ ] Authentication if the server exposes sensitive data

## Memory Systems

| Memory type | What it stores | Implementation |
|---|---|---|
| Short-term (working) | Current conversation context | Messages array in the loop |
| Long-term (persistent) | Facts, preferences, history across sessions | Vector store + key-value store |
| Episodic | Past task outcomes, what worked/didn't | Structured log with retrieval |
| Semantic | Domain knowledge, reference data | RAG over documents |

### Long-Term Memory Pattern
```python
# On write — save after each task completion
memory_store.upsert(
    id=task_id,
    content={"goal": goal, "outcome": outcome, "approach": approach},
    embedding=embed(f"{goal} {outcome}")
)

# On read — retrieve relevant memories before each task
relevant = memory_store.search(embed(current_goal), top_k=3)
context = "\n".join(m.content for m in relevant)
# Inject context into agent's system prompt
```

## Human-in-the-Loop (HITL)

```python
HITL_TRIGGERS = [
    "irreversible action",   # delete, send, publish, deploy
    "high-confidence threshold not met",
    "unexpected state encountered",
    "explicit agent uncertainty",
]

def should_pause_for_human(action: AgentAction, confidence: float) -> bool:
    return (
        action.is_irreversible or
        confidence < 0.85 or
        action.estimated_cost_usd > 50
    )

# When pausing:
# 1. Present agent's plan to user with full context
# 2. Show what action is about to be taken
# 3. Allow approve / reject / redirect
# 4. Log the human decision and rationale
```

## Agent Safety

| Risk | Guardrail |
|---|---|
| Infinite loops | `MAX_ITERATIONS` cap, enforced in every agent loop |
| Runaway costs | Token budget per run; cost-based HITL trigger |
| Prompt injection via tool results | Sanitize tool output before injecting into context |
| Irreversible actions | HITL checkpoint before any destructive operation |
| Scope creep | Agent charter — explicit list of allowed tools and domains |
| Inter-agent trust | Agents do not trust peer agents by default; validate outputs |

```python
# Agent charter pattern — scope restriction
AGENT_CHARTER = {
    "allowed_tools": ["search", "summarize", "draft_email"],
    "forbidden_tools": ["send_email", "delete_record", "execute_sql"],
    "max_iterations": 15,
    "max_cost_usd": 0.50,
    "requires_human_approval": ["send_email"],  # Even if allowed
}
```

## Agent Evaluation

### Trajectory Evaluation
Don't just evaluate the final output — evaluate the path taken.

```python
def evaluate_agent_trajectory(trajectory: list[AgentStep], expected_tools: list[str]) -> dict:
    used_tools = [step.tool_name for step in trajectory if step.is_tool_call]
    return {
        "final_answer_correct": check_answer(trajectory[-1].output),
        "tool_efficiency": len(used_tools) / len(expected_tools),  # > 1.0 = inefficient
        "unnecessary_tool_calls": [t for t in used_tools if t not in expected_tools],
        "iterations": len(trajectory),
    }
```

### Failure Mode Taxonomy

| Failure | Signal | Fix |
|---|---|---|
| Tool hallucination | Agent calls non-existent tool | Enumerate tools exhaustively in system prompt |
| Goal drift | Agent pursues subgoal, forgets original goal | Include original goal in every iteration context |
| Over-delegation | Agent creates unnecessary subagents | Limit sub-agent creation to explicit tool |
| Stuck in loop | Same tool called with same args repeatedly | Detect repeated calls; inject "try a different approach" |
| Context overflow | Agent loses track after many iterations | Summarize context periodically; trim history |

## Anti-Patterns

| Anti-pattern | Fix |
|---|---|
| Unbounded agent loops | Always set `MAX_ITERATIONS` |
| Agent calling itself recursively | Detect circular delegation; forbid same-agent calls |
| Tool errors raising Python exceptions | Return structured error dict; let agent reason about recovery |
| No observability | Log every tool call, result, and iteration — agent behavior is invisible otherwise |
| Agentic RAG without retrieval evaluation | Measure retrieval precision; bad retrieval corrupts every downstream step |
| One giant agent for everything | Decompose by domain or specialization; focused agents outperform generalists |
| Trusting inter-agent outputs blindly | Validate outputs from peer agents, especially for structured data |
| No HITL on irreversible actions | Always checkpoint before delete, send, publish, deploy |
