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
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { resolve as pathResolve } from 'path';
import { parse } from 'unbash';
import { fileURLToPath } from 'url';

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
    env?: string[];             // NAME=value assignments applied to this command (prefix or `env` wrapper)
    hasInputRedirect: boolean;  // true if command has << or <<< redirects
    pos?: number;               // source offset when produced by the AST parser
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

// ── Snapshot git-mutation guard (ADVISORY) ──
// Repo-store rework: the old canonical paths (/workspace/workgroup/<repo>)
// are read-only browsing snapshots of origin/HEAD, advanced by the host.
// Mutating git commands aimed there ("cd into the canonical and checkout a
// branch") are the stale-tree failure mode the topology exists to kill. The
// RO bind mount is the real enforcement (EROFS); this evaluator exists to
// give a *useful* message instead of a bare filesystem error. Same
// accepted-residual-bypass posture as the git-clone guard: command-text
// matching only, no cwd resolution.
//
// Deliberately NOT matched: read-only git verbs (log/status/diff/show/...),
// the .worktrees checkout namespace, and the memory tree. The .repos mirrors
// and .rescues archives ARE covered — Bash-level git mutations there are
// never sanctioned.
export const SNAPSHOT_GIT_MUTATION_VERB_RE =
    /\bgit\b(?:\s+(?:-C|--work-tree|--git-dir)\s+\S+|\s+-c\s+\S+|\s+--\S+)*\s+(checkout|switch|commit|reset|restore|clean|merge|rebase|cherry-pick|stash|am|apply|update-ref|branch|worktree)\b/;
export const SNAPSHOT_PATH_RE = /\/workspace\/workgroup\/(?!\.worktrees\b|memory\b)/;
export const SNAPSHOT_GIT_MUTATION_BLOCK_REASON =
    'Git working-tree mutations under /workspace/workgroup/<repo> are blocked: that path is a read-only snapshot of origin/HEAD maintained by the host. Use `create_worktree` and work in /workspace/worktrees/<repo>; shared long-lived checkouts belong under /workspace/workgroup/.worktrees/.';

export function evaluateSnapshotGitMutation(command: string): { action: 'allow' | 'block'; reason?: string } {
    if (!command) return { action: 'allow' };
    if (SNAPSHOT_GIT_MUTATION_VERB_RE.test(command) && SNAPSHOT_PATH_RE.test(command)) {
        return { action: 'block', reason: SNAPSHOT_GIT_MUTATION_BLOCK_REASON };
    }
    return { action: 'allow' };
}

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
    // Package runners execute an arbitrary command too. Without them here,
    // `pnpm exec rm -rf <path>` resolved to name='pnpm' and every destructive
    // check passed — and since `Bash(pnpm exec *)` is commonly allow-listed,
    // that also meant no prompt. A ten-character prefix defeated both layers.
    'pnpm', 'yarn', 'npx', 'bunx',
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

/** Split an `env -S` string into words the way GNU env does: whitespace and
 *  `\_` separate, quotes group, `\c` and a word-initial `#` end the string.
 *  Null for what cannot be resolved statically (`$` expansion, an unknown
 *  escape): the caller must then refuse rather than guess. */
function splitEnvString(text: string): string[] | null {
    const words: string[] = [];
    let word = '';
    let inWord = false;
    let quote: '"' | "'" | null = null;
    const ESCAPED: Record<string, string> = { t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') {
            const next = text[++i];
            if (next === undefined) return null;
            if (quote === "'") {
                if (next === '\\' || next === "'") word += next; else word += ch + next;
                continue;
            }
            if (next === 'c') break;
            if (next === '_') {
                if (quote === '"') { word += ' '; continue; }
                if (inWord) { words.push(word); word = ''; inWord = false; }
                continue;
            }
            if (next in ESCAPED) word += ESCAPED[next];
            else if ('\\"\'#$ '.includes(next)) word += next;
            else return null;
            inWord = true;
            continue;
        }
        if (quote === "'") {
            if (ch === "'") quote = null; else word += ch;
            continue;
        }
        if (ch === '$') return null;
        if (quote === '"') {
            if (ch === '"') quote = null; else word += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
        if (ch === '#' && !inWord) break;
        if (/\s/.test(ch)) {
            if (inWord) { words.push(word); word = ''; inWord = false; }
            continue;
        }
        word += ch;
        inWord = true;
    }
    if (quote) return null;
    if (inWord) words.push(word);
    return words;
}

