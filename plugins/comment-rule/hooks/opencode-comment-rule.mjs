import { checkFileAgainstHead } from '../lib/check.mjs';
import { editedFiles, feedbackMessage } from '../lib/feedback.mjs';

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch', 'apply_patch']);

/**
 * OpenCode has no hook manifest, so a host lists this module in its config `plugin` array. The
 * feedback is appended to the tool's own output, which is what the model reads next; any failure
 * leaves the output untouched.
 */
export const CommentRuleFeedback = async (context) => {
  const reported = new Map();
  const cwd = context?.directory || process.cwd();
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (!EDIT_TOOLS.has(input?.tool) || typeof output?.output !== 'string') return;
        const results = editedFiles(input.args, cwd).map((file) => checkFileAgainstHead(file));
        const message = feedbackMessage(results, reported);
        if (message) output.output = `${output.output}\n\n${message}`;
      } catch {}
    },
  };
};
