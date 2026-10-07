/**
 * Tests for `.github/workflows/verify-attestation.yml` — AISDLC-445
 * per-patch-id transcript-leaves directory staging.
 *
 * Context: AISDLC-421 introduced per-patch-id transcript-leaves files at
 * `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` as the primary path for v6
 * Merkle verification. The CI verifier's `v6ResolveLeavesForEnvelope` prefers
 * this per-patch-id file over the shared `transcript-leaves.jsonl` fallback.
 *
 * Before AISDLC-445 the `Stage fork envelope for verifier (DATA-ONLY API fetch)`
 * step only copied the singular `.ai-sdlc/transcript-leaves.jsonl` (the legacy
 * shared file) — it did NOT propagate the per-patch-id directory. The verifier
 * therefore fell back to the shared file, which carries stale leaves from
 * whichever PR landed most recently. The recomputed Merkle root from stale
 * leaves did not match the envelope's signed root, producing the misleading:
 *
 *   v6: rootSignature did not match any trusted reviewer pubkey
 *
 * The signature was fine; the leaves it was verified against were wrong.
 *
 * Two PRs hit this failure empirically: PR #727 (AISDLC-443) and PR #729
 * (AISDLC-444), both opened 2026-05-26. Local `node scripts/verify-attestation.mjs`
 * returned `status=valid reason=ok` for both; CI failed both.
 *
 * The fix has two parts:
 *
 * 1. pull_request_target path: list `.ai-sdlc/transcript-leaves` at the fork head via
 *    the contents API (AISDLC-704.6: no fork checkout), validate each filename
 *    against `^[0-9a-f]{40}\.jsonl$` (path-traversal guard), and write validated
 *    files to `.ai-sdlc/transcript-leaves/<basename>`.
 *
 * 2. merge_group path: add `git checkout "$HEAD_SHA" -- '.ai-sdlc/transcript-leaves/'`
 *    alongside the existing `transcript-leaves.jsonl` checkout.
 *
 * These tests assert both code paths are present and the filename validation
 * guard is applied on the pull_request_target path. They are static (parse the
 * YAML, inspect run: scripts) — the full end-to-end scenario can only be
 * exercised on GitHub Actions, which is impractical for hermetic CI.
 *
 * Run with: node --test .github/workflows/__tests__/verify-attestation.test.mjs
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
const WORKFLOWS_DIR = resolve(__dirname, '..');
const STAGE_SCRIPT_PATH = resolve(__dirname, '../../../scripts/stage-attestation-data.sh');
const STAGE_SCRIPT = readFileSync(STAGE_SCRIPT_PATH, 'utf-8');

function loadYaml(name) {
  const path = resolve(WORKFLOWS_DIR, name);
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

/**
 * Locate the `Stage fork envelope for verifier (DATA-ONLY API fetch)` step in
 * verify-attestation.yml and return it (or null if absent).
 */
function findStageStep(wf) {
  return (
    (wf.jobs.verify.steps ?? []).find(
      (s) => typeof s.name === 'string' && /Stage fork envelope for verifier/i.test(s.name),
    ) ?? null
  );
}

