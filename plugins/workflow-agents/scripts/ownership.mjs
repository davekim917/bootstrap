/**
 * Who owns a generated agent role file.
 *
 * This lives INSIDE the plugin on purpose. A marketplace install materializes
 * only `plugins/workflow-agents/`, so anything the plugin needs at runtime —
 * `install-agent-roles.mjs` and the renderer it calls — must resolve within
 * this directory. The repo-level `scripts/retire-bootstrap-agents.mjs` imports
 * the marker FROM here, never the other way round: the repo always has the
 * plugin, but the plugin never has the repo.
 *
 * The marker is this plugin's identity in a shared directory. Every role file
 * written by the installer carries it on line 1, and the installer overwrites
 * only files carrying exactly it — a file marked by another manager (NanoClaw's
 * `# managed by nanoclaw codex-sync` owns this same filename on a NanoClaw
 * host) or unmarked is refused.
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
