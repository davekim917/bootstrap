/**
 * Shared TypeScript type definitions for Claude Code hooks
 */

// Base hook input structure
export interface HookInput {
    session_id: string;
    cwd: string;
}

// Tool use hook input
export interface ToolUseInput extends HookInput {
    tool_name: string;
    tool_input: {
        file_path?: string;
        [key: string]: any;
    };
}
