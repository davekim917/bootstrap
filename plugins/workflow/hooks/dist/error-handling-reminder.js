#!/usr/bin/env bun
// @bun

// quality/error-handling-reminder.ts
import { readFileSync, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";

// lib/project-detection.ts
import { existsSync } from "fs";
import { dirname, join } from "path";
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== "/" && dir !== ".") {
    if (existsSync(join(dir, ".claude"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}
function getProjectDir(input) {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  const startDir = input.cwd || process.cwd();
  const found = findProjectRoot(startDir);
  if (found) {
    return found;
  }
  return startDir;
}

// quality/error-handling-reminder.ts
function getFileCategory(filePath) {
  if (filePath.includes("/app/api/") || filePath.includes("/lib/supabase/") || filePath.includes("/lib/helpers/") || filePath.includes("/lib/validators/"))
    return "backend";
  if (filePath.includes("/app/") && !filePath.includes("/app/api/") || filePath.includes("/components/") || filePath.includes("/contexts/"))
    return "frontend";
  if (filePath.includes("/supabase/migrations/") || filePath.includes("/supabase/functions/"))
    return "database";
  return "other";
}
function shouldCheckErrorHandling(filePath) {
  if (filePath.match(/\.(test|spec)\.(ts|tsx)$/))
    return false;
  if (filePath.match(/\.(config|d)\.(ts|tsx)$/))
    return false;
  if (filePath.includes("types/"))
    return false;
  if (filePath.includes(".styles.ts"))
    return false;
  return filePath.match(/\.(ts|tsx|js|jsx)$/) !== null;
}
function analyzeFileContent(filePath) {
  if (!existsSync2(filePath)) {
    return { hasTryCatch: false, hasAsync: false, hasSupabase: false, hasApiRoute: false, hasApiCall: false, hasHardcodedStyles: false };
  }
  const content = readFileSync(filePath, "utf-8");
  return {
    hasTryCatch: /try\s*\{/.test(content),
    hasAsync: /async\s+/.test(content),
    hasSupabase: /supabase\.|createClient|\.from\(|\.auth\.|\.rpc\(/i.test(content),
    hasApiRoute: /export async function (GET|POST|PUT|PATCH|DELETE)/.test(content),
    hasApiCall: /fetch\(|axios\./i.test(content),
    hasHardcodedStyles: /className=["'][^"']*\b(text-\[#|bg-\[#|h-\[|w-\[)/.test(content)
  };
}
async function main() {
  try {
    const input = readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    const { session_id } = data;
    const projectDir = getProjectDir(data);
    const cacheDir = join2(process.env.HOME || "/root", ".claude", "tsc-cache", session_id);
    const trackingFile = join2(cacheDir, "edited-files.log");
    if (!existsSync2(trackingFile)) {
      process.exit(0);
    }
    const trackingContent = readFileSync(trackingFile, "utf-8");
    const editedFiles = trackingContent.trim().split(`
`).filter((line) => line.length > 0).map((line) => {
      const [timestamp, tool, path] = line.split("\t");
      return { timestamp, tool, path };
    });
    if (editedFiles.length === 0) {
      process.exit(0);
    }
    const categories = {
      backend: [],
      frontend: [],
      database: [],
      other: []
    };
    const analysisResults = [];
    for (const file of editedFiles) {
      if (!shouldCheckErrorHandling(file.path))
        continue;
      const category = getFileCategory(file.path);
      categories[category].push(file.path);
      const analysis = analyzeFileContent(file.path);
      analysisResults.push({ path: file.path, category, analysis });
    }
    const needsAttention = analysisResults.some(({ analysis }) => analysis.hasTryCatch || analysis.hasAsync || analysis.hasSupabase || analysis.hasApiRoute || analysis.hasApiCall);
    if (!needsAttention) {
      process.exit(0);
    }
    console.log(`
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`);
    console.log("\uD83D\uDCCB ERROR HANDLING SELF-CHECK");
    console.log(`\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`);
    if (categories.backend.length > 0) {
      const backendFiles = analysisResults.filter((f) => f.category === "backend");
      const hasTryCatch = backendFiles.some((f) => f.analysis.hasTryCatch);
      const hasSupabase = backendFiles.some((f) => f.analysis.hasSupabase);
      const hasApiRoute = backendFiles.some((f) => f.analysis.hasApiRoute);
      console.log("\u26A0\uFE0F  Backend Changes Detected");
      console.log(`   ${categories.backend.length} file(s) edited
`);
      if (hasApiRoute) {
        console.log("   \u2753 Did you await params/searchParams in Next.js 15 API routes?");
        console.log("   \u2753 Are you using the correct Supabase client (server vs client)?");
      }
      if (hasSupabase) {
        console.log("   \u2753 Are Supabase queries wrapped in try/catch?");
        console.log("   \u2753 Did you verify RLS policies are in place?");
      }
      if (hasTryCatch) {
        console.log("   \u2753 Are errors returned with proper HTTP status codes?");
      }
      console.log(`
   \uD83D\uDCA1 Backend Best Practice (nextjs-supabase-backend-patterns):`);
      console.log("      - Always await params in Next.js 15 API routes");
      console.log("      - Use server Supabase client with createClient(cookies)");
      console.log("      - Validate input with Zod before DB operations");
      console.log(`      - Return NextResponse with appropriate status codes
`);
    }
    if (categories.frontend.length > 0) {
      const frontendFiles = analysisResults.filter((f) => f.category === "frontend");
      const hasApiCall = frontendFiles.some((f) => f.analysis.hasApiCall);
      const hasTryCatch = frontendFiles.some((f) => f.analysis.hasTryCatch);
      const hasHardcodedStyles = frontendFiles.some((f) => f.analysis.hasHardcodedStyles);
      console.log("\uD83D\uDCA1 Frontend Changes Detected");
      console.log(`   ${categories.frontend.length} file(s) edited
`);
      if (hasHardcodedStyles) {
        console.log("   \u274C HARDCODED STYLES DETECTED!");
        console.log("   \u2753 Are you using design tokens from lib/design-tokens.ts?");
      }
      if (hasApiCall) {
        console.log("   \u2753 Are API calls showing loading states?");
        console.log("   \u2753 Do errors display user-friendly messages?");
      }
      if (hasTryCatch) {
        console.log("   \u2753 Are errors handled gracefully in the UI?");
      }
      console.log(`
   \uD83D\uDCA1 Frontend Best Practice (nextjs-app-router-frontend-patterns):`);
      console.log("      - NEVER hardcode colors/spacing (use design tokens)");
      console.log("      - Use Shadcn UI components from components/ui/");
      console.log("      - Mobile-first design (375px viewport first)");
      console.log("      - Standardized spacing: px-4 py-3, gap-4, space-y-4");
      console.log(`      - WCAG AA compliance (contrast, touch targets)
`);
    }
    if (categories.database.length > 0) {
      console.log("\uD83D\uDDC4\uFE0F  Database Changes Detected");
      console.log(`   ${categories.database.length} file(s) edited
`);
      console.log("   \u2753 Did you run the migration with explicit version?");
      console.log("   \u2753 Are RLS policies defined for new tables?");
      console.log("   \u2753 Did you regenerate types with supabase gen types?");
      console.log(`
   \uD83D\uDCA1 Database Best Practice:`);
      console.log("      - Use supabase migration up --version <timestamp>");
      console.log("      - Never run supabase db push globally");
      console.log(`      - Always define RLS policies for new tables
`);
    }
    console.log("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
    console.log("\uD83D\uDCA1 TIP: Disable with SKIP_ERROR_REMINDER=1");
    console.log(`\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`);
    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
}
main().catch(() => process.exit(0));
