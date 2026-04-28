#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks destructive bash commands
 *
 * Uses unbash AST parser for accurate command boundary detection — eliminates
 * false positives from heredoc content, quoted strings, and comments. Falls
 * back to regex splitting if the parser fails (fail-open design).
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
 * Exit code 2 blocks the tool (Claude Code semantics)
 * Message written to stderr is shown to Claude as the reason for the block
 *
 * Gate mechanism: Infrastructure patterns use a one-time approval file in
 * /tmp/.claude-destructive-gate/<hash>. On first attempt, the hook blocks and
 * instructs Claude to get user approval. If approved, Claude creates the file,
 * retries, and the hook consumes (deletes) it to allow the command through.
 *
 * Fail-open on parse errors (exit 0) — tradeoff: a broken hook silently allows all commands.
 * This is intentional to avoid blocking legitimate work due to hook bugs.
 *
 * Known limitations:
 *   - Interpreter-based deletion (python -c os.remove, perl -e unlink) is not detected
 *   - mv, cp /dev/null, and redirect-based truncation (> file) are not in scope
 */
import { readFileSync, realpathSync, unlinkSync, existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { resolve as pathResolve } from 'path';
import { parse } from 'unbash';
import type { ToolUseInput } from '../lib/types';

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
const NANOCLAW_OUTBOUND_DB = '/workspace/outbound.db';
const NANOCLAW_INBOUND_DB = '/workspace/inbound.db';
const IS_NANOCLAW = existsSync(NANOCLAW_OUTBOUND_DB) && existsSync(NANOCLAW_INBOUND_DB);

// ── Types ────────────────────────────────────────────────────────────────────

interface BashToolInput extends ToolUseInput {
    tool_input: {
        command?: string;
    };
}

/** A command extracted from the AST with wrapper commands (sudo, env, etc.) resolved */
interface ResolvedCommand {
    name: string;               // resolved command name (e.g., "rm", "aws", "kubectl")
    args: string[];             // argument values after wrapper stripping
    raw: string;                // original text for error messages
    hasInputRedirect: boolean;  // true if command has << or <<< redirects
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// Command wrappers that should be stripped to find the real command
const WRAPPERS = new Set([
    'sudo', 'env', 'command', 'builtin', 'nohup', 'time', 'nice', 'timeout', 'gtimeout',
]);

// Protected home subdirectories — rm targeting anything inside these is blocked
const PROTECTED_HOME_DIRS = [
    // Personal data
    'Documents', 'Desktop', 'Downloads', 'Library',
    'Pictures', 'Music', 'Movies',
    // Security / credentials
    '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.1password',
    // AI / agent tooling
    '.claude', '.codex', '.agents', '.gemini', '.cursor',
    // Dev environment (painful to rebuild)
    '.nvm', '.cargo', '.npm',
    // App config
    '.config',
];

// Ephemeral dirs where rm is unconditionally allowed
const SAFE_PATH_PATTERNS = [
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
//
// Goal: catch the realistic accidental-destructive paths an agent can emit,
// not just literal `DROP/TRUNCATE/DELETE FROM` at column 1. The patterns
// below cover Snowflake/Postgres/MySQL DDL and DML that an agent could
// reasonably produce by mistake when working against a prod connection.
const DDL_DROP_TARGETS =
    '(?:TABLE|SCHEMA|DATABASE|VIEW|PROCEDURE|FUNCTION|OWNED|TRIGGER|INDEX|MATERIALIZED\\s+VIEW)';
const DDL_REPLACE_TARGETS =
    '(?:TABLE|VIEW|MATERIALIZED\\s+VIEW|TEMP(?:ORARY)?\\s+TABLE|EXTERNAL\\s+TABLE|FUNCTION|PROCEDURE|TRIGGER)';

const DESTRUCTIVE_SQL_PATTERNS: Array<{ rx: RegExp; label: string }> = [
    { rx: new RegExp(`^DROP\\s+${DDL_DROP_TARGETS}\\b`, 'i'), label: 'DROP' },
    { rx: /^TRUNCATE\b/i, label: 'TRUNCATE' },
    { rx: /^DELETE\s+FROM\b/i, label: 'DELETE FROM' },
    { rx: new RegExp(`^CREATE\\s+OR\\s+REPLACE\\s+${DDL_REPLACE_TARGETS}\\b`, 'i'), label: 'CREATE OR REPLACE' },
    { rx: /^INSERT\s+OVERWRITE\b/i, label: 'INSERT OVERWRITE' },
    { rx: /^MERGE\s+INTO\b/i, label: 'MERGE' },
    // ALTER ... DROP — match ALTER followed (anywhere in the same statement)
    // by a word-bounded DROP. After string-strip, a DROP keyword inside a
    // string literal cannot reach this check.
    { rx: /^ALTER\b[\s\S]*\bDROP\b/i, label: 'ALTER ... DROP' },
];

// UPDATE without WHERE is gated separately so the check can short-circuit
// when WHERE is present in the same statement.
const UPDATE_LEADING = /^UPDATE\b/i;
const HAS_WHERE = /\bWHERE\b/i;

// Recursion limit for EXECUTE IMMEDIATE — pathological nesting is silly,
// not dangerous; cap to keep the worst-case scan bounded.
const SQL_RECURSION_LIMIT = 3;

// MongoDB destructive methods
const DESTRUCTIVE_MONGO = /(?:\bdropDatabase\b|\.drop\s*\(|\.deleteMany\s*\(|\.remove\s*\()/i;

// SQL CLI name → display label (checked against DESTRUCTIVE_SQL_LEADING in argument values)
const SQL_CLIS: Record<string, string> = {
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
function stripSqlLiteralsAndComments(sql: string): string {
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
            const m = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
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
 * Decompose a `;`-separated SQL segment (already string-stripped) into the
 * list of "verb-bearing bodies" that need to be checked.
 *
 * For most statements this is just `[segment]`. For CTE-prefixed statements —
 * `WITH x AS (...) [, y AS (...)]* <body>` — it returns each CTE body plus
 * the trailing body. This catches Postgres-style destructive CTEs like
 * `WITH d AS (DELETE FROM foo RETURNING *) SELECT * FROM d`, where the
 * trailing body is a SELECT but the CTE body itself is a DELETE.
 *
 * Each returned body is annotated with `isCTE` so the gate message can
 * report whether the destructive statement was the top-level body or
 * wrapped inside a CTE.
 */
interface SqlBody {
    body: string;
    isCTE: boolean;
}

function decomposeSqlSegment(skel: string): SqlBody[] {
    const trimmed = skel.trim();
    if (!/^WITH\b/i.test(trimmed)) return [{ body: trimmed, isCTE: false }];

    const bodies: SqlBody[] = [];
    let s = trimmed.replace(/^WITH\s+(?:RECURSIVE\s+)?/i, '');

    // Each CTE: <name>[(col,...)] AS (<body>)[, ...]
    while (s.length > 0) {
        // Identifier: bare \w+, "double-quoted" (post-strip = "  "), or `backticked`
        const nameMatch = s.match(/^(?:"\s*"|"[^"]*"|`[^`]*`|[A-Za-z_][\w$]*)\s*(?:\([^)]*\))?\s+AS\s+/i);
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

interface DestructiveMatch {
    /** Pattern label for the gate message — e.g. "DROP", "UPDATE without WHERE", "CTE-wrapped DELETE FROM". */
    pattern: string;
    /** Statement fragment (truncated to 200 chars) — shown in the gate message so the approver sees what tripped it. */
    statement: string;
}

function checkSqlBody(b: SqlBody): DestructiveMatch | null {
    const trimmed = b.body.trim();
    if (!trimmed) return null;

    for (const { rx, label } of DESTRUCTIVE_SQL_PATTERNS) {
        if (rx.test(trimmed)) {
            return {
                pattern: b.isCTE ? `CTE-wrapped ${label}` : label,
                statement: trimmed.slice(0, 200),
            };
        }
    }

    // UPDATE without WHERE — bare `UPDATE foo SET col = val` rewrites every
    // row. Postgres `UPDATE foo SET ... FROM bar WHERE ...` is fine because
    // it has WHERE. A WHERE inside a subquery still counts (rare false-allow,
    // acceptable — the gate is meant to catch obvious accidents).
    if (UPDATE_LEADING.test(trimmed) && !HAS_WHERE.test(trimmed)) {
        return {
            pattern: b.isCTE ? 'CTE-wrapped UPDATE without WHERE' : 'UPDATE without WHERE',
            statement: trimmed.slice(0, 200),
        };
    }

    return null;
}

/**
 * Find every `EXECUTE IMMEDIATE '...'` literal in `originalSql` and return
 * the literal contents. The keyword match is done against the skeleton so
 * `EXECUTE IMMEDIATE` appearing inside a string or comment doesn't trigger
 * recursion (offsets are preserved by stripSqlLiteralsAndComments).
 */
function findExecuteImmediateLiterals(originalSql: string): string[] {
    const skel = stripSqlLiteralsAndComments(originalSql);
    const literals: string[] = [];
    const rx = /EXECUTE\s+IMMEDIATE\s+/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(skel)) !== null) {
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
            const tagMatch = originalSql.slice(litStart).match(/^\$([A-Za-z0-9_]*)\$/);
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
 * Scan `sql` for a destructive statement at any of the realistic accidental
 * paths an agent can emit. Returns a DestructiveMatch describing what
 * tripped the gate, or null if the SQL is non-destructive.
 *
 * Coverage:
 *   - Direct statement-leading destructive verbs (DROP/TRUNCATE/DELETE FROM)
 *   - DDL replacement (CREATE OR REPLACE TABLE/VIEW/MATERIALIZED VIEW/...)
 *   - Bulk overwrite (INSERT OVERWRITE)
 *   - MERGE (any form — the destructive clauses are too varied to whitelist)
 *   - ALTER ... DROP (drops columns/constraints/etc.)
 *   - UPDATE without WHERE (rewrites every row)
 *   - CTE-wrapped DML — `WITH x AS (DELETE FROM ...)` etc., recurses into
 *     each CTE body
 *   - Dynamic SQL via `EXECUTE IMMEDIATE '...'` — recurses into the literal
 *
 * False positives the leading/CTE/literal-strip triple is designed against:
 *   - destructive keywords inside string literals (`LIKE '%DROP TABLE%'`)
 *   - destructive keywords inside comments (`-- DROP TABLE` / `/* ... *\/`)
 *   - identifiers named like keywords (`"DROP TABLE archive"`)
 *
 * Known residual gaps (out of scope for syntactic checking):
 *   - destructive verbs inside CREATE PROCEDURE / FUNCTION bodies (the
 *     creation itself is non-destructive; a later CALL is the dangerous moment)
 *   - dynamic SQL composed at runtime via PREPARE / EXECUTE bind vars
 *   - `UPDATE ... WHERE 1=1` (semantically rewrites everything; syntactically
 *     has WHERE)
 */
function findDestructiveSqlStatement(sql: string, depth: number = 0): DestructiveMatch | null {
    if (depth > SQL_RECURSION_LIMIT) return null;

    const skeleton = stripSqlLiteralsAndComments(sql);
    for (const segment of skeleton.split(';')) {
        for (const body of decomposeSqlSegment(segment)) {
            const match = checkSqlBody(body);
            if (match) return match;
        }
    }

    // EXECUTE IMMEDIATE — peek into each literal and recurse on its contents.
    for (const literal of findExecuteImmediateLiterals(sql)) {
        const inner = findDestructiveSqlStatement(literal, depth + 1);
        if (inner) {
            return {
                pattern: `EXECUTE IMMEDIATE → ${inner.pattern}`,
                statement: inner.statement,
            };
        }
    }

    return null;
}

// Platform CLIs → destructive subcommand verbs
const PLATFORM_DESTRUCTIVE: Record<string, Set<string>> = {
    render:  new Set(['delete', 'down', 'destroy']),
    railway: new Set(['delete', 'down', 'destroy', 'remove']),
    fly:     new Set(['delete', 'destroy']),
    flyctl:  new Set(['delete', 'destroy']),
    doctl:   new Set(['delete', 'destroy']),
};

// ── Path helpers ─────────────────────────────────────────────────────────────

function expandPath(p: string): string {
    return p
        .replace(/^~(?=\/|$)/, HOME)
        .replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
}

function normalizePath(p: string): string {
    const expanded = expandPath(p);
    const resolved = pathResolve(expanded);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function isProtectedAbsolutePath(abs: string): boolean {
    if (/^\/+$/.test(abs)) return true;
    if (/^\/(?:usr|etc|System|private\/etc|bin|sbin|opt\/homebrew|var|Library|Applications)(?:\/|$)/.test(abs)) return true;
    if (abs === HOME || abs === HOME + '/') return true;
    for (const dir of PROTECTED_HOME_DIRS) {
        const prefix = `${HOME}/${dir}`;
        if (abs === prefix || abs.startsWith(prefix + '/')) return true;
    }
    return false;
}

function isProtectedPath(p: string): boolean {
    if (/^~\/?$/.test(p) || /^\$\{?HOME\}?\/?$/.test(p) || /^\/+$/.test(p)) return true;
    if (/^~\/\*$/.test(p) || /^\$\{?HOME\}?\/\*$/.test(p)) return true;
    if (/^\/\*/.test(p) || /^\.\.(?:\/|$)/.test(p)) return true;
    return isProtectedAbsolutePath(normalizePath(p));
}

function isSafePath(p: string): boolean {
    const normalized = normalizePath(p);
    return SAFE_PATH_PATTERNS.some(pat => pat.test(normalized));
}

// ── AST helpers ──────────────────────────────────────────────────────────────

/** Recursively walk an unbash AST node, accumulating all Command nodes into `out` */
function walkCommandNodes(node: any, out: any[] = []): any[] {
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
function walkPartsForSubstitutions(node: any, commands: any[]): void {
    if (!node) return;
    if (node.type === 'CommandSubstitution' || node.type === 'Backtick') {
        commands.push(...walkCommandNodes(node.body || node.command));
    }
    for (const part of (node.parts || [])) {
        walkPartsForSubstitutions(part, commands);
    }
}

/** Resolve a Command AST node: strip wrapper commands, extract name + args */
function resolveCommand(node: any): ResolvedCommand | null {
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
function extractCommands(command: string): ResolvedCommand[] {
    try {
        const ast = parse(command);
        const nodes = walkCommandNodes(ast);
        return nodes.map(resolveCommand).filter((c): c is ResolvedCommand => c !== null);
    } catch {
        return fallbackExtract(command);
    }
}

/** Regex-based fallback for when the AST parser fails */
function fallbackExtract(command: string): ResolvedCommand[] {
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
function normalizeCommandFallback(s: string): string {
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
function checkHardBlock(cmd: ResolvedCommand): string | null {
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
function checkGatedCommand(cmd: ResolvedCommand): string | null {
    const { name, args } = cmd;

    // ── Databases ────────────────────────────────────────────────────────

    // SQL CLIs: scan each arg for any of the realistic destructive paths an
    // agent can emit (DROP/TRUNCATE/DELETE, CREATE OR REPLACE, INSERT OVERWRITE,
    // MERGE, ALTER ... DROP, UPDATE without WHERE, CTE-wrapped DML, EXECUTE
    // IMMEDIATE recursion). Strings and comments are stripped before matching
    // so a SELECT against query history (`WHERE query_text LIKE '%DROP TABLE%'`)
    // does not trip the gate.
    const sqlLabel = SQL_CLIS[name];
    if (sqlLabel) {
        for (const a of args) {
            const matched = findDestructiveSqlStatement(a);
            if (matched) {
                return `Destructive ${sqlLabel} SQL detected (${matched.pattern}) — ${matched.statement}`;
            }
        }
    }
    // Snowflake: `snow sql -q "DROP TABLE ..."`
    if (name === 'snow' && args[0] === 'sql') {
        for (const a of args) {
            const matched = findDestructiveSqlStatement(a);
            if (matched) {
                return `Destructive Snowflake SQL detected (${matched.pattern}) — ${matched.statement}`;
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

/** Apply three-tier rm protection. Calls process.exit(2) if blocked. */
function checkRm(cmd: ResolvedCommand): void {
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
        console.error(`BLOCKED: '${cmd.raw}' — rm requires an explicit path. Use: trash <path>`);
        process.exit(2);
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
        console.error(`BLOCKED: '${cmd.raw}' — rm with bare wildcard/dot is not allowed. Be explicit about which paths to delete.`);
        process.exit(2);
    }

    // Tier 1: protected paths → hard block (safe ephemeral paths take priority)
    for (const p of paths) {
        if (!isSafePath(p) && isProtectedPath(p)) {
            console.error(`BLOCKED: '${cmd.raw}' — '${p}' is a protected path.`);
            process.exit(2);
        }
    }

    // Tier 2: safe ephemeral paths → allow
    // Tier 3: everything else → redirect to trash (flag only the unsafe paths)
    const unsafePaths = paths.filter(p => !isSafePath(p));
    if (unsafePaths.length > 0) {
        const trashCmd = `trash ${unsafePaths.join(' ')}`;
        console.error(`BLOCKED: rm is not allowed for non-ephemeral paths. Re-run your command using trash instead:\n\n  ${trashCmd}\n\ntrash moves files to macOS Trash (recoverable). Ephemeral paths (tmp, node_modules, dist, build, .cache, coverage, __pycache__, etc.) are allowed with rm.`);
        process.exit(2);
    }
}

// ── Gate mechanism ───────────────────────────────────────────────────────────

const GATE_DIR = '/tmp/.claude-destructive-gate';

function computeGateHash(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

function consumeGateApproval(command: string): boolean {
    const hash = computeGateHash(command);
    const approvalPath = `${GATE_DIR}/${hash}`;
    try {
        unlinkSync(approvalPath);  // atomic: delete = consume approval in one syscall
        return true;
    } catch {
        return false;  // ENOENT or any other error → no approval
    }
}

// ── NanoClaw DB-IPC helpers ──────────────────────────────────────────────────
// Direct writes to /workspace/outbound.db and polling reads from
// /workspace/inbound.db (both host-managed mounts). Schema stays in sync with
// container/agent-runner/src/db/{connection,messages-out,delivery-acks}.ts in
// the nanoclaw-v2 repo — any schema change there needs a matching change here.

/** Synchronous sleep using Atomics.wait (no busy loop). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/**
 * Write a request_bash_gate system action to outbound.db. requestId === id,
 * so the container side can poll `delivered` with that same string to learn
 * whether the admin approved. seq must be odd (container-side convention —
 * host uses even). We compute seq under BEGIN IMMEDIATE to serialize against
 * any concurrent writeMessageOut from the agent-runner process.
 */
function writeGateRequest(
    label: string,
    summary: string,
    command: string,
): string {
    // Dynamic import so non-NanoClaw environments (plain Claude Code) never
    // touch bun:sqlite — the module is only present under bun runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');

    const requestId = `gate-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const content = JSON.stringify({
        action: 'request_destructive_gate',
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

type GateDecision = 'approved' | 'denied' | 'timeout';

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
function pollDeliveredTable(requestId: string, timeoutMs: number): GateDecision {
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

// ── Gate blocking ───────────────────────────────────────────────────────────

function gateBlock(command: string, reason: string): void {
    // NanoClaw mode: DB-IPC gate. Block here until user approves via chat.
    if (IS_NANOCLAW) {
        let requestId: string;
        try {
            requestId = writeGateRequest(reason, reason, command);
        } catch (err) {
            // If we can't even stage the request, the session DBs are in a
            // broken state. Deny the command rather than silently allowing —
            // the destructive gate is fail-closed.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`BLOCKED: ${reason} — could not stage approval request (${msg.slice(0, 200)}).`);
            process.exit(2);
        }

        const decision = pollDeliveredTable(requestId, 60 * 60 * 1000); // 60 min, matches host BASH_GATE_TIMEOUT_MS

        if (decision === 'approved') {
            process.exit(0); // allow
        }

        const detail = decision === 'denied'
            ? 'Cancelled by user. Do not retry or explain why it was blocked — just acknowledge the cancellation briefly.'
            : 'Timed out waiting for user approval. Do not retry.';
        console.error(`BLOCKED: ${reason} — ${detail}`);
        process.exit(2);
    }

    // Local CC mode: exit with gate file instructions
    const hash = computeGateHash(command);
    console.error(
        `GATED: ${reason}\n\n` +
        `This command requires explicit user approval before execution.\n` +
        `1. Show the user the exact command and explain what it will do\n` +
        `2. Ask for their explicit approval\n` +
        `3. If approved, run: mkdir -p ${GATE_DIR} && echo approved > ${GATE_DIR}/${hash}\n` +
        `4. Then retry the original command unchanged`
    );
    process.exit(2);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: BashToolInput = JSON.parse(rawInput);
        const command = input.tool_input?.command || '';

        // Extract all commands from AST (or fallback to regex splitting)
        const commands = extractCommands(command);

        // --- Hard block checks (no bypass, ever) ---
        for (const cmd of commands) {
            const reason = checkHardBlock(cmd);
            if (reason) {
                console.error(`BLOCKED: ${reason}`);
                process.exit(2);
            }
        }

        // --- Gated checks (approval bypass) ---
        const gateApproved = consumeGateApproval(command);

        if (!gateApproved) {
            for (const cmd of commands) {
                const reason = checkGatedCommand(cmd);
                if (reason) {
                    gateBlock(command, reason);
                }
            }
        }

        // --- rm-specific checks (three-tier protection) ---
        for (const cmd of commands) {
            if (cmd.name === 'rm') {
                checkRm(cmd);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('[block-destructive] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
