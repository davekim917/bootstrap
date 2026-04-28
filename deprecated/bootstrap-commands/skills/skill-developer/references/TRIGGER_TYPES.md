# Trigger Types - Conceptual Guide

Understanding the types of patterns that drive skill activation. Use these concepts when writing skill descriptions — the description is the primary activation mechanism, and embedding the right keywords and intent phrases is what makes a skill discoverable.

## Table of Contents

- [Keyword Triggers (Explicit)](#keyword-triggers-explicit)
- [Intent Pattern Triggers (Implicit)](#intent-pattern-triggers-implicit)
- [File Path Triggers](#file-path-triggers)
- [Content Pattern Triggers](#content-pattern-triggers)
- [Best Practices Summary](#best-practices-summary)

---

## Keyword Triggers (Explicit)

### How It Works

Case-insensitive substring matching in user's prompt against keywords in the skill description.

### Use For

Topic-based activation where user explicitly mentions the subject.

### Example

- User prompt: "how does the **layout** system work?"
- Description contains: "layout", "grid"
- Skill activates based on keyword match

### Best Practices

- Use specific, unambiguous terms in descriptions
- Include common variations ("layout", "layout system", "grid layout")
- Avoid overly generic words ("system", "work", "create")
- Include 5+ specific keywords from real user workflows

---

## Intent Pattern Triggers (Implicit)

### How It Works

Matching user intent even when they don't mention the topic explicitly. The description's "Use when..." clauses capture these patterns.

### Use For

Action-based activation where user describes what they want to do rather than the specific topic.

### Examples

**Database Work:**
- User prompt: "add user tracking feature"
- Description says: "Use when adding features that touch the database"
- Skill activates based on intent match

**Component Creation:**
- User prompt: "create a dashboard widget"
- Description says: "Use when creating UI components"
- Skill activates based on intent match

### Best Practices

- Capture common action verbs in "Use when..." clauses: create, add, modify, build, implement
- Include domain-specific nouns: feature, endpoint, component, workflow
- Don't make trigger conditions too broad (causes false positives)
- Don't make trigger conditions too specific (causes false negatives)

### Common Intent Patterns

```
# Database Work
adding/creating features that touch users, auth, or data models

# Frontend Work
creating/building components, UI elements, pages, modals, forms

# Error Handling
fixing/debugging errors, exceptions, or bugs

# Workflow Operations
creating/modifying workflows, steps, branches, conditions
```

---

## File Path Triggers

### How It Works

Activation based on what files are being edited. Descriptions should mention the file types and directories the skill applies to.

### Use For

Domain/area-specific activation based on file location in the project.

### Description Patterns

Include file types and directory patterns in descriptions:
- "Use when editing `.tsx` files in the frontend"
- "Use when modifying Prisma schema or migration files"
- "Use when working with files in `src/workflow/`"

### Common Path References

```
# Frontend
frontend/src/**/*.tsx        # All React components
frontend/src/components/**   # Only components directory

# Database
**/schema.prisma            # Prisma schema (anywhere)
**/migrations/**/*.sql      # Migration files

# Workflows
src/workflow/**/*.ts        # Workflow engine files
```

### Best Practices

- Be specific about directories and file types in descriptions
- Mention file extensions explicitly (".tsx", ".prisma", ".sql")
- Reference directory names users would recognize

---

## Content Pattern Triggers

### How It Works

Activation based on what the code imports or uses. Descriptions should mention the specific technologies and libraries.

### Use For

Technology-specific activation based on frameworks, libraries, or patterns in the code.

### Description Patterns

Include technology names and import patterns:
- "Covers Prisma, TypeORM, and database query patterns"
- "Use when code imports React hooks or component libraries"
- "Use when working with Express controllers or route handlers"

### Common Technologies to Reference

```
# Database/ORM
Prisma, TypeORM, Drizzle, Sequelize, Knex

# Frontend Frameworks
React, Next.js, Vue, Svelte, Angular

# Backend Frameworks
Express, Fastify, NestJS, Hono

# Data Tools
dbt, Airflow, Dagster, Spark, Kafka
```

### Best Practices

- Name specific technologies and libraries in descriptions
- Include both the library name and common usage patterns
- Reference import patterns users would recognize

---

## Best Practices Summary

### DO:

- Use specific, unambiguous keywords in descriptions
- Include "Use when..." clauses with concrete trigger conditions
- Include "Do not use for..." boundaries to prevent false positives
- Name specific technologies, file types, and directories
- Include 5+ keywords from actual user workflows
- Test activation with real prompts

### DON'T:

- Use overly generic terms ("system", "work", "code")
- Make descriptions too broad (activates on everything)
- Make descriptions too narrow (never activates)
- Omit out-of-scope boundaries

---

**Related Files:**
- [SKILL.md](../SKILL.md) - Main skill guide
- [PATTERNS_LIBRARY.md](PATTERNS_LIBRARY.md) - Ready-to-use pattern library
