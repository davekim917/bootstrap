/**
 * Shared decision + gate logic for the destructive-command guard.
 *
 * This module is PURE LOGIC + the session-DB approval gate. It performs NO process.exit, NO stdin
 * read, and has NO `main()` / self-execution at import time. The Claude Code
 * hook (`block-destructive.ts`) and a future opencode plugin both import from
 * here; each owns its own I/O surface (stdin read, stderr emit, process exit).
 *
 * Three-tier rm protection:
 *   1. Always allow: rm targeting ephemeral dirs (tmp, node_modules, build caches) — checked first
 *   2. Always block: rm targeting /, ~, $HOME, or protected home directories
 *   3. Redirect: all other rm → instructs Claude to use `trash` instead (recoverable)
 *
 * Also always blocks: unlink, shred, truncate, eval, shell -c wrappers,
 *                     find -exec rm, find -delete, xargs rm
 *
 * Infrastructure gates (require user approval, then allow on retry):
 *   Databases: Snowflake, PostgreSQL, MySQL, DuckDB, MongoDB, SQLite, Redis
 *   Cloud: AWS, GCP/gcloud, Azure, DigitalOcean
 *   IaC: Terraform, Pulumi, CDK
 *   Containers: Docker, kubectl, Helm
 *   Platforms: Render, Railway, Fly.io, Heroku, Vercel, Netlify, Supabase
 *   Services: GitHub CLI, Cloudflare/wrangler, Firebase
 *   Data: dbt --full-refresh
 *   System: dd with if=
 *
 * Known limitations:
 *   - Interpreter-based deletion (python -c os.remove, perl -e unlink) is not detected
 *   - mv, cp /dev/null, and redirect-based truncation (> file) are not in scope
 */
