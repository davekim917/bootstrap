// The NanoClaw guard plugin for the OpenCode runtime. The guard itself lives in opencode-guard-core.ts.
//
// OpenCode calls every export of a plugin file as a plugin factory, passing its own plugin context, and one that
// throws marks the whole file "failed to load plugin". So this file exports the plugin and nothing else; anything
// else exported here would be called with the wrong arguments at load time. opencode-plugin-exports.test.ts holds the rule.
export { NanoclawGuard } from './opencode-guard-core';
