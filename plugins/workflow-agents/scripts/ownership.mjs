/**
 * Who owns an agent role file this plugin wrote in the past.
 *
 * NOTHING IN THIS PLUGIN WRITES ONE ANY MORE. The installer that did
 * (`install-agent-roles.mjs`, run by a `SessionStart` hook) and the role it
 * wrote (`worker-frontier`) were both deleted in workflow 5.7.0, when
 * `/orchestrate` moved to naming a model and an effort per dispatch. The marker
 * survives them because the files they left in users' Codex homes do: the
 * repo-level `scripts/retire-bootstrap-agents.mjs` is now the only consumer, and
 * it matches on exactly this string to decide what it may delete.
 *
 * So the reason it lives here has changed. It is no longer a runtime dependency
 * of the plugin — it is this plugin's signature on files already on disk
 * elsewhere, and moving or rewording it would orphan every one of them. Treat
 * the string as frozen.
 *
 * Marker semantics, unchanged: a role file carries it on line 1, and only files
 * carrying exactly it may be overwritten or removed. A file marked by another
 * manager (NanoClaw's `# managed by nanoclaw codex-sync` owns this same filename
 * on a NanoClaw host) or unmarked is reported and refused.
 */
export const OWNERSHIP_MARKER = '# managed by bootstrap-workflow-agents agent-sync';

/**
 * The manager marker on line 1, or null when the file carries none.
 *
 * Line 1 only, deliberately: a manager writes its marker first, so a marker
 * further down is someone's hand-written content, not a claim of ownership.
 * (`retire-bootstrap-agents.mjs` scans every line instead — it must recognise
 * legacy files this plugin wrote before that convention existed. The stricter
 * rule belongs on the write path.)
 */
export function managerOf(content) {
  const first = content.split('\n', 1)[0].replace(/\r$/, '').trim();
  return /^#\s*managed by\s+\S/.test(first) ? first : null;
}
