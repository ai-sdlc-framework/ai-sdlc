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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
import { FIXTURE_BENIGN } from './ucvg-threat-fixtures.js';
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

const PROBE = probeRunsc();

describe('GVisorSandboxDriver differential test (integration)', () => {
  it.skipIf(!PROBE.ok)(
    'returns the same result shape as the Docker driver',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'gvisor-integration-'));
      const prevFixture = process.env['SANDBOX_FIXTURE_B64'];
      process.env['SANDBOX_FIXTURE_B64'] = buildUcvgDemoFixtureB64();
      try {
        const result = await runSandbox({
          prNumber: FIXTURE_BENIGN.prNumber,
          prDiff: FIXTURE_BENIGN.prDiff,
          upstreamMainRef: 'https://github.com/ai-sdlc-framework/ai-sdlc-test-fixture.git',
          config: {
            ...DEFAULT_SANDBOX_CONFIG,
            sandboxDriver: 'gvisor',
          },
          workDir: tmpDir,
          driverOverride: new GVisorSandboxDriver(),
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
        if (prevFixture === undefined) delete process.env['SANDBOX_FIXTURE_B64'];
        else process.env['SANDBOX_FIXTURE_B64'] = prevFixture;
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
