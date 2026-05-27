/**
 * Tests for `.github/workflows/verify-attestation.yml` — AISDLC-445
 * per-patch-id transcript-leaves directory staging.
 *
 * Context: AISDLC-421 introduced per-patch-id transcript-leaves files at
 * `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` as the primary path for v6
 * Merkle verification. The CI verifier's `v6ResolveLeavesForEnvelope` prefers
 * this per-patch-id file over the shared `transcript-leaves.jsonl` fallback.
 *
 * Before AISDLC-445 the `Stage fork envelope for verifier (DATA-ONLY copy)`
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
 * 1. pull_request_target path: loop over `pr-content/.ai-sdlc/transcript-leaves/*.jsonl`,
 *    validate each filename against `^[0-9a-f]{40}\.jsonl$` (path-traversal guard),
 *    and copy validated files to `.ai-sdlc/transcript-leaves/<basename>`.
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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');

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
 * Locate the `Stage fork envelope for verifier (DATA-ONLY copy)` step in
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
      'verify-attestation.yml must declare a "Stage fork envelope for verifier (DATA-ONLY copy)" step',
    );
  });

  it('pull_request_target path: loops over pr-content/.ai-sdlc/transcript-leaves/*.jsonl', () => {
    // The per-patch-id staging loop must iterate over
    // `pr-content/.ai-sdlc/transcript-leaves/*.jsonl` to pick up each
    // <patch-id>.jsonl file emitted by AISDLC-421.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /pr-content\/\.ai-sdlc\/transcript-leaves\/\*\.jsonl/,
      'Stage step must loop over pr-content/.ai-sdlc/transcript-leaves/*.jsonl (AISDLC-445 per-patch-id directory)',
    );
  });

  it('pull_request_target path: applies ^[0-9a-f]{40}\\.jsonl$ filename validation guard', () => {
    // Path-traversal guard: only filenames matching exactly 40 lowercase hex
    // chars + .jsonl are copied. This prevents a malicious fork PR from
    // smuggling e.g. `../../etc/passwd.jsonl` past the copy step.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /\^?\[0-9a-f\]\{40\}\\?\.jsonl\$?/,
      'Stage step must validate per-patch-id leaf filenames with ^[0-9a-f]{40}\\.jsonl$ (path-traversal guard)',
    );
  });

  it('pull_request_target path: copies validated files to .ai-sdlc/transcript-leaves/', () => {
    // Validated files must land in `.ai-sdlc/transcript-leaves/` so the
    // verifier's `v6ResolveLeavesForEnvelope` lookup finds them via the
    // primary per-patch-id path.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /\.ai-sdlc\/transcript-leaves\//,
      'Stage step must copy per-patch-id leaves into .ai-sdlc/transcript-leaves/ destination directory',
    );
  });

  it('pull_request_target path: guards the loop with a directory existence check', () => {
    // The per-patch-id directory may not exist on PRs that use the legacy
    // shared-file path (pre-AISDLC-421). The loop MUST be guarded by
    // `[ -d "pr-content/.ai-sdlc/transcript-leaves" ]` so it does not fail
    // when the directory is absent.
    const wf = loadYaml('verify-attestation.yml');
    const step = findStageStep(wf);
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /-d\s+["']?pr-content\/\.ai-sdlc\/transcript-leaves["']?/,
      'Stage step must guard the per-patch-id loop with `[ -d pr-content/.ai-sdlc/transcript-leaves ]`',
    );
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
    // `pr-content/` are read as data only — never executed by node, bash,
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
    const run = String(step?.run ?? '');
    assert.match(
      run,
      /pr-content\/\.ai-sdlc\/transcript-leaves\.jsonl/,
      'Stage step must still copy pr-content/.ai-sdlc/transcript-leaves.jsonl (legacy shared-file fallback for pre-AISDLC-421 PRs)',
    );
  });
});
