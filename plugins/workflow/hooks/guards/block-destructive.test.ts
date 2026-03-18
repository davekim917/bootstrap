import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const HOOK_PATH = join(import.meta.dir, 'block-destructive.ts');
const GATE_DIR = '/tmp/.claude-destructive-gate';

function makeInput(command: string): string {
    return JSON.stringify({
        session_id: 'test',
        cwd: '/tmp/test',
        tool_name: 'Bash',
        tool_input: { command },
    });
}

function computeGateHash(command: string): string {
    return createHash('sha256').update(command).digest('hex').slice(0, 16);
}

async function runHook(command: string): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(['bun', 'run', HOOK_PATH], {
        stdin: new Blob([makeInput(command)]),
        stderr: 'pipe',
        stdout: 'pipe',
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
}

function createApproval(command: string): void {
    mkdirSync(GATE_DIR, { recursive: true });
    writeFileSync(`${GATE_DIR}/${computeGateHash(command)}`, 'approved');
}

function cleanupApprovals(): void {
    try { rmSync(GATE_DIR, { recursive: true }); } catch {}
}

// ── Hard blocks (no bypass, ever) ────────────────────────────────────────────

describe('hard blocks', () => {
    afterEach(cleanupApprovals);

    test.each([
        ['find . -exec rm {} \\;', 'find -exec rm'],
        ['find . -delete', 'find -delete'],
        ['xargs rm foo', 'xargs rm'],
        ['eval "echo hello"', 'eval'],
        ['unlink file.txt', 'unlink'],
        ['shred secret.txt', 'shred'],
        ['truncate -s 0 file.txt', 'truncate'],
        ['bash -c "echo hello"', 'shell -c'],
    ])('%s → BLOCKED (%s)', async (cmd) => {
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('BLOCKED');
    });

    test('hard blocks cannot be bypassed by gate approval', async () => {
        const cmd = 'eval "echo hello"';
        createApproval(cmd);
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('BLOCKED');
    });
});

// ── Gated full-command patterns ──────────────────────────────────────────────

describe('gated full-command patterns (first attempt blocks)', () => {
    test.each([
        // Databases
        ['snow sql -q "DROP TABLE users"', 'Snowflake'],
        ['psql -c "DROP TABLE users"', 'PostgreSQL'],
        ['mysql -e "DROP DATABASE prod"', 'MySQL'],
        ['duckdb test.db "DELETE FROM users"', 'DuckDB'],
        ['sqlite3 db.sqlite "DROP TABLE users"', 'SQLite'],
        ['mongosh --eval "db.users.drop()"', 'MongoDB'],
        ['redis-cli FLUSHALL', 'Redis'],
        // Cloud
        ['aws s3 rm s3://bucket --recursive', 'AWS S3 rm'],
        ['aws s3 rb s3://bucket', 'AWS S3 rb'],
        ['aws rds delete-db-instance --db-instance-identifier prod', 'AWS RDS'],
        ['aws ec2 terminate-instances --instance-ids i-123', 'AWS EC2'],
        ['gcloud compute instances delete my-vm', 'GCP'],
        ['gsutil rm gs://bucket/file', 'gsutil rm'],
        ['az vm delete --name my-vm', 'Azure'],
        ['doctl droplet delete 12345', 'DigitalOcean'],
        // IaC
        ['terraform destroy', 'Terraform destroy'],
        ['terraform apply -auto-approve', 'Terraform auto-approve'],
        ['pulumi destroy', 'Pulumi'],
        ['cdk destroy', 'CDK'],
        // dbt
        ['dbt run --full-refresh', 'dbt full-refresh'],
        ['dbt build --full-refresh', 'dbt build full-refresh'],
    ])('%s → GATED (%s)', async (cmd) => {
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });
});

// ── Gated lead-command patterns ──────────────────────────────────────────────

describe('gated lead patterns (first attempt blocks)', () => {
    test.each([
        // Containers
        ['kubectl delete pod my-pod', 'kubectl delete'],
        ['kubectl drain node1', 'kubectl drain'],
        ['docker rm container1', 'docker rm'],
        ['docker rmi image1', 'docker rmi'],
        ['docker system prune', 'docker prune'],
        ['docker volume rm vol1', 'docker volume rm'],
        ['helm uninstall my-release', 'helm uninstall'],
        // Platforms
        ['render services delete my-service', 'Render'],
        ['railway delete', 'Railway'],
        ['flyctl apps destroy my-app', 'Fly.io'],
        ['fly destroy my-app', 'Fly.io (fly)'],
        ['heroku apps:destroy my-app', 'Heroku'],
        ['heroku pg:reset DATABASE_URL', 'Heroku pg:reset'],
        ['vercel rm my-project', 'Vercel rm'],
        ['vercel remove my-project', 'Vercel remove'],
        ['netlify sites:delete', 'Netlify'],
        ['supabase projects delete my-proj', 'Supabase delete'],
        ['supabase db reset', 'Supabase db reset'],
        // Services
        ['gh repo delete my-repo', 'GitHub CLI'],
        ['wrangler delete my-worker', 'Wrangler'],
        ['firebase projects:delete my-proj', 'Firebase'],
        // System
        ['dd if=/dev/zero of=/dev/sda', 'dd'],
    ])('%s → GATED (%s)', async (cmd) => {
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });
});

// ── Gate approval flow ───────────────────────────────────────────────────────

describe('gate approval flow', () => {
    afterEach(cleanupApprovals);

    test('gated command passes after approval file is created', async () => {
        const cmd = 'aws rds delete-db-instance --db-instance-identifier test';

        // First attempt: blocked
        const first = await runHook(cmd);
        expect(first.exitCode).toBe(2);
        expect(first.stderr).toContain('GATED');

        // Create approval
        createApproval(cmd);

        // Retry: allowed
        const second = await runHook(cmd);
        expect(second.exitCode).toBe(0);
    });

    test('approval is one-time use (consumed on allow)', async () => {
        const cmd = 'terraform destroy';

        createApproval(cmd);

        // First retry: allowed (consumes approval)
        const first = await runHook(cmd);
        expect(first.exitCode).toBe(0);

        // Second retry: blocked again
        const second = await runHook(cmd);
        expect(second.exitCode).toBe(2);
        expect(second.stderr).toContain('GATED');
    });

    test('approval is command-specific (different commands have different hashes)', async () => {
        const cmd1 = 'aws s3 rm s3://bucket-a';
        const cmd2 = 'aws s3 rm s3://bucket-b';

        createApproval(cmd1);

        const result1 = await runHook(cmd1);
        expect(result1.exitCode).toBe(0);

        const result2 = await runHook(cmd2);
        expect(result2.exitCode).toBe(2);
    });

    test('gate message includes correct hash and directory', async () => {
        const cmd = 'kubectl delete namespace production';
        const { stderr } = await runHook(cmd);
        const hash = computeGateHash(cmd);
        expect(stderr).toContain(hash);
        expect(stderr).toContain(GATE_DIR);
    });

    test('approval for gated lead pattern works', async () => {
        const cmd = 'docker system prune';

        const first = await runHook(cmd);
        expect(first.exitCode).toBe(2);

        createApproval(cmd);

        const second = await runHook(cmd);
        expect(second.exitCode).toBe(0);
    });
});

// ── Approval file creation passes through hook ───────────────────────────────

describe('approval file creation is not blocked', () => {
    test('mkdir + echo approval command passes through', async () => {
        const hash = 'abc1234567890abc';
        const cmd = `mkdir -p ${GATE_DIR} && echo approved > ${GATE_DIR}/${hash}`;
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});

// ── rm tiers ─────────────────────────────────────────────────────────────────

describe('rm: ephemeral paths allowed', () => {
    test.each([
        ['rm -rf node_modules'],
        ['rm -rf dist'],
        ['rm -rf .next'],
        ['rm -rf /tmp/test-output'],
        ['rm -rf build'],
        ['rm coverage/lcov.info'],
        ['rm -rf __pycache__'],
        ['rm -rf .cache'],
        ['rm -rf .turbo'],
    ])('%s → allowed', async (cmd) => {
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});

describe('rm: protected paths hard-blocked', () => {
    test.each([
        ['rm -rf /', 'root'],
        ['rm -rf ~', 'home'],
        ['rm -rf ~/.ssh', '.ssh'],
        ['rm -rf ~/.aws', '.aws'],
        ['rm -rf ~/.config', '.config'],
    ])('%s → BLOCKED (%s)', async (cmd) => {
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('BLOCKED');
    });
});

describe('rm: non-ephemeral paths redirected to trash', () => {
    test('rm on project file suggests trash', async () => {
        const { exitCode, stderr } = await runHook('rm src/index.ts');
        expect(exitCode).toBe(2);
        expect(stderr).toContain('trash');
    });
});

// ── Safe commands pass through ───────────────────────────────────────────────

describe('safe commands pass through', () => {
    test.each([
        ['ls -la'],
        ['git status'],
        ['npm install'],
        ['cat README.md'],
        ['aws s3 ls'],
        ['aws s3 cp file s3://bucket'],
        ['psql -c "SELECT * FROM users"'],
        ['gcloud compute instances list'],
        ['kubectl get pods'],
        ['docker ps'],
        ['terraform plan'],
        ['terraform init'],
        ['dbt run'],
        ['dbt test'],
        ['redis-cli GET mykey'],
        ['gh pr list'],
        ['heroku apps:info'],
    ])('%s → allowed', async (cmd) => {
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});