describe('AISDLC-445: verify-attestation.yml stages per-patch-id transcript-leaves directory', () => {
  it('Stage fork envelope step exists', () => {
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    assert.ok(
      step,
      'verify-attestation.yml must declare a "Stage fork envelope for verifier (DATA-ONLY API fetch)" step',
    );
  });

  it('pull_request_target path: stages via git objects, with no contents-API loop', () => {
    const wf = loadYaml('verify-attestation.yml');
    const run = String(findStageStep(wf)?.run ?? '');
    assert.match(run, /bash scripts\/stage-attestation-data\.sh/);
    assert.ok(!/gh api[^\n]*contents\//.test(run), 'no gh api .../contents/ calls');
    assert.ok(!/fetch_dir/.test(run), 'no per-file fetch_dir loop');
    assert.match(STAGE_SCRIPT, /git ls-tree -z/);
    assert.match(STAGE_SCRIPT, /git show "\$\{HEAD_SHA\}:\$\{src\}"/);
    assert.ok(!/gh api/.test(STAGE_SCRIPT));
    assert.match(STAGE_SCRIPT, /stage_dir "\.ai-sdlc\/transcript-leaves"/);
    assert.match(STAGE_SCRIPT, /\.ai-sdlc\/transcript-leaves\.jsonl/);
  });

  it('pull_request_target path: a failed head fetch fails the step loudly', () => {
    const run = String(findStageStep(loadYaml('verify-attestation.yml'))?.run ?? '');
    assert.match(run, /::error::failed to fetch head/);
    assert.ok(!/git fetch[^\n]*\|\| true/.test(run), 'head fetch must not be swallowed');
  });

  it('staging script applies the 40-hex .jsonl filename validation guard', () => {
    assert.ok(STAGE_SCRIPT.includes("'^[0-9a-f]{40}\\.jsonl$'"));
  });

  it('merge_group path: checks out .ai-sdlc/transcript-leaves/ directory from HEAD_SHA', () => {
    // The merge_group branch surfaces files via `git checkout <sha> -- <path>`.
    // For per-patch-id leaves, it must add `.ai-sdlc/transcript-leaves/`
    // alongside the existing `.ai-sdlc/transcript-leaves.jsonl`.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /git checkout.*\.ai-sdlc\/transcript-leaves\//,
      'Stage step merge_group path must checkout .ai-sdlc/transcript-leaves/ directory from HEAD_SHA (AISDLC-445)',
    );
  });

  it('merge_group path: transcript-leaves/ checkout is graceful (2>/dev/null || true)', () => {
    // The per-patch-id directory may not exist on the queue commit (e.g.
    // legacy PRs before AISDLC-421). The checkout must be non-fatal.
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'verify-attestation.yml'), 'utf-8');
    // Locate the transcript-leaves/ directory checkout line.
    const lines = raw.split('\n');
    const checkoutLineIdx = lines.findIndex(
      (l) => l.includes('checkout') && l.includes("'.ai-sdlc/transcript-leaves/'"),
    );
    assert.ok(
      checkoutLineIdx !== -1,
      "verify-attestation.yml must contain a git checkout line for '.ai-sdlc/transcript-leaves/'",
    );
    const checkoutLine = lines[checkoutLineIdx];
    assert.match(
      checkoutLine,
      /2>\/dev\/null.*\|\|\s*true/,
      "The .ai-sdlc/transcript-leaves/ checkout must be graceful (2>/dev/null || true) for PRs that don't have the directory",
    );
  });

  it('Stage step references AISDLC-445 in its inline comments', () => {
    // Traceability: the inline comment must point back to this task so
    // future editors can understand why the per-patch-id staging is needed.
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'verify-attestation.yml'), 'utf-8');
    assert.match(
      raw,
      /AISDLC-445/,
      'verify-attestation.yml must reference AISDLC-445 in inline comments for traceability',
    );
  });

  it('DATA-ONLY contract preserved: per-patch-id leaves are never executed', () => {
    // The fork-PR safety pattern (AISDLC-381) requires that files from
    // the fork are fetched as data only — never executed by node, bash,
    // pnpm, or any interpreter.  Assert that no `run:` step in the workflow
    // invokes `node`, `bash`, or `sh` against `.ai-sdlc/transcript-leaves/`.
    const wf = loadYaml('verify-attestation.yml');
    for (const step of wf.jobs.verify.steps ?? []) {
      const run = String(step.run ?? '');
      if (!run) continue;
      assert.doesNotMatch(
        run,
        /\bnode\s+\.ai-sdlc\/transcript-leaves\//,
        `Step "${step.name ?? '<unnamed>'}" must NOT execute transcript-leaves/ files with node`,
      );
      assert.doesNotMatch(
        run,
        /\bbash\s+\.ai-sdlc\/transcript-leaves\//,
        `Step "${step.name ?? '<unnamed>'}" must NOT execute transcript-leaves/ files with bash`,
      );
      assert.doesNotMatch(
        run,
        /\bsh\s+\.ai-sdlc\/transcript-leaves\//,
        `Step "${step.name ?? '<unnamed>'}" must NOT execute transcript-leaves/ files with sh`,
      );
    }
  });

  it('regression: legacy transcript-leaves.jsonl staging is still present (pre-AISDLC-421 fallback)', () => {
    // Pre-AISDLC-421 PRs only have the shared transcript-leaves.jsonl. The
    // verifier falls back to it when the per-patch-id file is absent. The
    // shared-file staging must remain intact alongside the new per-patch-id
    // loop so legacy PRs continue to verify successfully.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    assert.match(
      STAGE_SCRIPT,
      /\.ai-sdlc\/transcript-leaves\.jsonl/,
      'Stage step must still fetch .ai-sdlc/transcript-leaves.jsonl (legacy shared-file fallback for pre-AISDLC-421 PRs)',
    );
  });
});

