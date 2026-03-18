---
name: software-engineering
description: >
  Software engineering practice patterns for full-stack web development, APIs, backend services,
  and frontend applications. Covers TypeScript, JavaScript, Python, React, Next.js, Node.js,
  REST APIs, GraphQL, authentication, testing, CI/CD, AWS, GCP, Docker, serverless, monorepos,
  and deployment. Use when reviewing or building web applications, microservices, full-stack
  projects, backend services, or cloud infrastructure. Do not use for data pipelines, ML models,
  analytics dashboards, dbt projects, LLM integration (use llm-engineering), or agent systems
  (use agentic-systems).
---

# Software Engineering Practice

Domain-specific patterns and checklists for software engineering work.

## Scope

- Web applications (frontend and backend)
- REST and GraphQL APIs
- Microservices, monoliths, serverless
- Authentication and authorization
- Testing strategies (unit, integration, E2E)
- CI/CD and deployment
- Cloud infrastructure (AWS, GCP)
- Monorepo tooling (Nx, Turborepo)

## Code Review Checklist

### API/Backend
- [ ] Authentication on all protected routes
- [ ] Input validation at API boundary (schema validation, not ad-hoc checks)
- [ ] Proper error handling with structured error responses
- [ ] No sensitive data in responses or logs
- [ ] Correct HTTP status codes (200, 201, 400, 401, 403, 404, 422, 500)
- [ ] Cache invalidation after mutations
- [ ] Rate limiting on public endpoints
- [ ] Request/response types defined

### Frontend
- [ ] Component architecture (server vs client separation, RSC vs CSR)
- [ ] Responsive design (mobile-first)
- [ ] Accessibility (ARIA labels, keyboard navigation, focus management, contrast)
- [ ] Loading states and error boundaries
- [ ] No hardcoded values (constants, env vars, design tokens)
- [ ] Form validation with user feedback
- [ ] Optimistic updates where appropriate

### Database/ORM
- [ ] Migrations are atomic and reversible
- [ ] Indexes on frequently queried and joined columns
- [ ] Foreign keys with appropriate cascade behavior
- [ ] Row-level security or application-level access control
- [ ] No N+1 queries (eager loading where needed)
- [ ] Connection pooling configured

### Testing
- [ ] Unit tests for business logic
- [ ] Integration tests for API endpoints
- [ ] E2E tests for critical user flows
- [ ] Test data isolated (no production data in tests)
- [ ] Mocks for external services

## Architecture Patterns

### API Design
```
GET    /api/resources             # List (paginated, filterable)
POST   /api/resources             # Create
GET    /api/resources/:id         # Get single
PATCH  /api/resources/:id         # Partial update
DELETE /api/resources/:id         # Soft delete preferred
POST   /api/resources/:id/actions # Non-CRUD actions (e.g., /publish)
```

### Layered Architecture
```
routes/         # HTTP routing only — no logic
controllers/    # Request/response handling, input validation
services/       # Business logic — framework-agnostic
repositories/   # Data access — all DB calls here
```

### Error Response Format
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "User-friendly message",
    "details": [{"field": "email", "message": "Invalid format"}]
  }
}
```

### Component Structure (React/Next.js)
```
components/
  feature/
    FeatureContainer.tsx    # Data fetching, state
    FeaturePresenter.tsx    # Pure display (props-only)
    FeatureForm.tsx         # User input, form state
    feature.test.tsx        # Tests
    index.ts                # Public exports
```

## Authentication Patterns

### JWT (API/SPA)
```typescript
// Server: sign on login
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET!,
  { expiresIn: "15m" }  // Short-lived access token
);
// Use refresh tokens (7d) to rotate access tokens without re-login

// Client: store access token in memory, refresh token in httpOnly cookie
// NEVER store access tokens in localStorage (XSS risk)
```

### Session-based (Server-rendered apps)
```typescript
// Use httpOnly, Secure, SameSite=Strict cookies
// Regenerate session ID on privilege escalation (login, role change)
// Store sessions in Redis for horizontal scaling
```

### OAuth2 / OIDC
```typescript
// Use an established library — don't implement OAuth flows from scratch
// Next.js: next-auth / auth.js
// Node.js: passport.js, openid-client
// Python: authlib, python-social-auth
// Validate the state parameter on callback — CSRF protection
// Verify JWT signature and claims (iss, aud, exp) on every request
```

### API Keys
```typescript
// Hash API keys before storing (SHA-256 is fine — keys are high entropy)
const hashedKey = crypto.createHash("sha256").update(rawKey).digest("hex");
// Show the raw key once on creation — never store it in plaintext
// Include key prefix (first 8 chars) for user identification without exposing key
```

## Cloud Patterns (AWS/GCP)

### AWS Service Defaults
| Workload | Service | Notes |
|---|---|---|
| HTTP API | API Gateway + Lambda OR ECS | Lambda for bursty; ECS for sustained load |
| Static assets | S3 + CloudFront | Always add CDN; S3 alone has no caching |
| Database (relational) | RDS Aurora Serverless v2 | Auto-scales; use Postgres engine |
| Database (cache) | ElastiCache Redis | Session store, rate limiter, hot data |
| Queue | SQS | FIFO for ordered processing; Standard for throughput |
| Background jobs | Lambda + SQS | Decouple from request path immediately |
| File uploads | Pre-signed S3 URLs | Client uploads directly — don't proxy through API |
| Secrets | Secrets Manager | Not SSM Parameter Store for secrets |

### IAM Principles
- Least privilege always — start with deny-all, add minimum needed
- Use execution roles on Lambda/ECS, not access keys in environment
- Rotate access keys on schedule; prefer roles over long-lived credentials
- Never use root account credentials in application code

### Serverless (Lambda) Patterns
```typescript
// Keep Lambda handlers thin — delegate to service layer
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const body = parseAndValidate(event.body);  // Validate here
    const result = await myService.process(body);  // All logic in service
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    return handleError(e);  // Consistent error response
  }
};