/** Resolve a Command AST node: strip wrapper commands, extract name + args */
export function resolveCommand(node: any): ResolvedCommand | null {
    if (!node.name) return null;

    let name = node.name.value || '';
    let args = (node.suffix || []).map((s: any) => s.value ?? s.text ?? '');
    const env: string[] = (node.prefix || [])
        .filter((p: any) => p?.type === 'Assignment' && typeof p.name === 'string')
        .map((p: any) => `${p.name}=${p.value?.value ?? p.value?.text ?? ''}`);

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
            // Skip flags and VAR=val assignments, keeping the assignments.
            // `-u NAME` and `-C DIR` take the next argument; `-S STRING` IS the
            // command line, split on whitespace.
            while (skip < args.length && (args[skip].startsWith('-') || /^\w+=/.test(args[skip]))) {
                const a = args[skip];
                if (/^\w+=/.test(a)) env.push(a);
                if (a === '-S' || a === '--split-string' || /^(?:-S.|--split-string=)/.test(a)) {
                    const inline = a.startsWith('--split-string=') ? a.slice('--split-string='.length)
                        : a.length > 2 && a.startsWith('-S') ? a.slice(2) : null;
                    const words = splitEnvString(inline ?? args[skip + 1] ?? '');
                    if (words === null) {
                        // Unresolvable: refuse it the way eval is refused.
                        name = 'eval';
                        args = [];
                        break;
                    }
                    args = [...args.slice(0, skip), ...words, ...args.slice(skip + (inline === null ? 2 : 1))];
                    continue;
                }
                skip += a === '-u' || a === '--unset' || a === '-C' || a === '--chdir' ? 2 : 1;
            }
        } else if (name === 'nice') {
            if (args[skip] === '-n' && skip + 1 < args.length) skip = 2;
        } else if (name === 'timeout' || name === 'gtimeout') {
            skip = 1; // skip duration argument
        } else if (name === 'pnpm' || name === 'yarn') {
            // Only `exec`/`dlx` run an arbitrary command. `pnpm run <script>`
            // executes a package.json script whose body is not on this command
            // line, so there is nothing here to resolve — leave it alone.
            while (skip < args.length && args[skip].startsWith('-')) skip += 1;
            if (!(skip < args.length && (args[skip] === 'exec' || args[skip] === 'dlx'))) break;
            skip += 1;
        } else if (name === 'npx' || name === 'bunx') {
            // The command follows the flags; -p/--package takes a value.
            while (skip < args.length && args[skip].startsWith('-')) {
                skip += args[skip] === '-p' || args[skip] === '--package' ? 2 : 1;
            }
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

    return {
        name,
        args,
        raw: rawParts.join(' '),
        env,
        hasInputRedirect,
        pos: typeof node.pos === 'number' ? node.pos : undefined,
    };
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
            const env: string[] = [];
            let rest = seg;
            let assignment: RegExpMatchArray | null;
            while ((assignment = rest.match(/^(\w+=\S*)\s+/))) {
                env.push(assignment[1]);
                rest = rest.slice(assignment[0].length);
            }
            const normalized = normalizeCommandFallback(rest);
            const parts = normalized.split(/\s+/);
            return {
                name: parts[0] || '',
                args: parts.slice(1),
                raw: seg,
                env,
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

// ── Provenance for rm of mktemp variables ───────────────────────────────────

const EXACT_VARIABLE_REFERENCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const SAFE_MKTEMP_SENTINEL = '/tmp/.bootstrap-mktemp-provenance';

/** Collect Assignment nodes without assuming a particular unbash container shape. */
function collectAssignmentNodes(node: unknown, out: any[], seen = new WeakSet<object>()): void {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
        for (const child of node) collectAssignmentNodes(child, out, seen);
        return;
    }

    const record = node as Record<string, unknown>;
    if (record.type === 'Assignment') out.push(node);
    for (const child of Object.values(record)) {
        collectAssignmentNodes(child, out, seen);
    }
}

/** True only for the narrow, known-safe assignment form: name=$(mktemp). */
function isZeroArgumentMktempAssignment(assignment: any): boolean {
    let parts = assignment?.value?.parts;
    if (!Array.isArray(parts) || parts.length !== 1) return false;

    // Quoting the substitution does not change its provenance.
    if (parts[0]?.type === 'DoubleQuoted') parts = parts[0].parts;
    if (!Array.isArray(parts) || parts.length !== 1) return false;

    const expansion = parts[0];
    if (expansion?.type !== 'CommandExpansion') return false;

    const nodes = walkCommandNodes(expansion.script);
    if (nodes.length !== 1 || (nodes[0].prefix || []).length !== 0) return false;
    const resolved = resolveCommand(nodes[0]);
    return resolved?.name === 'mktemp' && resolved.args.length === 0;
}

/**
 * Shell builtins can mutate a variable without producing an Assignment AST
 * node. Fail closed for the common mutation forms and for sourced scripts,
 * whose effects cannot be known statically.
 */
function hasPotentialVariableMutation(fragment: string, variable: string): boolean {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        new RegExp(`\\b(?:export|declare|typeset|local|readonly)\\b[^\\n;]*\\b${escaped}\\s*=`),
        new RegExp(`\\b(?:unset|read|readarray|mapfile)\\b[^\\n;]*\\b${escaped}\\b`),
        new RegExp(`\\bprintf\\b[^\\n;]*\\s-v\\s+${escaped}\\b`),
        new RegExp(`\\bfor\\s+${escaped}\\b`),
        new RegExp(`\\$\\{${escaped}(?::?=)`),
        /(?:^|[;&|]\s*|\n\s*)(?:source|\.)\s+/m,
    ].some(rx => rx.test(fragment));
}

/**
 * Map each top-level rm command's source offset to variables that are proven
 * to still contain a path created by zero-argument mktemp.
 *
 * This is deliberately narrow. The assignment and rm must both be top-level,
 * the assignment must be exactly `name=$(mktemp)` (optionally quoted), the
 * default mktemp directory must be ephemeral, and no intervening mutation may
 * occur. Anything the static analysis cannot prove remains blocked.
 */
function findEphemeralMktempVariables(command: string): Map<number, Set<string>> {
    const result = new Map<number, Set<string>>();

    try {
        const ast: any = parse(command);
        const tmpDir = process.env.TMPDIR || '/tmp';
        if (!isSafePath(tmpDir)) return result;

        const topLevelCommands = (ast.commands || [])
            .map((entry: any) => entry?.type === 'Statement' ? entry.command : entry)
            .filter((node: any) => node?.type === 'Command');

        const safeAssignments = new Set<any>();
        for (const node of topLevelCommands) {
            const prefix = node.prefix || [];
            if (!node.name && prefix.length === 1 &&
                (node.suffix || []).length === 0 && (node.redirects || []).length === 0 &&
                prefix[0]?.type === 'Assignment' && isZeroArgumentMktempAssignment(prefix[0])) {
                safeAssignments.add(prefix[0]);
            }
        }

        const assignments: any[] = [];
        collectAssignmentNodes(ast, assignments);
        assignments.sort((a, b) => (a.pos ?? -1) - (b.pos ?? -1));

        for (const node of topLevelCommands) {
            const resolved = resolveCommand(node);
            if (resolved?.name !== 'rm' || typeof resolved.pos !== 'number') continue;

            const proven = new Set<string>();
            for (const arg of resolved.args) {
                const match = arg.match(EXACT_VARIABLE_REFERENCE);
                const variable = match?.[1] || match?.[2];
                if (!variable) continue;

                const latest = assignments
                    .filter(a => a.name === variable && typeof a.pos === 'number' && a.pos < resolved.pos!)
                    .at(-1);
                if (!latest || !safeAssignments.has(latest)) continue;

                // A command-local TMPDIR override changes where zero-argument
                // mktemp writes; fail closed rather than trying to execute the
                // shell's environment semantics statically.
                if (/\bTMPDIR\s*=/.test(command.slice(0, latest.pos))) continue;

                const between = command.slice(latest.end ?? latest.pos, resolved.pos);
                if (hasPotentialVariableMutation(between, variable)) continue;
                proven.add(variable);
            }

            if (proven.size > 0) result.set(resolved.pos, proven);
        }
    } catch {
        // Parser failure already falls back conservatively for command
        // extraction; variable provenance must fail closed as well.
    }

    return result;
}

function resolveEphemeralRmArgs(cmd: ResolvedCommand, proven: ReadonlySet<string>): ResolvedCommand {
    if (proven.size === 0) return cmd;
    return {
        ...cmd,
        args: cmd.args.map(arg => {
            const match = arg.match(EXACT_VARIABLE_REFERENCE);
            const variable = match?.[1] || match?.[2];
            return variable && proven.has(variable) ? SAFE_MKTEMP_SENTINEL : arg;
        }),
    };
}

