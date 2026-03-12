#!/usr/bin/env bun
/**
 * UserPromptSubmit hook: Suggests relevant skills based on user prompt
 * Global hook that works across all projects with skill systems
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { UserPromptSubmitInput, SkillTriggers } from '../lib/types';
import { getProjectDir, getSkillRulesPath, getGlobalSkillRulesPath } from '../lib/project-detection';
import { discoverSkillsInDir } from '../lib/skill-discovery';

// Extend the base type to include prompt
interface HookInput extends UserPromptSubmitInput {
    prompt: string;
}

interface SkillRule {
    type: 'guardrail' | 'domain';
    enforcement: 'block' | 'suggest' | 'warn';
    priority: 'critical' | 'high' | 'medium' | 'low';
    promptTriggers?: SkillTriggers;
}

interface SkillRules {
    version: string;
    skills: Record<string, SkillRule>;
}

interface MatchedSkill {
    name: string;
    matchType: 'keyword' | 'intent';
    config: SkillRule;
}

interface SessionState {
    skills_suggested: string[];
}

// Global state directory with per-project isolation
const GLOBAL_STATE_DIR = join(process.env.HOME || '/root', '.claude', 'hooks', 'state');

function getProjectHash(projectDir: string): string {
    return createHash('md5').update(projectDir).digest('hex').slice(0, 12);
}

function getStatePath(projectDir: string, sessionId: string, filename: string): string {
    const projectHash = getProjectHash(projectDir);
    return join(GLOBAL_STATE_DIR, projectHash, sessionId, filename);
}

function readJSON<T>(path: string, fallback: T): T {
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return fallback;
    }
}

function writeJSON(path: string, data: any): void {
    try {
        mkdirSync(join(path, '..'), { recursive: true });
    } catch {}
    writeFileSync(path, JSON.stringify(data, null, 2));
}

async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        // Get project directory using reliable detection
        const projectDir = getProjectDir(data);

        // Read global and project skill rules, merge them (project takes precedence)
        const globalRulesPath = getGlobalSkillRulesPath();
        const projectRulesPath = getSkillRulesPath(projectDir);

        const globalSkillsDir = join(process.env.HOME || '/root', '.claude', 'skills');
        const projectSkillsDir = join(projectDir, '.claude', 'skills');

        // Collect manual skill names to skip in auto-discovery (manual entries win)
        const manualSkillNames = new Set<string>();
        if (globalRulesPath) {
            try {
                const r: SkillRules = JSON.parse(readFileSync(globalRulesPath, 'utf-8'));
                Object.keys(r.skills).forEach(k => manualSkillNames.add(k));
            } catch {}
        }
        if (projectRulesPath) {
            try {
                const r: SkillRules = JSON.parse(readFileSync(projectRulesPath, 'utf-8'));
                Object.keys(r.skills).forEach(k => manualSkillNames.add(k));
            } catch {}
        }

        // Auto-discover skills from SKILL.md frontmatter (all tiers)
        const globalDiscovered = discoverSkillsInDir(globalSkillsDir, 'global', manualSkillNames);
        const projectDiscovered = discoverSkillsInDir(projectSkillsDir, projectDir, manualSkillNames);

        // Also discover skills from plugin directories (scan all subdirs dynamically)
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
        let pluginDiscovered: Record<string, any> = {};
        if (pluginRoot) {
            const pluginSkillsRoot = join(pluginRoot, 'skills');
            try {
                const subdirs = readdirSync(pluginSkillsRoot).filter(entry => {
                    try { return statSync(join(pluginSkillsRoot, entry)).isDirectory(); } catch { return false; }
                });
                for (const subdir of subdirs) {
                    const pluginSkillsDir = join(pluginSkillsRoot, subdir);
                    const discovered = discoverSkillsInDir(pluginSkillsDir, `plugin-${subdir}`, manualSkillNames);
                    pluginDiscovered = { ...pluginDiscovered, ...discovered };
                }
            } catch {}
        }

        // Exit silently if no skill sources at all
        if (!globalRulesPath && !projectRulesPath
            && Object.keys(globalDiscovered).length === 0
            && Object.keys(projectDiscovered).length === 0
            && Object.keys(pluginDiscovered).length === 0) {
            process.exit(0);
        }

        const prompt = data.prompt.toLowerCase();

        // Merge priority (later wins): plugin discovered → global discovered → global rules → project discovered → project rules
        let mergedSkills: Record<string, SkillRule> = {};

        // 0. Plugin auto-discovered (lowest priority)
        mergedSkills = { ...pluginDiscovered };

        // 1. Global auto-discovered
        mergedSkills = { ...mergedSkills, ...globalDiscovered };

        // 2. Global skill-rules.json overrides discovered
        if (globalRulesPath) {
            const globalRules: SkillRules = JSON.parse(readFileSync(globalRulesPath, 'utf-8'));
            mergedSkills = { ...mergedSkills, ...globalRules.skills };
        }

        // 3. Project auto-discovered (overrides global)
        mergedSkills = { ...mergedSkills, ...projectDiscovered };

        // 4. Project skill-rules.json overrides everything
        if (projectRulesPath) {
            const projectRules: SkillRules = JSON.parse(readFileSync(projectRulesPath, 'utf-8'));
            mergedSkills = { ...mergedSkills, ...projectRules.skills };
        }

        const rules: SkillRules = { version: '2.0', skills: mergedSkills };

        const matchedSkills: MatchedSkill[] = [];

        // Check each skill for matches
        for (const [skillName, config] of Object.entries(rules.skills)) {
            const triggers = config.promptTriggers;
            if (!triggers) {
                continue;
            }

            // Keyword matching with word boundaries
            if (triggers.keywords) {
                const keywordMatch = triggers.keywords.some(kw => {
                    // Escape special regex characters in the keyword
                    const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    // Create regex with word boundaries
                    const regex = new RegExp(`\\b${escapedKw}\\b`, 'i');
                    return regex.test(prompt);
                });
                if (keywordMatch) {
                    matchedSkills.push({ name: skillName, matchType: 'keyword', config });
                    continue;
                }
            }

            // Intent pattern matching (with ReDoS protection)
            if (triggers.intentPatterns) {
                const intentMatch = triggers.intentPatterns.some(pattern => {
                    try {
                        const regex = new RegExp(pattern, 'i');
                        // Limit input length to prevent catastrophic backtracking
                        return regex.test(prompt.slice(0, 1000));
                    } catch {
                        return false; // Invalid regex pattern - skip
                    }
                });
                if (intentMatch) {
                    matchedSkills.push({ name: skillName, matchType: 'intent', config });
                }
            }
        }

        // Optional trigger accuracy tracking
        if (process.env.CLAUDE_TRACK_TRIGGERS === 'true') {
            const logFile = `${process.env.HOME}/.claude/trigger-log.csv`;
            const timestamp = new Date().toISOString();
            const skills = matchedSkills.map(s => s.name).join('|');
            const promptSample = prompt.substring(0, 100).replace(/[\n\r,]/g, ' ');
            const logEntry = `${timestamp},${skills || 'NONE'},${promptSample}\n`;

            try {
                const fs = require('fs');
                fs.appendFileSync(logFile, logEntry);
            } catch (error) {
                // Silently ignore logging errors
            }
        }

        // Session tracking: check if skills already suggested
        const sessionId = data.session_id || 'default';
        const statePath = getStatePath(projectDir, sessionId, 'skills-suggested.json');
        const sessionState = readJSON<SessionState>(statePath, { skills_suggested: [] });

        // Separate skills by enforcement level
        const blockingSkills = matchedSkills.filter(s => s.config.enforcement === 'block');
        const suggestingSkills = matchedSkills.filter(s => s.config.enforcement === 'suggest');
        const warningSkills = matchedSkills.filter(s => s.config.enforcement === 'warn');

        // Check if any NEW skills are being suggested (not already in session)
        const newBlockingSkills = blockingSkills.filter(s => !sessionState.skills_suggested.includes(s.name));
        const newSuggestingSkills = suggestingSkills.filter(s => !sessionState.skills_suggested.includes(s.name));
        const newWarningSkills = warningSkills.filter(s => !sessionState.skills_suggested.includes(s.name));

        const hasNewSkills = newBlockingSkills.length > 0 || newSuggestingSkills.length > 0 || newWarningSkills.length > 0;
        const hasAnySkills = matchedSkills.length > 0;

        // Generate output based on whether this is first suggestion or reminder
        if (hasNewSkills) {
            // FIRST TIME: Show full formatted message
            if (newBlockingSkills.length > 0) {
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('⚠️  CRITICAL SKILLS REQUIRED');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('');
                console.log('Load these skills BEFORE responding:');
                newBlockingSkills.forEach(s => {
                    const description = s.config.type === 'guardrail' ? 'Critical patterns' : 'Required patterns';
                    console.log(`  → ${s.name} (${description})`);
                });
                console.log('');
                console.log('ACTION: Use Skill tool now to load required skills');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                if (newSuggestingSkills.length > 0 || newWarningSkills.length > 0) {
                    console.log('');
                }
            }

            if (newSuggestingSkills.length > 0) {
                const names = newSuggestingSkills.map(s => s.name).join(', ');
                console.log(`💡 Recommended (optional): ${names}`);
            }

            if (newWarningSkills.length > 0) {
                const names = newWarningSkills.map(s => s.name).join(', ');
                console.log(`ℹ️  Additional context available: ${names}`);
            }

            // Update session state with newly suggested skills
            const allNewSkills = [...newBlockingSkills, ...newSuggestingSkills, ...newWarningSkills].map(s => s.name);
            sessionState.skills_suggested.push(...allNewSkills);
            writeJSON(statePath, sessionState);

        } else if (hasAnySkills && sessionState.skills_suggested.length > 0) {
            // SUBSEQUENT: Show gentle reminder
            const alreadySuggested = matchedSkills.filter(s => sessionState.skills_suggested.includes(s.name));
            if (alreadySuggested.length > 0) {
                const names = alreadySuggested.map(s => s.name).join(', ');
                console.log(`💡 Reminder: Skills loaded this session: ${names}`);
            }
        }

        process.exit(0);
    } catch (err) {
        // Fail silently for projects without skill systems or other errors
        process.exit(0);
    }
}

main().catch(() => {
    process.exit(0);
});
