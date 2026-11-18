/**
 * The attachments gws would refuse after an email send's approval, read before the card is asked for so no approval
 * is spent on a send that cannot run.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { isAbsolute, resolve as resolvePath } from 'path';
import { code, inline } from './gate-card-core';

// gws 0.22.5 refuses an attachment before it sends (crates/google-workspace-cli/src/helpers/gmail/mod.rs
// parse_attachments, crates/google-workspace/src/validate.rs validate_safe_file_path): a control or bidi/zero-width
// character in the path, a path whose symlinks resolve outside the directory gws runs in, anything but a readable,
// non-empty regular file, or more than 25 MiB in all.
const GWS_ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const GWS_REFUSED_PATH_CHAR = /[\p{Cc}\u200B-\u200D\uFEFF\u202A-\u202E\u2028\u2029\u2066-\u2069]/u;

/**
 * Why gws would refuse these attachments once the send runs, or null when it would not (or when the directory the
 * send runs in is unknown, so its rule can't be applied). Read when the card would be asked for, so a file changed
 * after this read is gws's to judge.
 */
export function attachmentRefusal(paths: string[], cwd: string | undefined): string | null {
    if (!paths.length || !cwd || !isAbsolute(cwd)) return null;
    let root: string;
    try {
        root = realpathSync(cwd);
    } catch {
        return null;
    }
    const inside = (p: string) => root === '/' || p === root || p.startsWith(`${root}/`);
    const refuse = (path: string, why: string, fix: string) =>
        `Email send refused before asking for approval: gws would refuse the attachment ${code(inline(path))} after ` +
        `approval, because ${why}. gws attaches only a readable, non-empty file inside the directory the command runs ` +
        `in (${code(inline(cwd))}), after resolving symlinks. ${fix} Then send again with that path; nothing was sent.`;
    const copyIn = (path: string) =>
        `Copy it under that directory in its own Bash call first (for example ${code(`mkdir -p send && cp ${shellQuoted(path)} send/`)}).`;
    let total = 0;
    for (const path of paths) {
        if (GWS_REFUSED_PATH_CHAR.test(path)) return refuse(path, 'its path holds a control, zero-width or direction-changing character', 'Rename the file without it.');
        let real: string;
        try {
            real = realpathSync(isAbsolute(path) ? path : resolvePath(cwd, path));
        } catch {
            return refuse(path, 'it does not exist', 'Check the path, or write the file first in its own Bash call.');
        }
        if (!inside(real)) return refuse(path, real === path ? 'it is outside that directory' : `it resolves to ${code(inline(real))}, outside that directory`, copyIn(path));
        let size: number;
        try {
            const stat = statSync(real);
            if (!stat.isFile()) return refuse(path, 'it is not a regular file', 'Attach a file, not a folder.');
            size = stat.size;
            const fd = openSync(real, 'r');
            try {
                if (readSync(fd, Buffer.alloc(1), 0, 1, 0) === 0) return refuse(path, 'it is empty', 'Write its contents first.');
            } finally {
                closeSync(fd);
            }
        } catch {
            return refuse(path, 'it cannot be read', 'Make it readable, or copy a readable version under that directory.');
        }
        total += size;
        if (total > GWS_ATTACHMENT_MAX_TOTAL_BYTES) return refuse(path, 'the attachments come to more than 25 MiB', 'Attach less, or share a link instead.');
    }
    return null;
}

function shellQuoted(text: string): string {
    return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