// ── Lab-scoped exemption ─────────────────────────────────────────────────────
// In a Lab session — a wiring whose channel instructions profile is `lab`, which
// the host projects into the container as NANOCLAW_INSTRUCTIONS_PROFILE
// (nanoclaw-v2 src/container-runner.ts) — a destructive action aimed at a LAB
// TARGET must neither hold for approval nor be denied. A lab exists to be torn
// down and rebuilt; an approval card on every `DROP SCHEMA` defeats the point.
//
// TWO predicates must BOTH hold. The session predicate alone is never enough:
// being in a lab room does not exempt a command aimed at production. The
// target predicate reads the RESOLVED command (post wrapper-stripping) and fails
// CLOSED — an unrecognized family, or a target constructed at runtime
// (`psql "$URL"`, a variable-built repo path), is NOT a lab target and stays
// gated.
//
// Deliberately NOT exempted:
//   • tier-1 hard blocks (eval, shell -c, find -exec rm, xargs rm, shred, dd,
//     truncate). A `sh -c` wrapper hides the real target from the target
//     predicate, so exempting tier 1 would dismantle the target matching itself.
//   • `snow sql` — Snowflake has no lab tenant, so every Snowflake statement
//     stays gated even in a lab session.
//   • non-LAB repos, non-`lab-` Render services, and prod/dev databases, in the
//     lab room or anywhere else.

/** The instructions-profile name that marks a Lab session. */
export const LAB_INSTRUCTIONS_PROFILE = 'lab';

// WHICH GitHub org owns lab repos, and which non-`LAB-*` repos are
// lab-writable, is deployment data, not source. It lives in an untracked
// `lab-scope.local.json` — `{"org": "<github-org>", "extraRepos": ["<REPO>"]}` —
// read from BOOTSTRAP_LAB_SCOPE_FILE when that is set (and then ONLY from there),
// else from the plugin repo root this module sits under (a runtime running the
// repo in place), else from the NanoClaw container mount of that repo (a runtime
// running a cached copy of the plugin, which has no repo root above it).
//
// No readable, valid file means no lab org: no repo reference is then a lab
// target, and every such command stays gated. A missing or malformed file can
// only make the guard stricter, never looser.
export interface LabScope {
    org: string;
    extraRepos: string[];
}

export const LAB_SCOPE_FILE_ENV = 'BOOTSTRAP_LAB_SCOPE_FILE';
const LAB_SCOPE_FILE = 'lab-scope.local.json';
const LAB_SCOPE_CONTAINER_PATH = `/workspace/plugins/bootstrap/${LAB_SCOPE_FILE}`;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// `https://[user[:token]@]github.com[:port]/`, `ssh://git@github.com/`,
// `git://github.com/`, scp-style `git@github.com:`, and GitHub's SSH-over-443
// host `ssh.github.com`.
const GITHUB_REMOTE_PREFIX =
    '(?:(?:https?|ssh|git|git\\+ssh):\\/\\/(?:[^\\s/@]+@)?(?:ssh\\.)?github\\.com(?::\\d+)?\\/|[A-Za-z0-9_.-]+@(?:ssh\\.)?github\\.com:)';

/** Parse a lab-scope file's text. Null when anything about it is unusable. */
export function parseLabScope(text: string): LabScope | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { org, extraRepos = [] } = raw as { org?: unknown; extraRepos?: unknown };
    if (typeof org !== 'string' || !GITHUB_OWNER_RE.test(org)) return null;
    if (!Array.isArray(extraRepos)) return null;
    if (!extraRepos.every((r) => typeof r === 'string' && GITHUB_REPO_RE.test(r))) return null;
    return { org, extraRepos: extraRepos as string[] };
}

function labScopeRepoRootPath(): string | null {
    try {
        return fileURLToPath(new URL(`../../../../${LAB_SCOPE_FILE}`, import.meta.url));
    } catch {
        return null;
    }
}

function labScopePath(): string | null {
    const explicit = process.env[LAB_SCOPE_FILE_ENV];
    if (explicit !== undefined) return explicit || null;
    for (const candidate of [labScopeRepoRootPath(), LAB_SCOPE_CONTAINER_PATH]) {
        if (candidate && existsSync(candidate)) return candidate;
    }
    return null;
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledLabScope {
    /** A whole value naming `<org>/<lab repo>` on GitHub; null without a lab org. */
    repoRef: RegExp | null;
    /** `worktrees/<lab repo>` path segment. */
    worktreeSegment: RegExp;
    /** Exactly `<org>/LAB-*` — the only repos `gh repo delete` may skip approval for. */
    ghDeletable: RegExp | null;
}

let labScopeCache: { key: string; compiled: CompiledLabScope } | null = null;

/**
 * Lab scope in force right now. Re-read on every call and keyed on the file's
 * CONTENT, never frozen at module scope and never keyed on metadata: a narrowed
 * file must take effect even when its size and mtime happen to match.
 */
function currentLabScope(): CompiledLabScope {
    const file = labScopePath();
    let key = 'none';
    let text: string | null = null;
    if (file) {
        try {
            text = readFileSync(file, 'utf-8');
            key = `${file}\0${text}`;
        } catch {
            key = `${file}\0unreadable`;
            text = null;
        }
    }
    if (labScopeCache?.key === key) return labScopeCache.compiled;

    const scope = text === null ? null : parseLabScope(text);
    // The OWNER half is pinned to that lab org inside the pattern itself, not only
    // in a follow-up comparison, so `other-org/LAB-APP` cannot match at all.
    //
    // Every pattern is case-INSENSITIVE. GitHub repo names are case-insensitive
    // and lab repos get renamed between casings, so agents still hold older URLs
    // that redirect to the current names. Refusing those spellings would gate the
    // exact commands the exemption exists to free.
    const extra = scope ? scope.extraRepos.map((r) => `|${escapeRegexLiteral(r)}`).join('') : '';
    const repoName = `(?:LAB-[A-Z0-9-]+${extra})`;
    const org = scope ? escapeRegexLiteral(scope.org) : null;
    const compiled: CompiledLabScope = {
        repoRef: org
            ? new RegExp(`^(?:${GITHUB_REMOTE_PREFIX})?(${org})\\/(${repoName})(?:\\.git)?\\/?$`, 'i')
            : null,
        worktreeSegment: new RegExp(`(?:^|\\/)worktrees\\/${repoName}(?:\\/|$)`, 'i'),
        ghDeletable: org ? new RegExp(`^(${org})\\/(LAB-[A-Z0-9-]+)$`, 'i') : null,
    };
    labScopeCache = { key, compiled };
    return compiled;
}

/**
 * PREDICATE 1 — lab session.
 *
 * Read at call time, never cached at module scope: the core is imported once per
 * adapter process and the tests flip this env between cases.
 */
export function isLabSession(): boolean {
    return process.env.NANOCLAW_INSTRUCTIONS_PROFILE === LAB_INSTRUCTIONS_PROFILE;
}

/** Name of a lab repo `value` references (`<org>/<repo>`), or null. Accepts a
 *  bare `org/repo` or a github.com URL (https, ssh, git, scp-style) whose path
 *  is exactly that repo — the same path on any other host is not a lab repo.
 *  Always null without a lab org. */
export function labRepoRefName(value: string): string | null {
    if (!value) return null;
    const { repoRef } = currentLabScope();
    const m = repoRef?.exec(value);
    return m ? `${m[1]}/${m[2]}` : null;
}

/** True when `value` references a LAB-* or configured extra repo under that lab org. */
export function isLabRepoRef(value: string): boolean {
    return labRepoRefName(value) !== null;
}

// A worktree checkout dir is named for its repo (`<worktrees>/APP`), and the host
// bind-mounts the same directory twice — at /workspace/worktrees and at its own
// host path (nanoclaw-v2 src/container-runner.ts). Matching the `worktrees/<repo>`
// SEGMENT rather than a /workspace-anchored prefix covers both mounts with one
// pattern. Case-insensitive for the same reason as the repo-reference pattern: a
// clone taken before a rename keeps its old casing on disk.

/**
 * True when `p` sits inside a LAB-* or configured extra repo worktree checkout,
 * under either the /workspace mount or the host-path alias mount.
 *
 * Tested against the NORMALIZED path only. Matching the raw string would let
 * `/workspace/worktrees/LAB-APP/../APP` read as a lab path and delete the prod
 * checkout next door.
 */
export function isLabWorktreePath(p: string): boolean {
    if (!p) return false;
    return currentLabScope().worktreeSegment.test(normalizePath(p));
}

/** process.cwd() throws when the cwd has been unlinked; a guard must not die on it. */
function currentWorkingDir(): string {
    try {
        return process.cwd();
    } catch {
        return '';
    }
}

// ── git target resolution ────────────────────────────────────────────────────

const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
// URL and scp-style (`git@github.com:org/repo`) remotes.
const REPO_URL_RE = /^(?:(?:https?|ssh|git|git\+ssh|file):\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)/;
// A bare `org/repo` positional. Only consulted in the REMOTE position, so a
// branch named `feature/x` in a refspec position is never mistaken for a repo.
const ORG_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

/** Index of the git subcommand in `args`, skipping git's global options. */
function gitSubcommandIndex(args: string[]): number {
    let i = 0;
    while (i < args.length) {
        if (GIT_GLOBAL_VALUE_OPTS.has(args[i])) { i += 2; continue; }
        if (args[i].startsWith('-')) { i += 1; continue; }
        break;
    }
    return i;
}

/** Value of `git -C <path>` / `--work-tree <path>`, which relocates the
 *  effective working directory. */
function gitRelocatedDir(args: string[]): string | null {
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-C' || args[i] === '--work-tree') return args[i + 1];
    }
    return null;
}

