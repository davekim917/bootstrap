#!/usr/bin/env bun
/**
 * Stop hook: Displays error handling reminders based on edited files
 * Global hook that works across all projects
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { StopHookInput, FileAnalysis } from '../lib/types';
import { getProjectDir } from '../lib/project-detection';

// Extend the base type to include hook_event_name
interface HookInput extends StopHookInput {
    hook_event_name: string;
}

interface EditedFile {
    path: string;
    tool: string;
    timestamp: string;
}

function getFileCategory(filePath: string): 'backend' | 'frontend' | 'database' | 'other' {
    // Backend detection (Next.js API routes, Supabase helpers, validators)
    if (filePath.includes('/app/api/') ||
        filePath.includes('/lib/supabase/') ||
        filePath.includes('/lib/helpers/') ||
        filePath.includes('/lib/validators/')) return 'backend';

    // Frontend detection (Next.js app router pages and components)
    if (filePath.includes('/app/') && !filePath.includes('/app/api/') ||
        filePath.includes('/components/') ||
        filePath.includes('/contexts/')) return 'frontend';

    // Database detection (Supabase migrations)
    if (filePath.includes('/supabase/migrations/') ||
        filePath.includes('/supabase/functions/')) return 'database';

    return 'other';
}

function shouldCheckErrorHandling(filePath: string): boolean {
    // Skip test files, config files, and type definitions
    if (filePath.match(/\.(test|spec)\.(ts|tsx)$/)) return false;
    if (filePath.match(/\.(config|d)\.(ts|tsx)$/)) return false;
    if (filePath.includes('types/')) return false;
    if (filePath.includes('.styles.ts')) return false;

    // Check for code files
    return filePath.match(/\.(ts|tsx|js|jsx)$/) !== null;
}

function analyzeFileContent(filePath: string): FileAnalysis {
    if (!existsSync(filePath)) {
        return { hasTryCatch: false, hasAsync: false, hasSupabase: false, hasApiRoute: false, hasApiCall: false, hasHardcodedStyles: false };
    }

    const content = readFileSync(filePath, 'utf-8');

    return {
        hasTryCatch: /try\s*\{/.test(content),
        hasAsync: /async\s+/.test(content),
        hasSupabase: /supabase\.|createClient|\.from\(|\.auth\.|\.rpc\(/i.test(content),
        hasApiRoute: /export async function (GET|POST|PUT|PATCH|DELETE)/.test(content),
        hasApiCall: /fetch\(|axios\./i.test(content),
        hasHardcodedStyles: /className=["'][^"']*\b(text-\[#|bg-\[#|h-\[|w-\[)/.test(content),
    };
}

async function main() {
    try {
        // Read input from stdin
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        const { session_id } = data;

        // Use reliable project detection
        const projectDir = getProjectDir(data);

        // Check for edited files tracking
        const cacheDir = join(process.env.HOME || '/root', '.claude', 'tsc-cache', session_id);
        const trackingFile = join(cacheDir, 'edited-files.log');

        if (!existsSync(trackingFile)) {
            // No files edited this session, no reminder needed
            process.exit(0);
        }

        // Read tracking data
        const trackingContent = readFileSync(trackingFile, 'utf-8');
        const editedFiles = trackingContent
            .trim()
            .split('\n')
            .filter(line => line.length > 0)
            .map(line => {
                const [timestamp, tool, path] = line.split('\t');
                return { timestamp, tool, path };
            });

        if (editedFiles.length === 0) {
            process.exit(0);
        }

        // Categorize files
        const categories = {
            backend: [] as string[],
            frontend: [] as string[],
            database: [] as string[],
            other: [] as string[],
        };

        const analysisResults: Array<{
            path: string;
            category: string;
            analysis: ReturnType<typeof analyzeFileContent>;
        }> = [];

        for (const file of editedFiles) {
            if (!shouldCheckErrorHandling(file.path)) continue;

            const category = getFileCategory(file.path);
            categories[category].push(file.path);

            const analysis = analyzeFileContent(file.path);
            analysisResults.push({ path: file.path, category, analysis });
        }

        // Check if any code that needs error handling was written
        const needsAttention = analysisResults.some(
            ({ analysis }) =>
                analysis.hasTryCatch ||
                analysis.hasAsync ||
                analysis.hasSupabase ||
                analysis.hasApiRoute ||
                analysis.hasApiCall
        );

        if (!needsAttention) {
            // No risky code patterns detected, skip reminder
            process.exit(0);
        }

        // Display reminder
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 ERROR HANDLING SELF-CHECK');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        // Backend reminders
        if (categories.backend.length > 0) {
            const backendFiles = analysisResults.filter(f => f.category === 'backend');
            const hasTryCatch = backendFiles.some(f => f.analysis.hasTryCatch);
            const hasSupabase = backendFiles.some(f => f.analysis.hasSupabase);
            const hasApiRoute = backendFiles.some(f => f.analysis.hasApiRoute);

            console.log('⚠️  Backend Changes Detected');
            console.log(`   ${categories.backend.length} file(s) edited\n`);

            if (hasApiRoute) {
                console.log('   ❓ Did you await params/searchParams in Next.js 15 API routes?');
                console.log('   ❓ Are you using the correct Supabase client (server vs client)?');
            }
            if (hasSupabase) {
                console.log('   ❓ Are Supabase queries wrapped in try/catch?');
                console.log('   ❓ Did you verify RLS policies are in place?');
            }
            if (hasTryCatch) {
                console.log('   ❓ Are errors returned with proper HTTP status codes?');
            }

            console.log('\n   💡 Backend Best Practice (nextjs-supabase-backend-patterns):');
            console.log('      - Always await params in Next.js 15 API routes');
            console.log('      - Use server Supabase client with createClient(cookies)');
            console.log('      - Validate input with Zod before DB operations');
            console.log('      - Return NextResponse with appropriate status codes\n');
        }

        // Frontend reminders
        if (categories.frontend.length > 0) {
            const frontendFiles = analysisResults.filter(f => f.category === 'frontend');
            const hasApiCall = frontendFiles.some(f => f.analysis.hasApiCall);
            const hasTryCatch = frontendFiles.some(f => f.analysis.hasTryCatch);
            const hasHardcodedStyles = frontendFiles.some(f => f.analysis.hasHardcodedStyles);

            console.log('💡 Frontend Changes Detected');
            console.log(`   ${categories.frontend.length} file(s) edited\n`);

            if (hasHardcodedStyles) {
                console.log('   ❌ HARDCODED STYLES DETECTED!');
                console.log('   ❓ Are you using design tokens from lib/design-tokens.ts?');
            }
            if (hasApiCall) {
                console.log('   ❓ Are API calls showing loading states?');
                console.log('   ❓ Do errors display user-friendly messages?');
            }
            if (hasTryCatch) {
                console.log('   ❓ Are errors handled gracefully in the UI?');
            }

            console.log('\n   💡 Frontend Best Practice (nextjs-app-router-frontend-patterns):');
            console.log('      - NEVER hardcode colors/spacing (use design tokens)');
            console.log('      - Use Shadcn UI components from components/ui/');
            console.log('      - Mobile-first design (375px viewport first)');
            console.log('      - Standardized spacing: px-4 py-3, gap-4, space-y-4');
            console.log('      - WCAG AA compliance (contrast, touch targets)\n');
        }

        // Database reminders
        if (categories.database.length > 0) {
            console.log('🗄️  Database Changes Detected');
            console.log(`   ${categories.database.length} file(s) edited\n`);
            console.log('   ❓ Did you run the migration with explicit version?');
            console.log('   ❓ Are RLS policies defined for new tables?');
            console.log('   ❓ Did you regenerate types with supabase gen types?');
            console.log('\n   💡 Database Best Practice:');
            console.log('      - Use supabase migration up --version <timestamp>');
            console.log('      - Never run supabase db push globally');
            console.log('      - Always define RLS policies for new tables\n');
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💡 TIP: Disable with SKIP_ERROR_REMINDER=1');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        process.exit(0);
    } catch (err) {
        // Silently fail - this is just a reminder, not critical
        process.exit(0);
    }
}

main().catch(() => process.exit(0));
