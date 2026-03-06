/**
 * Auto-discovery of skills from SKILL.md frontmatter.
 * Scans global (~/.claude/skills/) and project (.claude/skills/) directories,
 * parses YAML frontmatter, extracts trigger keywords, and caches results.
 * Cache is invalidated when any SKILL.md mtime changes.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { SkillTriggers } from './types';

const GLOBAL_STATE_DIR = join(process.env.HOME || '/root', '.claude', 'hooks', 'state');

export interface DiscoveredSkillEntry {
    type: 'domain';
    enforcement: 'suggest';
    priority: 'medium';
    promptTriggers: SkillTriggers;
}

export interface DiscoveredSkillCache {
    hash: string;
    timestamp: number;
    skills: Record<string, DiscoveredSkillEntry>;
}

/**
 * Parse YAML frontmatter from SKILL.md content line by line.
 * Handles double-quoted YAML strings with \" escape sequences.
 * Returns { name, description } or null if malformed/opted-out.
 */
function parseFrontmatter(content: string): { name: string; description: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const block = match[1];
    const lines = block.split(/\r?\n/);

    let name = '';
    let description = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // user-invocable: false → skip entirely
        if (/^user-invocable:\s*false\s*$/.test(line)) return null;

        const nameMatch = line.match(/^name:\s+(.+)$/);
        if (nameMatch) {
            name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
            continue;
        }

        const descLine = line.match(/^description:\s+(.+)$/);
        if (descLine) {
            const val = descLine[1].trim();
            if (val === '>' || val === '|') {
                // YAML block scalar — collect subsequent indented continuation lines
                const joiner = val === '>' ? ' ' : '\n';
                const parts: string[] = [];
                while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
                    i++;
                    parts.push(lines[i].trim());
                }
                description = parts.join(joiner).trim();
            } else if (val.startsWith('"')) {
                // YAML double-quoted string: \" → ", \\ → \
                // Walk char by char to find the closing unescaped "
                const chars = val.slice(1); // strip opening quote
                let result = '';
                let j = 0;
                while (j < chars.length) {
                    if (chars[j] === '\\' && j + 1 < chars.length) {
                        // Escape sequence — preserve the escaped char literally
                        result += chars[j + 1];
                        j += 2;
                    } else if (chars[j] === '"') {
                        break; // Closing quote
                    } else {
                        result += chars[j];
                        j++;
                    }
                }
                description = result;
            } else if (val.startsWith("'")) {
                // YAML single-quoted string: '' → '
                const inner = val.slice(1);
                const closeIdx = inner.indexOf("'");
                description = closeIdx >= 0 ? inner.slice(0, closeIdx) : inner;
            } else {
                description = val;
            }
        }
    }

    if (!name || !description) return null;
    return { name, description };
}

/**
 * Extract trigger keywords from a description string.
 * Rules:
 * 1. Quoted strings: "Word doc", ".docx", "deck" → keywords
 * 2. File extensions: .docx, .pptx, .xlsx, .csv, .json, .yaml, .md
 * 3. Known tool/framework names: React, Next.js, dbt, etc.
 */
function extractKeywords(description: string): string[] {
    const keywords = new Set<string>();

    // 1. Quoted strings (both single and double quotes) — strip trailing punctuation
    const quotedMatches = description.matchAll(/["']([^"']{2,40})["']/g);
    for (const m of quotedMatches) {
        const val = m[1].trim().replace(/[,;:.!?]+$/, '');
        if (val && !val.includes('\n') && val.length >= 2) {
            keywords.add(val.toLowerCase());
        }
    }

    // 2. File extensions
    const extMatches = description.matchAll(/\.(docx|pptx|xlsx|xlsm|csv|tsv|json|yaml|yml|md|pdf|txt|py|ts|js|sh|sql)\b/gi);
    for (const m of extMatches) {
        keywords.add('.' + m[1].toLowerCase());
    }

    // 3. Known tool/framework names — case-insensitive word boundaries
    const knownTools = [
        'React', 'Next.js', 'NextJS', 'dbt', 'Airflow', 'Dagster', 'Prefect',
        'Spark', 'Kafka', 'Looker', 'Tableau', 'Power BI', 'Metabase',
        'PyTorch', 'TensorFlow', 'MLflow', 'scikit-learn',
        'Expo', 'React Native', 'Supabase', 'Vercel',
    ];
    for (const tool of knownTools) {
        const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(description)) {
            keywords.add(tool.toLowerCase());
        }
    }

    return [...keywords];
}

/**
 * Extract intent patterns from "Use when..." and "Trigger when..." clauses.
 */
