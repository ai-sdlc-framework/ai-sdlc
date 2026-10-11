/**
 * AISDLC-803: one poster for the `ai-sdlc/attestation` commit status.
 *
 * Exactly one workflow (verify-attestation.yml) posts the context on
 * pull_request events; every post carries the run URL as target_url and a
 * `<status> | v<schema> | <reason> | run <id>` description; the gate reads the
 * verifier run's conclusion instead of the bare status.
 *
 * Run with: node --test .github/workflows/__tests__/attestation-single-poster.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadYaml(name) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',
        join(WORKFLOWS_DIR, name),
      ],
      { encoding: 'utf8' },
    ),
  );
}

function triggers(wf) {
  const on = wf.on ?? wf.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

// A POST of the exact `ai-sdlc/attestation` context (not `ai-sdlc/attestation-review` etc.).
const POST_RE = /context(?:=|:\s*)['"]ai-sdlc\/attestation['"]/g;

const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));
const rawOf = (f) => readFileSync(join(WORKFLOWS_DIR, f), 'utf8');

describe('single poster for ai-sdlc/attestation (AISDLC-803)', () => {
  it('exactly one workflow posts the context on pull_request events', () => {
    const posters = files.filter(
      (f) => triggers(loadYaml(f)).includes('pull_request') && POST_RE.test(rawOf(f)),
    );
    POST_RE.lastIndex = 0;
    assert.deepEqual(posters, ['verify-attestation.yml']);
  });

  it('no workflow posts the context from a non-verifier workflow at all', () => {
    const posters = files.filter((f) => (rawOf(f).match(POST_RE) ?? []).length > 0);
    assert.deepEqual(posters, ['verify-attestation.yml']);
  });

  it('every post carries the run URL as target_url and schema + run id in description', () => {
    const raw = rawOf('verify-attestation.yml');
    const posts = raw.match(/gh api "repos\/\$\{REPO\}\/statuses\/[\s\S]*?\n\s*(?:echo|\n)/g) ?? [];
    assert.ok(posts.length >= 3, 'expected docs-only, release-please and verifier posts');
    for (const p of posts) {
      assert.match(p, /-f target_url="\$RUN_URL"/);
      assert.match(p, /description="[^"]*\|[^"]*run \$\{RUN_ID\}"|description="\$DESC"/);
    }
    assert.match(
      raw,
      /RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/,
    );
    assert.match(raw, /PREFIX="\$\{STATE\} \| \$\{SCHEMA\} \| "/);
  });

  it('attestation-gate resolves the verifier run and does not read the bare status', () => {
    const job = loadYaml('ai-sdlc-gate.yml').jobs['attestation-gate'];
    const runs = job.steps.map((s) => s.run ?? '').join('\n');
    assert.match(runs, /node scripts\/resolve-attestation-gate\.mjs/);
    assert.doesNotMatch(runs, /commits\/.*\/status/);
    assert.equal(job.permissions.actions, 'read');
  });
});