/** First positional after the subcommand — the remote for push/fetch/pull. */
function gitRemoteArg(args: string[]): string | null {
    for (let j = gitSubcommandIndex(args) + 1; j < args.length; j++) {
        if (args[j].startsWith('-')) continue;
        return args[j];
    }
    return null;
}

function labGitTarget(cmd: ResolvedCommand, cwd: string): string | null {
    // An explicit repo URL anywhere in the command decides on its own, and ALL
    // of them must be lab repos — a lab cwd does not launder a push to a prod URL.
    const urls = cmd.args.filter(a => REPO_URL_RE.test(a));
    if (urls.length > 0) {
        return urls.every(isLabRepoRef) ? labRepoRefName(urls[0]) : null;
    }

    // A bare `org/repo` in the remote position decides the same way.
    const remote = gitRemoteArg(cmd.args);
    if (remote && ORG_REPO_RE.test(remote)) {
        return isLabRepoRef(remote) ? labRepoRefName(remote) : null;
    }

    // Bare remote name (`origin`, `upstream`) or none: the checkout decides.
    const effectiveCwd = gitRelocatedDir(cmd.args) ?? cwd;
    return isLabWorktreePath(effectiveCwd) ? effectiveCwd : null;
}

// ── SQL target resolution ────────────────────────────────────────────────────

