import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    evaluateGate,
    extractFeatureName,
    parseDriftEntries,
} from './workflow-gate-enforcement';

const tempDirs: string[] = [];

function tempFile(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-gate-'));
    tempDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
}

function report(entries = ''): string {
    return `# Drift Report: Design → Plan

## Summary

| Class | Count | Blocking? |
|---|---:|---|
| MISSING | 0 | Yes |
| DIVERGED | 0 | Yes |
| PARTIAL | 0 | No |
| CONFIRMED | 2 | No |

## Blocking Mismatches

${entries}`;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('build task namespace', () => {
    it('extracts the exact feature from a namespaced task subject', () => {
        expect(extractFeatureName('[team-build:auth-refresh] Group A: API')).toBe('auth-refresh');
        expect(extractFeatureName('[team-build:a_1] Group B')).toBe('a_1');
    });

    it('rejects malformed or traversal-bearing namespaces', () => {
        for (const subject of [
            '[team-build:Auth] Group A',
            '[team-build:../auth] Group A',
            '[team-build:auth/x] Group A',
            '[team-build:] Group A',
            'Group A: auth',
        ]) {
            expect(extractFeatureName(subject)).toBeNull();
        }
    });
});

describe('drift artifact evaluation', () => {
    it('accepts a structurally valid zero-finding report', () => {
        const reportPath = tempFile('pre-build-drift.md', report());
        const result = evaluateGate(reportPath, join(tmpdir(), 'absent-drift-acks.json'));
        expect(result).toMatchObject({ passing: true, missing: 0, divergedEffective: 0 });
    });

    it('rejects empty or unrelated markdown instead of treating it as zero findings', () => {
        for (const content of ['', '# Notes\nNothing to see here.']) {
            const reportPath = tempFile('pre-build-drift.md', content);
            expect(evaluateGate(reportPath, join(tmpdir(), 'absent-drift-acks.json'))).toBeNull();
        }
    });

    it('blocks MISSING entries and does not honor acknowledgments for them', () => {
        const reportPath = tempFile(
            'pre-build-drift.md',
            report('### [B1] Missing contract\n- **Class:** MISSING\n'),
        );
        const acksPath = tempFile(
            'drift-acks.json',
            JSON.stringify({ acknowledgments: [{ id: 'B1', reason: 'intentional' }] }),
        );
        const result = evaluateGate(reportPath, acksPath);
        expect(result).toMatchObject({ passing: false, missing: 1, divergedAcked: 0 });
        expect(result?.ackErrors.join('\n')).toContain('not DIVERGED');
    });

    it('honors a justified acknowledgment for a real DIVERGED entry', () => {
        const reportPath = tempFile(
            'pre-build-drift.md',
            report('### [B1] Intentional change\n- **Class:** DIVERGED\n'),
        );
        const acksPath = tempFile(
            'drift-acks.json',
            JSON.stringify({ acknowledgments: [{ id: 'B1', reason: 'review finding superseded design' }] }),
        );
        expect(evaluateGate(reportPath, acksPath)).toMatchObject({
            passing: true,
            divergedTotal: 1,
            divergedAcked: 1,
            divergedEffective: 0,
        });
    });

    it('ignores example entries inside fenced code', () => {
        expect(
            parseDriftEntries(
                report('```md\n### [B1] Example only\n- **Class:** MISSING\n```\n'),
            ),
        ).toEqual([]);
    });
});
