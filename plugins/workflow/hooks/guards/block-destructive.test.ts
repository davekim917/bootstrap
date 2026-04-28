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

// ── AST precision: no false positives from strings/heredocs ──────────────────

describe('AST precision: destructive keywords in non-command contexts are allowed', () => {
    test.each([
        // Quoted strings — destructive keywords are arguments, not commands
        ['echo "DROP TABLE users"', 'SQL in echo string'],
        ['echo "terraform destroy"', 'terraform in echo string'],
        ['echo "kubectl delete pod"', 'kubectl in echo string'],
        // Git commit messages
        ['git commit -m "delete old tables"', 'delete in commit msg'],
        ['git commit -m "drop unused columns"', 'drop in commit msg'],
        // Grep/cat/log searches — destructive keywords are search terms
        ['grep "DROP TABLE" migrations/', 'SQL in grep pattern'],
        ['grep -r "TRUNCATE" *.sql', 'TRUNCATE in grep pattern'],
    ])('%s → allowed (%s)', async (cmd) => {
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });

    test('heredoc content with destructive SQL is not treated as a command', async () => {
        const cmd = 'cat <<EOF\nDROP TABLE users\nEOF';
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });

    test('heredoc content with destructive keywords is not treated as a command', async () => {
        const cmd = 'cat <<EOF\nterraform destroy\nEOF';
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});

// ── SQL: destructive keywords in string literals / comments are NOT gated ────

describe('SQL gate: false positives from string literals and comments are allowed', () => {
    test.each([
        // The original report: querying query_history for past DROP statements.
        [`snow sql -q "SELECT * FROM snowflake.account_usage.query_history WHERE query_text LIKE '%DROP TABLE foo%'"`, 'snow query_history search'],
        [`psql -c "SELECT query FROM pg_stat_statements WHERE query LIKE '%TRUNCATE%'"`, 'psql pg_stat_statements search'],
        [`mysql -e "SELECT event_name FROM audit_log WHERE event_name = 'DROP TABLE'"`, 'mysql audit search'],
        // Comments mentioning destructive keywords
        [`psql -c "-- DROP TABLE comment\\nSELECT 1"`, 'psql line comment'],
        [`psql -c "/* DROP TABLE block comment */ SELECT 1"`, 'psql block comment'],
        // Double-quoted identifier that happens to share a keyword name
        [`psql -c 'SELECT * FROM "DROP TABLE archive"'`, 'identifier named like keyword'],
    ])('%s → allowed (%s)', async (cmd) => {
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});

describe('SQL gate: leading destructive statement is gated even after non-destructive prefix', () => {
    test('multi-statement: DROP TABLE before SELECT is gated', async () => {
        const cmd = `psql -c "DROP TABLE foo; SELECT 1"`;
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
        expect(stderr.toLowerCase()).toContain('drop table');
    });

    test('multi-statement: SELECT then DROP TABLE is gated', async () => {
        const cmd = `psql -c "SELECT 1; DROP TABLE foo"`;
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('gate message includes the matched statement', async () => {
        const cmd = `snow sql -q "DROP TABLE inventory.daily_snapshot"`;
        const { stderr } = await runHook(cmd);
        expect(stderr).toContain('leading statement');
        expect(stderr).toContain('DROP TABLE inventory.daily_snapshot');
    });
});

// ── AST precision: destructive commands inside subshells ARE caught ───────────

describe('AST precision: commands inside subshells/pipelines are still checked', () => {
    test('destructive command in subshell is caught', async () => {
        const cmd = '(kubectl delete namespace prod)';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('destructive command in pipeline is caught', async () => {
        const cmd = 'echo yes | terraform destroy';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('rm in subshell applies normal tier logic', async () => {
        const cmd = '(rm src/index.ts)';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('trash');
    });

    test('rm of ephemeral path in subshell is allowed', async () => {
        const cmd = '(rm -rf /tmp/test-output)';
        const { exitCode } = await runHook(cmd);
        expect(exitCode).toBe(0);
    });
});

// ── Wrapper resolution via AST ───────────────────────────────────────────────

describe('wrapper resolution', () => {
    test('sudo wrapper is stripped', async () => {
        const cmd = 'sudo kubectl delete pod my-pod';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('sudo with -u flag is handled', async () => {
        const cmd = 'sudo -u root terraform destroy';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('env wrapper is stripped', async () => {
        const cmd = 'env AWS_PROFILE=prod aws rds delete-db-instance --db-instance-identifier test';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });

    test('nohup wrapper is stripped', async () => {
        const cmd = 'nohup docker system prune';
        const { exitCode, stderr } = await runHook(cmd);
        expect(exitCode).toBe(2);
        expect(stderr).toContain('GATED');
    });
});