describe('AISDLC-704.6: verify job never checks out the fork head (DangerousWorkflow class)', () => {
  const wf = loadYaml('verify-attestation.yml');
  const steps = wf.jobs.verify.steps ?? [];
  const stage = findStageStep(wf);
  const stageRun = String(stage?.run ?? '');

  it('has no checkout of the PR head sha, fork repository, or pr-content path', () => {
    for (const st of steps) {
      if (typeof st.uses === 'string' && st.uses.startsWith('actions/checkout@')) {
        assert.equal(st.with?.ref, undefined, 'checkout must not pin a ref');
        assert.equal(st.with?.repository, undefined, 'checkout must not target a fork repository');
        assert.equal(st.with?.path, undefined, 'no sandbox path checkout');
        assert.equal(st.with?.['allow-unsafe-pr-checkout'], undefined);
      }
    }
    assert.ok(!/pr-content/.test(stageRun), 'stage step must not read from pr-content/');
  });

  it('binds head repo + base repo through step env, not inline expressions', () => {
    assert.equal(stage.env.HEAD_REPO_FULL, '${{ github.event.pull_request.head.repo.full_name }}');
    assert.equal(stage.env.BASE_REPO_FULL, '${{ github.repository }}');
    assert.ok(!/\$\{\{/.test(stageRun), 'stage run: block must contain no ${{ }} expressions');
  });

  it('hex-validates the head sha and pattern-validates the head repo before any fetch', () => {
    assert.ok(stageRun.includes('"$HEAD_SHA" =~ ^[0-9a-f]{40}$'), 'anchored 40-hex check');
    assert.ok(stageRun.includes('"$HEAD_REPO_FULL" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'));
    const validateIdx = stageRun.indexOf('unexpected head sha');
    const fetchIdx = stageRun.indexOf('git fetch --no-tags "https://github.com');
    assert.ok(validateIdx !== -1 && fetchIdx > validateIdx, 'validation precedes the first fetch');
  });

  it('stages envelopes with the strict <40hex>[.v6].dsse.json filename guard', () => {
    assert.ok(STAGE_SCRIPT.includes("'^[0-9a-f]{40}(\\.v6)?\\.dsse\\.json$'"));
  });

  it('no run: block anywhere interpolates github.event.* (bound via env)', () => {
    for (const job of Object.values(wf.jobs)) {
      for (const st of job.steps ?? []) {
        if (typeof st.run === 'string') {
          assert.ok(
            !/\$\{\{\s*github\.event\./.test(st.run),
            `step '${st.name ?? ''}': bind github.event.* to env: instead`,
          );
        }
      }
    }
  });
});

describe('AISDLC-747: approve job posts an approving review on a verified envelope', () => {
  const wf = loadYaml('verify-attestation.yml');
  const job = wf.jobs.approve;

  it('declares an approve job that needs verify', () => {
    assert.ok(job, 'approve job must exist');
    assert.equal(job.needs, 'verify');
  });

  it('holds pull-requests: write only on the approve job', () => {
    assert.equal(job.permissions['pull-requests'], 'write');
    assert.equal(wf.permissions['pull-requests'], undefined);
    assert.notEqual(wf.jobs.verify.permissions['pull-requests'], 'write');
  });

  it('gates on each required clause in the if condition', () => {
    const clauses = String(job.if)
      .split('&&')
      .map((c) => c.trim());
    assert.deepEqual(clauses, [
      "needs.verify.result == 'success'",
      "needs.verify.outputs.status == 'valid'",
      "github.event_name == 'pull_request_target'",
      'github.event.pull_request.head.repo.full_name == github.repository',
    ]);
  });

  it('never runs on pull_request or merge_group', () => {
    assert.ok(!/event_name\s*!=\s*'merge_group'/.test(String(job.if)));
    assert.ok(!/== 'pull_request'(?!_target)/.test(String(job.if)));
  });

  it('concurrency group is keyed by event name', () => {
    assert.match(wf.concurrency.group, /github\.event_name/);
  });

  it('verify job exposes status and reason outputs', () => {
    assert.ok(wf.jobs.verify.outputs.status);
    assert.ok(wf.jobs.verify.outputs.reason);
  });

  it('checks out the default branch explicitly with no persisted credentials', () => {
    const checkout = job.steps.find((st) => /actions\/checkout/.test(String(st.uses ?? '')));
    assert.ok(checkout, 'approve job must have a checkout step');
    assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(checkout.with['allow-unsafe-pr-checkout'], undefined);
  });

  it('runs the script and skips with a notice when it is absent (bootstrap)', () => {
    const step = job.steps.find((st) => /post-attestation-review\.mjs/.test(String(st.run ?? '')));
    assert.ok(step, 'script step must exist');
    const run = String(step.run);
    assert.match(run, /\[ ! -f scripts\/post-attestation-review\.mjs \]/);
    assert.match(run, /::notice::/);
    assert.match(run, /exit 0/);
    assert.match(run, /node scripts\/post-attestation-review\.mjs/);
  });
});

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
