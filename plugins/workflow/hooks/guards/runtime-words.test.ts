import { describe, expect, it } from 'bun:test';
import { PLATFORM_DESTRUCTIVE, evaluateBashCommand } from './block-destructive-core';

// One command per checkGatedCommand rule. A rule added there without a row here, or without its words in
// RUNTIME_PROBES, lets xargs input or a find match supply those words unseen.
const GATED_BY_RULE: string[][] = [
    ['psql', '-h', 'db.example', '-c', 'DROP TABLE users'],
    ['snow', 'sql', '-q', 'DROP TABLE prod.orders'],
    ['mongosh', '--eval', 'db.users.drop()'],
    ['redis-cli', 'FLUSHALL'],
    ['aws', 's3', 'rm', 's3://prod/x'],
    ['aws', 'ec2', 'terminate-instances', '--instance-ids', 'i-1'],
    ['gcloud', 'compute', 'instances', 'delete', 'vm-1'],
    ['gsutil', 'rm', 'gs://prod/x'],
    ['az', 'group', 'delete', '--name', 'rg'],
    ['doctl', 'compute', 'droplet', 'delete', 'web'],
    ['terraform', 'destroy'],
    ['terraform', 'apply', '-auto-approve'],
    ['pulumi', 'destroy'],
    ['cdk', 'destroy'],
    ['kubectl', 'delete', 'deployment', 'api'],
    ['kubectl', 'drain', 'node-1'],
    ['docker', 'rm', 'db'],
    ['docker', 'system', 'prune'],
    ['docker', 'volume', 'rm', 'data'],
    ['helm', 'uninstall', 'app'],
    ...Object.entries(PLATFORM_DESTRUCTIVE).flatMap(([cli, verbs]) => [...verbs].map(verb => [cli, verb, 'x'])),
    ['heroku', 'pg:reset'],
    ['vercel', 'remove', 'app'],
    ['netlify', 'sites:delete'],
    ['supabase', 'db', 'reset'],
    ['gh', 'repo', 'delete', 'org/app'],
    ['wrangler', 'delete'],
    ['cf', 'r2', 'bucket', 'delete', 'logs'],
    ['firebase', 'firestore:delete', '/users'],
    ['git', 'push', '--force', 'origin', 'main'],
    ['git', 'push', '--mirror', 'origin'],
    ['git', 'push', 'origin', ':main'],
    ['git', 'clean', '-fd'],
    ['git-clean', '-fd'],
    ['dbt', 'run', '--full-refresh'],
    ['dd', 'if=/dev/zero', 'of=/dev/sda'],
];

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
const line = (words: string[]) => words.map(quote).join(' ');

describe('a word xargs reads can be any word, or part of one, a rule gates on', () => {
    for (const [name, ...args] of GATED_BY_RULE) {
        it(`${name} ${args.join(' ')}`, () => {
            expect(evaluateBashCommand(line([name, ...args])).action).toBe('gate');
            // Put in place of any one word, or appended after any of them.
            for (let i = 0; i < args.length; i++) {
                const command = `xargs -I{} ${name} ${line(args.map((a, j) => (j === i ? '{}' : a)))} < list`;
                expect([command, evaluateBashCommand(command).action]).toEqual([command, 'gate']);
            }
            // Or as part of one, either side of the written text.
            for (let i = 0; i < args.length; i++) {
                const half = Math.ceil(args[i].length / 2);
                for (const part of [`${args[i].slice(0, half)}{}`, `{}${args[i].slice(half)}`]) {
                    const command = `xargs -I{} ${name} ${line(args.map((a, j) => (j === i ? part : a)))} < list`;
                    expect([command, evaluateBashCommand(command).action]).toEqual([command, 'gate']);
                }
            }
            for (let k = 0; k < args.length; k++) {
                const command = `xargs ${line([name, ...args.slice(0, k)])} < list`;
                expect([command, evaluateBashCommand(command).action]).toEqual([command, 'gate']);
            }
        });
    }
});
