/**
 * Hermetic tests for check-resource-gate.sh (AISDLC-462).
 *
 * Strategy: the script reads vm_stat and sysctl outputs. We can't mock shell
 * builtins directly, but we can exercise the logic by injecting env vars that
 * control the script's behaviour, and by testing the bash logic extracted into
 * inline node assertions.
 *
 * For full hermetic coverage we test the three exit paths:
 *   1. AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 → exit 0 (override)
 *   2. Simulated vm_stat showing < 4GB available → exit 1 (memory refused)
 *   3. Simulated high load avg >= ncpu → exit 1 (load refused)
 *   4. Healthy memory + load → exit 0 (pass)
 *
 * We use a wrapper script approach: write a minimal wrapper that overrides
 * `vm_stat` and `sysctl` via PATH injection to return controlled outputs,
 * then sources check-resource-gate.sh.
 */

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT = path.resolve(__dirname, 'check-resource-gate.sh');

// ─── Helper: run the script with a fake PATH so vm_stat/sysctl can be mocked ─

function runGate(opts = {}) {
  const {
    fakeVmstatOutput = null, // null = use real vm_stat
    fakeNcpu = null, // null = use real sysctl hw.ncpu
    fakeLoad1min = null, // null = use real sysctl vm.loadavg
    fakePageSize = null, // null = let the script use the real hw.pagesize
    skipOverride = false,
  } = opts;

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'resource-gate-test-'));
  const fakeBinDir = path.join(tmpDir, 'bin');
  mkdirSync(fakeBinDir, { recursive: true });

  try {
    // Write fake vm_stat if requested
    // Strategy: write the output to a data file and have the fake binary cat it.
    // This avoids bash quoting issues with multi-line strings containing dots and spaces.
    if (fakeVmstatOutput !== null) {
      const dataFile = path.join(tmpDir, 'vm_stat_output.txt');
      writeFileSync(dataFile, fakeVmstatOutput, 'utf8');
      const script = `#!/usr/bin/env bash\ncat ${JSON.stringify(dataFile)}\n`;
      const p = path.join(fakeBinDir, 'vm_stat');
      writeFileSync(p, script);
      chmodSync(p, 0o755);
    }

    // Write fake sysctl if requested (handles hw.ncpu, hw.pagesize, and vm.loadavg)
    if (fakeNcpu !== null || fakeLoad1min !== null || fakePageSize !== null) {
      const ncpuVal = fakeNcpu ?? 8;
      const load1 = fakeLoad1min ?? 1.0;
      const loadavgLine = `{ ${load1.toFixed(2)} 0.50 0.25 }`;
      const pageSizeVal = fakePageSize ?? 4096;
      const script =
        [
          '#!/usr/bin/env bash',
          'case "$*" in',
          `  *hw.pagesize*) printf '%s\\n' ${JSON.stringify(String(pageSizeVal))} ;;`,
          `  *hw.ncpu*) printf '%s\\n' ${JSON.stringify(String(ncpuVal))} ;;`,
          `  *vm.loadavg*) printf '%s\\n' ${JSON.stringify(loadavgLine)} ;;`,
          '  *) /usr/sbin/sysctl "$@" ;;',
          'esac',
        ].join('\n') + '\n';
      const p = path.join(fakeBinDir, 'sysctl');
      writeFileSync(p, script);
      chmodSync(p, 0o755);
    }

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    };
    if (skipOverride) {
      env['AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE'] = '1';
    } else {
      delete env['AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE'];
    }

    const result = spawnSync('bash', [SCRIPT], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Memory calculation helpers (matches the bash arithmetic) ─────────────────

const GB = 1073741824;
const THRESHOLD_BYTES = 4 * GB;

function buildVmStatOutput({ freePages, inactivePages, speculativePages, pageSize = 4096 }) {
  return [
    `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
    `Pages free:                           ${freePages}.`,
    `Pages active:                          50000.`,
    `Pages inactive:                       ${inactivePages}.`,
    `Pages speculative:                    ${speculativePages}.`,
    `Pages throttled:                           0.`,
    `Pages wired down:                     100000.`,
  ].join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('check-resource-gate.sh', () => {
  it('exits 0 immediately when skip override is set', () => {
    const r = runGate({ skipOverride: true });
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1/);
  });

  it('exits 1 when available memory < 4GB', () => {
    // Set up ~2GB available (pages: 100000 free + 200000 inactive + 50000 speculative)
    // 350000 * 4096 = ~1.37GB — well below 4GB threshold
    const vmstat = buildVmStatOutput({
      freePages: 100_000,
      inactivePages: 200_000,
      speculativePages: 50_000,
    });
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 8,
      fakeLoad1min: 0.5,
    });
    assert.equal(
      r.exitCode,
      1,
      `expected exit 1 (low memory), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /REFUSED.*memory/i);
  });

  it('exits 1 when 1-min load avg >= ncpu', () => {
    // Set up plenty of memory (> 4GB) but a saturated CPU load
    // 4GB / 4096 = 1048576 pages needed; use 2000000 pages total available
    const vmstat = buildVmStatOutput({
      freePages: 1_000_000,
      inactivePages: 800_000,
      speculativePages: 200_000,
    });
    // 8 CPUs, load avg 9.0 (> 8)
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 8,
      fakeLoad1min: 9.0,
    });
    assert.equal(
      r.exitCode,
      1,
      `expected exit 1 (high load), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /REFUSED.*load/i);
  });

  it('exits 0 when memory >= 4GB and load < ncpu', () => {
    // 2000000 pages * 4096 = ~7.6GB available
    const vmstat = buildVmStatOutput({
      freePages: 1_000_000,
      inactivePages: 800_000,
      speculativePages: 200_000,
    });
    // 8 CPUs, load avg 2.0 (< 8) — should pass
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 8,
      fakeLoad1min: 2.0,
    });
    assert.equal(r.exitCode, 0, `expected exit 0 (pass), got ${r.exitCode}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /PASSED/i);
  });

  it('exits 0 at the memory boundary (exactly 4GB available)', () => {
    // THRESHOLD_BYTES = 4294967296; pages needed = 4294967296 / 4096 = 1048576
    const vmstat = buildVmStatOutput({
      freePages: 500_000,
      inactivePages: 400_000,
      speculativePages: 148_576, // total = 1048576 pages = exactly 4GB
    });
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 4,
      fakeLoad1min: 1.0,
    });
    // At exactly 4GB threshold (avail >= threshold), gate passes
    assert.equal(
      r.exitCode,
      0,
      `expected exit 0 at 4GB boundary, got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
  });

  it('exits 1 at 1 byte below 4GB threshold', () => {
    // 1048575 pages = 4096*1048575 = 4GB - 4096 bytes — just below threshold
    const vmstat = buildVmStatOutput({
      freePages: 500_000,
      inactivePages: 400_000,
      speculativePages: 148_575, // total = 1048575 pages → 4GB - 4096 bytes
    });
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 4,
      fakeLoad1min: 1.0,
    });
    assert.equal(
      r.exitCode,
      1,
      `expected exit 1 just below 4GB, got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
  });

  it('exits 0 when load equals ncpu - 1 (just under threshold)', () => {
    const vmstat = buildVmStatOutput({
      freePages: 1_000_000,
      inactivePages: 800_000,
      speculativePages: 200_000,
    });
    // 4 CPUs, load avg 3.0 (< 4) — should pass
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 4,
      fakeLoad1min: 3.0,
    });
    assert.equal(
      r.exitCode,
      0,
      `expected exit 0 (load < ncpu), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
  });

  it('exits 1 when load equals ncpu exactly (>= triggers refusal)', () => {
    const vmstat = buildVmStatOutput({
      freePages: 1_000_000,
      inactivePages: 800_000,
      speculativePages: 200_000,
    });
    // 4 CPUs, load avg 4.0 (== 4) — should refuse
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 4,
      fakeLoad1min: 4.0,
    });
    assert.equal(
      r.exitCode,
      1,
      `expected exit 1 (load == ncpu), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
  });

  // Finding #3: Apple Silicon (M-series) uses 16384 bytes/page.
  // With hw.pagesize=16384, the same page count that appeared to be 2GB on Intel
  // is actually 8GB on Apple Silicon — the gate must pass correctly.
  it('exits 0 on Apple Silicon (hw.pagesize=16384): 500000 pages = ~8GB > 4GB threshold', () => {
    // 500000 pages × 16384 bytes = 8192 MB ≈ 8 GB — well above 4 GB threshold
    const vmstat = buildVmStatOutput({
      freePages: 200_000,
      inactivePages: 200_000,
      speculativePages: 100_000,
      pageSize: 16384,
    });
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 8,
      fakeLoad1min: 1.0,
      fakePageSize: 16384,
    });
    assert.equal(
      r.exitCode,
      0,
      `expected exit 0 (Apple Silicon: 500000×16384 = 8GB > 4GB threshold), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /PASSED/i);
  });

  it('exits 1 on Apple Silicon (hw.pagesize=16384): 200000 pages ≈ 3.2GB < 4GB threshold', () => {
    // 200000 pages × 16384 bytes = 3276.8 MB ≈ 3.2 GB — below 4 GB threshold
    // This validates the fix correctly handles the refusal case too.
    const vmstat = buildVmStatOutput({
      freePages: 80_000,
      inactivePages: 80_000,
      speculativePages: 40_000,
      pageSize: 16384,
    });
    const r = runGate({
      fakeVmstatOutput: vmstat,
      fakeNcpu: 8,
      fakeLoad1min: 1.0,
      fakePageSize: 16384,
    });
    assert.equal(
      r.exitCode,
      1,
      `expected exit 1 (Apple Silicon: 200000×16384 ≈ 3.2GB < 4GB threshold), got ${r.exitCode}\nstderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /REFUSED.*memory/i);
  });
});
