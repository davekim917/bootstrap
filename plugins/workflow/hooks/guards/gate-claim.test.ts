import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs';
import {
    GATE_CLAIM_DIR,
    GATE_DIR,
    abandonGateClaim,
    claimedGateRowMatches,
    computeGateHash,
    consumeGateApproval,
    claimGateRequest,
    gateClaimKey,
    gateRequestAlreadyDecided,
    isDecidedGateStatus,
    publishGateClaim,
} from './block-destructive-core';

// ── One approval card per tool call ──
//
// A Codex tool call dispatches every matched PreToolUse handler CONCURRENTLY
// (`FuturesUnordered` in codex-rs 0.154.0 `hooks/src/engine/dispatcher.rs`),
// with no ordering and no short-circuit on a deny. Measured on a real 0.154.0
// run: two handlers started 0.7 ms apart with the SAME `tool_use_id`. These
// tests pin the claim protocol that turns that into one approval card.

function clean(): void {
    rmSync(GATE_CLAIM_DIR, { recursive: true, force: true });
}

beforeEach(clean);
afterEach(clean);

describe('gateClaimKey', () => {
    test('two handlers of the SAME tool call, same gate, collide', () => {
        expect(gateClaimKey('exec-1', 'request_destructive_gate')).toBe(
            gateClaimKey('exec-1', 'request_destructive_gate'),
        );
    });

    test('different tool calls do NOT collide', () => {
        expect(gateClaimKey('exec-1', 'request_destructive_gate')).not.toBe(
            gateClaimKey('exec-2', 'request_destructive_gate'),
        );
    });

    test('one tool call needing TWO different approvals keeps two cards', () => {
        // A command that is both destructive and an outbound email send must
        // still raise one card per gate — collapsing them would answer one
        // question with the other's approval.
        expect(gateClaimKey('exec-1', 'request_destructive_gate')).not.toBe(
            gateClaimKey('exec-1', 'request_bash_gate'),
        );
    });

    test('the COMMAND is not in the key — the two guards do not see the same string', () => {
        // NanoClaw's in-tree chain sanitizes the command before gating
        // (`unset <secret-vars> 2>/dev/null; <original>`) while codex-guard.ts
        // gates on the raw input, because codex hands every handler one
        // `input_json` built before any of them runs. A command-keyed claim
        // produced two keys for one tool call and both guards staged anyway.
        expect(gateClaimKey('exec-1', 'request_destructive_gate')).toBe(
            gateClaimKey('exec-1', 'request_destructive_gate'),
        );
        // The signature takes exactly two arguments; an extra one cannot
        // reintroduce the split.
        expect(gateClaimKey.length).toBe(2);
    });
});

