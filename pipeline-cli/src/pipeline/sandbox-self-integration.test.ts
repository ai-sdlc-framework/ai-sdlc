/**
 * AISDLC-1296 AC-6 — gated integration test: the sandbox runs this repository's
 * own HEAD with the committed `.ai-sdlc/untrusted-pr-gate.yaml` and a diff that
 * adds one passing test under `orchestrator/src/`. Runs only when
 * `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` and Docker is available (network is
 * needed by the fetch container).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSandboxConfig, runSandbox, tailLines } from './sandbox-runner.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const ENABLED =
  process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1' &&
  spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!ENABLED)('sandbox on this repository (AISDLC-1296 AC-6)', () => {
  it('passes the upstream suite and a new orchestrator test', { timeout: 1_800_000 }, async () => {
    const repoRoot = resolve(
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname }).toString().trim(),
    );
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']).toString().trim();
    const fetchOutputs: string[] = [];
    const baseTree = mkdtempSync(join(tmpdir(), 'self-int-base-'));
    try {
      const tarball = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', 'HEAD'], {
        maxBuffer: 1 << 30,
      });
      execFileSync('tar', ['-x', '-C', baseTree], { input: tarball });
      execFileSync('chmod', ['-R', 'a+rX', baseTree]);
      const diff =
        'diff --git a/orchestrator/src/sandbox-self-probe.test.ts b/orchestrator/src/sandbox-self-probe.test.ts\n' +
        'new file mode 100644\n--- /dev/null\n+++ b/orchestrator/src/sandbox-self-probe.test.ts\n@@ -0,0 +1,2 @@\n' +
        "+import { it, expect } from 'vitest';\n+it('sandbox probe', () => { expect(1).toBe(1); });\n";
      const result = await runSandbox({
        prNumber: 1,
        prDiff: diff,
        upstreamMainRef: sha,
        config: loadSandboxConfig(repoRoot),
        workDir: repoRoot,
        baseTreeDir: baseTree,
        onFetchOutput: (out) => fetchOutputs.push(out),
      });
      // AISDLC-1312: say why a suite failed; the last 200 lines only.
      const failed =
        result.outcome !== 'success' ||
        !result.differentialTest.upstreamSuitePassed ||
        !result.differentialTest.newTestsPassed;
      if (failed) {
        const dt = result.outcome === 'success' ? result.differentialTest : undefined;
        process.stderr.write(
          [
            `sandbox outcome: ${result.outcome}`,
            `--- fetch phase (last 200 lines) ---\n${tailLines(fetchOutputs.join('\n'), 200)}`,
            `--- base suite (last 200 lines) ---\n${tailLines(dt?.upstreamSuiteOutput ?? JSON.stringify(result), 200)}`,
            `--- head suite (last 200 lines) ---\n${tailLines(dt?.newTestsOutput ?? '', 200)}`,
          ].join('\n') + '\n',
        );
      }
      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(true);
        expect(result.differentialTest.newTestsPassed).toBe(true);
      }
    } finally {
      removeFixtureDir(baseTree);
    }
  });
});