// `snow` is absent on purpose: Snowflake has no lab tenant.
const LAB_SQL_CLIS = new Set(['psql', 'pg_dump', 'pg_restore', 'pg_dumpall', 'mysql', 'mysqldump']);
const LAB_DB_NAME_RE = /^lab[-_]/i;
// Render Postgres hostnames look like `dpg-xxxx-a.virginia-postgres.render.com`,
// so the reliable lab signals are the DATABASE and USER names, not the host.
const CONNECTION_URI_RE =
    /\b(?:postgres(?:ql)?|mysql|mysqlx|mariadb):\/\/(?:([^:@/\s]*)(?::[^@/\s]*)?@)?([^/?#:\s]*)(?::\d+)?(?:\/([^?#\s]*))?/i;
// libpq keyword/value form: `psql "host=... dbname=lab_app user=lab_app_admin"`.
const CONNECTION_KV_RE = /\b(?:host|user|dbname|database)=([^\s'"]+)/gi;
const SQL_HOST_FLAGS = new Set(['-h', '--host']);
const SQL_USER_FLAGS = new Set(['-U', '--username']);
const SQL_DB_FLAGS = new Set(['-d', '--dbname']);

function labSqlSignal(value: string): string | null {
    if (!value) return null;

    const uri = CONNECTION_URI_RE.exec(value);
    if (uri) {
        for (const part of [uri[1], uri[2], uri[3]]) {
            if (part && LAB_DB_NAME_RE.test(part)) return part;
        }
    }

    CONNECTION_KV_RE.lastIndex = 0;
    let kv: RegExpExecArray | null;
    while ((kv = CONNECTION_KV_RE.exec(value)) !== null) {
        if (LAB_DB_NAME_RE.test(kv[1])) return kv[1];
    }

    return null;
}

function labSqlTarget(cmd: ResolvedCommand): string | null {
    const { args } = cmd;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];

        // --host=lab-x / --username=lab_x / --dbname=lab_app
        const eq = a.match(/^(?:--host|--username|--dbname)=(.+)$/);
        if (eq && LAB_DB_NAME_RE.test(eq[1])) return eq[1];

        // -h lab-x / -U lab_app_admin / -d lab_app
        if (SQL_HOST_FLAGS.has(a) || SQL_USER_FLAGS.has(a) || SQL_DB_FLAGS.has(a)) {
            const v = args[i + 1];
            if (v && !v.startsWith('-') && LAB_DB_NAME_RE.test(v)) return v;
            continue;
        }

        // A connection string, given bare or as some other flag's value.
        const signal = labSqlSignal(a);
        if (signal) return signal;
    }
    return null;
}

// ── Platform / service target resolution ─────────────────────────────────────

const LAB_RESOURCE_RE = /^lab-/;

function labRenderTarget(cmd: ResolvedCommand): string | null {
    const verbs = PLATFORM_DESTRUCTIVE.render;
    for (const a of cmd.args) {
        if (a.startsWith('-') || verbs.has(a)) continue;
        if (LAB_RESOURCE_RE.test(a)) return a;
    }
    return null;
}

// `gh repo delete` is exempt for LAB-* under that lab org ONLY. A configured
// extra repo is deliberately not deletable without approval: it is lab-writable,
// not lab-disposable — its name does not start with `LAB-`, so the
// case-insensitive `ghDeletable` pattern still refuses it.
function labGhTarget(cmd: ResolvedCommand): string | null {
    const target = cmd.args[2];
    if (!target) return null;
    const { ghDeletable } = currentLabScope();
    return ghDeletable?.test(target) ? target : null;
}

/**
 * PREDICATE 2 — lab target.
 *
 * Returns the matched target's name (used in the stderr log line) or null.
 * Fails CLOSED: every family it does not recognize, and every target it cannot
 * read literally out of the resolved command, returns null and stays gated.
 */
export function labTargetOf(cmd: ResolvedCommand, cwd: string = currentWorkingDir()): string | null {
    switch (cmd.name) {
        case 'git':
            return labGitTarget(cmd, cwd);
        case 'render':
            return labRenderTarget(cmd);
        case 'gh':
            return cmd.args[0] === 'repo' && cmd.args[1] === 'delete' ? labGhTarget(cmd) : null;
        default:
            return LAB_SQL_CLIS.has(cmd.name) ? labSqlTarget(cmd) : null;
    }
}

/** Boolean form of labTargetOf. */
export function isLabTarget(cmd: ResolvedCommand, cwd: string = currentWorkingDir()): boolean {
    return labTargetOf(cmd, cwd) !== null;
}

function logLabScope(message: string): void {
    console.error(`lab-scope: ${message}`);
}

// ── Git hook bypass ──────────────────────────────────────────────────────────
// A repo's commit and push hooks are where its own gates run — the public
// boundary scan, formatting, parity. An agent that trips one fixes the finding;
// it never switches the hook off. Every way of switching hooks off is refused:
// `--no-verify` (and `git commit -n`), a `core.hooksPath` override on the
// command line or through the environment, a `core.hooksPath` write, and the
// husky skip variables. Reading `core.hooksPath` stays allowed.
export const GIT_HOOK_BYPASS_REASON =
    'Skipping or disabling git hooks is not allowed: a hook is the repo\'s own gate. Fix what it reports, then commit or push normally.';
const GIT_NO_VERIFY_LONG_RE = /^--no-veri(?:f|fy)?$/;
const GIT_NO_VERIFY_SUBCOMMANDS = new Set(['commit', 'push', 'merge', 'am', 'rebase', 'cherry-pick', 'revert', 'pull']);
// core.hooksPath switches every hook off; bootstrap.boundaryChecker points this
// repo's hooks at the public-boundary checker (empty or unset skips the scan).
const GIT_HOOK_CONFIG_KEY_RE = /^(?:core\.hookspath|bootstrap\.boundarychecker)$/i;
const GIT_HOOK_CONFIG_SECTION_RE = /^(?:core|bootstrap)$/i;
// `git commit` short options that take a value: the rest of a cluster (or the
// next argument) is that value, never another flag.
const GIT_COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't', 'u', 'S']);
const GIT_COMMIT_VALUE_LONG = new Set([
    '--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message',
    '--template', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file',
]);
const GIT_CONFIG_VALUE_OPTS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const GIT_CONFIG_WRITE_OPTS = new Set(['--unset', '--unset-all', '--replace-all', '--add']);
const GIT_CONFIG_SECTION_OPTS = new Set(['--rename-section', '--remove-section']);
const GIT_CONFIG_READ_OPTS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
const GIT_CONFIG_ACTION_OPTS = new Set([...GIT_CONFIG_WRITE_OPTS, ...GIT_CONFIG_SECTION_OPTS, ...GIT_CONFIG_READ_OPTS]);

function envDisablesHooks(env: string[]): boolean {
    return env.some((entry) =>
        /^HUSKY=0$/.test(entry) ||
        /^HUSKY_SKIP_HOOKS=/.test(entry) ||
        /^GIT_CONFIG_PARAMETERS=.*(?:core\.hookspath|bootstrap\.boundarychecker)/i.test(entry) ||
        /^GIT_CONFIG_KEY_\d+=(?:core\.hookspath|bootstrap\.boundarychecker)$/i.test(entry),
    );
}

function gitCommitSkipsHooks(args: string[]): boolean {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') return false;
        if (GIT_NO_VERIFY_LONG_RE.test(arg)) return true;
        if (arg.startsWith('--')) {
            if (GIT_COMMIT_VALUE_LONG.has(arg)) i += 1;
            continue;
        }
        if (arg.startsWith('-') && arg.length > 1) {
            const letters = arg.slice(1);
            for (let j = 0; j < letters.length; j++) {
                const letter = letters[j];
                if (letter === 'n') return true;
                if (GIT_COMMIT_VALUE_SHORT.has(letter)) {
                    // A value-taking letter ends the cluster; a bare one takes the next arg.
                    if (j === letters.length - 1 && letter !== 'u' && letter !== 'S') i += 1;
                    break;
                }
            }
        }
    }
    return false;
}

function gitConfigWritesHookConfig(args: string[]): boolean {
    const positionals: string[] = [];
    // git config takes ONE action option; a later one replaces an earlier one and
    // `--no-<action>` clears it, leaving the positional form to decide.
    let mode: 'read' | 'write' | 'section' | null = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (GIT_CONFIG_VALUE_OPTS.has(arg)) { i += 1; continue; }
        // An editor session can rewrite any key unseen.
        if (arg === '-e' || arg === '--edit') return true;
        if (GIT_CONFIG_WRITE_OPTS.has(arg)) { mode = 'write'; continue; }
        if (GIT_CONFIG_SECTION_OPTS.has(arg)) { mode = 'section'; continue; }
        if (GIT_CONFIG_READ_OPTS.has(arg)) { mode = 'read'; continue; }
        if (arg.startsWith('--no-') && GIT_CONFIG_ACTION_OPTS.has(`--${arg.slice('--no-'.length)}`)) { mode = null; continue; }
        if (arg.startsWith('-')) continue;
        positionals.push(arg);
    }
    const [verb, ...rest] = positionals;
    if (verb === 'edit') return true;
    // Removing or renaming the whole section drops the key with it.
    if (verb === 'remove-section' || verb === 'rename-section') {
        return GIT_HOOK_CONFIG_SECTION_RE.test(rest[0] ?? '');
    }
    if (mode === 'section') return GIT_HOOK_CONFIG_SECTION_RE.test(verb ?? '');
    if (verb === 'set' || verb === 'unset') return rest.some((p) => GIT_HOOK_CONFIG_KEY_RE.test(p));
    if (verb === 'get' || verb === 'list') return false;
    const keyIndex = positionals.findIndex((p) => GIT_HOOK_CONFIG_KEY_RE.test(p));
    if (keyIndex === -1) return false;
    if (mode === 'write') return true;
    // `git config --get <key> <value-pattern>` is a read with a filter.
    if (mode === 'read') return false;
    return positionals.length > keyIndex + 1;
}