// Cold start mitigation
// - Keep dependencies minimal
// - Initialize clients outside handler (reused across invocations)
// - Use Provisioned Concurrency for latency-sensitive paths
const dbClient = new DatabaseClient();  // Outside handler — reused
```

### Infrastructure as Code
```hcl
# Terraform — all cloud resources in code
# No clicking in the console for production resources
# State in S3 + DynamoDB lock
# Environments via workspaces or separate state files
# Tag all resources: team, environment, service
```

## Monorepo Patterns

### Turborepo (Node.js/TypeScript)
```json
// turbo.json — define pipeline dependencies
{
  "pipeline": {
    "build": {"dependsOn": ["^build"], "outputs": ["dist/**"]},
    "test": {"dependsOn": ["build"]},
    "lint": {}
  }
}
```
- Shared packages in `packages/` (e.g., `packages/ui`, `packages/types`, `packages/utils`)
- Apps in `apps/` (e.g., `apps/web`, `apps/api`, `apps/mobile`)
- Remote caching via Vercel or self-hosted — CI time drops dramatically

### Package Boundaries
- UI components: separate package, zero business logic
- Shared types: separate package imported by all apps
- Business logic: stays in app layer — don't prematurely share
- Never circular dependencies between packages

## Security Checklist

- [ ] No secrets in code (environment variables only)
- [ ] HTTPS enforced (redirect HTTP → HTTPS, HSTS header)
- [ ] CORS configured correctly (allowlist, not `*`)
- [ ] CSRF protection on state-mutating endpoints
- [ ] SQL injection prevented (parameterized queries — ORMs handle this)
- [ ] XSS prevented (output encoding; `dangerouslySetInnerHTML` requires review)
- [ ] Auth tokens in httpOnly cookies (not localStorage)
- [ ] Passwords hashed with bcrypt or argon2
- [ ] Rate limiting on auth endpoints
- [ ] Security headers (CSP, X-Frame-Options, etc.)

## Performance Checklist

- [ ] Database queries have appropriate indexes
- [ ] N+1 queries eliminated
- [ ] Static assets cached with long TTL + content hash
- [ ] Lazy loading for large components/routes
- [ ] API responses paginated (cursor-based preferred for large datasets)
- [ ] Caching strategy defined (Redis, CDN, browser, stale-while-revalidate)
- [ ] Bundle size analyzed (avoid large dependencies for browser code)

## Common Anti-Patterns

| Anti-pattern | Fix |
|---|---|
| Business logic in controllers | Move to services layer |
| Direct DB access in components | Use data layer / repository |
| Catching errors without handling them | Handle or rethrow with context |
| `any` type in TypeScript without justification | Use `unknown` and narrow |
| Inline styles instead of design system tokens | Use CSS-in-JS or Tailwind consistently |
| No loading/error states in UI | Every async operation needs three states |
| Blocking the request with background work | Queue it (SQS, BullMQ, pg_notify) |
| Secrets in environment files committed to git | Use secrets manager; `.env.local` in `.gitignore` |
| `console.log` in production | Structured logging (pino, winston) with log levels |

## Technology-Specific Notes

### TypeScript
- Enable `strict: true` — non-negotiable
- Prefer `unknown` over `any`; use discriminated unions for state machines
- `zod` for runtime schema validation at API boundary
- Use `satisfies` operator for type-safe config objects

### React / Next.js
- Server Components by default; add `"use client"` only when needed (events, browser APIs)
- React Query / TanStack Query for server state; Zustand for client state
- Avoid `useEffect` for derived state — use `useMemo`
- `next/image` and `next/font` always — they handle optimization automatically

### Node.js
- `async/await` throughout; catch unhandled rejections at process level
- Structure: routes → controllers → services → repositories
- `pino` for structured logging; avoid `console.log` in production

### Python (FastAPI/Django)
- Pydantic models on all endpoints (FastAPI does this natively)
- `async` handlers for I/O-bound work; sync for CPU-bound (offload to workers)
- `alembic` for migrations (not auto-migrate in production)
- `pytest` + `httpx` for testing FastAPI; `pytest-django` for Django
