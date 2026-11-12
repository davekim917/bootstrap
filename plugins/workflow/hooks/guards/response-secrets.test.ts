import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RESPONSE_SECRETS_FILE_ENV, evaluateBashCommand, parseResponseSecrets } from './block-destructive-core';

/**
 * A line that calls a host listed in response-secrets.local.json may not write a file: the response can carry live
 * credentials, so it is read in memory and filtered. Reads that filter in memory run as before, with no card.
 */

const HOST = 'api.acme-events.example';
const API = `https://${HOST}/v1`;
let dir = '';
let scopeFile = '';
let saved: string | undefined;

beforeAll(() => {
    saved = process.env[RESPONSE_SECRETS_FILE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'response-secrets-test-'));
    scopeFile = join(dir, 'response-secrets.local.json');
    writeFileSync(scopeFile, JSON.stringify({ hosts: [HOST] }));
    process.env[RESPONSE_SECRETS_FILE_ENV] = scopeFile;
});

afterEach(() => {
    process.env[RESPONSE_SECRETS_FILE_ENV] = scopeFile;
});

afterAll(() => {
    if (saved === undefined) delete process.env[RESPONSE_SECRETS_FILE_ENV];
    else process.env[RESPONSE_SECRETS_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
});

const verdict = (command: string) => evaluateBashCommand(command, { cwd: dir });

describe('a response from a listed host never reaches a file', () => {
    test.each([
        ['the incident: curl -o, then jq reads the file',
            `curl -s "${API}/destinations?page=1" -o destinations.json; jq -r '.data.destinations[] | [.id, .name] | @tsv' destinations.json; curl -s "${API}/sources?page=1" -o sources.json; jq -r '.data.sources[].id' sources.json`],
        ['curl --output=', `curl -s --output=out.json ${API}/sources`],
        ['curl -sSo in one cluster', `curl -sSo out.json ${API}/sources`],
        ['curl -O', `curl -sO ${API}/sources`],
        ['curl --trace, which holds the body', `curl -s --trace t.log ${API}/sources`],
        ['stdout redirected', `curl -s ${API}/sources > sources.json`],
        ['appended', `curl -s ${API}/sources >> artifacts/all.json`],
        ['tee in the pipeline', `curl -s ${API}/sources | tee sources.json | jq length`],
        ['a jq stage redirected', `curl -s ${API}/sources | jq . > sources.json`],
        ['jq stderr redirected, which quotes its input', `curl -s ${API}/sources | jq '.x' 2>jq-errors.log`],
        ['a group redirected', `{ curl -s ${API}/sources; } > sources.json`],
        ['the URL in a variable on the same line', `U=${API}/sources; curl -s "$U" -o s.json`],
        ['through xargs', `echo ${API}/sources | xargs curl -s > s.json`],
        ['wget, which saves a file by default', `wget -q ${API}/sources`],
        ['wget -O file', `wget -qO s.json ${API}/sources`],
        ['HTTPie --download', `http --download GET ${API}/sources`],
        ['a substitution written out', `echo "$(curl -s ${API}/sources)" > s.json`],
        ['>& to a file', `curl -s ${API}/sources >& s.json`],
        ['a redirect inside a substitution', `echo "$(curl -s ${API}/sources > s.json)"`],
        ['xargs curl -o', `printf '%s' ${API}/sources | xargs curl -s -o s.json`],
        ['curl --expand-output', `curl -s ${API}/sources --expand-output s.json`],
        ['curl option abbreviated', `curl -s --remote-na ${API}/sources`],
        ['wget --warc-file', `wget -qO- --warc-file=resp ${API}/sources`],
        ['a quoted host', `curl -s https://api.'acme-events'.example/v1/sources -o s.json`],
        ['tee after --', `curl -s ${API}/sources | tee -- -s.json`],
        ['a read-write redirect', `curl -s ${API}/sources 1<> s.json`],
        ['tee to a file named -', `curl -s ${API}/sources | tee -`],
        ['xargs with a path to curl', `printf '%s' ${API}/sources | xargs /usr/bin/curl -s -o s.json`],
        ['xargs HTTPie --download', `printf '%s' ${API}/sources | xargs http --download`],
        ['wget --warc-file=-', `wget -qO- --warc-file=- ${API}/sources`],
        ['wget --spider=off', `wget --spider=off ${API}/sources`],
        ['wget --spider then --no-spider', `wget --spider --no-spider ${API}/sources`],
        ['curl with an inline config', `curl -s ${API}/sources -K - <<'CURL'\noutput = s.json\nCURL`],
        ['a quoted filename that looks like a process substitution', `curl -s ${API}/sources > '>(s.json)'`],
        ['stdout duplicated onto a read-write stdin', `curl -s ${API}/sources 0<> s.json >&0`],
        ['wget --execute setting a WARC file', `wget -qO- --execute 'warcfile=resp' ${API}/sources`],
        ['wget -e', `wget -qO- -e warcfile=resp ${API}/sources`],
    ])('%s', (_name, command) => {
        const result = verdict(command);
        expect(result.action).toBe('block');
        expect(result.reason).toContain(HOST);
    });
});

describe('a read that filters in memory is untouched', () => {
    test.each([
        ['curl piped to jq', `curl -s "${API}/destinations?page=1" | jq '[.data.destinations[] | {id, name, enabled}]' 2>/dev/null`],
        ['curl -o - to stdout', `curl -s -o - ${API}/sources | jq '.data.sources[].id'`],
        ['wget -qO- to stdout', `wget -qO- ${API}/sources | jq length`],
        ['wget --output-doc=- abbreviated', `wget -q --output-doc=- ${API}/sources | jq length`],
        ['HTTPie to stdout', `http GET ${API}/sources | jq length`],
        ['curl -o /dev/null for a status code', `curl -s -o /dev/null -w '%{http_code}' ${API}/sources`],
        ['jq given a client name as data', `curl -s ${API}/sources | jq --arg client wget '{id, name, client: $client}'`],
        ['an option value that looks like --output', `curl -s --user-agent '--output=s.json' ${API}/sources | jq '{id, name}'`],
        ['a process substitution', `curl -s ${API}/sources > >(jq '{id, name}')`],
        ['wget --spider', `wget -q --spider ${API}/sources`],
        ['into a variable', `ids=$(curl -s ${API}/sources | jq -r '.data.sources[].id'); echo "$ids"`],
        ['jq filter with a comparison', `curl -s ${API}/sources | jq '.data.sources[] | select(.count > 5) | .id'`],
    ])('%s', (_name, command) => {
        expect(verdict(command)).toEqual({ action: 'allow' });
    });

    test('an unlisted host may still save a file', () => {
        expect(verdict('curl -s https://downloads.example.org/tool.tar.gz -o tool.tar.gz')).toEqual({ action: 'allow' });
    });

    test('a line that writes a file but calls no HTTP client is untouched', () => {
        expect(verdict(`echo "${HOST} lists sources" > notes.md`)).toEqual({ action: 'allow' });
    });
});

describe('the scope file', () => {
    test('no file refuses nothing', () => {
        process.env[RESPONSE_SECRETS_FILE_ENV] = join(dir, 'missing.json');
        expect(verdict(`curl -s ${API}/sources -o s.json`)).toEqual({ action: 'allow' });
    });

    test('an unreadable file treats every host as listed', () => {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"hosts": "not a list"}');
        process.env[RESPONSE_SECRETS_FILE_ENV] = broken;
        const saving = verdict('curl -s https://downloads.example.org/tool.tar.gz -o tool.tar.gz');
        expect(saving.action).toBe('block');
        expect(saving.reason).toContain("response-secrets.local.json can't be read");
        expect(verdict('curl -s https://downloads.example.org/x | jq length')).toEqual({ action: 'allow' });
    });

    test.each([
        ['{"hosts": ["api.acme-events.example", "API.Other.example"]}', ['api.acme-events.example', 'api.other.example']],
        ['{"hosts": []}', []],
        ['{"hosts": ["https://api.acme-events.example"]}', null],
        ['{"hosts": ["localhost"]}', null],
        ['[]', null],
        ['not json', null],
    ])('parses %s', (text, expected) => {
        expect(parseResponseSecrets(text)).toEqual(expected);
    });
});
