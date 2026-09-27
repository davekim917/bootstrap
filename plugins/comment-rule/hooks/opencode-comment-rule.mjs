import { checkFileAgainstHead } from '../lib/check.mjs';
import { editedFiles, feedbackMessage } from '../lib/feedback.mjs';

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'patch', 'apply_patch']);

// OpenCode has no hook manifest: a host lists this module in its config `plugin` array.
export const CommentRuleFeedback = async (context) => {
  const reportedBySession = new Map();
  const cwd = context?.directory || process.cwd();
  return {
    'tool.execute.after': async (input, output) => {
      try {
        if (!EDIT_TOOLS.has(input?.tool) || typeof output?.output !== 'string') return;
        const results = editedFiles(input.args, cwd).map((file) => checkFileAgainstHead(file));
        const session = String(input.sessionID ?? '');
        if (!reportedBySession.has(session)) reportedBySession.set(session, new Map());
        const message = feedbackMessage(results, reportedBySession.get(session));
        if (message) output.output = `${output.output}\n\n${message}`;
      } catch {}
    },
  };
};
