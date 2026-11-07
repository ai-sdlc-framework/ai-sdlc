/**
 * AISDLC-515.1 — gated gVisor integration test.
 *
 * Runs the differential test through `GVisorSandboxDriver` (docker
 * `--runtime=runsc`) and asserts the result has the same shape as the Docker
 * driver's. Runs only when `AI_SDLC_GVISOR_INTEGRATION_TESTS=1` AND `runsc` is
 * installed; otherwise skipped. The CI step in `ai-sdlc-gate.yml` installs
 * runsc and sets the flag, so the run is visible there.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SANDBOX_CONFIG,
  GVisorSandboxDriver,
  checkDriverAvailability,
  parseDifferentialTestOutput,
  runSandbox,
} from './sandbox-runner.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

/**
 * Build the base64 gzip tarball of the repo-root `ucvg-demo/` directory, the
 * same `tar -C <dir> -cz . | base64` the fixture-demo mode of cli/ucvg.ts
 * uses. The sandbox runs under --network=none, so the test stages this
 * fixture offline instead of cloning upstreamMainRef.
 */
export function buildUcvgDemoFixtureB64(): string {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ucvg-demo');
  return execFileSync('tar', ['-C', dir, '-cz', '.'], {
    maxBuffer: 32 * 1024 * 1024,
  }).toString('base64');
}

const ENABLED =
  process.env['AI_SDLC_GVISOR_INTEGRATION_TESTS'] === '1' &&
  process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1' &&
  checkDriverAvailability('gvisor').available;

/**
 * Probe a trivial `docker run --runtime=runsc` so a runner whose runsc cannot
 * start a sandbox (no KVM or ptrace platform) skips with a logged reason
 * instead of failing the differential test.
 */
function probeRunsc(): { ok: boolean; reason: string } {
  if (!ENABLED) return { ok: false, reason: 'integration env flags or runsc not present' };
  const image = process.env['AI_SDLC_SANDBOX_IMAGE'] ?? 'node:22-slim';
  const r = spawnSync('docker', ['run', '--rm', '--runtime=runsc', image, 'true'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status === 0) return { ok: true, reason: '' };
  const reason = `docker run --runtime=runsc probe failed (status=${r.status}): ${r.stderr || r.error?.message || ''}`;
  console.warn(`[gvisor-integration] skipping differential test: ${reason}`);
  return { ok: false, reason };
}

/**
 * Well-formed patch adding `src/multiply.js` and `test/multiply.test.js` to
 * ucvg-demo (hunk counts match the bodies), so its `node --test` suite runs it.
 */
const MULTIPLY_DIFF = `diff --git a/src/multiply.js b/src/multiply.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/multiply.js
@@ -0,0 +1,4 @@
+function multiply(a, b) {
+  return a * b;
+}
+module.exports = { multiply };
diff --git a/test/multiply.test.js b/test/multiply.test.js
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/test/multiply.test.js
@@ -0,0 +1,10 @@
+const test = require('node:test');
+const assert = require('node:assert');
+const { multiply } = require('../src/multiply');
+
+test('multiplies two numbers', () => {
+  assert.strictEqual(multiply(3, 4), 12);
+});
+test('multiplies by zero', () => {
+  assert.strictEqual(multiply(5, 0), 0);
+});
`;

/** Fail fast with git's own error text if the diff does not apply to an empty tree. */
function assertDiffApplies(diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'gvisor-diff-check-'));
  try {
    const work = join(dir, 'work');
    mkdirSync(work);
    const patch = join(dir, 'p.diff');
    writeFileSync(patch, diff);
    const r = spawnSync('git', ['apply', '--check', patch], { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`MULTIPLY_DIFF does not apply: ${r.stderr}`);
  } finally {
    removeFixtureDir(dir);
  }
}

const PROBE = probeRunsc();

describe('GVisorSandboxDriver differential test (integration)', () => {
  it.skipIf(!PROBE.ok)(
    'returns the same result shape as the Docker driver',
    async () => {
      assertDiffApplies(MULTIPLY_DIFF);
      const tmpDir = mkdtempSync(join(tmpdir(), 'gvisor-integration-'));
      try {
        const result = await runSandbox({
          prNumber: 1,
          prDiff: MULTIPLY_DIFF,
          upstreamMainRef: 'https://github.com/ai-sdlc-framework/ai-sdlc-test-fixture.git',
          config: {
            ...DEFAULT_SANDBOX_CONFIG,
            sandboxDriver: 'gvisor',
          },
          workDir: tmpDir,
          driverOverride: new GVisorSandboxDriver(),
          sandboxEnv: { SANDBOX_FIXTURE_B64: buildUcvgDemoFixtureB64() },
        });
        if (result.outcome !== 'success') {
          console.error(
            `[gvisor-integration] outcome=${result.outcome} detail=${JSON.stringify(result)}`,
          );
        }
        expect(result.outcome, JSON.stringify(result)).toBe('success');
        if (result.outcome === 'success') {
          expect(Object.keys(result.differentialTest).sort()).toEqual(
            Object.keys(parseDifferentialTestOutput('')).sort(),
          );
        }
      } finally {
        removeFixtureDir(tmpDir);
      }
    },
    240_000,
  );
});

describe('buildUcvgDemoFixtureB64', () => {
  it('produces a tarball that extracts to ucvg-demo/package.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'ucvg-fixture-'));
    try {
      const buf = Buffer.from(buildUcvgDemoFixtureB64(), 'base64');
      execFileSync('tar', ['-C', out, '-xz'], { input: buf });
      expect(existsSync(join(out, 'package.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toBeTypeOf('object');
    } finally {
      removeFixtureDir(out);
    }
  });
});
