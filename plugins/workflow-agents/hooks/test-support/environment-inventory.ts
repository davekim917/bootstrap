import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS = join(import.meta.dir, '..');

/**
 * Reads of the environment whose name is not written at the read itself, keyed by the exact expression, each with the
 * names it can read, found in the sources. A read that is neither a literal name nor one of these fails the scan, so
 * a new read has to be placed here before the wrapper rows below cover it.
 */
const INDIRECT_READS: Record<string, (sources: Map<string, string>) => string[]> = {
    // deploymentFilePath(FILE, FILE_ENV): each constant passed as its second argument.
    'process.env[envVar]': (sources) => {
        const named = callArguments(sources, /deploymentFilePath\(\s*\w+\s*,\s*(\w+)\s*\)/g, true);
        if ([...joined(sources).matchAll(/(?<!function )\bdeploymentFilePath\(/g)].length !== named.length) {
            throw new Error('deploymentFilePath is called with a variable name that is not a constant');
        }
        return named;
    },
    // assignedValue('NAME', …), and a literal list mapped through it.
    'process.env[name]': (sources) => {
        const named = callArguments(sources, /assignedValue\(\s*'(\w+)'/g, false);
        const listed = [...joined(sources).matchAll(/\[([^\]]*)\]\.some\(\s*name\s*=>\s*assignedValue\(name\b/g)]
            .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((n) => n[1]));
        const calls = [...joined(sources).matchAll(/(?<!function )\bassignedValue\(/g)].length;
        if (calls !== named.length + [...joined(sources).matchAll(/(?<!function )\bassignedValue\(name\b/g)].length) {
            throw new Error('assignedValue is called with a name that is not a literal');
        }
        return [...named, ...listed];
    },
    // The local Postgres probe's host.env, read only for the names in LIBPQ_REDIRECT_ENV.
    'env: process.env,': libpqRedirects,
    'LIBPQ_REDIRECT_ENV.some(k => LIVE_LOCAL_PG_HOST.env[k]': libpqRedirects,
    'LIBPQ_REDIRECT_ENV.some(k => host.env[k]': libpqRedirects,
    // Any SNOWFLAKE_ name, in any case.
    "Object.keys(process.env).some(k => k.toUpperCase().startsWith('SNOWFLAKE_'))": () => ['SNOWFLAKE_ACCOUNT', 'snowflake_account'],
    // Any name at all: whether a variable a command assigns is already set. One stands for every name.
    '!(name in process.env)': () => ['EXAMPLE_ASSIGNED_NAME'],
    // The whole environment, handed to the gws child. One stands for every name.
    '{ ...process.env, GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE': () => ['HTTPS_PROXY'],
    // The supervisor hands its environment to the guard, whose own reads are the rest of this list.
    'const env = { ...process.env };': () => [],
};

function joined(sources: Map<string, string>): string {
    return [...sources.values()].join('\n');
}

function libpqRedirects(sources: Map<string, string>): string[] {
    const list = /const LIBPQ_REDIRECT_ENV = \[([^\]]*)\]/.exec(joined(sources))?.[1];
    if (list === undefined) throw new Error('LIBPQ_REDIRECT_ENV is not a literal list');
    return [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

/** The literal (or, with `resolve`, the string constant) each call passes. */
function callArguments(sources: Map<string, string>, call: RegExp, resolve: boolean): string[] {
    const text = joined(sources);
    return [...text.matchAll(call)].map((m) => {
        if (!resolve) return m[1];
        const value = new RegExp(`const ${m[1]}\\s*=\\s*'(\\w+)'`).exec(text)?.[1];
        if (!value) throw new Error(`${m[1]} is not a string constant`);
        return value;
    });
}

/** Every variable name the sources read from the environment, or an error naming a read the scan cannot place. */
export function environmentReads(sources: Map<string, string>): string[] {
    const names = new Set<string>();
    const read = /\b(?:process\.env|Bun\.env|import\.meta\.env)\b|\bprocess\[\s*['"]env['"]\s*\]|\.env\[|\.env\.(?=[A-Z])|\b(homedir|tmpdir)\(\)/g;
    for (const [path, text] of sources) {
        text.split('\n').forEach((line, index) => {
            if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
            for (const match of line.matchAll(read)) {
                // os.homedir() reads HOME; os.tmpdir() reads TMPDIR, then TMP, then TEMP.
                if (match[1] === 'homedir') { names.add('HOME'); continue; }
                if (match[1] === 'tmpdir') { ['TMPDIR', 'TMP', 'TEMP'].forEach((n) => names.add(n)); continue; }
                const after = line.slice(match.index! + match[0].length);
                const before = line.slice(0, match.index!);
                const literal = match[0].endsWith('.') ? /^([A-Za-z_]\w*)/.exec(after)
                    : match[0].endsWith('[') ? /^\s*(['"])(\w+)\1\s*\]/.exec(after)?.slice(1)
                    : (/^\.([A-Za-z_]\w*)/.exec(after) ?? /^\[\s*(['"])(\w+)\1\s*\]/.exec(after)?.slice(1));
                if (literal) { names.add(literal.at(-1)!); continue; }
                const destructured = /\{([^{}]*)\}\s*=\s*$/.exec(before);
                if (destructured && !match[0].startsWith('.')) {
                    for (const part of destructured[1].split(',')) {
                        if (!part.trim()) continue;
                        // NAME, NAME: alias or NAME = default; a computed key or a rest element reads names not written here.
                        const name = /^\s*([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?(?:=.*)?$/.exec(part)?.[1];
                        if (!name) throw new Error(`${path}:${index + 1} destructures the environment in a way the scan cannot place: ${line.trim()}`);
                        names.add(name);
                    }
                    continue;
                }
                const indirect = Object.keys(INDIRECT_READS).find((expression) => line.includes(expression));
                if (!indirect) throw new Error(`${path}:${index + 1} reads the environment in a way the scan cannot place: ${line.trim()}`);
                for (const name of INDIRECT_READS[indirect](sources)) names.add(name);
            }
        });
    }
    return [...names].sort();
}

/** Every module the wrappers load: the adapters, the reply check, the policy and the vendored cores. */
export function guardSources(): Map<string, string> {
    const sources = new Map<string, string>();
    for (const dir of [HOOKS, join(HOOKS, 'guards')]) {
        for (const name of readdirSync(dir).sort()) {
            if (name.endsWith('.ts') && !name.endsWith('.test.ts')) sources.set(join(dir, name), readFileSync(join(dir, name), 'utf8'));
        }
    }
    return sources;
}

