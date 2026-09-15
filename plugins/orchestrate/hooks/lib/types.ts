/**
 * Shared TypeScript type definitions for Claude Code hooks
 */

// Base hook input structure
export interface HookInput {
    session_id: string;
    cwd: string;
    /** Path to the session's JSONL transcript (hooks doc, "Common input fields"). */
    transcript_path?: string;
    /** Present only when the hook fires inside a subagent. */
    agent_id?: string;
    hook_event_name?: string;
}

// Tool use hook input
export interface ToolUseInput extends HookInput {
    tool_name: string;
    /** Matches the `id` of the assistant's tool_use block in the transcript. */
    tool_use_id?: string;
    tool_input: {
        file_path?: string;
        [key: string]: any;
    };
}
