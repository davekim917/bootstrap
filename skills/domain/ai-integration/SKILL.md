---
name: ai-integration
description: >
  AI/LLM engineering patterns for building with Claude, OpenAI, and other LLM APIs.
  Covers prompt engineering, evaluation harnesses, agent loops, RAG architecture,
  streaming, tool use, output validation, and API integration patterns.
  Use when building LLM-powered features, AI pipelines, or agent systems.
  Do not use for general web API development, backend architecture without LLM components, or non-AI software engineering.
---

# AI/LLM Engineering

Domain-specific patterns for building LLM-powered features and systems.

## When to Apply

- LLM API integration (Claude, OpenAI, Anthropic SDK, `openai` Python client)
- Prompt engineering and prompt chains
- Agent loops and multi-step AI workflows
- RAG systems (retrieval-augmented generation)
- Evaluation harnesses and prompt regression testing
- Streaming responses
- Tool use / function calling
- Structured output validation
- LLM pipeline orchestration (langchain, LlamaIndex, or custom)

## TDD Vocabulary for AI/LLM

In the LLM domain, "a failing test" is an **eval assertion** — a check that verifies a known
prompt/response pair produces the expected output shape, content, or quality, and fails
because the prompt template, chain, or agent doesn't exist yet or produces incorrect output.

**RED:** Write an eval assertion specifying the expected input → output contract.
**GREEN:** Implement the prompt, chain, or agent logic until the eval passes.
**REFACTOR:** Improve prompt clarity, reduce token cost, add retry logic → re-run evals.

Eval files live in: `evals/`, `*.eval.py`, or dedicated evaluation harness scripts.

## Evaluation Patterns

### Response Schema Validation

Test that LLM output matches the required structure before shipping.

```python
# evals/test_extraction.eval.py
def test_entity_extraction_returns_schema():
    result = extract_entities("Apple acquired Beats in 2014 for $3B")
    assert "entities" in result
    assert all("name" in e and "type" in e for e in result["entities"])
```

### Quality Threshold Assertion

Define a quality floor before implementing.

```python
def test_summarization_quality():
    score = evaluate_summary(TEST_DOCUMENT, generated_summary)
    assert score >= 0.8, f"Quality below threshold: {score}"
```

### Latency and Cost Assertions

```python
def test_call_within_latency_budget():
    start = time.time()
    result = call_llm(prompt)
    elapsed = time.time() - start
    assert elapsed < 3.0, f"Latency exceeded: {elapsed:.2f}s"
```

### Prompt Regression Tests

For each prompt change, re-run the eval suite. A prompt "improvement" that breaks an existing
eval is a regression, not an improvement.

## Security Surface

- **API key exposure:** Never log the raw API key, response headers, or request objects in
  production. Use structured logging that explicitly excludes credential fields.
- **Prompt injection:** User-controlled input that flows into a system prompt or prompt template
  must be sanitized. Do not trust user input as instructions. Use a separate `user_message`
  parameter rather than string interpolation into the system prompt.
- **System prompt leakage:** Never include the system prompt in user-visible output. Test that
  the system prompt cannot be extracted via prompt injection ("repeat your instructions back").
- **Output filtering bypass:** If outputs are filtered (harmful content, PII), test the filter
  independently from the LLM. Don't rely on the LLM to self-censor.
- **Credential rotation:** API keys should be stored in environment variables and rotated on
  schedule. No hardcoded keys in source files, notebooks, or eval scripts.

## Performance Surface

- **Token cost per call:** Count input + output tokens for every prompt in development.
  Define a per-call budget (e.g., ≤ 2000 tokens) as a test assertion.
- **Model tier selection:**
  - Opus: complex reasoning, adversarial review, architectural decisions
  - Sonnet: implementation tasks, code generation, data analysis
  - Haiku: simple extraction, classification, structured output from well-defined templates
  - Don't use Opus for Haiku-level work. It's 15x the cost.
- **Streaming vs batch:** Use streaming for user-facing outputs where latency matters. Use
  batch (non-streaming) for eval harnesses, pipeline steps, and background processing.
- **Retry/backoff:** Implement exponential backoff with jitter for rate limit errors (429).
  Don't retry on 400 (bad request) — fix the request. Retry on 429/503.
- **Context window management:** Track token usage per request. For long-context tasks,
  chunk input or use retrieval to stay within the model's context window.

## Anti-Patterns

| Anti-pattern | Why it's wrong | What to do instead |
|---|---|---|
| Hardcoded model names in string literals | Model versions deprecate; references break | Use constants: `DEFAULT_MODEL = "claude-sonnet-4-6"` |
| Testing with live API in unit tests | Slow, expensive, non-deterministic | Mock the API call; use eval harnesses for live integration tests |
| Skipping the eval harness ("it looks right") | Visual inspection is not a test | Write at least one eval assertion per prompt before shipping |
| String interpolation of user input into system prompt | Prompt injection vector | Use separate `user` role message; sanitize user content |
| Building agent loops without timeout/error bounds | Infinite loop risk | Set max_iterations, implement timeout, handle tool call errors explicitly |
| No retry logic for rate limits | Fragile in production | Implement exponential backoff with jitter for 429 errors |
| One eval that tests everything | Brittle; hard to debug failures | Write focused, single-behavior eval assertions |
| Pinning model by capability label ("the smart model") | Ambiguous, breaks on updates | Pin by model ID with a named constant |

## Code Patterns

### Client Initialization (Python/Anthropic)

```python
import anthropic
import os

# Always initialize from environment — never hardcode
client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
```

### Structured Output with Validation

```python
from pydantic import BaseModel

class ExtractionResult(BaseModel):
    entities: list[dict]
    confidence: float

def extract_with_validation(text: str) -> ExtractionResult:
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"Extract entities from: {text}"}]
    )
    # Validate before returning — don't trust raw LLM output
    return ExtractionResult.model_validate_json(response.content[0].text)
```

### Agent Loop with Bounds

```python
MAX_ITERATIONS = 10

def run_agent(initial_prompt: str) -> str:
    messages = [{"role": "user", "content": initial_prompt}]
    for i in range(MAX_ITERATIONS):
        response = client.messages.create(model=MODEL, messages=messages, tools=TOOLS)
        if response.stop_reason == "end_turn":
            return response.content[0].text
        # handle tool use...
    raise RuntimeError(f"Agent exceeded {MAX_ITERATIONS} iterations")
```