import { realpathSync, existsSync, unlinkSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { resolve as pathResolve } from 'path';
import { parse } from 'unbash';

// ── NanoClaw detection ──────────────────────────────────────────────────────
// When running inside a NanoClaw v2 container, gated commands request approval
// via the session DBs mounted at /workspace/{inbound,outbound}.db — the same
// request_bash_gate primitive the email gate uses. The host's bash-gate module
// picks up the outbound system action, delivers an ask_question approval card
// to the configured admin, and writes the decision back to inbound.db's
// `delivered` table. We poll that table here.
//
// v1 used file IPC (NANOCLAW_IPC_DIR/queries/{id}.json + query_responses/);
// v2 deleted that surface. Don't detect via env vars — detect via the DB files
// themselves, since their paths are load-bearing constants in v2's agent-runner
// (see container/agent-runner/src/db/connection.ts).
export const NANOCLAW_OUTBOUND_DB = '/workspace/outbound.db';
export const NANOCLAW_INBOUND_DB = '/workspace/inbound.db';
export const IS_NANOCLAW = existsSync(NANOCLAW_OUTBOUND_DB) && existsSync(NANOCLAW_INBOUND_DB);

// ── Types ────────────────────────────────────────────────────────────────────

/** A command extracted from the AST with wrapper commands (sudo, env, etc.) resolved */
export interface ResolvedCommand {
    name: string;               // resolved command name (e.g., "rm", "aws", "kubectl")
    args: string[];             // argument values after wrapper stripping
    raw: string;                // original text for error messages
    hasInputRedirect: boolean;  // true if command has << or <<< redirects
}

export interface DestructiveMatch {
    pattern: string;
    statement: string;
}

export type GateDecision = 'approved' | 'denied' | 'timeout';

/** Outcome of evaluating a bash command against all guard tiers. */
export interface GateEvaluation {
    action: 'allow' | 'block' | 'gate';
    reason?: string;
}

// ── git-clone destination guard (ADVISORY workflow nudge — NOT a security boundary) ──
// The agent already has RW to every managed dir, so this does NOT prevent
// access; it nudges agents toward the create_worktree / clone_repo MCP tools
// (credential scoping, auto-commit safety, index registration) instead of an
// ad-hoc `git clone`. It blocks a `git clone` whose command text contains a
// literal managed-dir path (incl. clone-to-/tmp-then-`mv` where that path is
// literal). KNOWN, ACCEPTED RESIDUAL BYPASSES (advisory, not airtight):
//   • a bare `git clone <url>` with NO path lands in the cwd (often
//     /workspace/agent) — not caught: no literal managed path in the command;
//   • `git -C <managed> clone`, a renamed git binary, a pre-staged symlink, and
//     `cd <managed>; git clone <url> rel/dir` also evade it.
// Closing these needs cwd+relative-target resolution; deferred. The real
// enforcement is that clone_repo is the sanctioned path. (The sibling
// snowflake-connector guard labels itself the same way.)
//
// SINGLE SOURCE OF TRUTH for all provider adapters (Claude SDK hook, OpenCode
// plugin, Codex runner). The conformance suite pins these verdicts; do not fork
// the policy into a provider adapter.
export const GIT_CLONE_RE = /\bgit\s+clone\b/;
export const GIT_CLONE_MANAGED_DIR_RE = /\/workspace\/(?:agent|worktrees|workgroup|global|extra|thread|plugins)\b/;
export const GIT_CLONE_BLOCK_REASON =
    'Ad-hoc `git clone` into a managed dir (/workspace/{agent,worktrees,workgroup,...}) is blocked. Use the `create_worktree` MCP tool for an existing repo, or `clone_repo` to add a new one. If the clone is ephemeral, keep the entire command within /tmp.';

/** Verdict for the git-clone guard. Intentionally NARROWER than GateEvaluation
 *  (no `gate`) so every adapter can treat any non-`allow` as a block and never
 *  fail-open on an unexpected verdict. Pure — no I/O. */
export type GitCloneVerdict = { action: 'allow' | 'block'; reason?: string };

export function evaluateGitCloneDestination(command: string): GitCloneVerdict {
    if (!command || !GIT_CLONE_RE.test(command)) return { action: 'allow' };
    if (GIT_CLONE_MANAGED_DIR_RE.test(command)) {
        return { action: 'block', reason: GIT_CLONE_BLOCK_REASON };
    }
    return { action: 'allow' };
}

// ── Self-approval block (ADVISORY → BLOCK) ──
// Ported verbatim from nanoclaw-v2 claude.ts:462-484 (createSelfApprovalBlockHook).
// The bootstrap/plugins/workflow plugin's block-destructive hook gates
// destructive filesystem ops behind a file-based approval at
// `.claude-destructive-gate`. This evaluator prevents the agent from bypassing
// that gate by writing the approval file itself via Bash (`touch
// .claude-destructive-gate`, `echo … > .claude-destructive-gate`, etc.).
// Admin approval must come through the chat channel, not the agent's own
// filesystem writes.
//
// SINGLE SOURCE OF TRUTH for all provider adapters. Pure — no env/IO,
// deterministic on `command`. Verdict shape matches evaluateGitCloneDestination.
export const SELF_APPROVAL_RE = /\.claude-destructive-gate/;
export const SELF_APPROVAL_BLOCK_REASON =
    'Self-approval of destructive operation gates is not allowed. Approval must come from the user via the chat channel, not by writing .claude-destructive-gate yourself.';

export function evaluateSelfApproval(command: string): { action: 'allow' | 'block'; reason?: string } {
    if (!command) return { action: 'allow' };
    if (SELF_APPROVAL_RE.test(command)) {
        return { action: 'block', reason: SELF_APPROVAL_BLOCK_REASON };
    }
    return { action: 'allow' };
}

// ── Block ad-hoc Python snowflake.connector (ADVISORY → BLOCK) ──
// Ported verbatim from nanoclaw-v2 claude.ts:486-512 (createBlockSnowflakeConnectorHook).
// `snow` CLI is gated by destructive-operation controls (and scoped
// credential mounts); the Python connector bypasses those. Only blocks
// direct python execution — grep, echo, pip install, and existing
// scripts that happen to contain the string are unaffected.
//
// This is ADVISORY, not a security boundary. The regex is bypassable
// with base64-decoded source, heredocs, script files, or point-version
// binaries (python3.11). The real mitigation is only mounting Snowflake
// credentials when the snow CLI is actually invoked — a larger arch
// change. In the current model the guard nudges the agent toward `snow
// sql` for normal cases and raises the friction for unintended paths.
//
// Pure — no env/IO, deterministic on `command`.
export const SNOWFLAKE_CONNECTOR_EXEC_RE = /\bpython[23]?\b.*\bsnowflake[._]connector\b/i;
export const SNOWFLAKE_CONNECTOR_BLOCK_REASON =
    "Direct use of Python snowflake.connector is blocked. Use `snow sql` for ad-hoc queries. If `snow` isn't working, report the error rather than falling back to the Python connector.";

export function evaluateSnowflakeConnector(command: string): { action: 'allow' | 'block'; reason?: string } {
    if (!command) return { action: 'allow' };
    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) {
        return { action: 'block', reason: SNOWFLAKE_CONNECTOR_BLOCK_REASON };
    }
    return { action: 'allow' };
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();

export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// Command wrappers that should be stripped to find the real command
export const WRAPPERS = new Set([
    'sudo', 'env', 'command', 'builtin', 'nohup', 'time', 'nice', 'timeout', 'gtimeout',
]);

// Protected home subdirectories — rm targeting anything inside these is blocked
export const PROTECTED_HOME_DIRS = [
    // Personal data
    'Documents', 'Desktop', 'Downloads', 'Library',
    'Pictures', 'Music', 'Movies',
    // Security / credentials
    '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.1password',
    // AI / agent tooling
    '.claude', '.codex', '.agents', '.cursor',
    // Dev environment (painful to rebuild)
    '.nvm', '.cargo', '.npm',
    // App config
    '.config',
];

// Ephemeral dirs where rm is unconditionally allowed
export const SAFE_PATH_PATTERNS = [
    /(?:^|\/)tmp(?:\/|$)/,
    /(?:^|\/)node_modules(?:\/|$)/,
    /(?:^|\/)\.next(?:\/|$)/,
    /(?:^|\/)dist(?:\/|$)/,
    /(?:^|\/)build(?:\/|$)/,
    /(?:^|\/)\.cache(?:\/|$)/,
    /(?:^|\/)out(?:\/|$)/,
    /(?:^|\/)coverage(?:\/|$)/,
    /(?:^|\/)\.turbo(?:\/|$)/,
    /(?:^|\/)__pycache__(?:\/|$)/,
    /(?:^|\/)\.pytest_cache(?:\/|$)/,
    /(?:^|\/)\.mypy_cache(?:\/|$)/,
    /(?:^|\/)storybook-static(?:\/|$)/,
    /(?:^|\/)\.claude\/discovery(?:\/|$)/,   // bootstrap artifacts (recreated every run)
    /(?:^|\/)\.agents\/skills(?:\/|$)/,      // Codex mirror (rebuilt from .claude/skills/)
    /(?:^|\/)\.codex\/skills(?:\/|$)/,       // optional legacy Codex mirror
];

// Destructive SQL patterns, anchored to statement-leading. Each pattern fires
// only after string literals, comments, and CTE preambles are stripped (see
// findDestructiveSqlStatement) — so substrings inside `'%DROP TABLE%'` and
// keyword-like identifiers in `"DROP TABLE archive"` do not match.
const DDL_DROP_TARGETS =
    '(?:TABLE|SCHEMA|DATABASE|VIEW|PROCEDURE|FUNCTION|OWNED|TRIGGER|INDEX|MATERIALIZED\\s+VIEW)';
const DDL_REPLACE_TARGETS =
    '(?:TABLE|VIEW|MATERIALIZED\\s+VIEW|TEMP(?:ORARY)?\\s+TABLE|EXTERNAL\\s+TABLE|FUNCTION|PROCEDURE|TRIGGER)';

export const DESTRUCTIVE_SQL_PATTERNS: Array<{ rx: RegExp; label: string }> = [
    { rx: new RegExp(`^DROP\\s+${DDL_DROP_TARGETS}\\b`, 'i'), label: 'DROP' },
    { rx: /^TRUNCATE\b/i, label: 'TRUNCATE' },
    { rx: /^DELETE\s+FROM\b/i, label: 'DELETE FROM' },
    { rx: new RegExp(`^CREATE\\s+OR\\s+REPLACE\\s+${DDL_REPLACE_TARGETS}\\b`, 'i'), label: 'CREATE OR REPLACE' },
    { rx: /^INSERT\s+OVERWRITE\b/i, label: 'INSERT OVERWRITE' },
    { rx: /^MERGE\s+INTO\b/i, label: 'MERGE' },
    // After string-strip, a DROP keyword inside a string literal cannot reach
    // this check, so anywhere-in-statement matching is safe.
    { rx: /^ALTER\b[\s\S]*\bDROP\b/i, label: 'ALTER ... DROP' },
];

const UPDATE_LEADING = /^UPDATE\b/i;
const HAS_WHERE = /\bWHERE\b/i;

// Cheap superset prefilter — if none of these verbs appear anywhere in the
// SQL arg, no destructive pattern can match. Skips the full strip+scan
// pipeline on SELECT-only queries (the common case).
const SQL_PREFILTER = /\b(?:DROP|TRUNCATE|DELETE|MERGE|UPDATE|INSERT|CREATE|ALTER|EXECUTE)\b/i;

// Hoisted to module scope — these regexes are matched per-segment / per-call
// inside the SQL scanner; defining them inline would recompile on every
// invocation.
const WITH_LEADING = /^WITH\b/i;
const WITH_PREFIX = /^WITH\s+(?:RECURSIVE\s+)?/i;
const CTE_NAME_AS = /^(?:"\s*"|"[^"]*"|`[^`]*`|[A-Za-z_][\w$]*)\s*(?:\([^)]*\))?\s+AS\s+/i;
const EXECUTE_IMMEDIATE = /EXECUTE\s+IMMEDIATE\s+/gi;
const DOLLAR_TAG = /^\$([A-Za-z0-9_]*)\$/;

const STATEMENT_PREVIEW_CHARS = 200;
const SQL_RECURSION_LIMIT = 3;

// MongoDB destructive methods
export const DESTRUCTIVE_MONGO = /(?:\bdropDatabase\b|\.drop\s*\(|\.deleteMany\s*\(|\.remove\s*\()/i;

// SQL CLI name → display label
export const SQL_CLIS: Record<string, string> = {
    psql: 'PostgreSQL', mysql: 'MySQL', duckdb: 'DuckDB',
    sqlite3: 'SQLite', sqlite: 'SQLite',
};

// ── SQL parsing helpers ──────────────────────────────────────────────────────

/**
 * Strip SQL string literals and comments out of `sql`, replacing their
 * contents with spaces of equal length. Length-preserving so the output
 * shares offsets with the input — the caller can split on `;` and trust the
 * boundaries to match the original source.
 *
 * Handles:
 *   - line comments (`-- ...`)
 *   - block comments (`/* ... *\/`, non-nested)
 *   - single-quoted strings with `''` escape
 *   - double-quoted identifiers (Postgres/Snowflake) with `""` escape
 *   - backtick identifiers (MySQL)
 *   - dollar-quoted strings (`$$...$$`, `$tag$...$tag$` — Postgres/Snowflake)
 *
 * Not a real SQL parser. Constructs that produce destructive effects from
 * inside a string literal — the most realistic being EXECUTE IMMEDIATE —
 * are handled separately by findExecuteImmediateLiterals + recursion in
 * findDestructiveSqlStatement.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        const c2 = sql.slice(i, i + 2);

        if (c2 === '--') {
            const nl = sql.indexOf('\n', i);
            const end = nl < 0 ? sql.length : nl;
            out.push(' '.repeat(end - i));
            i = end;
            continue;
        }
        if (c2 === '/*') {
            const close = sql.indexOf('*/', i + 2);
            const end = close < 0 ? sql.length : close + 2;
            out.push(' '.repeat(end - i));
            i = end;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            const start = i;
            i += 1;
            while (i < sql.length) {
                if (sql[i] === quote && sql[i + 1] === quote) {
                    i += 2; // SQL doubled-quote escape
                    continue;
                }
                if (sql[i] === quote) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            // Replace whole literal (quotes included) with spaces, length-preserving
            out.push(quote + ' '.repeat(Math.max(0, i - start - 2)) + quote);
            continue;
        }
        if (c === '$') {
            const m = sql.slice(i).match(DOLLAR_TAG);
            if (m) {
                const tag = m[0];
                const start = i + tag.length;
                const close = sql.indexOf(tag, start);
                if (close >= 0) {
                    const end = close + tag.length;
                    out.push(tag + ' '.repeat(close - start) + tag);
                    i = end;
                    continue;
                }
                // Unclosed dollar-quote — stop parsing as code from here, replace rest with spaces
                out.push(' '.repeat(sql.length - i));
                i = sql.length;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    return out.join('');
}

/**
 * Split a `;`-separated SQL segment (already string-stripped) into the list
 * of bodies that need to be destructiveness-checked. For non-CTE statements
 * this is `[{body: segment, isCTE: false}]`; for CTE-prefixed statements
 * (`WITH x AS (...) [, y AS (...)]* <body>`) it returns each CTE body plus
 * the trailing body, so a Postgres-style destructive CTE like `WITH d AS
 * (DELETE FROM foo RETURNING *) SELECT * FROM d` cannot hide its DELETE
 * behind a SELECT trailer.
 */
export function decomposeSqlSegment(skel: string): Array<{ body: string; isCTE: boolean }> {
    const trimmed = skel.trim();
    if (!WITH_LEADING.test(trimmed)) return [{ body: trimmed, isCTE: false }];

    const bodies: Array<{ body: string; isCTE: boolean }> = [];
    let s = trimmed.replace(WITH_PREFIX, '');

    while (s.length > 0) {
        const nameMatch = s.match(CTE_NAME_AS);
        if (!nameMatch) break;
        s = s.slice(nameMatch[0].length);

        if (s[0] !== '(') break;
        let depth = 1;
        let i = 1;
        while (i < s.length && depth > 0) {
            if (s[i] === '(') depth++;
            else if (s[i] === ')') depth--;
            if (depth > 0) i++;
        }
        if (depth !== 0) break; // unbalanced — bail rather than mis-classify
        bodies.push({ body: s.slice(1, i).trim(), isCTE: true });
        s = s.slice(i + 1).trimStart();

        if (s[0] === ',') {
            s = s.slice(1).trimStart();
            continue;
        }
        break;
    }

    if (s.length > 0) bodies.push({ body: s.trim(), isCTE: false });
    return bodies;
}

export function checkSqlBody(body: string, isCTE: boolean): DestructiveMatch | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    const preview = trimmed.slice(0, STATEMENT_PREVIEW_CHARS);

    for (const { rx, label } of DESTRUCTIVE_SQL_PATTERNS) {
        if (rx.test(trimmed)) {
            return { pattern: isCTE ? `CTE-wrapped ${label}` : label, statement: preview };
        }
    }

    // A WHERE inside a subquery still counts as having WHERE — rare false-allow,
    // acceptable since the gate is meant to catch obvious accidents.
    if (UPDATE_LEADING.test(trimmed) && !HAS_WHERE.test(trimmed)) {
        return {
            pattern: isCTE ? 'CTE-wrapped UPDATE without WHERE' : 'UPDATE without WHERE',
            statement: preview,
        };
    }

    return null;
}

/**
 * Find every `EXECUTE IMMEDIATE '...'` literal and return its contents. The
 * keyword scan runs against `skeleton` (already stripped, offsets preserved)
 * so an EXECUTE IMMEDIATE appearing inside a string or comment doesn't
 * trigger recursion. The returned bodies come from `originalSql` so the
 * literal contents are real SQL the recursion can scan.
 */
export function findExecuteImmediateLiterals(originalSql: string, skeleton: string): string[] {
    const literals: string[] = [];
    EXECUTE_IMMEDIATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXECUTE_IMMEDIATE.exec(skeleton)) !== null) {
        const litStart = m.index + m[0].length;
        if (litStart >= originalSql.length) continue;
        const c = originalSql[litStart];
        let body: string | null = null;

        if (c === "'" || c === '"' || c === '`') {
            let i = litStart + 1;
            while (i < originalSql.length) {
                if (originalSql[i] === c && originalSql[i + 1] === c) { i += 2; continue; }
                if (originalSql[i] === c) break;
                i++;
            }
            body = originalSql.slice(litStart + 1, i);
        } else if (c === '$') {
            const tagMatch = originalSql.slice(litStart).match(DOLLAR_TAG);
            if (tagMatch) {
                const tag = tagMatch[0];
                const tagStart = litStart + tag.length;
                const close = originalSql.indexOf(tag, tagStart);
                if (close >= 0) body = originalSql.slice(tagStart, close);
            }
        }

        if (body !== null) literals.push(body);
    }
    return literals;
}

/**
 * Scan `sql` for a destructive statement and return what tripped the gate,
 * or null. Coverage maps to DESTRUCTIVE_SQL_PATTERNS plus UPDATE-without-WHERE,
 * CTE-wrapped DML, and EXECUTE IMMEDIATE recursion.
 *
 * Known residual gaps (out of scope for syntactic checking):
 *   - destructive verbs inside CREATE PROCEDURE / FUNCTION bodies — creation
 *     is non-destructive; CALL is the dangerous moment, but we can't tell
 *     what a procedure does
 *   - dynamic SQL via PREPARE / EXECUTE bind vars
 *   - `UPDATE ... WHERE 1=1` — syntactically has WHERE; semantically rewrites
 *     everything
 */
export function findDestructiveSqlStatement(sql: string, depth: number = 0): DestructiveMatch | null {
    if (depth > SQL_RECURSION_LIMIT) return null;
    if (!SQL_PREFILTER.test(sql)) return null;

    const skeleton = stripSqlLiteralsAndComments(sql);
    for (const segment of skeleton.split(';')) {
        for (const { body, isCTE } of decomposeSqlSegment(segment)) {
            const match = checkSqlBody(body, isCTE);
            if (match) return match;
        }
    }

    for (const literal of findExecuteImmediateLiterals(sql, skeleton)) {
        const inner = findDestructiveSqlStatement(literal, depth + 1);
        if (inner) {
            return { pattern: `EXECUTE IMMEDIATE → ${inner.pattern}`, statement: inner.statement };
        }
    }

    return null;
}

// Platform CLIs → destructive subcommand verbs
export const PLATFORM_DESTRUCTIVE: Record<string, Set<string>> = {
    render:  new Set(['delete', 'down', 'destroy']),
    railway: new Set(['delete', 'down', 'destroy', 'remove']),
    fly:     new Set(['delete', 'destroy']),
    flyctl:  new Set(['delete', 'destroy']),
    doctl:   new Set(['delete', 'destroy']),
};

// ── Path helpers ─────────────────────────────────────────────────────────────

export function expandPath(p: string): string {
    return p
        .replace(/^~(?=\/|$)/, HOME)
        .replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
}

export function normalizePath(p: string): string {
    const expanded = expandPath(p);
    const resolved = pathResolve(expanded);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

export function isProtectedAbsolutePath(abs: string): boolean {
    if (/^\/+$/.test(abs)) return true;
    if (/^\/(?:usr|etc|System|private\/etc|bin|sbin|opt\/homebrew|var|Library|Applications)(?:\/|$)/.test(abs)) return true;
    if (abs === HOME || abs === HOME + '/') return true;
    for (const dir of PROTECTED_HOME_DIRS) {
        const prefix = `${HOME}/${dir}`;
        if (abs === prefix || abs.startsWith(prefix + '/')) return true;
    }
    return false;
}

export function isProtectedPath(p: string): boolean {
    if (/^~\/?$/.test(p) || /^\$\{?HOME\}?\/?$/.test(p) || /^\/+$/.test(p)) return true;
    if (/^~\/\*$/.test(p) || /^\$\{?HOME\}?\/\*$/.test(p)) return true;
    if (/^\/\*/.test(p) || /^\.\.(?:\/|$)/.test(p)) return true;
    return isProtectedAbsolutePath(normalizePath(p));
}

export function isSafePath(p: string): boolean {
    const normalized = normalizePath(p);
    return SAFE_PATH_PATTERNS.some(pat => pat.test(normalized));
}

// ── AST helpers ──────────────────────────────────────────────────────────────

/** Recursively walk an unbash AST node, accumulating all Command nodes into `out` */
export function walkCommandNodes(node: any, out: any[] = []): any[] {
    if (!node) return out;

    if (node.type === 'Command') {
        out.push(node);
        // Recurse into command substitutions embedded in suffix values
        for (const s of (node.suffix || [])) {
            walkPartsForSubstitutions(s, out);
        }
        return out;
    }

    // Recurse into all known container types
    for (const child of (node.commands || [])) {
        walkCommandNodes(child, out);
    }
    if (node.body) walkCommandNodes(node.body, out);
    if (node.command) walkCommandNodes(node.command, out);
    if (node.then) walkCommandNodes(node.then, out);
    if (node.else) walkCommandNodes(node.else, out);
    if (node.condition) walkCommandNodes(node.condition, out);
    for (const clause of (node.clauses || [])) {
        walkCommandNodes(clause, out);
    }

    return out;
}

/** Walk into suffix parts to find CommandSubstitution nodes */
export function walkPartsForSubstitutions(node: any, commands: any[]): void {
    if (!node) return;
    if (node.type === 'CommandSubstitution' || node.type === 'Backtick') {
        commands.push(...walkCommandNodes(node.body || node.command));
    }
    for (const part of (node.parts || [])) {
        walkPartsForSubstitutions(part, commands);
    }
}

/** Resolve a Command AST node: strip wrapper commands, extract name + args */
export function resolveCommand(node: any): ResolvedCommand | null {
    if (!node.name) return null;

    let name = node.name.value || '';
    let args = (node.suffix || []).map((s: any) => s.value ?? s.text ?? '');

    // Strip path prefix (e.g., /usr/bin/rm → rm)
    name = name.replace(/^\/(?:usr\/(?:local\/)?)?(?:s?bin)\//, '');

    // Resolve through wrapper commands
    while (WRAPPERS.has(name) && args.length > 0) {
        let skip = 0;

        if (name === 'sudo') {
            // Skip flags; handle -u/-g/-C which take an argument
            while (skip < args.length && args[skip].startsWith('-')) {
                if (['-u', '-g', '-C'].includes(args[skip]) && skip + 1 < args.length) {
                    skip += 2;
                } else {
                    skip += 1;
                }
            }
        } else if (name === 'env') {
            // Skip flags and VAR=val assignments
            while (skip < args.length && (args[skip].startsWith('-') || /^\w+=/.test(args[skip]))) {
                skip += 1;
            }
        } else if (name === 'nice') {
            if (args[skip] === '-n' && skip + 1 < args.length) skip = 2;
        } else if (name === 'timeout' || name === 'gtimeout') {
            skip = 1; // skip duration argument
        }
        // nohup, time, command, builtin: just skip the wrapper word

        if (skip >= args.length) break;

        name = args[skip].replace(/^\/(?:usr\/(?:local\/)?)?(?:s?bin)\//, '');
        args = args.slice(skip + 1);
    }

    // Check for input redirects (<<, <<<) on the original Command node
    const hasInputRedirect = (node.redirects || []).some((r: any) =>
        ['<<', '<<<', '<<-'].includes(r.operator)
    );

    // Reconstruct raw text for error messages
    const rawParts = [node.name.text || node.name.value, ...(node.suffix || []).map((s: any) => s.text || s.value)];

    return { name, args, raw: rawParts.join(' '), hasInputRedirect };
}

/** Parse command string into resolved commands. Falls back to regex splitting if parser fails. */
export function extractCommands(command: string): ResolvedCommand[] {
    try {
        const ast = parse(command);
        const nodes = walkCommandNodes(ast);
        return nodes.map(resolveCommand).filter((c): c is ResolvedCommand => c !== null);
    } catch {
        return fallbackExtract(command);
    }
}

/** Regex-based fallback for when the AST parser fails */
export function fallbackExtract(command: string): ResolvedCommand[] {
    return command
        .split(/(?:;|&&|\|\||\||\n)\s*/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(seg => {
            const normalized = normalizeCommandFallback(seg);
            const parts = normalized.split(/\s+/);
            return {
                name: parts[0] || '',
                args: parts.slice(1),
                raw: seg,
                hasInputRedirect: /<<<?\s/.test(seg),
            };
        });
}

/** Fallback wrapper stripping (regex-based, used only when parser fails) */
export function normalizeCommandFallback(s: string): string {
    let prev = '';
    let curr = s;
    while (prev !== curr) {
        prev = curr;
        curr = curr
            .replace(/^sudo\s+/, '')
            .replace(/^env(?:\s+(?:-\S+|\w+=\S+))*\s+/, '')
            .replace(/^(?:command|builtin)\s+/, '')
            .replace(/^\/(?:usr\/(?:local\/)?)?bin\//, '')
            .replace(/^(?:nohup|time)\s+/, '')
            .replace(/^nice(?:\s+-n\s+\S+)?\s+/, '')
            .replace(/^(?:timeout|gtimeout)\s+\S+\s+/, '');
    }
    return curr;
}

// ── Hard block checks ────────────────────────────────────────────────────────

/** Returns block reason if the command is unconditionally blocked, null otherwise */
export function checkHardBlock(cmd: ResolvedCommand): string | null {
    // find -exec rm / find -delete
    if (cmd.name === 'find') {
        for (let i = 0; i < cmd.args.length; i++) {
            if ((cmd.args[i] === '-exec' || cmd.args[i] === '-execdir') &&
                (cmd.args[i + 1] === 'rm' || cmd.args[i + 1] === 'sudo')) {
                return 'find -exec rm is not allowed. Use trash for file deletion.';
            }
        }
        if (cmd.args.includes('-delete')) {
            return 'find -delete permanently deletes files. Use trash instead.';
        }
    }

    // xargs rm
    if (cmd.name === 'xargs') {
        if (cmd.args[0] === 'rm' || (cmd.args[0] === 'sudo' && cmd.args[1] === 'rm')) {
            return 'xargs rm is not allowed. Use trash for file deletion.';
        }
    }

    // Shell -c / here-string wrappers — bypass vectors for all other checks
    if (SHELLS.has(cmd.name)) {
        if (cmd.args.includes('-c') || cmd.hasInputRedirect) {
            return 'Shell inline execution (shell -c, here-strings) is not allowed. Run commands directly.';
        }
    }

    // Simple dangerous commands
    if (cmd.name === 'eval') return 'eval is not allowed. Run commands directly.';
    if (cmd.name === 'unlink') return 'unlink permanently deletes files. Use: trash <path>';
    if (cmd.name === 'shred') return 'shred permanently destroys file content. Use: trash <path>';
    if (cmd.name === 'truncate') return 'truncate destroys file content.';

    return null;
}

// ── Gated checks ─────────────────────────────────────────────────────────────

/** Returns gate reason if the command requires approval, null otherwise */
export function checkGatedCommand(cmd: ResolvedCommand): string | null {
    const { name, args } = cmd;

    // ── Databases ────────────────────────────────────────────────────────

    // SQL CLIs: scan each arg for the realistic destructive paths an agent can
    // emit. Coverage and false-positive guards live in findDestructiveSqlStatement.
    const sqlDialect = SQL_CLIS[name] ?? (name === 'snow' && args[0] === 'sql' ? 'Snowflake' : null);
    if (sqlDialect) {
        for (const a of args) {
            const matched = findDestructiveSqlStatement(a);
            if (matched) {
                return `Destructive ${sqlDialect} SQL detected (${matched.pattern}) — ${matched.statement}`;
            }
        }
    }

    // MongoDB
    if ((name === 'mongosh' || name === 'mongo') && args.some(a => DESTRUCTIVE_MONGO.test(a))) {
        return 'Destructive MongoDB command detected (drop/deleteMany/remove).';
    }

    // Redis
    if (name === 'redis-cli' && args.some(a => /^(?:FLUSHDB|FLUSHALL)$/i.test(a))) {
        return 'Destructive Redis command detected (FLUSHDB/FLUSHALL).';
    }

    // ── Cloud providers ──────────────────────────────────────────────────

    if (name === 'aws') {
        if (args[0] === 's3' && ['rm', 'rb'].includes(args[1])) {
            return 'Destructive AWS S3 command (rm/rb).';
        }
        if (args.length >= 2 && /^(?:terminate|delete)/.test(args[1] || '')) {
            return 'Destructive AWS CLI command detected.';
        }
    }
    if (name === 'gcloud' && args.includes('delete')) {
        return 'Destructive gcloud command detected.';
    }
    if (name === 'gsutil' && ['rm', 'rb'].includes(args[0])) {
        return 'Destructive gsutil command (rm/rb).';
    }
    if (name === 'az' && args.includes('delete')) {
        return 'Destructive Azure CLI command detected.';
    }
    if (name === 'doctl' && args.some(a => a === 'delete' || a === 'destroy')) {
        return 'Destructive DigitalOcean CLI command detected.';
    }

    // ── Infrastructure as Code ───────────────────────────────────────────

    if (name === 'terraform') {
        if (args[0] === 'destroy') return 'Destructive Terraform command (destroy).';
        if (args[0] === 'apply' && args.includes('-auto-approve')) {
            return 'Destructive Terraform command (apply -auto-approve).';
        }
    }
    if (name === 'pulumi' && args[0] === 'destroy') return 'Pulumi destroy detected.';
    if (name === 'cdk' && args[0] === 'destroy') return 'CDK destroy detected.';

    // ── Containers / orchestration ───────────────────────────────────────

    if (name === 'kubectl' && ['delete', 'drain', 'cordon'].includes(args[0])) {
        return 'Destructive kubectl command.';
    }
    if (name === 'docker') {
        if (['rm', 'rmi'].includes(args[0])) return 'Destructive Docker command.';
        if (args[0] === 'system' && args[1] === 'prune') return 'Destructive Docker command.';
        if (['volume', 'container', 'image'].includes(args[0]) && args[1] === 'rm') {
            return 'Destructive Docker command.';
        }
    }
    if (name === 'helm' && ['uninstall', 'delete'].includes(args[0])) {
        return 'Destructive Helm command.';
    }

    // ── Platform CLIs ────────────────────────────────────────────────────

    // Data-driven platform CLIs (shared verb-set lookup)
    const platformVerbs = PLATFORM_DESTRUCTIVE[name];
    if (platformVerbs && args.some(a => platformVerbs.has(a))) {
        return `Destructive ${name} CLI command.`;
    }

    // Platform CLIs with custom logic
    if (name === 'heroku' && args.some(a => a === 'destroy' || a === 'pg:reset' || a.includes(':destroy'))) {
        return 'Destructive Heroku CLI command.';
    }
    if (name === 'vercel' && ['remove', 'rm'].includes(args[0])) {
        return 'Destructive Vercel CLI command.';
    }
    if (name === 'netlify' && args.some(a => a === 'sites:delete')) {
        return 'Destructive Netlify CLI command.';
    }
    if (name === 'supabase') {
        if (args.includes('delete')) return 'Destructive Supabase CLI command.';
        if (args[0] === 'db' && args[1] === 'reset') return 'Destructive Supabase CLI command.';
    }

    // ── Service CLIs ─────────────────────────────────────────────────────

    if (name === 'gh' && args[0] === 'repo' && args[1] === 'delete') {
        return 'Destructive GitHub CLI command (repo delete).';
    }
    if (name === 'wrangler' && args.includes('delete')) {
        return 'Destructive Cloudflare Wrangler command.';
    }
    if (name === 'firebase' && args.some(a => ['projects:delete', 'firestore:delete', 'hosting:disable'].includes(a))) {
        return 'Destructive Firebase CLI command.';
    }

    // ── dbt ──────────────────────────────────────────────────────────────

    if (name === 'dbt' && ['run', 'build'].includes(args[0]) && args.includes('--full-refresh')) {
        return 'dbt --full-refresh drops and recreates tables.';
    }

    // ── dd (disk overwrite) ──────────────────────────────────────────────

    if (name === 'dd' && args.some(a => a.startsWith('if='))) {
        return 'dd with input file — potential disk overwrite.';
    }

    return null;
}

// ── rm checks ────────────────────────────────────────────────────────────────

/**
 * Apply three-tier rm protection. Returns the full block message (already
 * prefixed with `BLOCKED:`) when the rm should be blocked, or null when it is
 * allowed. The caller is responsible for emitting the message and exiting.
 */
export function checkRmDecision(cmd: ResolvedCommand): string | null {
    // Separate flags from paths using AST-parsed args
    const flags: string[] = [];
    const paths: string[] = [];
    let endOfFlags = false;

    for (const arg of cmd.args) {
        if (arg === '--') {
            endOfFlags = true;
        } else if (!endOfFlags && arg.startsWith('-')) {
            flags.push(arg);
        } else {
            paths.push(arg);
        }
    }

    const isRecursive = flags.some(f => /^-[^-]*r/i.test(f) || f === '--recursive');
    const isForce = flags.some(f => /^-[^-]*f/.test(f) || f === '--force');

    if (paths.length === 0) {
        return `BLOCKED: '${cmd.raw}' — rm requires an explicit path. Use: trash <path>`;
    }

    // Dangerous wildcards — bare *, ., .. always blocked; ./* and ../* when -r or -f
    const hasDangerousWildcard = paths.some(p => {
        if (p === '*' || p === '.' || p === '..') return true;
        if (isRecursive || isForce) {
            if (p === './*' || p === '../*') return true;
        }
        return false;
    });
    if (hasDangerousWildcard) {
        return `BLOCKED: '${cmd.raw}' — rm with bare wildcard/dot is not allowed. Be explicit about which paths to delete.`;
    }

    // Tier 1: protected paths → hard block (safe ephemeral paths take priority)
    for (const p of paths) {
        if (!isSafePath(p) && isProtectedPath(p)) {
            return `BLOCKED: '${cmd.raw}' — '${p}' is a protected path.`;
        }
    }

    // Tier 2: safe ephemeral paths → allow
    // Tier 3: everything else → redirect to trash (flag only the unsafe paths)
    const unsafePaths = paths.filter(p => !isSafePath(p));
    if (unsafePaths.length > 0) {
        const trashCmd = `trash ${unsafePaths.join(' ')}`;
        return `BLOCKED: rm is not allowed for non-ephemeral paths. Re-run your command using trash instead:\n\n  ${trashCmd}\n\ntrash moves files to macOS Trash (recoverable). Ephemeral paths (tmp, node_modules, dist, build, .cache, coverage, __pycache__, etc.) are allowed with rm.`;
    }

    return null;
}

/**
 * Replicate main()'s decision ordering against a raw bash command string,
 * WITHOUT the approval-bypass step (that stays in the caller) and without any
 * process.exit / stderr:
 *   (1) hard block (first non-null checkHardBlock) ⇒ block
 *   (2) gated command (first non-null checkGatedCommand) ⇒ gate
 *   (3) rm decision (first non-null checkRmDecision) ⇒ block
 *   else ⇒ allow
 *
 * Reasons are returned verbatim: hard-block reasons are the bare message
 * (the caller prefixes `BLOCKED: `); gated reasons are the bare gate reason;
 * rm reasons are already prefixed with `BLOCKED:`.
 *
 * `opts.skipGate` skips tier (2). The caller uses this for the post-approval
 * pass: in the original main(), an approved gate falls through to the rm tier,
 * so a destructive rm in the same command line is still blocked even after the
 * gated verb was approved. Skipping tier (2) reproduces that fall-through.
 */
export function evaluateBashCommand(
    command: string,
    opts: { skipGate?: boolean } = {},
): GateEvaluation {
    const commands = extractCommands(command);

    // --- Hard block checks (no bypass, ever) ---
    for (const cmd of commands) {
        const reason = checkHardBlock(cmd);
        if (reason) {
            return { action: 'block', reason };
        }
    }

    // --- Gated checks ---
    if (!opts.skipGate) {
        for (const cmd of commands) {
            const reason = checkGatedCommand(cmd);
            if (reason) {
                return { action: 'gate', reason };
            }
        }
    }

    // --- rm-specific checks (three-tier protection) ---
    for (const cmd of commands) {
        if (cmd.name === 'rm') {
            const reason = checkRmDecision(cmd);
            if (reason) {
                return { action: 'block', reason };
            }
        }
    }

    return { action: 'allow' };
}

// ── Gate mechanism (local CC gate-file) ───────────────────────────────────────

export const GATE_DIR = '/tmp/.claude-destructive-gate';

export function computeGateHash(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

export function consumeGateApproval(command: string): boolean {
    const hash = computeGateHash(command);
    const approvalPath = `${GATE_DIR}/${hash}`;
    try {
        unlinkSync(approvalPath);  // atomic: delete = consume approval in one syscall
        return true;
    } catch {
        return false;  // ENOENT or any other error → no approval
    }
}

// ── NanoClaw session-DB approval gate ────────────────────────────────────────
// NOT a side-channel IPC: this rides NanoClaw v2's sole IO surface — the two
// session DBs ("everything is a message"). Direct writes to /workspace/outbound.db
// and polling reads from
// /workspace/inbound.db (both host-managed mounts). Schema stays in sync with
// container/agent-runner/src/db/{connection,messages-out,delivery-acks}.ts in
// the nanoclaw-v2 repo — any schema change there needs a matching change here.

/** Synchronous sleep using Atomics.wait (no busy loop). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/**
 * Write a request_bash_gate system action to outbound.db. requestId === id,
 * so the container side can poll `delivered` with that same string to learn
 * whether the admin approved. seq must be odd (container-side convention —
 * host uses even). We compute seq under BEGIN IMMEDIATE to serialize against
 * any concurrent writeMessageOut from the agent-runner process.
 */
export function writeGateRequest(
    label: string,
    summary: string,
    command: string,
    action: 'request_destructive_gate' | 'request_bash_gate' = 'request_destructive_gate',
): string {
    // Dynamic import so non-NanoClaw environments (plain Claude Code) never
    // touch bun:sqlite — the module is only present under bun runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');

    const requestId = `gate-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const content = JSON.stringify({
        action,
        requestId,
        label,
        summary,
        command: command.slice(0, 500),
    });

    const outbound = new Database(NANOCLAW_OUTBOUND_DB);
    outbound.exec('PRAGMA busy_timeout = 5000');
    const inbound = new Database(NANOCLAW_INBOUND_DB, { readonly: true });
    inbound.exec('PRAGMA busy_timeout = 5000');
    try {
        outbound.exec('BEGIN IMMEDIATE');
        try {
            const maxOut = (outbound
                .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out')
                .get() as { m: number }).m;
            const maxIn = (inbound
                .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in')
                .get() as { m: number }).m;
            const max = Math.max(maxOut, maxIn);
            const seq = max % 2 === 0 ? max + 1 : max + 2; // next odd

            outbound
                .prepare(
                    `INSERT INTO messages_out (id, seq, timestamp, kind, content)
                     VALUES ($id, $seq, datetime('now'), 'system', $content)`,
                )
                .run({ $id: requestId, $seq: seq, $content: content });
            outbound.exec('COMMIT');
        } catch (err) {
            try { outbound.exec('ROLLBACK'); } catch { /* ignore */ }
            throw err;
        }
    } finally {
        outbound.close();
        inbound.close();
    }

    return requestId;
}

/**
 * Poll inbound.db's `delivered` table for the host's decision on our
 * requestId. delivered writes come from:
 *   - admin click-through → bash-gate handler writes status='delivered'
 *   - admin rejects / 60-min timeout on the host → status='failed'
 *
 * Opening a fresh connection per poll (instead of persisting one) sidesteps
 * cross-mount visibility issues where a long-held SQLite reader can freeze
 * on an early snapshot and never see host writes — the same reason
 * inbound.db forces journal_mode=DELETE.
 */
export function pollDeliveredTable(requestId: string, timeoutMs: number): GateDecision {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const db = new Database(NANOCLAW_INBOUND_DB, { readonly: true });
        db.exec('PRAGMA busy_timeout = 2000');
        try {
            const row = db
                .prepare('SELECT status FROM delivered WHERE message_out_id = ?')
                .get(requestId) as { status?: string } | undefined;
            if (row && row.status === 'delivered') return 'approved';
            if (row && row.status === 'failed') return 'denied';
        } catch {
            // Schema mismatch (old session DB, table missing) — treat as
            // denied rather than busy-loop forever against a broken surface.
            db.close();
            return 'denied';
        } finally {
            db.close();
        }
        sleepSync(500);
    }
    return 'timeout';
}

/**
 * Lower-level NanoClaw session-DB approval gate, parameterized on the gate
 * `action`. Stage an approval request on outbound.db, then poll inbound.db's
 * `delivered` table for the host's decision (60-min window, matching host
 * BASH_GATE_TIMEOUT_MS).
 *
 * `opts.action` selects the host-side handler the staged request routes to:
 *   - 'request_destructive_gate' — the destructive-command gate (default path).
 *   - 'request_bash_gate'        — the generic bash gate (email gate uses this).
 *
 * Fail-closed: if writeGateRequest throws (session DBs in a broken state),
 * returns 'denied'. The CALLER emits the stderr/exit — this function never
 * touches process.exit so it stays reusable across hooks.
 *
 * `opts.onStageError` (optional) fires with the staging error before the
 * fail-closed 'denied' return, so a caller can reproduce the original
 * "could not stage approval request" message distinct from an admin denial.
 */
export function runGateRequest(
    command: string,
    reason: string,
    opts: {
        action: 'request_destructive_gate' | 'request_bash_gate';
        onStageError?: (err: unknown) => void;
        // Optional structured card body. When omitted the card shows `reason`
        // for both label and summary (destructive-gate behavior). The email gate
        // passes a distinct summary (the from/to/cc/bcc/body card) so the approver
        // sees structured fields, at parity with Claude's in-tree card (S-QA2).
        summary?: string;
    },
): GateDecision {
    let requestId: string;
    try {
        requestId = writeGateRequest(reason, opts.summary ?? reason, command, opts.action);
    } catch (err) {
        // If we can't even stage the request, the session DBs are in a broken
        // state. Deny rather than silently allowing — the gate is fail-closed.
        opts.onStageError?.(err);
        return 'denied';
    }

    return pollDeliveredTable(requestId, 60 * 60 * 1000); // 60 min, matches host BASH_GATE_TIMEOUT_MS
}

/**
 * NanoClaw destructive-command session-DB approval gate. Thin wrapper over
 * runGateRequest with action='request_destructive_gate'.
 *
 * SIGNATURE IS LOAD-BEARING — `(command, reason, onStageError?)`. Existing
 * callers (block-destructive.ts, opencode-guard.ts) pass the onStageError
 * callback as the 3rd positional arg. Do NOT add a positional `action` here;
 * route action selection through runGateRequest instead.
 */
export function runNanoclawGate(
    command: string,
    reason: string,
    onStageError?: (err: unknown) => void,
): GateDecision {
    return runGateRequest(command, reason, { action: 'request_destructive_gate', onStageError });
}

/**
 * NanoClaw email session-DB approval gate. Thin wrapper over runGateRequest
 * with action='request_bash_gate' — the same host-side handler the in-tree
 * email gate uses (nanoclaw claude.ts createEmailGateHook).
 *
 * `(command, reason, onStageError?, summary?)` — the first three positionals
 * match runNanoclawGate (load-bearing: existing callers/tests pass onStageError
 * 3rd). The optional 4th `summary` carries evaluateEmailSend's structured card
 * body (from/to/cc/bcc/body); when omitted, the card falls back to `reason` for
 * both label and summary. Threading summary gives OpenCode's approval card the
 * same structured content as Claude's in-tree card (S-QA2 parity).
 */
export function runEmailGate(
    command: string,
    reason: string,
    onStageError?: (err: unknown) => void,
    summary?: string,
): GateDecision {
    return runGateRequest(command, reason, { action: 'request_bash_gate', onStageError, summary });
}
