#!/usr/bin/env bun
/**
 * PreToolUse hook: Blocks destructive bash commands
 *
 * Three-tier rm protection:
 *   1. Always allow: rm targeting ephemeral dirs (tmp, node_modules, build caches) — checked first
 *   2. Always block: rm targeting /, ~, $HOME, or protected home directories
 *   3. Redirect: all other rm → instructs Claude to use `trash` instead (recoverable)
 *
 * Also always blocks: unlink, shred, truncate, find -exec rm, find -delete,
 *                     xargs rm, rm inside $() or backtick substitution,
 *                     rm inside subshells, shell -c/here-string wrappers, eval,
 *                     env/command/builtin/nohup/nice/timeout//bin/ rm wrappers
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
 * Known limitations (inherent to static shell analysis):
 *   - Interpreter-based deletion (python -c os.remove, perl -e unlink) is not detected
 *   - Process substitution <(rm ...) is not detected
 *   - ANSI-C quoting ($'\x7e') in paths is not expanded
 *   - mv, cp /dev/null, and redirect-based truncation (> file) are not in scope
 */
import { readFileSync, realpathSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { resolve as pathResolve } from 'path';
import type { ToolUseInput } from '../lib/types';

interface BashToolInput extends ToolUseInput {
    tool_input: {
        command?: string;
    };
}

const HOME = homedir();

// Multi-word patterns checked against the full command string.
const ALWAYS_BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bfind\b.*\s-exec\s+(?:sudo\s+)?rm\s/, reason: 'find -exec rm is not allowed. Use trash for file deletion.' },
    { pattern: /\bfind\b.*\s-delete\b/, reason: 'find -delete permanently deletes files. Use trash instead.' },
    { pattern: /\bxargs\s+(?:sudo\s+)?rm\b/, reason: 'xargs rm is not allowed. Use trash for file deletion.' },
    // rm inside $() or backtick runs even when the outer command looks harmless (e.g. echo $(rm ...))
    { pattern: /(?:\$\([^)]*|`[^`]*)\brm\b/, reason: 'rm inside command substitution is not allowed. Use explicit paths.' },
    // rm inside subshell (rm ...) bypasses segment extraction
    { pattern: /\(\s*(?:sudo\s+)?rm\b/, reason: 'rm inside subshell is not allowed. Run commands directly.' },
];