function extractIntentPatterns(description: string): string[] {
    const patterns: string[] = [];

    // Match "Use when [verb]ing [object]" → "(verb|verbing).*(object)"
    const useWhenMatches = description.matchAll(/[Uu]se (?:this skill )?when (?:the user (?:wants? to |asks? to )?)?(\w+ing|\w+) ([^,.;]{3,40})/g);
    for (const m of useWhenMatches) {
        const verb = m[1].toLowerCase().replace(/ing$/, '');
        const obj = m[2].toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (verb.length > 2 && obj.length > 2) {
            patterns.push(`(${verb}|${verb}ing).*?(${obj})`);
        }
    }

    // Match "Trigger when..." or "Triggers on..." clauses
    const triggerMatches = description.matchAll(/[Tt]rigger(?:s)? (?:on|when) ([^,.;]{5,60})/g);
    for (const m of triggerMatches) {
        const clause = m[1].toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (clause.length > 5) {
            patterns.push(clause);
        }
    }

    return patterns;
}

/**
 * Compute a hash over all SKILL.md mtimes in a directory.
 * Returns empty string if directory doesn't exist.
 */
function computeDirHash(skillsDir: string): string {
    if (!existsSync(skillsDir)) return '';
    try {
        const entries = readdirSync(skillsDir).sort();
        const parts: string[] = [];
        for (const entry of entries) {
            const skillMd = join(skillsDir, entry, 'SKILL.md');
            if (existsSync(skillMd)) {
                const mtime = statSync(skillMd).mtimeMs;
                parts.push(`${entry}:${mtime}`);
            }
        }
        return createHash('md5').update(parts.join('|')).digest('hex');
    } catch {
        return '';
    }
}

/**
 * Get cache file path for a given cacheKey.
 * 'global' → discovered-skills-global.json
 * project path → discovered-skills-<hash>.json in per-project subdir
 */
function getCachePath(cacheKey: string): string {
    if (cacheKey === 'global') {
        return join(GLOBAL_STATE_DIR, 'discovered-skills-global.json');
    }
    const projectHash = createHash('md5').update(cacheKey).digest('hex').slice(0, 12);
    return join(GLOBAL_STATE_DIR, projectHash, 'discovered-skills-project.json');
}

/**
 * Scan a skills directory and return discovered SkillRule entries.
 * Uses mtime-based caching. cacheKey is 'global' or the project directory path.
 * Skills already listed in manualSkills (from skill-rules.json) are skipped.
 */
export function discoverSkillsInDir(
    skillsDir: string,
    cacheKey: string,
    manualSkills: Set<string> = new Set()
): Record<string, DiscoveredSkillEntry> {
    if (!existsSync(skillsDir)) return {};

    const cachePath = getCachePath(cacheKey);
    const currentHash = computeDirHash(skillsDir);

    // Try cache first
    if (existsSync(cachePath)) {
        try {
            const cached: DiscoveredSkillCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
            if (cached.hash === currentHash) {
                // Filter out any skills that are now in manualSkills
                const result: Record<string, DiscoveredSkillEntry> = {};
                for (const [name, entry] of Object.entries(cached.skills)) {
                    if (!manualSkills.has(name)) {
                        result[name] = entry;
                    }
                }
                return result;
            }
        } catch {
            // Cache corrupt — rebuild below
        }
    }

    // Cache miss: scan directory
    const skills: Record<string, DiscoveredSkillEntry> = {};

    try {
        const entries = readdirSync(skillsDir);
        for (const entry of entries) {
            // Skip non-directories and skip skill-rules.json
            const skillPath = join(skillsDir, entry);
            try {
                if (!statSync(skillPath).isDirectory()) continue;
            } catch {
                continue; // Broken symlink or permission error
            }

            const skillMd = join(skillPath, 'SKILL.md');
            if (!existsSync(skillMd)) continue;

            let content: string;
            try {
                content = readFileSync(skillMd, 'utf-8');
            } catch {
                continue; // Unreadable
            }

            const parsed = parseFrontmatter(content);
            if (!parsed) continue;

            const { name, description } = parsed;

            const keywords = extractKeywords(description);
            const intentPatterns = extractIntentPatterns(description);

            if (keywords.length === 0 && intentPatterns.length === 0) continue;

            const triggers: SkillTriggers = {};
            if (keywords.length > 0) triggers.keywords = keywords;
            if (intentPatterns.length > 0) triggers.intentPatterns = intentPatterns;

            skills[name] = {
                type: 'domain',
                enforcement: 'suggest',
                priority: 'medium',
                promptTriggers: triggers,
            };
        }
    } catch {
        // Directory unreadable
        return {};
    }

    // Write cache (with all skills, before manualSkills filtering)
    const cache: DiscoveredSkillCache = {
        hash: currentHash,
        timestamp: Date.now(),
        skills,
    };
    try {
        mkdirSync(join(cachePath, '..'), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    } catch {
        // Cache write failure is non-fatal
    }

    // Return filtered result (exclude manual skills)
    const result: Record<string, DiscoveredSkillEntry> = {};
    for (const [name, entry] of Object.entries(skills)) {
        if (!manualSkills.has(name)) {
            result[name] = entry;
        }
    }
    return result;
}
