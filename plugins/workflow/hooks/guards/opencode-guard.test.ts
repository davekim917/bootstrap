import { describe, test, expect } from 'bun:test';
import { gateBashOrThrow } from './opencode-guard';

// Regression guard for the OpenCode plugin's bash gate wrapper. The full
// decision matrix is covered by block-destructive.test.ts (shared core); these
// lock the wrapper's throw/allow contract that opencode's tool.execute.before
// relies on. The session-DB approval gate path (runNanoclawGate) needs the session DBs and
// is exercised by the in-container integration test, not here.

describe('opencode-guard gateBashOrThrow', () => {
  test('throws on a hard-blocked command (eval)', () => {
    expect(() => gateBashOrThrow("eval 'echo hi'")).toThrow(/eval is not allowed/);
  });

  test('throws on a hard-blocked deletion (find -delete)', () => {
    expect(() => gateBashOrThrow('find . -delete')).toThrow(/find -delete/);
  });

  test('throws on rm of a non-ephemeral path (trash redirect)', () => {
    expect(() => gateBashOrThrow('rm important.txt')).toThrow(/trash/);
  });

  test('allows a safe command (no throw)', () => {
    expect(() => gateBashOrThrow('ls -la')).not.toThrow();
  });

  test('allows rm of an ephemeral path (no throw)', () => {
    expect(() => gateBashOrThrow('rm -rf node_modules')).not.toThrow();
  });

  test('empty command is a no-op', () => {
    expect(() => gateBashOrThrow('')).not.toThrow();
  });
});
