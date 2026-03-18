# Security Baseline Checklist

Used when no project `security-review-gates` skill exists, or as a quick inline check for
non-security-critical files before deciding whether to invoke the `security-reviewer` agent.

If the changed files touch auth, user data, or external APIs — always invoke `security-reviewer`
agent regardless of this baseline. This checklist is for quick triage, not deep analysis.

---

## Input Validation

- [ ] All user-supplied input is validated before use (type, format, length, allowed values)
- [ ] Validation happens at system boundaries — not assumed to be clean from internal callers
- [ ] File uploads: file type and size validated, not just the extension
- [ ] Query parameters and path params: validated and sanitized before use in queries or logic

**Flag if:** Input flows directly into a query, command, or template without validation.

---

## Injection Risks

**SQL Injection:**
- [ ] No string interpolation into SQL queries
- [ ] Parameterized queries / prepared statements used throughout
- [ ] ORM methods used correctly (no raw query with user input)

**Command Injection:**
- [ ] No user input passed to `exec()`, `spawn()`, `system()`, `eval()`, or shell commands
- [ ] If shell commands needed: input sanitized with an allowlist, not a denylist

**XSS (frontend):**
- [ ] No `dangerouslySetInnerHTML` with unsanitized content
- [ ] No `innerHTML =` with user-controlled values
- [ ] Template literals that render HTML use proper escaping

---

## Authentication and Authorization

- [ ] Protected routes have auth middleware applied
- [ ] Auth checks happen server-side, not just client-side
- [ ] Resource ownership verified before returning data (user can only read their own data)
- [ ] Admin-only operations have role checks, not just auth checks
- [ ] Password handling: bcrypt or argon2 (never MD5, SHA1, or plaintext)
- [ ] JWT: signature verified on every request, expiry checked

**Flag if:** A route returns user data without verifying the requester owns it.

---

## Secrets and Credentials

- [ ] No API keys, tokens, passwords, or connection strings in source code
- [ ] No secrets in comments or commit messages
- [ ] Environment variables used for all secrets (`.env` file, not hardcoded)
- [ ] `.env` files not committed (check `.gitignore`)
- [ ] Secrets not logged (log statements don't include token values, passwords, or PII)

**Flag if:** Any string that looks like a key/token/password appears in source code.

---

## Error Handling

- [ ] Error responses do not expose stack traces to the client
- [ ] Error responses do not expose internal file paths or DB schema details
- [ ] Generic error messages to users; detailed errors only in server logs
- [ ] Errors are caught and handled — no unhandled promise rejections in async paths

---

## Sensitive Data Exposure

- [ ] Passwords, tokens, SSNs, credit card numbers never returned in API responses
- [ ] PII fields (email, phone, address) not logged
- [ ] Sensitive fields excluded from serialization (not just hidden in UI)
- [ ] HTTPS enforced for any external API calls that transmit credentials

---

## Rate Limiting and Abuse

- [ ] Auth endpoints (login, password reset) have rate limiting
- [ ] File upload endpoints have size limits enforced server-side
- [ ] Search/list endpoints are paginated (no unbounded result sets)

---

## Data Domain Security

Apply these checks when changed files include SQL models, notebooks, pipelines, ML code, or
metric definitions. These supplement (not replace) the checks above.

### PII and Sensitive Data

- [ ] No PII (emails, names, phone numbers, SSNs, financial account numbers) in committed notebook outputs
- [ ] No PII in hardcoded test data within SQL models or pipeline code
- [ ] Sensitive columns masked or excluded in downstream models (`_hashed`, `_masked`, or omitted)
- [ ] Query results used in dashboards do not expose individual-level sensitive data without access controls
- [ ] Model training data does not include sensitive fields unless explicitly required and documented

### Pipeline and Notebook Credentials

- [ ] No connection strings, API keys, or passwords in DAG definitions or pipeline configs
- [ ] No credentials in Jupyter notebook cells (use environment variables or secrets manager)
- [ ] dbt `profiles.yml` not committed to repo (check `.gitignore`)
- [ ] Warehouse credentials use service accounts, not personal credentials, in production pipelines
- [ ] `.env` or `secrets/` files for pipeline configs excluded from version control

### Data Access Controls

- [ ] Warehouse roles and permissions follow least-privilege (no `GRANT ALL` in migrations)
- [ ] Row-level security applied where required (multi-tenant data, customer-specific views)
- [ ] Column-level masking applied for sensitive fields in shared views/dashboards
- [ ] Data retention policies documented for any newly created tables holding PII

---

## When to Escalate to `security-reviewer` Agent

Invoke the `security-reviewer` agent (not this checklist) when changed files include:
- Authentication or session management code
- Authorization / permissions / role checks
- Payment processing or financial data
- File upload handling
- External API integrations that handle credentials
- Cryptography or hashing
- Any code that was flagged for security in the `/team-review` stage
- Notebooks or pipelines that process PII or financial data
- DAGs with credential/secrets management (connection configs, vault access)
- SQL models or views that expose sensitive fields to broad roles
- ML training data with sensitive attributes (protected characteristics, financial data)
- Data retention or deletion logic