/** Reason to refuse `cmd` because it skips or disables git hooks, or null. */
export function gitHookBypassReason(cmd: ResolvedCommand): string | null {
    if (cmd.name === 'export' && envDisablesHooks(cmd.args)) return GIT_HOOK_BYPASS_REASON;
    if (cmd.name !== 'git') return null;
    if (envDisablesHooks(cmd.env ?? [])) return GIT_HOOK_BYPASS_REASON;

    const sub = gitSubcommandIndex(cmd.args);
    const overridesHookConfig = (assignment: string) =>
        GIT_HOOK_CONFIG_KEY_RE.test(assignment.split('=')[0] ?? '');
    for (let i = 0; i < sub; i++) {
        const arg = cmd.args[i];
        if ((arg === '-c' || arg === '--config-env') && overridesHookConfig(cmd.args[i + 1] ?? '')) {
            return GIT_HOOK_BYPASS_REASON;
        }
        if (arg.startsWith('-c') && arg.length > 2 && overridesHookConfig(arg.slice(2))) return GIT_HOOK_BYPASS_REASON;
        if (arg.startsWith('--config-env=') && overridesHookConfig(arg.slice('--config-env='.length))) {
            return GIT_HOOK_BYPASS_REASON;
        }
    }

    const subcommand = cmd.args[sub];
    const rest = cmd.args.slice(sub + 1);
    // `commit` is parsed with its argument roles (`-m --no-verify` is a message).
    if (subcommand === 'commit') return gitCommitSkipsHooks(rest) ? GIT_HOOK_BYPASS_REASON : null;
    if (subcommand && GIT_NO_VERIFY_SUBCOMMANDS.has(subcommand) && rest.some((a) => GIT_NO_VERIFY_LONG_RE.test(a))) {
        return GIT_HOOK_BYPASS_REASON;
    }
    if (subcommand === 'config' && gitConfigWritesHookConfig(rest)) return GIT_HOOK_BYPASS_REASON;
    return null;
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

    const hookBypass = gitHookBypassReason(cmd);
    if (hookBypass) return hookBypass;

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

    // ── Git (remote history mutation) ────────────────────────────────────
    // (fleet-hardening P2) Raw `git push --force` was the one unclassified
    // history-mutation path: the MCP git_push tool is lease-protected, but a
    // Bash force push was invisible to the matrix, and server-side branch
    // protection is unavailable on free-plan private repos — this gate is the
    // enforcement point. `--force-with-lease`/`--force-if-includes` stay
    // allowed: they refuse to clobber unseen remote work and are the
    // sanctioned recovery path the git_push tool itself uses.
    if (name === 'git') {
        // Skip git's global options so `git -C /x push -f` classifies like
        // `git push -f`. Only these take a separate value argument.
        const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
        let i = 0;
        while (i < args.length) {
            if (GIT_GLOBAL_VALUE_OPTS.has(args[i])) { i += 2; continue; }
            if (args[i].startsWith('-')) { i += 1; continue; }
            break;
        }
        if (args[i] === 'push') {
            const pushArgs = args.slice(i + 1);
            if (pushArgs.includes('--force') || pushArgs.includes('-f')) {
                return 'git push --force rewrites remote history. Use --force-with-lease (refuses to clobber unseen work) or get approval.';
            }
            if (pushArgs.includes('--mirror')) {
                return 'git push --mirror force-updates every remote ref.';
            }
            // `+refspec` is per-ref force; `:refspec` deletes the remote ref.
            if (pushArgs.includes('--delete') || pushArgs.includes('-d') ||
                pushArgs.some(a => (a.startsWith(':') || a.startsWith('+')) && a.length > 1)) {
                return 'git push deleting or force-updating a remote ref (+/: refspec, --delete).';
            }
        }
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
 *
 * `opts.isExtraSafe` widens tier 2 (the ephemeral-path allowlist) for the
 * caller's scope. evaluateBashCommand passes its lab-worktree matcher through it
 * in a Lab session and nothing else does — the default behavior is unchanged.
 */
export function checkRmDecision(
    cmd: ResolvedCommand,
    opts: { isExtraSafe?: (path: string) => boolean } = {},
): string | null {
    const safe = opts.isExtraSafe
        ? (p: string) => isSafePath(p) || opts.isExtraSafe!(p)
        : isSafePath;
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
        if (!safe(p) && isProtectedPath(p)) {
            return `BLOCKED: '${cmd.raw}' — '${p}' is a protected path.`;
        }
    }

    // Tier 2: safe ephemeral paths → allow
    // Tier 3: everything else → redirect to trash (flag only the unsafe paths)
    const unsafePaths = paths.filter(p => !safe(p));
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
 *
 * `opts.cwd` is the working directory the command will run in — supplied by an
 * adapter that has it on its hook input (Claude's `cwd` field), else
 * process.cwd(). It only ever matters to lab-scope predicates below, which
 * uses it to resolve a bare `git push origin` to the repo it would actually
 * push to.
 *
 * LAB SCOPE (tier 2 and tier 3 only): in a Lab session, a gated verb aimed at a
 * lab target allows instead of holding, and a lab worktree path joins the rm
 * ephemeral allowlist. Tier 1 is never exempted. Both predicates must hold and
 * both fail closed — see "Lab-scoped exemption" above.
 */
export function evaluateBashCommand(
    command: string,
    opts: { skipGate?: boolean; cwd?: string } = {},
): GateEvaluation {
    const commands = extractCommands(command);
    const ephemeralMktempVariables = findEphemeralMktempVariables(command);
    const lab = isLabSession();
    const cwd = opts.cwd ?? currentWorkingDir();

    // --- Hard block checks (no bypass, ever — lab included) ---
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
                if (lab) {
                    const target = labTargetOf(cmd, cwd);
                    if (target !== null) {
                        logLabScope(`allowed ${cmd.name} against lab target ${target}`);
                        continue;
                    }
                }
                return { action: 'gate', reason };
            }
        }
    }

    // --- rm-specific checks (three-tier protection) ---
    for (const cmd of commands) {
        if (cmd.name === 'rm') {
            const proven = typeof cmd.pos === 'number'
                ? ephemeralMktempVariables.get(cmd.pos) ?? new Set<string>()
                : new Set<string>();
            const resolved = resolveEphemeralRmArgs(cmd, proven);
            let reason = checkRmDecision(resolved);
            if (reason && lab) {
                // Re-decide with lab worktree paths counted as ephemeral. Only
                // logged when it actually changes the outcome.
                const relaxed = checkRmDecision(resolved, { isExtraSafe: isLabWorktreePath });
                if (relaxed === null) {
                    logLabScope(`allowed rm against lab target ${resolved.args.filter(a => !a.startsWith('-')).join(' ')}`);
                }
                reason = relaxed;
            }
            if (reason) {
                return { action: 'block', reason };
            }
        }
    }

    return { action: 'allow' };
}

