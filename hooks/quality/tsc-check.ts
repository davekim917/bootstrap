#!/usr/bin/env bun
/**
 * PostToolUse hook: TypeScript type checking after file modifications
 * Runs tsc --noEmit when TypeScript/JavaScript files are edited
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { getProjectDir } from '../lib/project-detection';
import type { ToolUseInput } from '../lib/types';

interface TscCheckInput extends ToolUseInput {
    tool_name: string;
    tool_input: {
        file_path?: string;
        edits?: Array<{ file_path?: string }>;
    };
}

const TS_EXTENSIONS = /\.(ts|tsx|js|jsx)$/;
const CACHE_DIR = join(process.env.HOME || '/root', '.claude', 'tsc-cache');

function getCacheDir(sessionId: string): string {
    const dir = join(CACHE_DIR, sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function getFilePaths(input: TscCheckInput): string[] {
    const toolInput = input.tool_input || {};

    if (input.tool_name === 'MultiEdit' && Array.isArray(toolInput.edits)) {
        return toolInput.edits
            .map(e => e?.file_path)
            .filter((p): p is string => typeof p === 'string');
    }

    return toolInput.file_path ? [toolInput.file_path] : [];
}

function hasTsConfig(projectDir: string): boolean {
    return existsSync(join(projectDir, 'tsconfig.json'));
}

function runTscCheck(projectDir: string): { success: boolean; output: string; errorCount: number } {
    try {
        const output = execSync('npx tsc --noEmit 2>&1', {
            cwd: projectDir,
            encoding: 'utf-8',
            timeout: 60000,
        });
        return { success: true, output, errorCount: 0 };
    } catch (error: any) {
        const output = error.stdout || error.message || '';
        const errorCount = (output.match(/error TS/g) || []).length;
        return { success: false, output, errorCount };
    }
}

function cleanOldCache(): void {
    // Clean cache dirs older than 7 days using native Node.js
    try {
        if (!existsSync(CACHE_DIR)) return;

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const entries = readdirSync(CACHE_DIR, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const dirPath = join(CACHE_DIR, entry.name);
                const stats = statSync(dirPath);
                if (stats.mtimeMs < sevenDaysAgo) {
                    rmSync(dirPath, { recursive: true, force: true });
                }
            }
        }
    } catch {
        // Ignore cleanup errors
    }
}

async function main(): Promise<void> {
    try {
        const rawInput = readFileSync(0, 'utf-8');
        const input: TscCheckInput = JSON.parse(rawInput);

        // Only process file modification tools
        if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) {
            process.exit(0);
        }

        // Check if any TypeScript/JavaScript files were modified
        const filePaths = getFilePaths(input);
        const tsFilesModified = filePaths.filter(p => TS_EXTENSIONS.test(p));

        if (tsFilesModified.length === 0) {
            process.exit(0);
        }

        // Get project directory using shared lib
        const projectDir = getProjectDir(input);

        // Check if project has TypeScript
        if (!hasTsConfig(projectDir)) {
            process.exit(0);
        }

        console.error('⚡ Running TypeScript check...');

        const { success, output, errorCount } = runTscCheck(projectDir);

        if (!success || errorCount > 0) {
            const sessionId = input.session_id || 'default';
            const cacheDir = getCacheDir(sessionId);
            const projectName = basename(projectDir);

            // Save error information
            writeFileSync(join(cacheDir, 'last-errors.txt'), output);
            writeFileSync(join(cacheDir, 'affected-repos.txt'), projectName);
            writeFileSync(join(cacheDir, 'tsc-commands.txt'), `# TSC Command\n${projectName}: npx tsc --noEmit`);

            // Output error summary
            console.error('❌ TypeScript errors found');
            console.error('');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error(`🚨 TypeScript validation failed - ${errorCount} error(s) found`);
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('');
            console.error('📝 Error preview (first 10):');

            const errorLines = output.split('\n').filter(line => line.includes('error TS'));
            errorLines.slice(0, 10).forEach(line => console.error(line));

            if (errorCount > 10) {
                console.error(`... and ${errorCount - 10} more error(s)`);
            }

            console.error('');
            console.error(`💡 Full error details saved to: ${cacheDir}/last-errors.txt`);
            console.error('🔧 Run \'npx tsc --noEmit\' to see full output');
            console.error('');
            console.error('⚠️  WE DO NOT LEAVE A MESS BEHIND');

            process.exit(1);
        } else {
            console.error('✅ TypeScript check passed');
        }

        // Cleanup old cache
        cleanOldCache();

        process.exit(0);
    } catch (error) {
        // Fail open but log the error for debugging
        console.error('[tsc-check] Hook error (non-blocking):', error instanceof Error ? error.message : error);
        process.exit(0);
    }
}

main();
