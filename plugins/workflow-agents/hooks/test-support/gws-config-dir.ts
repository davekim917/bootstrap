import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A gws login in the machine's own config directory, or an access token in the environment, makes the email gate refuse
// every send that names a credentials file, so the suite runs as on a machine with neither: a config directory that
// does not exist. Tests of those refusals set their own.
const root = mkdtempSync(join(tmpdir(), 'gws-config-'));
process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = join(root, 'gws');
delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
