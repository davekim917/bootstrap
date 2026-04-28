# Common Patterns Library

Ready-to-use regex and glob patterns for skill descriptions and trigger design. Reference these when writing skill descriptions to ensure the right keywords and patterns are included.

---

## Intent Patterns (Regex)

### Feature/Endpoint Creation
```regex
(add|create|implement|build).*?(feature|endpoint|route|service|controller)
```

### Component Creation
```regex
(create|add|make|build).*?(component|UI|page|modal|dialog|form)
```

### Database Work
```regex
(add|create|modify|update).*?(user|table|column|field|schema|migration)
(database|prisma).*?(change|update|query)
```

### Error Handling
```regex
(fix|handle|catch|debug).*?(error|exception|bug)
(add|implement).*?(try|catch|error.*?handling)
```

### Explanation Requests
```regex
(how does|how do|explain|what is|describe|tell me about).*?
```

### Workflow Operations
```regex
(create|add|modify|update).*?(workflow|step|branch|condition)
(debug|troubleshoot|fix).*?workflow
```

### Testing
```regex
(write|create|add).*?(test|spec|unit.*?test)
```

---

## File Path Patterns (Glob)

### Frontend
```glob
frontend/src/**/*.tsx        # All React components
frontend/src/**/*.ts         # All TypeScript files
frontend/src/components/**   # Only components directory
```

### Backend Services
```glob
form/src/**/*.ts            # Form service
email/src/**/*.ts           # Email service
users/src/**/*.ts           # Users service
projects/src/**/*.ts        # Projects service
```

### Database
```glob
**/schema.prisma            # Prisma schema (anywhere)
**/migrations/**/*.sql      # Migration files
database/src/**/*.ts        # Database scripts
```

### Workflows
```glob
form/src/workflow/**/*.ts              # Workflow engine
form/src/workflow-definitions/**/*.json # Workflow definitions
```

### Test Exclusions
```glob
**/*.test.ts                # TypeScript tests
**/*.test.tsx               # React component tests
**/*.spec.ts                # Spec files
```

---

## Content Patterns (Regex)

### Prisma/Database
```regex
import.*[Pp]risma                # Prisma imports
PrismaService                    # PrismaService usage
prisma\.                         # prisma.something
\.findMany\(                     # Prisma query methods
\.create\(
\.update\(
\.delete\(
```

### Controllers/Routes
```regex
export class.*Controller         # Controller classes
router\.                         # Express router
app\.(get|post|put|delete|patch) # Express app routes
```

### Error Handling
```regex
try\s*\{                        # Try blocks
catch\s*\(                      # Catch blocks
throw new                        # Throw statements
```

### React/Components
```regex
export.*React\.FC               # React functional components
export default function.*       # Default function exports
useState|useEffect              # React hooks
```

---

---

**Related Files:**
- [SKILL.md](../SKILL.md) - Main skill guide
- [TRIGGER_TYPES.md](TRIGGER_TYPES.md) - Trigger type concepts