describe('claimGateRequest', () => {
    test('the FIRST caller owns the claim', () => {
        expect(claimGateRequest(gateClaimKey('exec-1', 'a'))).toEqual({ owner: true });
    });

    test('a second caller waits and gets the owner’s requestId', () => {
        const key = gateClaimKey('exec-1', 'a');
        expect(claimGateRequest(key)).toEqual({ owner: true });
        publishGateClaim(key, 'gate-123-abc');
        expect(claimGateRequest(key)).toEqual({ owner: false, requestId: 'gate-123-abc' });
    });

    test('a second caller on a DIFFERENT tool call owns its own claim', () => {
        const first = gateClaimKey('exec-1', 'a');
        claimGateRequest(first);
        publishGateClaim(first, 'gate-1');
        expect(claimGateRequest(gateClaimKey('exec-2', 'a'))).toEqual({ owner: true });
    });

    test('an ABANDONED claim lets the peer take over rather than wait it out', () => {
        // The owner staged nothing — session DBs broken, or it crashed. The peer
        // must not sit for the full publish window and must not be told to poll
        // a requestId that does not exist.
        const key = gateClaimKey('exec-1', 'a');
        claimGateRequest(key);
        abandonGateClaim(key);
        const start = Date.now();
        const claim = claimGateRequest(key);
        // Taking the freed lock is the ideal answer; falling through to
        // `requestId: null` is the acceptable one. Both stage their own request,
        // which is the fail-closed direction — two cards beats no gate.
        expect(claim.owner === true || claim.requestId === null).toBe(true);
        expect(Date.now() - start).toBeLessThan(15_000);
    });

    test('publishing is ATOMIC — a loser never reads a half-written id', () => {
        // The id is written to `<claim>.tmp` and renamed, so `<claim>` only ever
        // exists complete. A loser reading a truncated id would poll a
        // nonexistent request and time out at 60 minutes.
        const key = gateClaimKey('exec-1', 'a');
        claimGateRequest(key);
        publishGateClaim(key, 'gate-atomic-1');
        expect(readFileSync(`${GATE_CLAIM_DIR}/${key}`, 'utf-8')).toBe('gate-atomic-1');
        expect(existsSync(`${GATE_CLAIM_DIR}/${key}.tmp`)).toBe(false);
    });

    test('a stale claim from an earlier session is swept, not honoured', () => {
        // A requestId older than the 60-minute gate window names a decision
        // nobody is going to make. Polling it would hang the new tool call for
        // an hour; sweeping it means this call stages a fresh card.
        const key = gateClaimKey('exec-old', 'a');
        mkdirSync(GATE_CLAIM_DIR, { recursive: true });
        for (const p of [`${GATE_CLAIM_DIR}/${key}`, `${GATE_CLAIM_DIR}/${key}.lock`]) {
            writeFileSync(p, 'gate-ancient');
            const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
            utimesSync(p, old, old);
        }
        expect(claimGateRequest(key)).toEqual({ owner: true });
    });

    test('a FRESH claim from a live peer is not swept', () => {
        const key = gateClaimKey('exec-fresh', 'a');
        claimGateRequest(key);
        publishGateClaim(key, 'gate-fresh');
        expect(claimGateRequest(gateClaimKey('exec-other', 'a'))).toEqual({ owner: true });
        expect(readFileSync(`${GATE_CLAIM_DIR}/${key}`, 'utf-8')).toBe('gate-fresh');
    });
});

describe('claimGateRequest across real PROCESSES', () => {
    // The whole point: the two guards are separate processes that codex starts
    // within a millisecond of each other. An in-process test cannot exercise the
    // O_EXCL race that decides which one stages the card.
    test('exactly one of N concurrent processes owns the claim', async () => {
        const key = gateClaimKey('exec-race', 'request_destructive_gate');
        const script = `${import.meta.dir}/__gate-claim-race.ts`;
        writeFileSync(
            script,
            [
                `import { claimGateRequest, publishGateClaim } from '${import.meta.dir}/block-destructive-core';`,
                `const key = process.argv[2];`,
                `const claim = claimGateRequest(key);`,
                `if (claim.owner) { Bun.sleepSync(120); publishGateClaim(key, 'gate-race-winner'); }`,
                `console.log(JSON.stringify(claim));`,
            ].join('\n'),
        );
        try {
            const results = await Promise.all(
                [0, 1, 2, 3].map(async () => {
                    const proc = Bun.spawn(['bun', script, key], { stdout: 'pipe', stderr: 'pipe' });
                    const out = await new Response(proc.stdout).text();
                    await proc.exited;
                    return JSON.parse(out.trim()) as { owner: boolean; requestId?: string | null };
                }),
            );
            expect(results.filter((r) => r.owner)).toHaveLength(1);
            // Every loser waited for the owner's id rather than staging its own.
            for (const loser of results.filter((r) => !r.owner)) {
                expect(loser.requestId).toBe('gate-race-winner');
            }
        } finally {
            rmSync(script, { force: true });
        }
    }, 30_000);
});

describe('gateRequestAlreadyDecided', () => {
    // The claim directory is under /tmp, which an agent can write to, so this is
    // the check that makes a published requestId safe to honour at all: an id
    // that already carries a `delivered` row is a past decision being replayed,
    // not a live peer.
    test('answers TRUE when it cannot check at all', () => {
        // No session DB in a unit-test environment. "I could not check" must
        // refuse the shortcut and make the caller stage its own card — the
        // opposite answer would let an unreadable DB wave a replay through.
        expect(gateRequestAlreadyDecided('gate-anything')).toBe(true);
    });
});

