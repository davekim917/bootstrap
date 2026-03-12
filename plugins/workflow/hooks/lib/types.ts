/**
 * Shared TypeScript type definitions for Claude Code hooks
 */

// Base hook input structure
export interface HookInput {
    session_id: string;
    cwd: string;
}

// UserPromptSubmit hook input
export interface UserPromptSubmitInput extends HookInput {
    transcript_path: string;
    permission_mode: string;
    prompt?: string;
}

// Tool use hook input
export interface ToolUseInput extends HookInput {
    tool_name: string;
    tool_input: {
        file_path?: string;
        [key: string]: any;
    };
}

// Stop hook input
export interface StopHookInput extends HookInput {
    transcript_path: string;
}

// Skill configuration
export interface SkillConfig {
    type: string;
    enforcement: 'block' | 'warn' | 'suggest';
    priority: string;
}

// Skill trigger configuration
export interface SkillTriggers {
    keywords?: string[];
    intentPatterns?: string[];
}

// Skill rules structure
export interface SkillRules {
    skills: {
        [skillName: string]: {
            type: string;
            enforcement: 'block' | 'warn' | 'suggest';
            priority: string;
            promptTriggers?: SkillTriggers;
            fileTriggers?: {
                pathPatterns?: string[];
                contentPatterns?: string[];
            };
        };
    };
}

// File analysis result
export interface FileAnalysis {
    hasTryCatch: boolean;
    hasAsync: boolean;
    hasSupabase: boolean;
    hasApiRoute: boolean;
    hasApiCall: boolean;
    hasHardcodedStyles: boolean;
}

// Auto-discovered skill cache (generated from SKILL.md frontmatter)
export interface DiscoveredSkillCache {
    hash: string;        // Hash of skill directory mtimes
    timestamp: number;   // When cache was generated (ms since epoch)
    skills: Record<string, {
        type: 'domain';
        enforcement: 'suggest';
        priority: 'medium';
        promptTriggers: SkillTriggers;
    }>;
}

// Session state tracking
export interface SessionState {
    skills_used: string[];
    edit_logs: Array<{
        path: string;
        timestamp: string;
    }>;
}
