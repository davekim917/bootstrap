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

// Skill trigger configuration
export interface SkillTriggers {
    keywords?: string[];
    intentPatterns?: string[];
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