describe('isDecidedGateStatus', () => {
    // The predicate `gateRequestAlreadyDecided` rests on. An earlier revision
    // treated the mere presence of a row as decided, which made every `pending`
    // card — the live, unanswered state — look settled and brought back the
    // duplicate cards the claim exists to remove.
    test('only delivered and failed are decided', () => {
        expect(isDecidedGateStatus('delivered')).toBe(true);
        expect(isDecidedGateStatus('failed')).toBe(true);
    });

    test('PENDING is NOT decided — it is exactly what a loser should wait on', () => {
        // The host writes `pending` the moment it posts the card and leaves it
        // there for the whole decision window. Counting it as decided makes
        // every loser arriving more than one host poll (~1s) after the owner
        // raise its own card, and a command needing both the destructive and
        // the email gate raise four.
        expect(isDecidedGateStatus('pending')).toBe(false);
    });

    test('an absent row is not decided', () => {
        expect(isDecidedGateStatus(undefined)).toBe(false);
        expect(isDecidedGateStatus(null)).toBe(false);
    });

    test('an UNKNOWN future status is not decided', () => {
        // A status this code has never heard of is likelier a new in-flight
        // state than a new terminal one, and guessing "decided" is the answer
        // that silently duplicates cards.
        expect(isDecidedGateStatus('queued')).toBe(false);
        expect(isDecidedGateStatus('')).toBe(false);
    });
});

// ── nanoclaw #858: nothing in agent-writable /tmp can grant an approval ──

describe('consumeGateApproval is retired', () => {
    test('a planted marker for the exact command grants nothing, and is left alone', () => {
        // The old reader unlinked `<GATE_DIR>/<hash>` and answered true, so any
        // process that could create that one file self-approved the command.
        const command = 'rm -rf /workspace/agent/important';
        mkdirSync(GATE_DIR, { recursive: true });
        const marker = `${GATE_DIR}/${computeGateHash(command)}`;
        writeFileSync(marker, '');
        try {
            expect(consumeGateApproval(command)).toBe(false);
            // Not consumed either: the function no longer touches the filesystem.
            expect(existsSync(marker)).toBe(true);
        } finally {
            rmSync(marker, { force: true });
        }
    });
});

describe('claimedGateRowMatches binds a claim to the command the human sees', () => {
    const action = 'request_destructive_gate';
    const command = 'rm -rf /workspace/agent/important';
    const row = (over: Record<string, unknown> = {}): string =>
        JSON.stringify({ action, requestId: 'gate-1', label: 'x', summary: 'x', command, ...over });

    test('same action and same command: the peer card is ours', () => {
        expect(claimedGateRowMatches(row(), action, command)).toBe(true);
    });

    test('a planted claim whose card shows an innocuous command is refused', () => {
        expect(claimedGateRowMatches(row({ command: 'echo hello' }), action, command)).toBe(false);
    });

    test('a suffix or prefix of the real command is NOT a match', () => {
        // Near-matches are how one card would approve another command.
        expect(claimedGateRowMatches(row({ command: `true; ${command}` }), action, command)).toBe(false);
        expect(claimedGateRowMatches(row({ command: command.slice(0, -1) }), action, command)).toBe(false);
    });

    test('a different gate (email vs destructive) is refused', () => {
        expect(claimedGateRowMatches(row({ action: 'request_bash_gate' }), action, command)).toBe(false);
    });

    test('missing, unparsable or non-object content is refused', () => {
        expect(claimedGateRowMatches(undefined, action, command)).toBe(false);
        expect(claimedGateRowMatches(null, action, command)).toBe(false);
        expect(claimedGateRowMatches('not json', action, command)).toBe(false);
        expect(claimedGateRowMatches('"a string"', action, command)).toBe(false);
        expect(claimedGateRowMatches('null', action, command)).toBe(false);
    });
});