// Gated full-command patterns — matched against the full command string.
// These block with instructions to get user approval, then allow on retry.
const GATED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // ── Databases ─────────────────────────────────────────────────────────────
    // Destructive SQL keywords shared across SQL-based CLIs
    { pattern: /\bsnow\s+sql\b.*\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|VIEW|PROCEDURE|FUNCTION)|TRUNCATE\s|DELETE\s+FROM)\b/i,
      reason: 'Destructive Snowflake SQL detected (DROP/TRUNCATE/DELETE).' },
    { pattern: /\bpsql\b.*\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|VIEW|OWNED)|TRUNCATE\s|DELETE\s+FROM)\b/i,
      reason: 'Destructive PostgreSQL SQL detected (DROP/TRUNCATE/DELETE).' },
    { pattern: /\bmysql\b.*\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|VIEW)|TRUNCATE\s|DELETE\s+FROM)\b/i,
      reason: 'Destructive MySQL SQL detected (DROP/TRUNCATE/DELETE).' },
    { pattern: /\bduckdb\b.*\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|VIEW)|TRUNCATE\s|DELETE\s+FROM)\b/i,
      reason: 'Destructive DuckDB SQL detected (DROP/TRUNCATE/DELETE).' },
    { pattern: /\bsqlite3?\b.*\b(?:DROP\s+(?:TABLE|VIEW|TRIGGER|INDEX)|DELETE\s+FROM)\b/i,
      reason: 'Destructive SQLite SQL detected (DROP/DELETE).' },

    // MongoDB — shell methods are the destructive surface
    { pattern: /\b(?:mongosh|mongo)\b.*\b(?:dropDatabase|\.drop\s*\(|deleteMany\s*\(|remove\s*\()\b/i,
      reason: 'Destructive MongoDB command detected (drop/deleteMany/remove).' },

    // Redis — flush and mass-delete
    { pattern: /\bredis-cli\b.*\b(?:FLUSHDB|FLUSHALL)\b/i,
      reason: 'Destructive Redis command detected (FLUSHDB/FLUSHALL).' },

    // ── Cloud providers ───────────────────────────────────────────────────────
    // AWS — s3 rm/rb and any service terminate/delete
    { pattern: /\baws\s+s3\s+(?:rm|rb)\b/, reason: 'Destructive AWS S3 command (rm/rb).' },
    { pattern: /\baws\s+\S+\s+(?:terminate|delete)\S*\b/, reason: 'Destructive AWS CLI command detected.' },

    // GCP/gcloud — any delete subcommand across all services
    { pattern: /\bgcloud\s+\S+\s+\S+\s+delete\b/, reason: 'Destructive gcloud command detected.' },
    { pattern: /\bgsutil\s+(?:rm|rb)\b/, reason: 'Destructive gsutil command (rm/rb).' },

    // Azure — any delete subcommand
    { pattern: /\baz\s+\S+\s+delete\b/, reason: 'Destructive Azure CLI command detected.' },

    // DigitalOcean
    { pattern: /\bdoctl\s+.*\b(?:delete|destroy)\b/, reason: 'Destructive DigitalOcean CLI command detected.' },

    // ── Infrastructure as Code ────────────────────────────────────────────────
    { pattern: /\bterraform\s+(?:destroy|apply\s+.*-auto-approve)\b/, reason: 'Destructive Terraform command (destroy/auto-approve).' },
    { pattern: /\bpulumi\s+destroy\b/, reason: 'Pulumi destroy detected.' },
    { pattern: /\bcdk\s+destroy\b/, reason: 'CDK destroy detected.' },

    // ── dbt ───────────────────────────────────────────────────────────────────
    { pattern: /\bdbt\s+(?:run|build)\b.*--full-refresh\b/, reason: 'dbt --full-refresh drops and recreates tables.' },
];

// Per-segment lead-command patterns (checked after normalizeCommand).
// Kept as a precompiled array to avoid constructing RegExp objects in a hot loop.
const BLOCKED_LEAD_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // Shell wrappers: -c flag and here-strings both hide arbitrary commands
    {
        pattern: /^(?:bash|sh|zsh|dash|ksh|fish)\s+(?:-\S+\s+)*(?:-c|<<<?)\s/,
        reason: 'Shell inline execution (shell -c, here-strings) is not allowed. Run commands directly.',
    },
    { pattern: /^eval(?:\s|$)/, reason: 'eval is not allowed. Run commands directly.' },
    { pattern: /^unlink(?:\s|$)/, reason: 'unlink permanently deletes files. Use: trash <path>' },
    { pattern: /^shred(?:\s|$)/, reason: 'shred permanently destroys file content. Use: trash <path>' },
    { pattern: /^truncate(?:\s|$)/, reason: 'truncate destroys file content.' },
];

// Gated per-segment lead-command patterns (checked after normalizeCommand).
// These block with instructions to get user approval, then allow on retry.
const GATED_LEAD_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // ── Container / orchestration ─────────────────────────────────────────────
    { pattern: /^kubectl\s+(?:delete|drain|cordon)\b/, reason: 'Destructive kubectl command.' },
    { pattern: /^docker\s+(?:rm|rmi|system\s+prune|volume\s+rm|container\s+rm|image\s+rm)\b/, reason: 'Destructive Docker command.' },
    { pattern: /^helm\s+(?:uninstall|delete)\b/, reason: 'Destructive Helm command.' },

    // ── Platform CLIs ─────────────────────────────────────────────────────────
    { pattern: /^render\s+.*\b(?:delete|down|destroy)\b/, reason: 'Destructive Render CLI command.' },
    { pattern: /^railway\s+.*\b(?:delete|down|destroy|remove)\b/, reason: 'Destructive Railway CLI command.' },
    { pattern: /^flyctl?\s+.*\b(?:delete|destroy)\b/, reason: 'Destructive Fly.io CLI command.' },
    { pattern: /^heroku\s+.*\b(?:destroy|pg:reset)\b/, reason: 'Destructive Heroku CLI command.' },
    { pattern: /^vercel\s+(?:remove|rm)\b/, reason: 'Destructive Vercel CLI command.' },
    { pattern: /^netlify\s+.*\bsites:delete\b/, reason: 'Destructive Netlify CLI command.' },
    { pattern: /^supabase\s+(?:.*\bdelete\b|db\s+reset)\b/, reason: 'Destructive Supabase CLI command.' },

    // ── Service CLIs ──────────────────────────────────────────────────────────
    { pattern: /^gh\s+repo\s+delete\b/, reason: 'Destructive GitHub CLI command (repo delete).' },
    { pattern: /^wrangler\s+(?:delete|d1\s+delete|r2\s+.*delete|kv:.*delete)\b/, reason: 'Destructive Cloudflare Wrangler command.' },
    { pattern: /^firebase\s+.*\b(?:projects:delete|firestore:delete|hosting:disable)\b/, reason: 'Destructive Firebase CLI command.' },

    // ── dd (disk overwrite) ───────────────────────────────────────────────────
    { pattern: /^dd\s+.*\bif=/, reason: 'dd with input file — potential disk overwrite.' },
];

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

