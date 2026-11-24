import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A gws login in the machine's own config directory makes the email gate refuse every send that names a credentials
// file, so the suite runs as on a machine with none: a config directory that does not exist. Tests of that refusal
// pass their own directory.
const root = mkdtempSync(join(tmpdir(), 'gws-config-'));
process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = join(root, 'gws');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
