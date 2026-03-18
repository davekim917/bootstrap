#!/usr/bin/env bun
/**
 * UserPromptSubmit hook: Suggests relevant skills based on user prompt.
 * Discovers skills from SKILL.md frontmatter across global, project,
 * and plugin directories, then matches against the user's prompt.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { UserPromptSubmitInput, SkillTriggers } from '../lib/types';
import { getProjectDir } from '../lib/project-detection';
import { discoverSkillsInDir } from '../lib/skill-discovery';

interface HookInput extends UserPromptSubmitInput {
    prompt: string;
}

interface DiscoveredSkill {
    promptTriggers: SkillTriggers;
}

interface SessionState {
    skills_suggested: string[];
}

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
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);
        const projectDir = getProjectDir(data);

        const globalSkillsDir = join(process.env.HOME || '/root', '.claude', 'skills');
        const projectSkillsDir = join(projectDir, '.claude', 'skills');

        // Auto-discover skills from SKILL.md frontmatter (all tiers)
        const globalDiscovered = discoverSkillsInDir(globalSkillsDir, 'global');
        const projectDiscovered = discoverSkillsInDir(projectSkillsDir, projectDir);

        // Discover skills from plugin directories
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
        let pluginDiscovered: Record<string, DiscoveredSkill> = {};
        let pluginNamePrefix = '';
        if (pluginRoot) {
            const pluginJsonPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
            let skillsDirs: string[] = [];

            if (existsSync(pluginJsonPath)) {
                try {
                    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
                    pluginNamePrefix = pluginJson.name ? pluginJson.name + ':' : '';
                    if (Array.isArray(pluginJson.skills)) {
                        skillsDirs = pluginJson.skills.map((s: string) => resolve(pluginRoot, s));
                    }
                } catch {}
            }

            // Fallback: scan plugins/*/skills/
            if (skillsDirs.length === 0) {
                try {
                    const pluginsDir = join(pluginRoot, 'plugins');
                    const subPlugins = readdirSync(pluginsDir).filter(entry => {
                        try { return statSync(join(pluginsDir, entry)).isDirectory(); } catch { return false; }
                    });
                    for (const sub of subPlugins) {
                        const skillsPath = join(pluginsDir, sub, 'skills');
                        if (existsSync(skillsPath)) {
                            skillsDirs.push(skillsPath);
                        }
                    }
                } catch {}
            }

            for (const skillsDir of skillsDirs) {
                const discovered = discoverSkillsInDir(skillsDir, `plugin-${skillsDir}`);
                if (pluginNamePrefix) {
                    for (const [name, entry] of Object.entries(discovered)) {
                        pluginDiscovered[pluginNamePrefix + name] = entry;
                    }
                } else {
                    pluginDiscovered = { ...pluginDiscovered, ...discovered };
                }
            }
        }

        // Merge: plugin (lowest) → global → project (highest)
        const mergedSkills: Record<string, DiscoveredSkill> = {
            ...pluginDiscovered,
            ...globalDiscovered,
            ...projectDiscovered,
        };

        if (Object.keys(mergedSkills).length === 0) {
            process.exit(0);
        }

        const prompt = data.prompt.toLowerCase();
        const matchedNames: string[] = [];

        for (const [skillName, skill] of Object.entries(mergedSkills)) {
            const triggers = skill.promptTriggers;
            if (!triggers) continue;

            // Keyword matching with word boundaries
            if (triggers.keywords) {
                const keywordMatch = triggers.keywords.some(kw => {
                    const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`\\b${escapedKw}\\b`, 'i').test(prompt);
                });
                if (keywordMatch) {
                    matchedNames.push(skillName);
                    continue;
                }
            }

            // Intent pattern matching (with ReDoS protection)
            if (triggers.intentPatterns) {
                const intentMatch = triggers.intentPatterns.some(pattern => {
                    try {
                        return new RegExp(pattern, 'i').test(prompt.slice(0, 1000));
                    } catch {
                        return false;
                    }
                });
                if (intentMatch) {
                    matchedNames.push(skillName);
                }
            }
        }

        if (matchedNames.length === 0) {
            process.exit(0);
        }

        // Session tracking: avoid re-suggesting
        const sessionId = data.session_id || 'default';
        const statePath = getStatePath(projectDir, sessionId, 'skills-suggested.json');
        const sessionState = readJSON<SessionState>(statePath, { skills_suggested: [] });

        const newSkills = matchedNames.filter(s => !sessionState.skills_suggested.includes(s));

        if (newSkills.length > 0) {
            console.log(`💡 Recommended (optional): ${newSkills.join(', ')}`);
            sessionState.skills_suggested.push(...newSkills);
            writeJSON(statePath, sessionState);
        } else {
            const names = matchedNames.join(', ');
            console.log(`💡 Reminder: Skills loaded this session: ${names}`);
        }

        process.exit(0);
    } catch {
        process.exit(0);
    }
}

main().catch(() => {
    process.exit(0);
});
