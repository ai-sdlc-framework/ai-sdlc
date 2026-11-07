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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SANDBOX_CONFIG,
  GVisorSandboxDriver,
  checkDriverAvailability,
  parseDifferentialTestOutput,
  runSandbox,
} from './sandbox-runner.js';
import { FIXTURE_BENIGN } from './ucvg-threat-fixtures.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const ENABLED =
  process.env['AI_SDLC_GVISOR_INTEGRATION_TESTS'] === '1' &&
  process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1' &&
  checkDriverAvailability('gvisor').available;

describe('GVisorSandboxDriver differential test (integration)', () => {
  it.skipIf(!ENABLED)(
    'returns the same result shape as the Docker driver',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'gvisor-integration-'));
      try {
        const result = await runSandbox({
          prNumber: FIXTURE_BENIGN.prNumber,
          prDiff: FIXTURE_BENIGN.prDiff,
          upstreamMainRef:
            process.env['AI_SDLC_TEST_UPSTREAM_REF'] ??
            'https://github.com/ai-sdlc-framework/ai-sdlc-test-fixture.git',
          config: {
            ...DEFAULT_SANDBOX_CONFIG,
            sandboxDriver: 'gvisor',
          },
          workDir: tmpDir,
          driverOverride: new GVisorSandboxDriver(),
        });
        expect(result.outcome).toBe('success');
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