// Handles ~, $HOME, and ${HOME}
function expandPath(p: string): string {
    return p
        .replace(/^~(?=\/|$)/, HOME)
        .replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
}

// Normalize a path: expand ~/$HOME, resolve .. components, then follow symlinks.
// Falls back gracefully at each step if the path does not exist on disk.
function normalizePath(p: string): string {
    const expanded = expandPath(p);
    const resolved = pathResolve(expanded);  // normalize .. and . (no FS access)
    try {
        return realpathSync(resolved);        // follow symlinks (requires FS access)
    } catch {
        return resolved;                      // path doesn't exist — use normalized form
    }
}

// Check if an absolute, fully-expanded path is in a protected location.
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
    // Check bare/symbolic forms on the original path string first (fast path, no FS access)
    if (/^~\/?$/.test(p) || /^\$\{?HOME\}?\/?$/.test(p) || /^\/+$/.test(p)) return true;
    if (/^~\/\*$/.test(p) || /^\$\{?HOME\}?\/\*$/.test(p)) return true;
    // /^\/\*/ catches root-level wildcards; /^\.\.(?:\/|$)/ catches ../ without false-matching ..foo
    if (/^\/\*/.test(p) || /^\.\.(?:\/|$)/.test(p)) return true;

    // Check the fully normalized path — catches .. traversal and symlinks into protected dirs
    return isProtectedAbsolutePath(normalizePath(p));
}

function isSafePath(p: string): boolean {
    // Check the normalized path only — prevents path traversal tricks like node_modules/../../
    const normalized = normalizePath(p);
    return SAFE_PATH_PATTERNS.some(pat => pat.test(normalized));
}

