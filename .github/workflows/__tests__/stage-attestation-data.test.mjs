/**
 * Hermetic behaviour tests for `scripts/stage-attestation-data.sh` (AISDLC-704.6),
 * the data-only head-envelope stager used by the `attestation-gate` job in
 * `ai-sdlc-gate.yml`. Relocated from the retired verify-attestation.test.mjs
 * (AISDLC-833) so the 40-hex / symlink / traversal guards keep regression tests.
 *
 * Run with: node --test .github/workflows/__tests__/stage-attestation-data.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE_SCRIPT_PATH = resolve(__dirname, '../../../scripts/stage-attestation-data.sh');

describe('AISDLC-704.6: scripts/stage-attestation-data.sh behaviour (hermetic temp git repo)', () => {
  const H40 = 'a'.repeat(40);
  const G40 = 'b'.repeat(40);

  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  }

  function initRepo() {
    const dir = mkdtempSync(resolve(tmpdir(), 'stage-att-'));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  }

  function makeRepo() {
    const dir = initRepo();
    const put = (rel, content = '{}') => {
      mkdirSync(dirname(resolve(dir, rel)), { recursive: true });
      writeFileSync(resolve(dir, rel), content);
    };
    put(`.ai-sdlc/attestations/${H40}.v6.dsse.json`, '{"v6":true}');
    put(`.ai-sdlc/attestations/${G40}.dsse.json`);
    put('.ai-sdlc/attestations/evil name.json');
    put('.ai-sdlc/attestations/..hidden.dsse.json');
    put(`.ai-sdlc/attestations/sub/${H40}.dsse.json`);
    put(`.ai-sdlc/transcript-leaves/${H40}.jsonl`, 'leaf\n');
    put('.ai-sdlc/transcript-leaves/notes.jsonl');
    put('.ai-sdlc/transcript-leaves.jsonl', 'legacy\n');
    symlinkSync('/etc/passwd', resolve(dir, `.ai-sdlc/attestations/${'c'.repeat(40)}.dsse.json`));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'head');
    return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
  }

  // Stage into a clean repo that shares the source object store via alternates.
  function stage(sha, srcDir) {
    const out = initRepo();
    writeFileSync(
      resolve(out, '.git/objects/info/alternates'),
      resolve(srcDir, '.git/objects') + '\n',
    );
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', [STAGE_SCRIPT_PATH], {
        cwd: out,
        env: { ...process.env, HEAD_SHA: sha },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
      output = `${e.stdout}${e.stderr}`;
    }
    return { out, status, output };
  }

  const list = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const cleanup = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

  it('stages only strict-regex regular blobs; skips hostile names, symlinks, subdirectories', () => {
    const { dir, sha } = makeRepo();
    const r = stage(sha, dir);
    try {
      assert.equal(r.status, 0, r.output);
      assert.deepEqual(list(resolve(r.out, '.ai-sdlc/attestations')), [
        `${H40}.v6.dsse.json`,
        `${G40}.dsse.json`,
      ]);
      assert.deepEqual(list(resolve(r.out, '.ai-sdlc/transcript-leaves')), [`${H40}.jsonl`]);
      assert.equal(
        readFileSync(resolve(r.out, '.ai-sdlc/transcript-leaves.jsonl'), 'utf-8'),
        'legacy\n',
      );
      assert.equal(
        readFileSync(resolve(r.out, `.ai-sdlc/attestations/${H40}.v6.dsse.json`), 'utf-8'),
        '{"v6":true}',
      );
    } finally {
      cleanup(dir, r.out);
    }
  });

  it('fails the step when the head commit is not in the local store', () => {
    const { dir } = makeRepo();
    const r = stage('d'.repeat(40), dir);
    try {
      assert.notEqual(r.status, 0);
      assert.match(r.output, /::error::head commit/);
      assert.deepEqual(list(resolve(r.out, '.ai-sdlc')), []);
    } finally {
      cleanup(dir, r.out);
    }
  });

  it('rejects a malformed head sha before touching git', () => {
    const { dir } = makeRepo();
    const r = stage('../../x', dir);
    try {
      assert.notEqual(r.status, 0);
      assert.match(r.output, /unexpected head sha/);
    } finally {
      cleanup(dir, r.out);
    }
  });

  it('an absent attestations directory is fine (verifier reports missing)', () => {
    const dir = initRepo();
    writeFileSync(resolve(dir, 'a.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'x');
    const r = stage(git(dir, 'rev-parse', 'HEAD'), dir);
    try {
      assert.equal(r.status, 0, r.output);
      assert.deepEqual(list(resolve(r.out, '.ai-sdlc/attestations')), []);
    } finally {
      cleanup(dir, r.out);
    }
  });
});