// ── Legacy gate-file compatibility ────────────────────────────────────────────
// Current local Claude and Codex adapters use their native `ask` permission
// decision. The agent-writable marker below is retired — see
// `consumeGateApproval`. GATE_DIR itself still hosts the claim files.

export const GATE_DIR = '/tmp/.claude-destructive-gate';

export function computeGateHash(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

export function consumeGateApproval(_command: string): boolean {
    // RETIRED (nanoclaw #858). This used to unlink `<GATE_DIR>/<hash(command)>`
    // and answer true, which made the caller skip the approval gate outright.
    // GATE_DIR is under /tmp — agent-writable — and NOTHING in either tree ever
    // wrote that marker: the only real approval path is the session-DB gate
    // (`runGateRequest`), whose decision the HOST writes to inbound.db. So the
    // read granted nothing legitimate and was a pure self-approval door for any
    // process in the container that could create one file. It now answers false
    // unconditionally. The export stays because NanoClaw's in-tree Codex chain
    // validates its presence at load (codex-hooks/runner.ts `validateGuardCore`)
    // and older container images still call it.
    return false;
}

// ── One approval card per tool call (cross-process claim) ────────────────────
// A Codex tool call dispatches EVERY matched PreToolUse handler, and it does so
// CONCURRENTLY: `execute_handlers_with_metadata` pushes each handler onto a
// `FuturesUnordered` before awaiting any of them, and `should_block` is a plain
// `.any()` over all the results — there is no ordering and no short-circuit on a
// deny (codex-rs 0.154.0 `hooks/src/engine/dispatcher.rs`,
// `hooks/src/events/pre_tool_use.rs`). Measured on a real 0.154.0 run: two
// PreToolUse handlers started 0.7 ms apart and received the SAME `tool_use_id`.
//
// In a NanoClaw container there are two such handlers — the in-tree chain and
// this plugin's `codex-guard.ts` — and both reach the session-DB gate. Without a
// claim, one gated command raises TWO approval cards, each needing its own
// answer. It fails closed (both must approve), but it doubles approval traffic
// on exactly the commands that matter most.
//
// Deduping HERE, at the approval layer, rather than by silencing one chain, is
// what keeps it safe: both chains still evaluate the command in full, so no
// guard's coverage depends on the other running, and a third PreToolUse handler
// would join the same claim rather than add a third card.
//
// The protocol is two files per claim, in a shared /tmp dir, and it has to work
// between separate PROCESSES that start within a millisecond of each other:
//
//   <claim>.lock   created with O_EXCL. Exactly one process wins it and becomes
//                  the OWNER: it stages the request and publishes the id.
//   <claim>        written as `<claim>.tmp` then RENAMED, so it never exists in
//                  a half-written state. Losers read it to learn the owner's
//                  requestId and then poll the same decision.
//
// A loser that never sees `<claim>` appear — the owner crashed, or failed to
// stage — falls back to staging its own request. Two cards is a worse
// experience; no gate at all is a security failure, so the fallback is the
// fail-closed direction.

export const GATE_CLAIM_DIR = `${GATE_DIR}/claims`;

/** How long a loser waits for the owner to publish its requestId. */
const CLAIM_PUBLISH_TIMEOUT_MS = 15_000;
const CLAIM_POLL_INTERVAL_MS = 25;
/** Claims older than this are swept; matches the 60-minute gate window. */
const CLAIM_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Identity of ONE approval card: the tool call, plus which gate is asking.
 *
 * `toolUseId` is what makes two handlers of the same tool call collide and two
 * different tool calls not. `action` is in the key so a single tool call that
 * legitimately needs two DIFFERENT approvals — a destructive gate and an
 * outbound-email gate — still raises one card each rather than collapsing into
 * whichever staged first and answering one question with the other's approval.
 *
 * The COMMAND is deliberately NOT in the key, and leaving it in was a real bug
 * caught before this shipped. The two guards do not see the same command string:
 * NanoClaw's in-tree chain runs its Bash sanitizer FIRST and gates on the
 * rewritten `unset <secret-vars> 2>/dev/null; <original>` form, while this
 * adapter gates on the raw command from the hook input — codex hands every
 * handler the same `input_json`, built once before any of them runs. Keying on
 * the command therefore produced two different keys for one tool call and both
 * guards staged anyway, exactly the behaviour the claim exists to remove. One
 * tool call is one command, so (toolUseId, action) is both sufficient and the
 * only thing the two chains can agree on.
 */
export function gateClaimKey(toolUseId: string, action: string): string {
    return createHash('sha256').update(`${toolUseId}\u0000${action}`).digest('hex').slice(0, 32);
}

/** Remove claim files older than the gate window. Best-effort, never throws. */
function sweepStaleClaims(nowMs: number): void {
    let entries: string[];
    try {
        entries = readdirSync(GATE_CLAIM_DIR);
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = `${GATE_CLAIM_DIR}/${entry}`;
        try {
            if (nowMs - statSync(full).mtimeMs > CLAIM_MAX_AGE_MS) unlinkSync(full);
        } catch {
            // Gone already, or not ours to remove.
        }
    }
}

/**
 * Which `delivered.status` values mean a human has ANSWERED the card.
 *
 * Extracted and exported because this predicate, not the SQLite plumbing around
 * it, is where the bug was: an earlier revision treated the mere PRESENCE of a
 * row as decided, which made every `pending` card — the live, unanswered state —
 * look settled. The DB path is a hardcoded container mount, so the round trip
 * cannot be driven from a unit test; the predicate can, exhaustively.
 *
 * An unknown status is NOT decided: a future status this code has never heard of
 * is more likely a new in-flight state than a new terminal one, and guessing
 * "decided" is the answer that silently duplicates approval cards.
 */
export function isDecidedGateStatus(status: string | null | undefined): boolean {
    return status === 'delivered' || status === 'failed';
}

/**
 * Has this requestId ALREADY been decided?
 *
 * A live peer publishes an id that nothing has answered yet, so a published id
 * that already carries a `delivered` row is not a peer to wait on — it is a past
 * decision being replayed, and honouring it would hand this tool call an
 * approval a human gave to a different command.
 *
 * The claim directory lives under /tmp, which an agent can write to, so this is
 * the one check that cannot be skipped: without it, planting a claim pointing at
 * any previously-approved requestId skips the gate outright. (It also covers the
 * no-attacker case — a `tool_use_id` repeating inside the sweep window would
 * otherwise reuse the earlier decision.)
 *
 * DECIDED means `delivered` or `failed` — NOT `pending`. The host writes a
 * `pending` row the moment it posts the card and leaves it there for the whole
 * decision window (nanoclaw `src/modules/bash-gate/index.ts` →
 * `src/modules/mailbox/ops/delivery.ts`), so `pending` is precisely the state a
 * loser SHOULD wait on. Counting it as decided fails safe but reintroduces the
 * duplicate cards this whole mechanism removes: every loser arriving more than
 * one host poll (~1s) after the owner staged would raise its own card, and a
 * command needing both the destructive and the email gate would raise four.
 * Every other reader agrees — `pollDeliveredTable` below, and nanoclaw's
 * `container/agent-runner/src/db/delivery-acks.ts`, both treat `pending` as
 * unresolved.
 *
 * Unreadable DB, missing table, anything unexpected: answer TRUE. "I could not
 * check" must refuse the shortcut and make the caller stage its own card, never
 * wave it through.
 */
export function gateRequestAlreadyDecided(requestId: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    let db: import('bun:sqlite').Database | undefined;
    try {
        db = new Database(NANOCLAW_INBOUND_DB, { readonly: true });
        db.exec('PRAGMA busy_timeout = 2000');
        const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(requestId) as
            | { status?: string }
            | undefined
            | null;
        return isDecidedGateStatus(row?.status);
    } catch {
        return true;
    } finally {
        try {
            db?.close();
        } catch {
            // Nothing left to do.
        }
    }
}

export type GateClaim =
    | { owner: true }
    /** Another process owns the card; poll `requestId` for the shared decision. */
    | { owner: false; requestId: string }
    /** Nobody published in time — stage your own request (fail-closed). */
    | { owner: false; requestId: null };

/**
 * Claim the right to stage the approval card for `key`, or find out who did.
 *
 * The winner MUST follow up with `publishGateClaim` (on a successful stage) or
 * `abandonGateClaim` (on a failure), or every peer waits out
 * CLAIM_PUBLISH_TIMEOUT_MS and stages its own.
 *
 * Any filesystem failure answers `{ owner: true }`: unable to coordinate means
 * behaving exactly as this code did before the claim existed.
 */
export function claimGateRequest(key: string, nowMs: number = Date.now()): GateClaim {
    const lockPath = `${GATE_CLAIM_DIR}/${key}.lock`;
    const claimPath = `${GATE_CLAIM_DIR}/${key}`;
    try {
        mkdirSync(GATE_CLAIM_DIR, { recursive: true });
        sweepStaleClaims(nowMs);
    } catch {
        return { owner: true };
    }

    try {
        closeSync(openSync(lockPath, 'wx'));
        return { owner: true };
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return { owner: true };
    }

    // Someone else holds the lock. Wait for them to publish the requestId.
    const deadline = nowMs + CLAIM_PUBLISH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const requestId = readFileSync(claimPath, 'utf-8').trim();
            if (requestId) return { owner: false, requestId };
        } catch {
            // Not published yet, or the owner abandoned it — the lock's absence
            // means the latter, and racing for it now would just duplicate the
            // wait, so keep polling until the deadline either way.
        }
        if (!existsSync(lockPath)) break;
        sleepSync(CLAIM_POLL_INTERVAL_MS);
    }
    // One last look: the owner may have published between the final read and
    // the lock disappearing.
    try {
        const requestId = readFileSync(claimPath, 'utf-8').trim();
        if (requestId) return { owner: false, requestId };
    } catch {
        // Genuinely nothing published.
    }
    return { owner: false, requestId: null };
}