// Strip all leading command wrappers that don't change the underlying command.
// Loops until stable to handle chains like `sudo nohup env rm` or `timeout 10 sudo rm`.
function normalizeCommand(s: string): string {
    let prev = '';
    let curr = s;
    while (prev !== curr) {
        prev = curr;
        curr = curr
            .replace(/^sudo\s+/, '')
            // env accepts flags (-i, -u VAR) before VAR=VALUE pairs — handle both
            .replace(/^env(?:\s+(?:-\S+|\w+=\S+))*\s+/, '')
            .replace(/^(?:command|builtin)\s+/, '')
            .replace(/^\/(?:usr\/(?:local\/)?)?bin\//, '')
            // Process scheduling wrappers — strip before checking the underlying command
            .replace(/^(?:nohup|time)\s+/, '')
            .replace(/^nice(?:\s+-n\s+\S+)?\s+/, '')
            .replace(/^(?:timeout|gtimeout)\s+\S+\s+/, '');
    }
    return curr;
}

// Split a compound command into individual segments on shell operators.
function splitSegments(command: string): string[] {
    return command
        .split(/(?:;|&&|\|\||\||\n)\s*/)
        .map(s => s.trim())
        .filter(Boolean);
}

// Extract segments that invoke rm — directly or via sudo/env/command/nohup/full path.
function extractRmSegments(command: string): string[] {
    return splitSegments(command)
        .filter(s => /^rm\b/.test(normalizeCommand(s)));
}

// Quote-aware tokenizer — handles "path with spaces" and 'single quoted paths'.
// Strips enclosing quotes so downstream checks see the raw path.
// Note: backslash escaping is intentionally unsupported (errs toward more tokens = more checks).
function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (c === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (c === ' ' && !inSingle && !inDouble) {
            if (current) { tokens.push(current); current = ''; }
        } else {
            current += c;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

function parseRmArgs(normalizedSegment: string): { flags: string[]; paths: string[] } {
    const rest = normalizedSegment.replace(/^rm\s*/, '').trim();
    const tokens = tokenize(rest);
    const flags: string[] = [];
    const paths: string[] = [];
    let endOfFlags = false;

    for (const token of tokens) {
        if (token === '--') {
            endOfFlags = true;
        } else if (!endOfFlags && token.startsWith('-')) {
            flags.push(token);
        } else {
            paths.push(token);
        }
    }

    return { flags, paths };
}

// ── Gate mechanism ────────────────────────────────────────────────────────────
// Gated commands are blocked on first attempt with instructions for Claude to
// ask the user for approval. If approved, Claude creates a one-time approval
// file keyed by command hash. On retry, the hook finds the approval, consumes
// it (deletes), and allows the command through.

const GATE_DIR = '/tmp/.claude-destructive-gate';

function computeGateHash(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

function consumeGateApproval(command: string): boolean {
    const hash = computeGateHash(command);
    const approvalPath = `${GATE_DIR}/${hash}`;
    try {
        if (!existsSync(approvalPath)) return false;
        unlinkSync(approvalPath);  // one-time use — consume on check
        return true;
    } catch {
        return false;
    }
}

function gateBlock(command: string, reason: string): void {
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

function main(): void {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: BashToolInput = JSON.parse(rawInput);
        const command = input.tool_input?.command || '';

        // --- Full-command pattern checks ---
        for (const { pattern, reason } of ALWAYS_BLOCKED_PATTERNS) {
            if (pattern.test(command)) {
                console.error(`BLOCKED: ${reason}`);
                process.exit(2);
            }
        }

        // --- Per-segment lead-command checks ---
        // Checked per-segment (not full-string) to avoid false positives on
        // `grep unlink file.ts`, `man shred`, `echo "bash -c example"`, etc.
        for (const seg of splitSegments(command)) {
            const n = normalizeCommand(seg);
            for (const { pattern, reason } of BLOCKED_LEAD_PATTERNS) {
                if (pattern.test(n)) {
                    console.error(`BLOCKED: '${seg}' — ${reason}`);
                    process.exit(2);
                }
            }
        }

        // --- Gated checks (approval bypass) ---
        // Check once — a single approval covers all gated patterns for this command.
        const gateApproved = consumeGateApproval(command);

        if (!gateApproved) {
            // Full-command gated patterns
            for (const { pattern, reason } of GATED_PATTERNS) {
                if (pattern.test(command)) {
                    gateBlock(command, reason);
                }
            }

            // Per-segment gated lead-command patterns
            for (const seg of splitSegments(command)) {
                const n = normalizeCommand(seg);
                for (const { pattern, reason } of GATED_LEAD_PATTERNS) {
                    if (pattern.test(n)) {
                        gateBlock(command, reason);
                    }
                }
            }
        }

        // --- rm-specific checks ---
        const rmSegments = extractRmSegments(command);
        if (rmSegments.length === 0) process.exit(0);

        for (const segment of rmSegments) {
            const normalized = normalizeCommand(segment);

            // Block rm with shell substitution — paths can't be statically evaluated
            if (/\$\(|\$\{|`/.test(segment)) {
                console.error(`BLOCKED: '${segment}' — rm with shell substitution is not allowed. Use explicit paths.`);
                process.exit(2);
            }

            const { flags, paths } = parseRmArgs(normalized);
            const isRecursive = flags.some(f => /^-[^-]*r/i.test(f) || f === '--recursive');
            const isForce = flags.some(f => /^-[^-]*f/.test(f) || f === '--force');

            if (paths.length === 0) {
                console.error(`BLOCKED: '${segment}' — rm requires an explicit path. Use: trash <path>`);
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
                console.error(`BLOCKED: '${segment}' — rm with bare wildcard/dot is not allowed. Be explicit about which paths to delete.`);
                process.exit(2);
            }

            // Tier 1: protected paths → hard block (safe ephemeral paths take priority)
            for (const p of paths) {
                if (!isSafePath(p) && isProtectedPath(p)) {
                    console.error(`BLOCKED: '${segment}' — '${p}' is a protected path.`);
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

            // All paths are ephemeral — allow
        }

        process.exit(0);
    } catch (error) {
        console.error('[block-destructive] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
