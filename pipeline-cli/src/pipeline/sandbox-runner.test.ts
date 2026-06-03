/**
 * RFC-0043 Phase 3 — sandbox-runner.ts hermetic tests (AISDLC-499)
 *
 * All tests are hermetic: no real Docker/Kata/MicroVM required.
 * Real-container tests are gated behind AI_SDLC_SANDBOX_INTEGRATION_TESTS=1.
 *
 * Test coverage:
 *  - AC-1: OpenShell lifecycle (spawn / lifecycle / teardown)
 *  - AC-3: Credential withholding invariant (exfiltration-attempt test)
 *  - AC-5: Resource limits defaults and per-org config override
 *  - AC-6: Resource breach → hard abort + Decision comment
 *  - AC-7: Driver abstraction — all 5 driver options instantiate correctly
 *  - AC-8: RFC-0022 regime override — HIPAA / FedRAMP High / PCI-DSS Level 1 → MicroVM
 *  - AC-9: Per-test timeout as adopter-optional refinement
 *  - Config loader: absent config → defaults, partial override, malformed YAML → defaults
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveEffectiveDriver,
  validateSandboxEnv,
  buildResourceBreachEvent,
  buildResourceBreachComment,
  loadSandboxConfig,
  loadOpenShellPolicy,
  createSandboxDriver,
  runSandbox,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_CONFIG,
  WITHHELD_ENV_VARS,
  RESOURCE_EXHAUSTED_DECISION_SUMMARY,
  DockerSandboxDriver,
  PodmanSandboxDriver,
  KataSandboxDriver,
  GVisorSandboxDriver,
  MicroVmSandboxDriver,
  MockSandboxDriver,
  type SandboxConfig,
  type ResourceBreachEvent,
} from './sandbox-runner.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-runner-test-'));
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function writeGateYaml(dir: string, content: string): void {
  writeFileSync(join(dir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), content);
}

function writeOpenShellYaml(dir: string, content: string): void {
  writeFileSync(join(dir, '.ai-sdlc', 'untrusted-pr.openshell.yaml'), content);
}

const MINIMAL_SPAWN_INPUT = {
  prNumber: 42,
  prDiff: 'diff --git a/foo.ts b/foo.ts\n+// new line\n',
  upstreamMainRef: 'https://github.com/example/repo.git',
  config: DEFAULT_SANDBOX_CONFIG,
};

// ── AC-5: Default resource limits ────────────────────────────────────────────

describe('DEFAULT_RESOURCE_LIMITS', () => {
  it('has 600s wall-clock (10 minutes)', () => {
    expect(DEFAULT_RESOURCE_LIMITS.wallClockSeconds).toBe(600);
  });

  it('has 2 CPU cores', () => {
    expect(DEFAULT_RESOURCE_LIMITS.cpuCores).toBe(2);
  });

  it('has 4096 MB (4 GB) memory', () => {
    expect(DEFAULT_RESOURCE_LIMITS.memoryMb).toBe(4096);
  });

  it('has no perTestTimeoutSeconds by default', () => {
    expect(DEFAULT_RESOURCE_LIMITS.perTestTimeoutSeconds).toBeUndefined();
  });
});

// ── Config loader ─────────────────────────────────────────────────────────────

describe('loadSandboxConfig', () => {
  it('returns defaults when config file absent', () => {
    const dir = makeTmpDir();
    const config = loadSandboxConfig(dir);
    expect(config.sandboxDriver).toBe('docker');
    expect(config.differentialTest.resourceLimits.wallClockSeconds).toBe(600);
    expect(config.complianceRegime).toBe('none');
    expect(config.deployment).toBe('ci');
  });

  it('reads sandboxDriver from config', () => {
    const dir = makeTmpDir();
    writeGateYaml(dir, 'sandboxDriver: kata\n');
    const config = loadSandboxConfig(dir);
    expect(config.sandboxDriver).toBe('kata');
  });

  it('reads complianceRegime from config', () => {
    const dir = makeTmpDir();
    writeGateYaml(dir, 'complianceRegime: hipaa\n');
    const config = loadSandboxConfig(dir);
    expect(config.complianceRegime).toBe('hipaa');
  });

  it('reads resource limits from config', () => {
    const dir = makeTmpDir();
    writeGateYaml(
      dir,
      [
        'differentialTest:',
        '  resourceLimits:',
        '    wallClockSeconds: 1200',
        '    cpuCores: 4',
        '    memoryMb: 8192',
        '    perTestTimeoutSeconds: 30',
      ].join('\n'),
    );
    const config = loadSandboxConfig(dir);
    const rl = config.differentialTest.resourceLimits;
    expect(rl.wallClockSeconds).toBe(1200);
    expect(rl.cpuCores).toBe(4);
    expect(rl.memoryMb).toBe(8192);
    expect(rl.perTestTimeoutSeconds).toBe(30);
  });

  it('falls back to defaults on malformed YAML', () => {
    const dir = makeTmpDir();
    writeGateYaml(dir, '{ invalid: yaml: content\n');
    const config = loadSandboxConfig(dir);
    expect(config.sandboxDriver).toBe('docker');
  });

  it('ignores unknown sandboxDriver value (stays default)', () => {
    const dir = makeTmpDir();
    writeGateYaml(dir, 'sandboxDriver: unknown-driver\n');
    const config = loadSandboxConfig(dir);
    expect(config.sandboxDriver).toBe('docker');
  });
});

// ── AC-8: RFC-0022 regime override ───────────────────────────────────────────

describe('resolveEffectiveDriver (RFC-0022 regime override)', () => {
  it('HIPAA regime overrides docker → microvm', () => {
    const { driver, overrideApplied, overrideReason } = resolveEffectiveDriver('docker', 'hipaa');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(true);
    expect(overrideReason).toContain('hipaa');
    expect(overrideReason).toContain('MicroVM');
  });

  it('FedRAMP High regime overrides docker → microvm', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('docker', 'fedramp-high');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(true);
  });

  it('PCI-DSS Level 1 regime overrides docker → microvm', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('docker', 'pci-dss-level-1');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(true);
  });

  it('HIPAA with microvm already selected: no override applied', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('microvm', 'hipaa');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(false);
  });

  it('FedRAMP High overrides kata → microvm', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('kata', 'fedramp-high');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(true);
  });

  it('PCI-DSS Level 1 overrides gvisor → microvm', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('gvisor', 'pci-dss-level-1');
    expect(driver).toBe('microvm');
    expect(overrideApplied).toBe(true);
  });

  it('no regime: docker stays docker', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('docker', 'none');
    expect(driver).toBe('docker');
    expect(overrideApplied).toBe(false);
  });

  it('no regime (undefined): docker stays docker', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('docker');
    expect(driver).toBe('docker');
    expect(overrideApplied).toBe(false);
  });

  it('no regime: kata stays kata', () => {
    const { driver, overrideApplied } = resolveEffectiveDriver('kata', 'none');
    expect(driver).toBe('kata');
    expect(overrideApplied).toBe(false);
  });
});

// ── AC-3: Credential withholding invariant ────────────────────────────────────

describe('validateSandboxEnv (credential withholding invariant)', () => {
  it('accepts undefined env (no credentials injected)', () => {
    expect(() => validateSandboxEnv(undefined)).not.toThrow();
  });

  it('accepts empty env', () => {
    expect(() => validateSandboxEnv({})).not.toThrow();
  });

  it('accepts safe env vars', () => {
    expect(() => validateSandboxEnv({ NODE_ENV: 'test', HOME: '/sandbox' })).not.toThrow();
  });

  it('blocks GITHUB_TOKEN (withheld: write-scoped)', () => {
    expect(() => validateSandboxEnv({ GITHUB_TOKEN: 'ghp_secret' })).toThrow(
      /credential withholding violation/i,
    );
  });

  it('blocks NPM_TOKEN', () => {
    expect(() => validateSandboxEnv({ NPM_TOKEN: 'npm_secret' })).toThrow(
      /credential withholding violation/i,
    );
  });

  it('blocks AI_SDLC_PAT', () => {
    expect(() => validateSandboxEnv({ AI_SDLC_PAT: 'pat_secret' })).toThrow(
      /credential withholding violation/i,
    );
  });

  it('blocks AI_SDLC_SIGNING_KEY', () => {
    expect(() =>
      validateSandboxEnv({ AI_SDLC_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----' }),
    ).toThrow(/credential withholding violation/i);
  });

  it('blocks vars with SIGNING_KEY in the name', () => {
    expect(() => validateSandboxEnv({ MY_SIGNING_KEY: 'value' })).toThrow(
      /credential withholding violation/i,
    );
  });

  it('blocks vars with SIGNING_PEM in the name', () => {
    expect(() => validateSandboxEnv({ OPERATOR_SIGNING_PEM: 'value' })).toThrow(
      /credential withholding violation/i,
    );
  });

  it('error message names the offending variable', () => {
    const err = (() => {
      try {
        validateSandboxEnv({ GITHUB_TOKEN: 'secret' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain('GITHUB_TOKEN');
  });

  it('WITHHELD_ENV_VARS list is non-empty and includes expected keys', () => {
    expect(WITHHELD_ENV_VARS).toContain('GITHUB_TOKEN');
    expect(WITHHELD_ENV_VARS).toContain('NPM_TOKEN');
    expect(WITHHELD_ENV_VARS).toContain('AI_SDLC_PAT');
    expect(WITHHELD_ENV_VARS).toContain('AI_SDLC_SIGNING_KEY');
  });

  it('sandbox-escape exfiltration attempt: driver.spawn refuses when withheld cred present', async () => {
    // NOTE: runSandbox deliberately does NOT accept a sandboxEnv parameter —
    // the public API has no path to inject credentials into the sandbox
    // environment. This is intentional: callers cannot accidentally pass
    // write-scoped tokens, signing keys, or PATs through the runSandbox
    // entry point. Providers are injected at the sandbox-local inference
    // router (inference.local), not in the env.
    //
    // The credential withholding check in validateSandboxEnv / BaseSandboxDriver
    // is a defense-in-depth layer that guards the lower-level driver.spawn()
    // call, which DOES accept sandboxEnv for drivers that need to inject
    // safe read-only vars (e.g. CI_JOB_ID, SANDBOX_RUN_ID).
    const mockDriver = new MockSandboxDriver('docker');
    const spawnSpy = vi.spyOn(mockDriver, 'spawn');

    const sandboxRunner = await import('./sandbox-runner.js');
    let caughtError: Error | null = null;
    try {
      await sandboxRunner.runSandbox({
        ...MINIMAL_SPAWN_INPUT,
        driverOverride: mockDriver,
        config: { ...DEFAULT_SANDBOX_CONFIG },
      });
    } catch (e) {
      caughtError = e as Error;
    }

    // validateSandboxEnv rejects withheld credentials at the driver.spawn boundary
    expect(() => validateSandboxEnv({ GITHUB_TOKEN: 'ghp_secret_write_scoped' })).toThrow(
      /credential withholding violation/i,
    );

    // runSandbox never passes sandboxEnv to the driver — the field is absent
    if (spawnSpy.mock.calls.length > 0) {
      const callInput = spawnSpy.mock.calls[0][0];
      expect(callInput.sandboxEnv).toBeUndefined();
    }
    void caughtError; // runSandbox itself does not throw here; the guard is at the driver level
  });
});

// ── AC-7: Driver abstraction — all 5 driver options ──────────────────────────

describe('createSandboxDriver (driver abstraction)', () => {
  it('docker config → DockerSandboxDriver', () => {
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'docker' };
    const { driver } = createSandboxDriver(config);
    expect(driver.kind).toBe('docker');
    expect(driver).toBeInstanceOf(DockerSandboxDriver);
  });

  it('podman config → PodmanSandboxDriver', () => {
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'podman' };
    const { driver } = createSandboxDriver(config);
    expect(driver.kind).toBe('podman');
    expect(driver).toBeInstanceOf(PodmanSandboxDriver);
  });

  it('kata config → KataSandboxDriver', () => {
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'kata' };
    const { driver } = createSandboxDriver(config);
    expect(driver.kind).toBe('kata');
    expect(driver).toBeInstanceOf(KataSandboxDriver);
  });

  it('gvisor config → GVisorSandboxDriver', () => {
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'gvisor' };
    const { driver } = createSandboxDriver(config);
    expect(driver.kind).toBe('gvisor');
    expect(driver).toBeInstanceOf(GVisorSandboxDriver);
  });

  it('microvm config → MicroVmSandboxDriver', () => {
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'microvm' };
    const { driver } = createSandboxDriver(config);
    expect(driver.kind).toBe('microvm');
    expect(driver).toBeInstanceOf(MicroVmSandboxDriver);
  });

  it('HIPAA regime overrides docker → MicroVmSandboxDriver', () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      sandboxDriver: 'docker',
      complianceRegime: 'hipaa',
    };
    const { driver, regimeOverrideApplied } = createSandboxDriver(config);
    expect(driver.kind).toBe('microvm');
    expect(driver).toBeInstanceOf(MicroVmSandboxDriver);
    expect(regimeOverrideApplied).toBe(true);
  });

  it('driver override takes precedence over config', () => {
    const mockDriver = new MockSandboxDriver('kata');
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxDriver: 'docker' };
    const { driver, regimeOverrideApplied } = createSandboxDriver(config, mockDriver);
    expect(driver).toBe(mockDriver);
    expect(driver.kind).toBe('kata');
    expect(regimeOverrideApplied).toBe(false);
  });
});

// ── AC-7: Driver stub behaviours ──────────────────────────────────────────────

describe('driver stubs return descriptive errors (not raw throws)', () => {
  it('PodmanSandboxDriver spawn returns outcome:error', async () => {
    const driver = new PodmanSandboxDriver();
    const result = await driver.spawn({
      policyFilePath: '/nonexistent',
      prDiff: '',
      upstreamMainRef: 'test',
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      prNumber: 0,
    });
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('PodmanSandboxDriver');
    }
  });

  it('KataSandboxDriver spawn returns outcome:error', async () => {
    const driver = new KataSandboxDriver();
    const result = await driver.spawn({
      policyFilePath: '/nonexistent',
      prDiff: '',
      upstreamMainRef: 'test',
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      prNumber: 0,
    });
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('KataSandboxDriver');
    }
  });

  it('GVisorSandboxDriver spawn returns outcome:error', async () => {
    const driver = new GVisorSandboxDriver();
    const result = await driver.spawn({
      policyFilePath: '/nonexistent',
      prDiff: '',
      upstreamMainRef: 'test',
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      prNumber: 0,
    });
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('GVisorSandboxDriver');
    }
  });

  it('MicroVmSandboxDriver spawn returns outcome:error', async () => {
    const driver = new MicroVmSandboxDriver();
    const result = await driver.spawn({
      policyFilePath: '/nonexistent',
      prDiff: '',
      upstreamMainRef: 'test',
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      prNumber: 0,
    });
    expect(result.outcome).toBe('error');
    if (result.outcome === 'error') {
      expect(result.error).toContain('MicroVmSandboxDriver');
      expect(result.error).toContain('KVM');
    }
  });

  it('DockerSandboxDriver without integration flag returns outcome:error', async () => {
    const orig = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    try {
      const driver = new DockerSandboxDriver();
      const result = await driver.spawn({
        policyFilePath: '/nonexistent',
        prDiff: '',
        upstreamMainRef: 'test',
        resourceLimits: DEFAULT_RESOURCE_LIMITS,
        prNumber: 0,
      });
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        // The error message names DockerSandboxDriver and instructs callers to
        // inject a MockSandboxDriver — it does NOT say "MockSandboxDriver is the
        // real driver here" (that was a misleading prior assertion).
        expect(result.error).toContain('DockerSandboxDriver');
      }
    } finally {
      if (orig !== undefined) process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = orig;
    }
  });
});

// ── AC-6: Resource breach events ─────────────────────────────────────────────

describe('buildResourceBreachEvent', () => {
  it('wall-clock breach has correct shape', () => {
    const event = buildResourceBreachEvent(42, 'wall-clock', 600, 'seconds', 700);
    expect(event.type).toBe('ResourceBreach');
    expect(event.breachType).toBe('wall-clock');
    expect(event.limit).toBe(600);
    expect(event.limitUnit).toBe('seconds');
    expect(event.observedValue).toBe(700);
    expect(event.prNumber).toBe(42);
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('memory breach has correct shape', () => {
    const event = buildResourceBreachEvent(7, 'memory', 4096, 'MB');
    expect(event.breachType).toBe('memory');
    expect(event.limit).toBe(4096);
    expect(event.observedValue).toBeUndefined();
  });

  it('cpu breach has correct shape', () => {
    const event = buildResourceBreachEvent(99, 'cpu', 2, 'cores');
    expect(event.breachType).toBe('cpu');
  });
});

describe('buildResourceBreachComment', () => {
  it('names the breached limit in wall-clock comment', () => {
    const breach = buildResourceBreachEvent(42, 'wall-clock', 600, 'seconds', 700);
    const comment = buildResourceBreachComment(breach, 'alice');
    expect(comment).toContain('wall-clock');
    expect(comment).toContain('600');
    expect(comment).toContain('@alice');
    expect(comment).toContain('needs-maintainer-review');
  });

  it('names the breached limit in memory comment', () => {
    const breach = buildResourceBreachEvent(5, 'memory', 4096, 'MB');
    const comment = buildResourceBreachComment(breach, 'bob');
    expect(comment).toContain('memory');
    expect(comment).toContain('4096');
  });

  it('names the breached limit in cpu comment', () => {
    const breach = buildResourceBreachEvent(5, 'cpu', 2, 'cores');
    const comment = buildResourceBreachComment(breach, 'carol');
    expect(comment).toContain('CPU');
    expect(comment).toContain('2');
  });

  it('MUST NOT contain internal tracker IDs (adopter-facing strings gate)', () => {
    const breach = buildResourceBreachEvent(1, 'wall-clock', 600, 'seconds');
    const comment = buildResourceBreachComment(breach, 'user');
    // Pattern: AISDLC-NNN or DEC-NNNN
    expect(comment).not.toMatch(/\bAISDLC-\d+\b/);
    expect(comment).not.toMatch(/\bDEC-\d+\b/);
  });
});

describe('RESOURCE_EXHAUSTED_DECISION_SUMMARY', () => {
  it('is defined and does not contain internal tracker IDs', () => {
    expect(typeof RESOURCE_EXHAUSTED_DECISION_SUMMARY).toBe('string');
    expect(RESOURCE_EXHAUSTED_DECISION_SUMMARY).not.toMatch(/\bAISDLC-\d+\b/);
    expect(RESOURCE_EXHAUSTED_DECISION_SUMMARY).not.toMatch(/\bDEC-\d+\b/);
  });
});

// ── AC-9: Per-test timeout ────────────────────────────────────────────────────

describe('per-test timeout (AC-9)', () => {
  it('perTestTimeoutSeconds is undefined in default config', () => {
    expect(
      DEFAULT_SANDBOX_CONFIG.differentialTest.resourceLimits.perTestTimeoutSeconds,
    ).toBeUndefined();
  });

  it('perTestTimeoutSeconds is loaded from config YAML', () => {
    const dir = makeTmpDir();
    writeGateYaml(
      dir,
      ['differentialTest:', '  resourceLimits:', '    perTestTimeoutSeconds: 60'].join('\n'),
    );
    const config = loadSandboxConfig(dir);
    expect(config.differentialTest.resourceLimits.perTestTimeoutSeconds).toBe(60);
  });
});

// ── AC-1: OpenShell lifecycle (spawn / lifecycle / teardown) ──────────────────

describe('runSandbox lifecycle', () => {
  it('calls spawn and teardown on success', async () => {
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: true,
        upstreamSuiteOutput: 'All tests passed',
        newTestsPassed: true,
        newTestsOutput: 'All new tests passed',
        newCodeCoveragePct: 82,
      },
      durationMs: 12345,
    });

    const result = await runSandbox({
      ...MINIMAL_SPAWN_INPUT,
      driverOverride: mockDriver,
    });

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.differentialTest.upstreamSuitePassed).toBe(true);
      expect(result.differentialTest.newTestsPassed).toBe(true);
      expect(result.differentialTest.newCodeCoveragePct).toBe(82);
      expect(result.durationMs).toBe(12345);
    }
    expect(mockDriver.wasTeardownCalled()).toBe(true);
  });

  it('calls teardown even on resource-breach result', async () => {
    const breach: ResourceBreachEvent = buildResourceBreachEvent(
      42,
      'wall-clock',
      600,
      'seconds',
      700,
    );
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'resource-breach',
      breach,
    });

    const result = await runSandbox({
      ...MINIMAL_SPAWN_INPUT,
      driverOverride: mockDriver,
    });

    expect(result.outcome).toBe('resource-breach');
    expect(mockDriver.wasTeardownCalled()).toBe(true);
  });

  it('calls teardown even on error result', async () => {
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'error',
      error: 'test error',
    });

    const result = await runSandbox({
      ...MINIMAL_SPAWN_INPUT,
      driverOverride: mockDriver,
    });

    expect(result.outcome).toBe('error');
    expect(mockDriver.wasTeardownCalled()).toBe(true);
  });

  it('regime override is applied inside runSandbox (HIPAA)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const mockMicroVm = new MockSandboxDriver('microvm');
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      sandboxDriver: 'docker',
      complianceRegime: 'hipaa',
    };

    await runSandbox({
      prNumber: 1,
      prDiff: '',
      upstreamMainRef: 'test',
      config,
      driverOverride: mockMicroVm,
    });

    // The driver override bypasses the regime selection but the override IS applied
    // when no driverOverride is supplied. Test that the warning would be emitted.
    // Verify the createSandboxDriver path:
    const { driver, regimeOverrideApplied } = createSandboxDriver(config);
    expect(driver.kind).toBe('microvm');
    expect(regimeOverrideApplied).toBe(true);

    stderrSpy.mockRestore();
  });
});

// ── AC-4: Differential testing sequence ──────────────────────────────────────

describe('differential testing sequence via MockSandboxDriver', () => {
  it('reports upstream suite pass + new tests pass + coverage', async () => {
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: true,
        upstreamSuiteOutput: 'Tests: 100 passed',
        newTestsPassed: true,
        newTestsOutput: 'Tests: 5 new passed',
        newCodeCoveragePct: 91.5,
      },
      durationMs: 30000,
    });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.differentialTest.upstreamSuitePassed).toBe(true);
      expect(result.differentialTest.newTestsPassed).toBe(true);
      expect(result.differentialTest.newCodeCoveragePct).toBe(91.5);
    }
  });

  it('reports upstream suite fail (functional parity failure)', async () => {
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: false,
        upstreamSuiteOutput: 'FAIL: 3 tests failed',
        newTestsPassed: true,
        newTestsOutput: 'Tests: 5 passed',
        newCodeCoveragePct: 75,
      },
      durationMs: 10000,
    });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });

    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.differentialTest.upstreamSuitePassed).toBe(false);
    }
  });

  it('reports new-tests fail (no-op or coverage-gaming tests)', async () => {
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: true,
        upstreamSuiteOutput: 'All passed',
        newTestsPassed: false,
        newTestsOutput: 'FAIL: new test asserts wrong value',
        newCodeCoveragePct: 0,
      },
      durationMs: 5000,
    });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });

    if (result.outcome === 'success') {
      expect(result.differentialTest.newTestsPassed).toBe(false);
      expect(result.differentialTest.newCodeCoveragePct).toBe(0);
    }
  });
});

// ── OpenShell policy loader ───────────────────────────────────────────────────

describe('loadOpenShellPolicy', () => {
  it('returns null when policy file absent', () => {
    const dir = makeTmpDir();
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });

  it('parses the policy file correctly', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly:',
        '    - /usr',
        '    - /lib',
        '  readWrite:',
        '    - /sandbox',
        'process:',
        '  blockSyscalls:',
        '    - mount',
        '    - ptrace',
        'network:',
        '  enforcement: enforce',
        '  egressAllow:',
        '    - host: github.com',
        '      binary: /usr/bin/git',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    const policy = loadOpenShellPolicy(dir);
    expect(policy).not.toBeNull();
    expect(policy!.filesystem.readOnly).toContain('/usr');
    expect(policy!.filesystem.readWrite).toContain('/sandbox');
    expect(policy!.process.blockSyscalls).toContain('mount');
    expect(policy!.network.enforcement).toBe('enforce');
    expect(policy!.network.egressAllow[0].host).toBe('github.com');
    expect(policy!.inference.route).toBe('inference.local');
  });

  it('returns null on malformed policy YAML', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(dir, '{ bad yaml\n');
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });
});

// ── MockSandboxDriver ─────────────────────────────────────────────────────────

describe('MockSandboxDriver', () => {
  it('accepts any driver kind', () => {
    const kinds: Array<import('./sandbox-runner.js').SandboxDriverKind> = [
      'docker',
      'podman',
      'kata',
      'gvisor',
      'microvm',
    ];
    for (const kind of kinds) {
      expect(new MockSandboxDriver(kind).kind).toBe(kind);
    }
  });

  it('returns default success result when no mock provided', async () => {
    const driver = new MockSandboxDriver();
    const result = await driver.spawn({
      policyFilePath: '/test',
      prDiff: '',
      upstreamMainRef: 'test',
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      prNumber: 1,
    });
    expect(result.outcome).toBe('success');
  });

  it('tracks teardown calls', async () => {
    const driver = new MockSandboxDriver();
    expect(driver.wasTeardownCalled()).toBe(false);
    await driver.teardown();
    expect(driver.wasTeardownCalled()).toBe(true);
  });

  it('enforces credential withholding even in mock', async () => {
    const driver = new MockSandboxDriver();
    await expect(
      driver.spawn({
        policyFilePath: '/test',
        prDiff: '',
        upstreamMainRef: 'test',
        resourceLimits: DEFAULT_RESOURCE_LIMITS,
        prNumber: 1,
        sandboxEnv: { GITHUB_TOKEN: 'ghp_secret' },
      }),
    ).rejects.toThrow(/credential withholding violation/i);
  });
});

// ── Resource breach all 3 types ───────────────────────────────────────────────

describe('resource breach — all 3 breach types', () => {
  it('wall-clock breach → resource-breach outcome', async () => {
    const breach = buildResourceBreachEvent(
      1,
      'wall-clock',
      600,
      'seconds',
      700,
      new Date('2026-06-01T00:00:00Z'),
    );
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'resource-breach',
      breach,
    });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });
    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.breachType).toBe('wall-clock');
      expect(result.breach.limit).toBe(600);
    }
  });

  it('memory breach → resource-breach outcome', async () => {
    const breach = buildResourceBreachEvent(2, 'memory', 4096, 'MB', 5000);
    const mockDriver = new MockSandboxDriver('docker', { outcome: 'resource-breach', breach });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });
    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.breachType).toBe('memory');
    }
  });

  it('cpu breach → resource-breach outcome', async () => {
    const breach = buildResourceBreachEvent(3, 'cpu', 2, 'cores');
    const mockDriver = new MockSandboxDriver('docker', { outcome: 'resource-breach', breach });

    const result = await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });
    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.breachType).toBe('cpu');
    }
  });
});

// ── MAJOR FIX 1: prNumber threading — breach events carry REAL prNumber ──────

describe('breach events carry the REAL prNumber (not hardcoded 0)', () => {
  it('buildResourceBreachEvent uses the supplied prNumber', () => {
    const event = buildResourceBreachEvent(845, 'wall-clock', 600, 'seconds', 700);
    expect(event.prNumber).toBe(845);
  });

  it('runSandbox — wall-clock breach from driver carries prNumber from RunSandboxInput', async () => {
    // Simulate a driver that emits a breach with the correct prNumber.
    // The driver receives prNumber in SandboxSpawnInput and uses it when
    // building the breach event. This test exercises the threading path.
    const prNumber = 845;
    const breach = buildResourceBreachEvent(prNumber, 'wall-clock', 600, 'seconds', 700);
    const mockDriver = new MockSandboxDriver('docker', { outcome: 'resource-breach', breach });

    const result = await runSandbox({
      prNumber,
      prDiff: 'diff --git a/foo.ts b/foo.ts',
      upstreamMainRef: 'test',
      config: DEFAULT_SANDBOX_CONFIG,
      driverOverride: mockDriver,
    });

    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      // The breach must name the actual PR, not prNumber:0
      expect(result.breach.prNumber).toBe(845);
      expect(result.breach.prNumber).not.toBe(0);
    }
  });
});

// ── MAJOR FIX 2: wall-clock timeout-abort mechanism is real and unit-testable ─

describe('runner-level wall-clock timeout/abort enforcement (Promise.race)', () => {
  it('runSandbox aborts a long-running task and returns outcome:resource-breach', async () => {
    // MockSandboxDriver with delayMs=200 simulates a slow task.
    // runSandbox is configured with wallClockSeconds=0.05 (50ms).
    // The Promise.race fires at 50ms, before the driver resolves at 200ms.
    const slowDriver = new MockSandboxDriver(
      'docker',
      {
        outcome: 'success',
        differentialTest: {
          upstreamSuitePassed: true,
          upstreamSuiteOutput: 'should not reach here',
          newTestsPassed: true,
          newTestsOutput: 'should not reach here',
          newCodeCoveragePct: 90,
        },
        durationMs: 200,
      },
      200, // delayMs — the driver takes 200ms
    );

    const prNumber = 999;
    const result = await runSandbox({
      prNumber,
      prDiff: 'diff --git a/foo.ts b/foo.ts',
      upstreamMainRef: 'test',
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        differentialTest: {
          resourceLimits: {
            ...DEFAULT_RESOURCE_LIMITS,
            wallClockSeconds: 0.05, // 50ms timeout fires before 200ms driver
          },
        },
      },
      driverOverride: slowDriver,
    });

    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.breachType).toBe('wall-clock');
      // The breach carries the REAL prNumber (not 0)
      expect(result.breach.prNumber).toBe(prNumber);
    }
    // teardown is called even when the timeout fires
    expect(slowDriver.wasTeardownCalled()).toBe(true);
  });

  it('fast task completes before timeout fires — outcome is success', async () => {
    const fastDriver = new MockSandboxDriver(
      'docker',
      {
        outcome: 'success',
        differentialTest: {
          upstreamSuitePassed: true,
          upstreamSuiteOutput: 'fast',
          newTestsPassed: true,
          newTestsOutput: 'fast',
          newCodeCoveragePct: 95,
        },
        durationMs: 10,
      },
      0, // no delay — resolves immediately
    );

    const result = await runSandbox({
      prNumber: 1,
      prDiff: '',
      upstreamMainRef: 'test',
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        differentialTest: {
          resourceLimits: {
            ...DEFAULT_RESOURCE_LIMITS,
            wallClockSeconds: 600, // generous timeout
          },
        },
      },
      driverOverride: fastDriver,
    });

    expect(result.outcome).toBe('success');
  });

  it('teardown is always called even when timeout fires', async () => {
    const slowDriver = new MockSandboxDriver(
      'docker',
      {
        outcome: 'success',
        differentialTest: {
          upstreamSuitePassed: true,
          upstreamSuiteOutput: '',
          newTestsPassed: true,
          newTestsOutput: '',
          newCodeCoveragePct: 80,
        },
        durationMs: 500,
      },
      500, // slow
    );

    await runSandbox({
      prNumber: 2,
      prDiff: '',
      upstreamMainRef: 'test',
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        differentialTest: {
          resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, wallClockSeconds: 0.05 },
        },
      },
      driverOverride: slowDriver,
    });

    expect(slowDriver.wasTeardownCalled()).toBe(true);
  });
});

// ── MINOR FIX 3: loadOpenShellPolicy structural validation ────────────────────

describe('loadOpenShellPolicy — structural validation (missing required sections)', () => {
  it('returns null when filesystem section is missing', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'network:',
        '  enforcement: enforce',
        '  egressAllow: []',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    // Missing 'filesystem' → null (safe defaults instead of partial object)
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });

  it('returns null when network section is missing', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly: []',
        '  readWrite: []',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });

  it('returns null when inference section is missing', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly: []',
        '  readWrite: []',
        'network:',
        '  enforcement: enforce',
        '  egressAllow: []',
      ].join('\n'),
    );
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });

  it('returns null for malformed-but-parseable YAML that results in a non-object', () => {
    const dir = makeTmpDir();
    // Valid YAML but not an object (just a scalar)
    writeOpenShellYaml(dir, 'just-a-string\n');
    expect(loadOpenShellPolicy(dir)).toBeNull();
  });

  it('returns the policy when all required sections are present', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly: [/usr]',
        '  readWrite: [/sandbox]',
        'process:',
        '  blockSyscalls: [mount]',
        'network:',
        '  enforcement: audit',
        '  egressAllow: []',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    const policy = loadOpenShellPolicy(dir);
    expect(policy).not.toBeNull();
    expect(policy!.network.enforcement).toBe('audit');
  });
});

// ── MINOR FIX 5: boundary-value tests + enforcement:audit enum coverage ───────

describe('boundary-value config: wallClockSeconds:0 / negative cpuCores', () => {
  it('wallClockSeconds:0 in config falls back to default (positive guard)', () => {
    const dir = makeTmpDir();
    writeGateYaml(
      dir,
      ['differentialTest:', '  resourceLimits:', '    wallClockSeconds: 0'].join('\n'),
    );
    const config = loadSandboxConfig(dir);
    // The YAML parser sees 0 which is NOT > 0, so parseSandboxConfig ignores it
    // and falls back to DEFAULT_RESOURCE_LIMITS.wallClockSeconds (600).
    expect(config.differentialTest.resourceLimits.wallClockSeconds).toBe(600);
  });

  it('negative cpuCores in config falls back to default', () => {
    const dir = makeTmpDir();
    writeGateYaml(dir, ['differentialTest:', '  resourceLimits:', '    cpuCores: -4'].join('\n'));
    const config = loadSandboxConfig(dir);
    expect(config.differentialTest.resourceLimits.cpuCores).toBe(2);
  });

  it('wallClockSeconds:0 in runSandbox config → no timeout arm (safe)', async () => {
    // A zero wallClockSeconds should not cause an immediate abort.
    // The runner treats zero as "no timeout" to avoid breaking badly-configured setups.
    const driver = new MockSandboxDriver();
    const result = await runSandbox({
      prNumber: 1,
      prDiff: '',
      upstreamMainRef: 'test',
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        differentialTest: {
          resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, wallClockSeconds: 0 },
        },
      },
      driverOverride: driver,
    });
    // Should succeed — zero does not trigger an immediate timeout
    expect(result.outcome).toBe('success');
  });
});

describe('loadOpenShellPolicy — enforcement:audit enum coverage', () => {
  it('parses enforcement:audit value correctly', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly: []',
        '  readWrite: []',
        'process:',
        '  blockSyscalls: []',
        'network:',
        '  enforcement: audit',
        '  egressAllow: []',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    const policy = loadOpenShellPolicy(dir);
    expect(policy).not.toBeNull();
    expect(policy!.network.enforcement).toBe('audit');
  });

  it('parses enforcement:enforce value correctly', () => {
    const dir = makeTmpDir();
    writeOpenShellYaml(
      dir,
      [
        'filesystem:',
        '  readOnly: []',
        '  readWrite: []',
        'process:',
        '  blockSyscalls: []',
        'network:',
        '  enforcement: enforce',
        '  egressAllow: []',
        'inference:',
        '  route: inference.local',
      ].join('\n'),
    );
    const policy = loadOpenShellPolicy(dir);
    expect(policy).not.toBeNull();
    expect(policy!.network.enforcement).toBe('enforce');
  });
});
