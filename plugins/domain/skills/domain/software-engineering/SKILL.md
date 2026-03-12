---
name: software-engineering
description: Software engineering practice patterns for web development, APIs, backend services, and frontend applications. Covers TypeScript, JavaScript, Python, React, Node.js, REST APIs, GraphQL, authentication, testing, and deployment. Use when reviewing or building web applications, microservices, or full-stack projects. Do not use for data pipelines, ML models, analytics dashboards, dbt projects, or AI/LLM integration (use ai-integration for those).
---

# Software Engineering Practice

Domain-specific patterns and checklists for software engineering work.

## Scope

- Web applications (frontend and backend)
- REST and GraphQL APIs
- Microservices and monoliths
- Authentication and authorization
- Testing strategies
- CI/CD and deployment

## Code Review Checklist

### API/Backend
- [ ] Authentication on protected routes
- [ ] Input validation at API boundary (schema validation preferred)
- [ ] Proper error handling with try/catch
- [ ] No sensitive data in responses or logs
- [ ] Appropriate HTTP status codes (200, 201, 400, 401, 403, 404, 500)
- [ ] Cache invalidation after mutations
- [ ] Rate limiting on public endpoints
- [ ] Request/response typing

### Frontend
- [ ] Component architecture (server vs client separation if applicable)
- [ ] Responsive design (mobile-first)
- [ ] Accessibility (ARIA labels, keyboard navigation, focus management)
- [ ] Loading states and error boundaries
- [ ] No hardcoded values (use constants, env vars, design tokens)
- [ ] Event propagation handled on nested interactives
- [ ] Form validation with user feedback
- [ ] Optimistic updates where appropriate

### Database/ORM
- [ ] Migrations are atomic and reversible
- [ ] Indexes on frequently queried columns
- [ ] Foreign keys with appropriate cascade behavior
- [ ] Row-level security or application-level access control
- [ ] No N+1 queries (use eager loading)
- [ ] Connection pooling configured

### Testing
- [ ] Unit tests for business logic
- [ ] Integration tests for API endpoints
- [ ] E2E tests for critical user flows
- [ ] Test data isolated (no production data)
- [ ] Mocks for external services

## Architecture Patterns

### API Design
```
GET    /api/resources          # List (paginated)
POST   /api/resources          # Create
GET    /api/resources/:id      # Get single
PATCH  /api/resources/:id      # Partial update
DELETE /api/resources/:id      # Delete
```

### Error Response Format
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "User-friendly message",
    "details": []
  }
}
```

### Component Structure (React/Vue/Svelte)
```
components/
  feature/
    FeatureContainer.tsx    # Data fetching, state
    FeaturePresenter.tsx    # Pure display
    FeatureForm.tsx         # User input
    feature.test.tsx        # Tests
    index.ts                # Public exports
```

## Security Checklist

- [ ] No secrets in code (use environment variables)
- [ ] HTTPS enforced
- [ ] CORS configured correctly
- [ ] CSRF protection on mutations
- [ ] SQL injection prevented (parameterized queries)
- [ ] XSS prevented (output encoding, CSP headers)
- [ ] Authentication tokens stored securely (httpOnly cookies preferred)
- [ ] Password hashing with bcrypt/argon2

## Performance Checklist

- [ ] Database queries optimized (indexes, pagination)
- [ ] No N+1 queries
- [ ] Static assets cached and compressed
- [ ] Lazy loading for large components/routes
- [ ] API responses paginated
- [ ] Caching strategy defined (Redis, CDN, browser)

## Common Anti-Patterns

- ❌ Business logic in controllers (move to services)
- ❌ Direct database access in components (use data layer)
- ❌ Catching errors without handling them
- ❌ Console.log in production code
- ❌ Any type in TypeScript without justification
- ❌ Inline styles instead of design system
- ❌ Prop drilling instead of context/state management
- ❌ Missing loading/error states

## Technology-Specific Notes

### TypeScript
- Prefer `unknown` over `any`
- Use discriminated unions for state
- Enable strict mode

### React
- Prefer function components with hooks
- Use React Query/SWR for server state
- Avoid useEffect for derived state

### Node.js
- Use async/await over callbacks
- Handle unhandled rejections
- Structure: routes → controllers → services → repositories

### Python
- Type hints on function signatures
- Use pydantic for validation
- Async with FastAPI, sync with Flask/Django
