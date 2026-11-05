import { describe, test, expect } from 'bun:test';
import { describeGate, evaluateBashCommand, OPERATOR_OVERRIDE_FLAGS } from './block-destructive-core';

const HELD: Array<[command: string, flag: string]> = [
  ['python load_records.py --accept-drop run-42', '--accept-drop'],
  ['python load_records.py --accept-drop=run-42', '--accept-drop'],
  ['./sync.sh --allow-drop', '--allow-drop'],
  ['./sync.sh --allow-drop=orders', '--allow-drop'],
  ['node migrate.js --skip-guard', '--skip-guard'],
  ['node migrate.js --skip-guard=size', '--skip-guard'],
  ['node migrate.js --skip-guards', '--skip-guards'],
  ['node migrate.js --skip-guards=all', '--skip-guards'],
  ['npm run deploy -- --no-verify', '--no-verify'],
  ['./release.sh --no-verify=yes', '--no-verify'],
  ['./publish.sh --force-publish', '--force-publish'],
  ['./publish.sh --force-publish=widgets', '--force-publish'],
  ['cd /srv/app && uv run python load_records.py --accept-drop run-42', '--accept-drop'],
  ['sudo -u loader python load_records.py --accept-drop run-42', '--accept-drop'],
  ['echo run-42 | xargs python load_records.py --accept-drop', '--accept-drop'],
  ["env -S 'python load_records.py --accept-drop run-42'", '--accept-drop'],
  ['FLAG=--accept-drop; python load_records.py $FLAG run-42', '--accept-drop'],
  ['OPTS="--skip-guard --verbose"; node migrate.js $OPTS', '--skip-guard'],
  ['python load_records.py "--accept-drop" run-42', '--accept-drop'],
];

const ALLOWED = [
  'python load_records.py run-42',
  './sync.sh',
  'node migrate.js',
  'npm run deploy',
  './publish.sh',
  'git commit -m "mention --accept-drop"',
  'git commit -m --accept-drop',
  'git commit --message=--skip-guard',
  'echo "rerun with --accept-drop once reviewed"',
  'python load_records.py --accept-dropped-rows run-42',
  'grep -rn -e --accept-drop scripts/',
  'rg -- --skip-guard src/',
  'FLAG=--verbose; python load_records.py $FLAG run-42',
];

describe('an operator-override flag holds for approval', () => {
  for (const [command, flag] of HELD) {
    test(`holds: ${command}`, () => {
      const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
      expect(verdict.action).toBe('gate');
      expect(verdict.reason).toContain(flag);
      expect(verdict.reason).toContain('overrides a safety check');
    });
  }
});

describe('the same command without the flag runs', () => {
  for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
      expect(evaluateBashCommand(command, { cwd: '/tmp' }).action).toBe('allow');
    });
  }
});

describe('the card', () => {
  test('says the command overrides the tool\'s own safety check and names the flag', () => {
    const command = 'python load_records.py --accept-drop=run-42';
    const verdict = evaluateBashCommand(command, { cwd: '/tmp' });
    const card = describeGate(command, verdict.reason!, '/tmp');
    expect(card.label).toBe('Run python with --accept-drop');
    expect(card.summary.split('\n')[0]).toBe(
      'Runs `python` with `--accept-drop`, which overrides a safety check the tool itself applies; the check is there to stop a run like this one, so find out what it would have refused before approving.',
    );
  });

  test('a destructive step keeps its own card when it also carries an override flag', () => {
    const verdict = evaluateBashCommand('terraform destroy --skip-guard', { cwd: '/tmp' });
    expect(verdict.action).toBe('gate');
    expect(verdict.reason).toBe('Destructive Terraform command (destroy).');
  });

  test('every flag on the list holds', () => {
    for (const flag of OPERATOR_OVERRIDE_FLAGS) {
      expect(evaluateBashCommand(`./tool ${flag}`, { cwd: '/tmp' }).action).toBe('gate');
    }
  });
});