/** Publish the owner's requestId, atomically, so losers can poll the same decision. */
export function publishGateClaim(key: string, requestId: string): void {
    const claimPath = `${GATE_CLAIM_DIR}/${key}`;
    try {
        // Written then renamed: a loser must never read a half-written id.
        writeFileSync(`${claimPath}.tmp`, requestId);
        renameSync(`${claimPath}.tmp`, claimPath);
    } catch {
        // A loser falls back to staging its own request — two cards, never none.
    }
}

/** Release a claim the owner could not stage, so a peer can take it over. */
export function abandonGateClaim(key: string): void {
    try {
        unlinkSync(`${GATE_CLAIM_DIR}/${key}.lock`);
    } catch {
        // Never created, or already gone.
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
        // The host renders a bounded head+tail preview and retains the full
        // command in its approval record. Truncating here would discard final
        // arguments before the approver or audit trail could inspect them.
        command,
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
        // The tool call this gate belongs to (`tool_use_id` from the PreToolUse
        // hook input). When given, concurrently-dispatched guards for the SAME
        // tool call share ONE approval card instead of raising one each — see
        // `claimGateRequest`. Omitted, behaviour is exactly as before.
        toolUseId?: string;
    },
): GateDecision {
    const key = opts.toolUseId ? gateClaimKey(opts.toolUseId, opts.action) : null;
    if (key) {
        const claim = claimGateRequest(key);
        if (!claim.owner && claim.requestId && !gateRequestAlreadyDecided(claim.requestId)) {
            // A peer guard already staged this exact card. Wait on ITS decision
            // so the human answers once and both guards honour that one answer.
            return pollDeliveredTable(claim.requestId, 60 * 60 * 1000);
        }
        // Either we own the claim, or nobody published in time. Both stage
        // below; the second case is the fail-closed fallback (two cards beats
        // no gate).
    }

    let requestId: string;
    try {
        requestId = writeGateRequest(reason, opts.summary ?? reason, command, opts.action);
    } catch (err) {
        // If we can't even stage the request, the session DBs are in a broken
        // state. Deny rather than silently allowing — the gate is fail-closed.
        if (key) abandonGateClaim(key);
        opts.onStageError?.(err);
        return 'denied';
    }
    if (key) publishGateClaim(key, requestId);

    return pollDeliveredTable(requestId, 60 * 60 * 1000); // 60 min, matches host BASH_GATE_TIMEOUT_MS
}

/**
 * NanoClaw destructive-command session-DB approval gate. Thin wrapper over
 * runGateRequest with action='request_destructive_gate'.
 *
 * SIGNATURE IS LOAD-BEARING — `(command, reason, onStageError?, toolUseId?)`.
 * Existing callers (block-destructive.ts, opencode-guard.ts) pass the
 * onStageError callback as the 3rd positional arg. Do NOT add a positional
 * `action` here; route action selection through runGateRequest instead.
 *
 * `toolUseId` is APPENDED rather than folded into an options object for the same
 * reason: a caller on an older container image passes three arguments and keeps
 * working, and a caller that passes four gets one approval card per tool call
 * even when two guards gate the same command concurrently.
 */
export function runNanoclawGate(
    command: string,
    reason: string,
    onStageError?: (err: unknown) => void,
    toolUseId?: string,
): GateDecision {
    return runGateRequest(command, reason, { action: 'request_destructive_gate', onStageError, toolUseId });
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
    toolUseId?: string,
): GateDecision {
    return runGateRequest(command, reason, { action: 'request_bash_gate', onStageError, summary, toolUseId });
}
