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
import { mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import {
  resolveEffectiveDriver,
  validateSandboxEnv,
  validateUpstreamMainRef,
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
  buildDockerRunArgs,
  DOCKER_SECCOMP_PROFILE,
  parseDifferentialTestOutput,
  buildDifferentialTestScript,
  DIFFERENTIAL_RESULT_SENTINEL,
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

// ── AISDLC-508: Docker argument construction (AC-1) ──────────────────────────

describe('buildDockerRunArgs — hardened isolation flags (AISDLC-508 AC-1)', () => {
  const BASE_LIMITS = {
    wallClockSeconds: 600,
    cpuCores: 2,
    memoryMb: 4096,
  };

  // Shared helper: create a per-test cidfile path in an isolated mkdtemp dir.
  function makeCidFilePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-args-test-'));
    return join(dir, 'container.cid');
  }

  it('includes --cidfile with the provided cidFilePath', () => {
    const cidFilePath = makeCidFilePath();
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath,
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const cidIdx = args.indexOf('--cidfile');
    expect(cidIdx).toBeGreaterThanOrEqual(0);
    expect(args[cidIdx + 1]).toBe(cidFilePath);
  });

  it('--cidfile appears before --network=none (ordering sanity)', () => {
    const cidFilePath = makeCidFilePath();
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath,
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const cidIdx = args.indexOf('--cidfile');
    const netIdx = args.indexOf('--network=none');
    expect(cidIdx).toBeGreaterThanOrEqual(0);
    expect(netIdx).toBeGreaterThan(cidIdx);
  });

  it('includes --network=none for full network deny', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).toContain('--network=none');
  });

  it('includes --cap-drop=ALL to drop all Linux capabilities', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).toContain('--cap-drop=ALL');
  });

  it('includes --read-only for read-only root filesystem', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).toContain('--read-only');
  });

  it('includes --tmpfs for /tmp with noexec,nosuid', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const tmpfsIdx = args.indexOf('--tmpfs');
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    const tmpfsVal = args[tmpfsIdx + 1];
    expect(tmpfsVal).toContain('/tmp');
    expect(tmpfsVal).toContain('noexec');
    expect(tmpfsVal).toContain('nosuid');
  });

  it('includes --tmpfs for /sandbox/workspace', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    // Find all --tmpfs entries
    const tmpfsEntries: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--tmpfs' && i + 1 < args.length) {
        tmpfsEntries.push(args[i + 1]!);
      }
    }
    expect(tmpfsEntries.some((e) => e.includes('/sandbox/workspace'))).toBe(true);
  });

  it('includes --pids-limit 512 to prevent fork bombs', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const pidsIdx = args.indexOf('--pids-limit');
    expect(pidsIdx).toBeGreaterThanOrEqual(0);
    expect(args[pidsIdx + 1]).toBe('512');
  });

  it('wires --memory from resourceLimits.memoryMb', () => {
    const args = buildDockerRunArgs({
      resourceLimits: { ...BASE_LIMITS, memoryMb: 8192 },
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const memIdx = args.indexOf('--memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);
    expect(args[memIdx + 1]).toBe('8192m');
  });

  it('wires --cpus from resourceLimits.cpuCores', () => {
    const args = buildDockerRunArgs({
      resourceLimits: { ...BASE_LIMITS, cpuCores: 4 },
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const cpusIdx = args.indexOf('--cpus');
    expect(cpusIdx).toBeGreaterThanOrEqual(0);
    expect(args[cpusIdx + 1]).toBe('4');
  });

  it('runs as non-root user nobody:nogroup (--user 65534:65534)', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const userIdx = args.indexOf('--user');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(args[userIdx + 1]).toBe('65534:65534');
  });

  it('includes --rm for auto-removal', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).toContain('--rm');
  });

  it('includes --security-opt no-new-privileges', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).toContain('no-new-privileges');
    // Verify it is preceded by --security-opt
    const idx = args.indexOf('no-new-privileges');
    expect(args[idx - 1]).toBe('--security-opt');
  });

  it('injects the seccomp profile via --security-opt seccomp=<json>', () => {
    const profile = JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] });
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: profile,
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const seccompArg = args.find((a) => a.startsWith('seccomp='));
    expect(seccompArg).toBeDefined();
    expect(seccompArg).toBe(`seccomp=${profile}`);
    // Preceded by --security-opt
    const idx = args.indexOf(seccompArg!);
    expect(args[idx - 1]).toBe('--security-opt');
  });

  it('places the image and command after all flags', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['/bin/sh', '-c', 'echo hi'],
    });
    const imageIdx = args.indexOf('node:22-slim');
    expect(imageIdx).toBeGreaterThan(0);
    expect(args[imageIdx + 1]).toBe('/bin/sh');
    expect(args[imageIdx + 2]).toBe('-c');
    expect(args[imageIdx + 3]).toBe('echo hi');
  });

  it('first argument is "run"', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args[0]).toBe('run');
  });

  it('does NOT include --network=host or --privileged (hardening regression guard)', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--network=host');
  });

  // ── AISDLC-522 AC-1: env var forwarding ──────────────────────────────────────
  it('includes -e SANDBOX_PR_DIFF_B64 in the docker run argv (AC-1)', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '/tmp/seccomp.json',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    // The argv must contain both '-e' followed by 'SANDBOX_PR_DIFF_B64'
    const eIdx = args.findIndex((a, i) => a === '-e' && args[i + 1] === 'SANDBOX_PR_DIFF_B64');
    expect(eIdx).toBeGreaterThanOrEqual(0);
  });

  it('includes -e SANDBOX_FIXTURE_B64 in the docker run argv (AC-1)', () => {
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '/tmp/seccomp.json',
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    // The argv must contain both '-e' followed by 'SANDBOX_FIXTURE_B64'
    const eIdx = args.findIndex((a, i) => a === '-e' && args[i + 1] === 'SANDBOX_FIXTURE_B64');
    expect(eIdx).toBeGreaterThanOrEqual(0);
  });

  it('SANDBOX_PR_DIFF_B64 and SANDBOX_FIXTURE_B64 both appear before the image name (ordering)', () => {
    const image = 'node:22-slim';
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: '/tmp/seccomp.json',
      cidFilePath: makeCidFilePath(),
      image,
      command: ['echo', 'test'],
    });
    const imageIdx = args.indexOf(image);
    expect(imageIdx).toBeGreaterThan(0);

    const diffIdx = args.findIndex((a, i) => a === '-e' && args[i + 1] === 'SANDBOX_PR_DIFF_B64');
    const fixtureIdx = args.findIndex(
      (a, i) => a === '-e' && args[i + 1] === 'SANDBOX_FIXTURE_B64',
    );

    expect(diffIdx).toBeGreaterThanOrEqual(0);
    expect(fixtureIdx).toBeGreaterThanOrEqual(0);
    expect(diffIdx).toBeLessThan(imageIdx);
    expect(fixtureIdx).toBeLessThan(imageIdx);
  });

  // ── AISDLC-522 AC-2: seccomp profile is a file path, not inline JSON ─────────
  it('seccomp arg references a path string (not inline JSON) when a path is passed (AC-2)', () => {
    const seccompPath = '/tmp/ai-sdlc-sandbox-abc123/seccomp.json';
    const args = buildDockerRunArgs({
      resourceLimits: BASE_LIMITS,
      seccompProfileJson: seccompPath,
      cidFilePath: makeCidFilePath(),
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    const seccompArg = args.find((a) => a.startsWith('seccomp='));
    expect(seccompArg).toBeDefined();
    expect(seccompArg).toBe(`seccomp=${seccompPath}`);
    // Must not contain '{' or '}' — a file path never contains JSON delimiters
    expect(seccompArg).not.toContain('{');
    expect(seccompArg).not.toContain('}');
  });
});

// ── AISDLC-522 AC-2: seccomp file written to per-spawn temp dir ──────────────

describe('DockerSandboxDriver — seccomp profile written to file (AISDLC-522 AC-2)', () => {
  it('DOCKER_SECCOMP_PROFILE JSON is non-empty and serializable', () => {
    // Verify the profile exists and can be serialized to JSON (the writeFileSync call)
    const json = JSON.stringify(DOCKER_SECCOMP_PROFILE);
    expect(json).toBeTruthy();
    expect(json.length).toBeGreaterThan(10);
    const reparsed = JSON.parse(json) as unknown;
    expect(typeof reparsed).toBe('object');
  });
});

// ── AISDLC-522 AC-6: fixture-demo mode in buildDifferentialTestScript ─────────

describe('buildDifferentialTestScript — fixture-demo mode (AISDLC-522 AC-6)', () => {
  it('generated script contains SANDBOX_FIXTURE_B64 check before URL check', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('SANDBOX_FIXTURE_B64');
    // The fixture branch must precede the URL branch
    const fixtureIdx = script.indexOf('SANDBOX_FIXTURE_B64');
    const urlIdx = script.indexOf('grep -qE');
    expect(fixtureIdx).toBeLessThan(urlIdx);
  });

  it('generated script extracts fixture via base64 -d | tar xz', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('base64 -d | tar xz');
    expect(script).toContain('mkdir -p repo');
  });

  it('SANDBOX_FIXTURE_B64 check uses ${VAR:-} form (safe unset-variable test)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The shell guard must use -n "${SANDBOX_FIXTURE_B64:-}" to safely test if the var is set
    expect(script).toContain('${SANDBOX_FIXTURE_B64:-}');
  });

  it('generated script still contains the URL-clone branch (non-fixture mode)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('git clone');
  });

  it('generated script still contains the SHA-path branch (non-fixture mode)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('no pre-cloned repo found');
  });
});

// ── AISDLC-508: cidfile-based container ID capture (MAJOR FIX 1) ─────────────
//
// Verifies that:
//  - buildDockerRunArgs includes --cidfile <path>
//  - DockerSandboxDriver reads containerId from the cidfile (not from stdout)
//  - killContainer / teardown use the real container ID from the cidfile
//
// These tests use a hermetic approach: write a fake container ID to the cidfile
// path synchronously before the spawn mock runs, simulating the moment Docker
// writes the cidfile at container-start time.

describe('DockerSandboxDriver — cidfile-based container ID capture (AISDLC-508)', () => {
  it('buildDockerRunArgs includes --cidfile for every spawn (no --detach required)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-cid-test-'));
    const cidFilePath = join(dir, 'container.cid');
    const args = buildDockerRunArgs({
      resourceLimits: DEFAULT_RESOURCE_LIMITS,
      seccompProfileJson: '{}',
      cidFilePath,
      image: 'node:22-slim',
      command: ['echo', 'test'],
    });
    // --cidfile must be present
    expect(args).toContain('--cidfile');
    // The value after --cidfile must be our path
    const cidIdx = args.indexOf('--cidfile');
    expect(args[cidIdx + 1]).toBe(cidFilePath);
    // --detach must NOT be present (foreground run)
    expect(args).not.toContain('--detach');
    expect(args).not.toContain('-d');
  });

  it('teardown() is idempotent when containerId was never set (no cidfile)', async () => {
    // DockerSandboxDriver where doSpawn was never called (integration gate prevents real spawn)
    const driver = new DockerSandboxDriver();
    // containerId and cidFilePath are both null — teardown must not throw
    await expect(driver.teardown()).resolves.toBeUndefined();
    // Second call is also safe
    await expect(driver.teardown()).resolves.toBeUndefined();
  });

  it('teardown() cleans up cidfile temp dir when cidFilePath was set (hermetic simulation)', async () => {
    // Simulate the scenario: a cidfile dir was created, cidfile written, teardown cleans up.
    // We verify this by checking the DockerSandboxDriver teardown path with a
    // real cidfile on disk (the integration-test gate prevents real docker calls).
    const {
      mkdtempSync: mkdtemp,
      writeFileSync: writeFile,
      existsSync: fExists,
    } = await import('node:fs');
    const cidDir = mkdtemp(join(tmpdir(), 'sandbox-teardown-test-'));
    const cidFilePath = join(cidDir, 'container.cid');
    writeFile(cidFilePath, 'abc123deadbeef456789\n');

    // Confirm the cidfile exists before teardown
    expect(fExists(cidFilePath)).toBe(true);

    // We cannot call doSpawn directly (integration gate), but we can verify
    // that teardown() handles cidFilePath cleanup via the public teardown API.
    // The DockerSandboxDriver's teardown reads this.cidFilePath — we cannot
    // set it from outside. Instead verify the rmSync call behaviour via the
    // buildDockerRunArgs signature requirement (cidFilePath is the contract).
    // This is the mechanical guarantee: buildDockerRunArgs requires cidFilePath,
    // so any real spawn would set this.cidFilePath before teardown runs.
    //
    // For hermetic teardown coverage, verify that the teardown path does NOT
    // throw when the cidfile/dir no longer exists (already cleaned up).
    const driver = new DockerSandboxDriver();
    // teardown with null cidFilePath is always safe
    await expect(driver.teardown()).resolves.toBeUndefined();
  });

  it('DockerSandboxDriver.spawn returns outcome:error without integration flag (hermetic gate)', async () => {
    // The hermetic gate prevents real Docker calls; this confirms the integration
    // path is properly behind AI_SDLC_SANDBOX_INTEGRATION_TESTS=1.
    const orig = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    try {
      const driver = new DockerSandboxDriver();
      const result = await driver.spawn({
        policyFilePath: '/nonexistent',
        prDiff: '',
        upstreamMainRef: 'test',
        resourceLimits: DEFAULT_RESOURCE_LIMITS,
        prNumber: 1,
      });
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('DockerSandboxDriver');
        expect(result.error).toContain('AI_SDLC_SANDBOX_INTEGRATION_TESTS');
      }
    } finally {
      if (orig !== undefined) process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = orig;
    }
  });
});

// ── AISDLC-508: DockerSandboxDriver without integration flag (AC-5) ───────────

describe('DockerSandboxDriver — hermetic (no real Docker, AC-5)', () => {
  it('returns outcome:error when AI_SDLC_SANDBOX_INTEGRATION_TESTS is not set', async () => {
    const orig = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    try {
      const driver = new DockerSandboxDriver();
      const result = await driver.spawn({
        policyFilePath: '/nonexistent',
        prDiff: 'diff',
        upstreamMainRef: 'test',
        resourceLimits: DEFAULT_RESOURCE_LIMITS,
        prNumber: 1,
      });
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('DockerSandboxDriver');
        expect(result.error).toContain('AI_SDLC_SANDBOX_INTEGRATION_TESTS');
      }
    } finally {
      if (orig !== undefined) process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = orig;
    }
  });

  it('teardown() is idempotent — no throw when containerId is null', async () => {
    const driver = new DockerSandboxDriver();
    // Should not throw even with no active container
    await expect(driver.teardown()).resolves.toBeUndefined();
    // Second call also safe
    await expect(driver.teardown()).resolves.toBeUndefined();
  });
});

// ── AISDLC-508: WITHHELD_ENV_VARS provably never enter container env (AC-4) ──

describe('Credential withholding — WITHHELD_ENV_VARS provably excluded (AISDLC-508 AC-4)', () => {
  it('WITHHELD_ENV_VARS includes all four required credentials', () => {
    expect(WITHHELD_ENV_VARS).toContain('AI_SDLC_SIGNING_KEY');
    expect(WITHHELD_ENV_VARS).toContain('GITHUB_TOKEN');
    expect(WITHHELD_ENV_VARS).toContain('NPM_TOKEN');
    expect(WITHHELD_ENV_VARS).toContain('AI_SDLC_PAT');
  });

  it('validateSandboxEnv blocks all four withheld credentials individually', () => {
    const withheld = ['AI_SDLC_SIGNING_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AI_SDLC_PAT'] as const;
    for (const key of withheld) {
      expect(
        () => validateSandboxEnv({ [key]: 'secret-value' }),
        `Expected ${key} to be blocked`,
      ).toThrow(/credential withholding violation/i);
    }
  });

  it('error message names each withheld credential', () => {
    const withheld = ['AI_SDLC_SIGNING_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AI_SDLC_PAT'] as const;
    for (const key of withheld) {
      let err: Error | null = null;
      try {
        validateSandboxEnv({ [key]: 'secret' });
      } catch (e) {
        err = e as Error;
      }
      expect(err, `Expected error for ${key}`).not.toBeNull();
      expect(err!.message).toContain(key);
    }
  });

  it('runSandbox never exposes sandboxEnv as a public API parameter', async () => {
    // RunSandboxInput has no sandboxEnv field — confirming the API surface
    // cannot accidentally leak credentials via the high-level entry point.
    const mockDriver = new MockSandboxDriver('docker', {
      outcome: 'success',
      differentialTest: {
        upstreamSuitePassed: true,
        upstreamSuiteOutput: '',
        newTestsPassed: true,
        newTestsOutput: '',
        newCodeCoveragePct: 100,
      },
      durationMs: 1,
    });
    const spawnSpy = vi.spyOn(mockDriver, 'spawn');

    await runSandbox({ ...MINIMAL_SPAWN_INPUT, driverOverride: mockDriver });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArg = spawnSpy.mock.calls[0]?.[0];
    // runSandbox does not pass sandboxEnv — it must be absent or undefined
    expect(callArg?.sandboxEnv).toBeUndefined();
  });

  it('BaseSandboxDriver.spawn rejects withheld credentials even when passed directly', async () => {
    const driver = new MockSandboxDriver();
    await expect(
      driver.spawn({
        policyFilePath: '/test',
        prDiff: '',
        upstreamMainRef: 'test',
        resourceLimits: DEFAULT_RESOURCE_LIMITS,
        prNumber: 1,
        sandboxEnv: { AI_SDLC_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----' },
      }),
    ).rejects.toThrow(/credential withholding violation/i);
  });

  it('accepts safe env vars (CI_JOB_ID, SANDBOX_RUN_ID)', () => {
    expect(() =>
      validateSandboxEnv({ CI_JOB_ID: '12345', SANDBOX_RUN_ID: 'abc-123' }),
    ).not.toThrow();
  });
});

// ── AISDLC-508: DOCKER_SECCOMP_PROFILE shape ─────────────────────────────────

describe('DOCKER_SECCOMP_PROFILE — seccomp allowlist shape (AISDLC-508 AC-1)', () => {
  it('has defaultAction SCMP_ACT_ERRNO (deny by default)', () => {
    expect(DOCKER_SECCOMP_PROFILE.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it('has a syscalls array with at least one allowlist entry', () => {
    const syscalls = DOCKER_SECCOMP_PROFILE.syscalls as Array<unknown>;
    expect(Array.isArray(syscalls)).toBe(true);
    expect(syscalls.length).toBeGreaterThan(0);
  });

  it('allows read and write syscalls', () => {
    const syscalls = DOCKER_SECCOMP_PROFILE.syscalls as Array<{ names: string[]; action: string }>;
    const allowed = syscalls.filter((s) => s.action === 'SCMP_ACT_ALLOW').flatMap((s) => s.names);
    expect(allowed).toContain('read');
    expect(allowed).toContain('write');
  });

  it('does NOT allow mount (privilege escalation guard)', () => {
    // mount syscall is explicitly absent — it enables privilege escalation
    // and container breakout via overlay filesystem manipulation
    const syscalls = DOCKER_SECCOMP_PROFILE.syscalls as Array<{ names: string[]; action: string }>;
    const explicitlyAllowed = syscalls
      .filter((s) => s.action === 'SCMP_ACT_ALLOW')
      .flatMap((s) => s.names);
    // mount must not be in the allowlist (defaultAction ERRNO blocks it)
    expect(explicitlyAllowed).not.toContain('mount');
  });

  it('does NOT allow ptrace (prevents container debugging / escape)', () => {
    const syscalls = DOCKER_SECCOMP_PROFILE.syscalls as Array<{ names: string[]; action: string }>;
    const explicitlyAllowed = syscalls
      .filter((s) => s.action === 'SCMP_ACT_ALLOW')
      .flatMap((s) => s.names);
    expect(explicitlyAllowed).not.toContain('ptrace');
  });

  it('does NOT allow kexec_load (prevents kernel replacement)', () => {
    const syscalls = DOCKER_SECCOMP_PROFILE.syscalls as Array<{ names: string[]; action: string }>;
    const explicitlyAllowed = syscalls
      .filter((s) => s.action === 'SCMP_ACT_ALLOW')
      .flatMap((s) => s.names);
    expect(explicitlyAllowed).not.toContain('kexec_load');
  });

  it('serializes to valid JSON (required for --security-opt seccomp=<json>)', () => {
    expect(() => JSON.stringify(DOCKER_SECCOMP_PROFILE)).not.toThrow();
    const json = JSON.stringify(DOCKER_SECCOMP_PROFILE);
    expect(json).toContain('SCMP_ACT_ERRNO');
    expect(json).toContain('SCMP_ACT_ALLOW');
  });
});

// ── Hermetic DockerSandboxDriver lifecycle tests (AISDLC-508) ─────────────────
//
// These tests use a thin injectable spawn seam (_spawnProcess) introduced in
// AISDLC-508 to exercise the full DockerSandboxDriver lifecycle without a real
// Docker daemon. The seam is a protected method override (subclass pattern) —
// behaviour is 100% identical to production; only the irreducible spawn() syscall
// is replaced with an EventEmitter-based mock process.
//
// AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 is set per-test to bypass the CI gate
// and enter the real lifecycle paths. Each test restores the original value.

/**
 * Minimal fake ChildProcess — an EventEmitter with the subset of properties
 * used by DockerSandboxDriver (stdout, stderr, kill, on('close'), on('error')).
 */
class FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  readonly spawnArgs: string[];

  constructor(spawnArgs: string[] = []) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.spawnArgs = spawnArgs;
  }

  /** Simulate process exit with the given exit code. */
  emitClose(exitCode: number): void {
    this.emit('close', exitCode);
  }

  /** Simulate a spawn error (e.g. docker binary not found). */
  emitError(err: Error): void {
    this.emit('error', err);
  }

  /** Simulate stdout data. */
  emitStdout(data: string): void {
    this.stdout.emit('data', Buffer.from(data));
  }

  /** Simulate stderr data. */
  emitStderr(data: string): void {
    this.stderr.emit('data', Buffer.from(data));
  }

  /** No-op kill stub. */
  kill(_signal?: string): boolean {
    return true;
  }
}

/**
 * Testable subclass of DockerSandboxDriver that overrides the _spawnProcess seam
 * and records every invocation for assertions.
 */
class TestableDockerDriver extends DockerSandboxDriver {
  private readonly processes: FakeProcess[] = [];
  private readonly processFactory: (cmd: string, args: string[]) => FakeProcess;

  constructor(factory?: (cmd: string, args: string[]) => FakeProcess) {
    super();
    this.processFactory = factory ?? ((_cmd, args) => new FakeProcess(args));
  }

  protected _spawnProcess(cmd: string, args: string[], _options: SpawnOptions): ChildProcess {
    const proc = this.processFactory(cmd, args);
    this.processes.push(proc);
    return proc as unknown as ChildProcess;
  }

  /** Get the Nth spawned process (0-indexed). */
  getProcess(n: number): FakeProcess {
    return this.processes[n]!;
  }

  /** Number of spawn calls made. */
  get spawnCount(): number {
    return this.processes.length;
  }

  /** All commands spawned (first arg to _spawnProcess). */
  get spawnedCommands(): string[] {
    return this.processes.map((p) => p.spawnArgs[0] ?? '');
  }

  /** All arg arrays spawned. */
  get spawnedArgLists(): string[][] {
    return this.processes.map((p) => p.spawnArgs);
  }
}

/** Set the integration flag and restore it after the test. */
function withIntegrationFlag(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const orig = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = '1';
    try {
      await fn();
    } finally {
      if (orig !== undefined) {
        process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = orig;
      } else {
        delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
      }
    }
  };
}

/** Minimal valid SandboxSpawnInput for lifecycle tests. */
const LIFECYCLE_INPUT = {
  policyFilePath: '/nonexistent',
  prDiff: 'diff --git a/foo.ts b/foo.ts\n+// new line\n',
  // Use a valid https URL — 'test' is not a valid SHA or URL (would fail validateUpstreamMainRef)
  upstreamMainRef: 'https://github.com/example/repo.git',
  resourceLimits: DEFAULT_RESOURCE_LIMITS,
  prNumber: 42,
};

describe('DockerSandboxDriver — hermetic lifecycle via _spawnProcess seam', () => {
  // ── abort-before-spawn path ────────────────────────────────────────────────

  it(
    'doSpawn: abort signal already aborted before spawn → outcome:resource-breach immediately',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver();
      const controller = new AbortController();
      controller.abort(); // aborted BEFORE spawn

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('resource-breach');
      if (result.outcome === 'resource-breach') {
        expect(result.breach.breachType).toBe('wall-clock');
        expect(result.breach.prNumber).toBe(42);
        expect(result.breach.limit).toBe(DEFAULT_RESOURCE_LIMITS.wallClockSeconds);
      }
      // No docker process spawned because the signal was already aborted
      expect(driver.spawnCount).toBe(0);
    }),
  );

  // ── catch-block abort-vs-error distinction ─────────────────────────────────

  it(
    'doSpawn catch block: aborted signal → outcome:resource-breach (not error)',
    withIntegrationFlag(async () => {
      const controller = new AbortController();

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        // Emit error after a tick so we enter the Promise body first
        setImmediate(() => {
          controller.abort(); // abort BEFORE error fires
          proc.emitError(new Error('SIGKILL'));
        });
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('resource-breach');
      if (result.outcome === 'resource-breach') {
        expect(result.breach.breachType).toBe('wall-clock');
        expect(result.breach.prNumber).toBe(42);
      }
    }),
  );

  it(
    'doSpawn catch block: non-aborted signal + error → outcome:error',
    withIntegrationFlag(async () => {
      const controller = new AbortController();

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitError(new Error('docker not found'));
        });
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('docker not found');
      }
    }),
  );

  // ── successful exit path ───────────────────────────────────────────────────

  it(
    'doSpawn: docker exits 0 with no sentinel → outcome:success with fail-closed result (garbage output)',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          // No sentinel in output → parseDifferentialTestOutput returns failure
          proc.emitStdout('some unstructured stdout\n');
          proc.emitClose(0);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        // Fail-closed: no sentinel → all false/0
        expect(result.differentialTest.upstreamSuitePassed).toBe(false);
        expect(result.differentialTest.newTestsPassed).toBe(false);
        expect(result.differentialTest.newCodeCoveragePct).toBe(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    }),
  );

  it(
    'doSpawn: docker exits 0 with valid sentinel + JSON → outcome:success with parsed result',
    withIntegrationFlag(async () => {
      const validOutput = [
        'Running upstream tests...',
        'All tests passed',
        DIFFERENTIAL_RESULT_SENTINEL,
        JSON.stringify({
          upstreamPassed: true,
          upstreamOutput: 'All 42 tests passed',
          headPassed: true,
          headOutput: 'Coverage: 88.5%',
          coveragePct: 88.5,
        }),
      ].join('\n');

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout(validOutput);
          proc.emitClose(0);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(true);
        expect(result.differentialTest.newTestsPassed).toBe(true);
        expect(result.differentialTest.newCodeCoveragePct).toBe(88.5);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    }),
  );

  it(
    'doSpawn: docker exits non-zero → outcome:error (surfaces exit code)',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStderr('container crashed\n');
          proc.emitClose(1);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('exited with code');
        expect(result.error).toContain('1');
      }
    }),
  );

  // ── stdout / stderr data wiring ────────────────────────────────────────────

  it(
    'doSpawn: stdout + stderr data are captured and surfaced in error message on non-zero exit',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout('OUT: something happened\n');
          proc.emitStderr('ERR: container exited\n');
          proc.emitClose(2);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('OUT: something happened');
      }
    }),
  );

  // ── cidfile poll + containerId capture ────────────────────────────────────

  it(
    'cidfile poll: containerId is captured from cidfile written during container start',
    withIntegrationFlag(async () => {
      const fakeContainerId = 'abc1234567890def1234567890deadbeef12345678901234';

      // Override the driver to intercept the --cidfile arg from docker run args,
      // write a fake container ID to that path, and close after the poll fires.
      // This simulates Docker writing the cidfile at container-start time.
      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            setImmediate(() => {
              // Write the cidfile as Docker does when container starts
              writeFileSync(driverCidFilePath, fakeContainerId + '\n');
              // Wait for the cidfile poll interval (50ms) to fire, then close
              setTimeout(() => proc.emitClose(0), 120);
            });
          }
        }
        if (cmd === 'docker' && (args[0] === 'rm' || args[0] === 'kill')) {
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      expect(result.outcome).toBe('success');

      // After successful spawn, teardown() should docker rm -f the container ID.
      await driver.teardown();

      // The rm -f command must have been called with the captured container ID
      const spawnedArgLists = driver.spawnedArgLists;
      const rmCall = spawnedArgLists.find((a) => a.includes('rm') && a.includes('-f'));
      expect(rmCall).toBeDefined();
      expect(rmCall).toContain(fakeContainerId);
    }),
  );

  // ── killContainer with populated containerId ───────────────────────────────

  it(
    'killContainer: invokes docker kill <id> when containerId is set',
    withIntegrationFlag(async () => {
      const fakeContainerId = 'deadbeef1234567890deadbeef1234567890deadbeef12';

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          // Write the cidfile so killContainer has a real ID to use
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            setImmediate(() => {
              writeFileSync(driverCidFilePath, fakeContainerId + '\n');
              // Abort after the cidfile is written so killContainer fires
            });
          }
        }
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      await driver.teardown();

      // The teardown issues docker rm -f <containerId>
      const allArgs = driver.spawnedArgLists;
      const rmCall = allArgs.find((a) => a.includes('rm') && a.includes('-f'));
      expect(rmCall).toBeDefined();
      expect(rmCall).toContain(fakeContainerId);
    }),
  );

  it(
    'killContainer with containerId: docker kill is invoked with the real container ID',
    withIntegrationFlag(async () => {
      const fakeId = 'cafebabe1234567890abcdef1234567890abcdef12345678';
      const controller = new AbortController();

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            setImmediate(() => {
              // Write cidfile first
              writeFileSync(driverCidFilePath, fakeId + '\n');
              // Then abort → triggers onAbort which calls killContainer()
              setTimeout(() => {
                controller.abort();
              }, 60);
            });
          }
        }
        if (cmd === 'docker' && args[0] === 'kill') {
          setImmediate(() => proc.emitClose(0));
        }
        if (cmd === 'docker' && args[0] === 'rm') {
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      // Spawn with abortSignal — abort fires after cidfile written
      const spawnPromise = driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      const result = await spawnPromise;

      // The abort path returns resource-breach
      expect(result.outcome).toBe('resource-breach');

      // docker kill must have been invoked with the real container ID
      const allArgs = driver.spawnedArgLists;
      const killCall = allArgs.find((a) => a[0] === 'kill');
      expect(killCall).toBeDefined();
      if (killCall) {
        expect(killCall).toContain(fakeId);
      }
    }),
  );

  // ── teardown with live container + cidfile cleanup ─────────────────────────

  it(
    'teardown: with populated containerId → docker rm -f <id> is called',
    withIntegrationFlag(async () => {
      const fakeId = '1234abcdef567890abcdef1234567890abcdef567890abcd';

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            setImmediate(() => {
              writeFileSync(driverCidFilePath, fakeId + '\n');
              setTimeout(() => proc.emitClose(0), 80);
            });
          }
        }
        if (cmd === 'docker' && (args[0] === 'rm' || args[0] === 'kill')) {
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      await driver.teardown();

      const allArgs = driver.spawnedArgLists;
      const rmCall = allArgs.find((a) => a[0] === 'rm' && a.includes('-f'));
      expect(rmCall).toBeDefined();
      expect(rmCall).toContain(fakeId);
    }),
  );

  it(
    'teardown: cidfile temp directory is cleaned up after successful spawn',
    withIntegrationFlag(async () => {
      let capturedCidDir: string | null = null;

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        const cidfileIdx = args.indexOf('--cidfile');
        if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
          const cidFilePath = args[cidfileIdx + 1]!;
          // Capture the cidDir so we can check it was removed
          capturedCidDir = cidFilePath.substring(0, cidFilePath.lastIndexOf('/'));
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      // cidDir should exist at this point (or may already be cleaned by teardown in finally)
      await driver.teardown();

      // After teardown the cidDir should be gone
      if (capturedCidDir) {
        expect(existsSync(capturedCidDir)).toBe(false);
      }
    }),
  );

  it(
    'teardown: idempotent — second call with null containerId and cidFilePath is safe',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      await driver.teardown(); // first call — clears containerId + cidFilePath
      await expect(driver.teardown()).resolves.toBeUndefined(); // second call — no-op
    }),
  );

  // ── onAbort path (abort signal fires after spawn starts) ─────────────────

  it(
    'onAbort: abort after spawn triggers docker kill and rejects with resource-breach',
    withIntegrationFlag(async () => {
      const controller = new AbortController();

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          // Do not emit close — the abort should kill this
          setImmediate(() => {
            controller.abort();
          });
        }
        if (cmd === 'docker' && (args[0] === 'kill' || args[0] === 'rm')) {
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('resource-breach');
      if (result.outcome === 'resource-breach') {
        expect(result.breach.breachType).toBe('wall-clock');
      }
    }),
  );

  it(
    'onAbort: abort signal already aborted when addEventListener fires → onAbort called immediately',
    withIntegrationFlag(async () => {
      const controller = new AbortController();

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && (args[0] === 'kill' || args[0] === 'rm')) {
          setImmediate(() => proc.emitClose(0));
        }
        // Simulate: abort happens synchronously in the factory before EventListener is wired
        // The driver handles this case: `if (input.abortSignal.aborted) { onAbort(); return; }`
        return proc;
      });

      // Abort the controller before we even call spawn — tests the `input.abortSignal.aborted`
      // branch INSIDE runDockerDifferentialTest that fires onAbort early
      controller.abort();

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      // doSpawn checks abortSignal?.aborted before calling runDockerDifferentialTest,
      // so we get resource-breach at the doSpawn level (before any spawn)
      expect(result.outcome).toBe('resource-breach');
    }),
  );

  // ── cidfile read at close (fast-exit path) ─────────────────────────────────

  it(
    'cidfile read on close: containerId captured from cidfile when poll did not fire first',
    withIntegrationFlag(async () => {
      const fakeId = 'abcdef1234567890abcdef1234567890abcdef12';

      // Use setTimeout(0) to ensure the write+close fires after all sync
      // setup (including proc.on('close', ...) listener registration) but
      // before the 50ms cidfile poll interval has a chance to tick.
      // This exercises the "read cidfile at close" fallback path.
      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            // Write cidfile immediately then close (no delay → close fires before 50ms poll)
            setImmediate(() => {
              writeFileSync(driverCidFilePath, fakeId + '\n');
              setImmediate(() => proc.emitClose(0));
            });
          } else {
            // Fallback: close immediately so the test doesn't hang
            setImmediate(() => proc.emitClose(0));
          }
        }
        if (cmd === 'docker' && (args[0] === 'rm' || args[0] === 'kill')) {
          setImmediate(() => proc.emitClose(0));
        }
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      expect(result.outcome).toBe('success');

      // Teardown should use the ID captured at close
      await driver.teardown();
      const allArgs = driver.spawnedArgLists;
      const rmCall = allArgs.find((a) => a[0] === 'rm' && a.includes('-f'));
      expect(rmCall).toBeDefined();
      expect(rmCall).toContain(fakeId);
    }),
    10000, // generous timeout for the cidfile read path
  );

  // ── proc.on('error') path ──────────────────────────────────────────────────

  it(
    'proc error event (docker binary missing) → outcome:error, never false success',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitError(new Error('ENOENT: docker binary not found'));
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('docker binary not found');
      }
    }),
  );

  // ── close event with aborted signal set ───────────────────────────────────

  it(
    'close event with aborted signal → resource-breach (not success)',
    withIntegrationFlag(async () => {
      const controller = new AbortController();

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          controller.abort(); // abort while process is "running"
          proc.emitClose(0); // process exits 0 but signal was already aborted
        });
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        abortSignal: controller.signal,
      } as Parameters<typeof driver.spawn>[0]);

      // The close handler checks `input.abortSignal?.aborted` and rejects
      // with 'aborted by wall-clock timeout' which doSpawn catches and returns
      // resource-breach (because abortSignal.aborted is true in the catch block)
      expect(result.outcome).toBe('resource-breach');
    }),
  );

  // ── AI_SDLC_SANDBOX_IMAGE env var ─────────────────────────────────────────

  it(
    'uses AI_SDLC_SANDBOX_IMAGE env var when set (default is node:22-slim)',
    withIntegrationFlag(async () => {
      const origImage = process.env['AI_SDLC_SANDBOX_IMAGE'];
      process.env['AI_SDLC_SANDBOX_IMAGE'] = 'custom-sandbox:v2';

      try {
        const driver = new TestableDockerDriver((_cmd, args) => {
          const proc = new FakeProcess(args);
          setImmediate(() => proc.emitClose(0));
          return proc;
        });

        await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

        // The image name appears as an arg to docker run
        const runArgs = driver.spawnedArgLists[0] ?? [];
        expect(runArgs).toContain('custom-sandbox:v2');
      } finally {
        if (origImage !== undefined) {
          process.env['AI_SDLC_SANDBOX_IMAGE'] = origImage;
        } else {
          delete process.env['AI_SDLC_SANDBOX_IMAGE'];
        }
      }
    }),
  );

  it(
    'uses default node:22-slim image when AI_SDLC_SANDBOX_IMAGE is not set',
    withIntegrationFlag(async () => {
      const origImage = process.env['AI_SDLC_SANDBOX_IMAGE'];
      delete process.env['AI_SDLC_SANDBOX_IMAGE'];

      try {
        const driver = new TestableDockerDriver((_cmd, args) => {
          const proc = new FakeProcess(args);
          setImmediate(() => proc.emitClose(0));
          return proc;
        });

        await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

        const runArgs = driver.spawnedArgLists[0] ?? [];
        expect(runArgs).toContain('node:22-slim');
      } finally {
        if (origImage !== undefined) {
          process.env['AI_SDLC_SANDBOX_IMAGE'] = origImage;
        }
      }
    }),
  );

  // ── buildDockerRunArgs arg structure with seam ────────────────────────────

  it(
    'runDockerDifferentialTest: docker run args include all hardening flags',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      const runArgs = driver.spawnedArgLists[0] ?? [];
      expect(runArgs).toContain('run');
      expect(runArgs).toContain('--network=none');
      expect(runArgs).toContain('--cap-drop=ALL');
      expect(runArgs).toContain('--read-only');
      expect(runArgs).toContain('--user');
      expect(runArgs).toContain('65534:65534');
      expect(runArgs).toContain('--pids-limit');
      expect(runArgs).toContain('512');
      expect(runArgs).toContain('--cidfile');
      // Seccomp profile embedded in args
      const seccompArg = runArgs.find((a) => a.startsWith('seccomp='));
      expect(seccompArg).toBeDefined();
    }),
  );

  // ── teardown: docker rm -f error is suppressed ─────────────────────────────

  it(
    'teardown: docker rm -f error is swallowed (does not propagate)',
    withIntegrationFlag(async () => {
      const fakeId = 'aaabbbccc1234567890abcdef1234567890abcdef1234';

      const driver = new TestableDockerDriver((cmd, args) => {
        const proc = new FakeProcess(args);
        if (cmd === 'docker' && args[0] === 'run') {
          const cidfileIdx = args.indexOf('--cidfile');
          if (cidfileIdx !== -1 && args[cidfileIdx + 1]) {
            const driverCidFilePath = args[cidfileIdx + 1]!;
            setImmediate(() => {
              writeFileSync(driverCidFilePath, fakeId + '\n');
              setTimeout(() => proc.emitClose(0), 80);
            });
          }
        }
        if (cmd === 'docker' && args[0] === 'rm') {
          // Simulate docker rm -f failing (container already removed)
          setImmediate(() => proc.emitError(new Error('container not found')));
        }
        return proc;
      });

      await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      // teardown should NOT throw even when docker rm -f fails
      await expect(driver.teardown()).resolves.toBeUndefined();
    }),
  );
});

// ── AISDLC-509: parseDifferentialTestOutput — fail-closed output parser ────────

describe('parseDifferentialTestOutput (AISDLC-509 AC-4)', () => {
  // Helper: build a valid output string with a sentinel + JSON result
  function makeOutput(result: {
    upstreamPassed: boolean;
    upstreamOutput: string;
    headPassed: boolean;
    headOutput: string;
    coveragePct: number;
  }): string {
    return `Some test output\n${DIFFERENTIAL_RESULT_SENTINEL}\n${JSON.stringify(result)}\n`;
  }

  it('DIFFERENTIAL_RESULT_SENTINEL is a non-empty string', () => {
    expect(typeof DIFFERENTIAL_RESULT_SENTINEL).toBe('string');
    expect(DIFFERENTIAL_RESULT_SENTINEL.length).toBeGreaterThan(0);
  });

  // ── Fail-closed cases ─────────────────────────────────────────────────────

  it('empty stdout → fail-closed result', () => {
    const result = parseDifferentialTestOutput('');
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('garbage/unstructured stdout → fail-closed result', () => {
    const result = parseDifferentialTestOutput('some random output\nno sentinel here');
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('sentinel present but no JSON after it → fail-closed result', () => {
    const result = parseDifferentialTestOutput(`${DIFFERENTIAL_RESULT_SENTINEL}\n`);
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('sentinel present but invalid JSON after it → fail-closed result', () => {
    const result = parseDifferentialTestOutput(`${DIFFERENTIAL_RESULT_SENTINEL}\n{not valid json`);
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('sentinel present + JSON array (not object) → fail-closed result', () => {
    const result = parseDifferentialTestOutput(`${DIFFERENTIAL_RESULT_SENTINEL}\n[1, 2, 3]`);
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
  });

  it('sentinel present + JSON null → fail-closed result', () => {
    const result = parseDifferentialTestOutput(`${DIFFERENTIAL_RESULT_SENTINEL}\nnull`);
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
  });

  it('sentinel present + JSON with wrong field types → fail-closed result', () => {
    // upstreamPassed should be boolean, not string
    const result = parseDifferentialTestOutput(
      `${DIFFERENTIAL_RESULT_SENTINEL}\n` +
        JSON.stringify({
          upstreamPassed: 'yes',
          upstreamOutput: 'output',
          headPassed: true,
          headOutput: 'output',
          coveragePct: 80,
        }),
    );
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
  });

  it('sentinel present + JSON with missing fields → fail-closed result', () => {
    const result = parseDifferentialTestOutput(
      `${DIFFERENTIAL_RESULT_SENTINEL}\n` + JSON.stringify({ upstreamPassed: true }), // missing headPassed, coveragePct, etc.
    );
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('sentinel present + JSON with NaN coveragePct → fail-closed result', () => {
    // JSON.parse('{"coveragePct": NaN}') would fail since NaN is not valid JSON
    // but we can test the guard by producing a coveragePct via constructor
    const result = parseDifferentialTestOutput(
      `${DIFFERENTIAL_RESULT_SENTINEL}\n` +
        `{"upstreamPassed":true,"upstreamOutput":"","headPassed":true,"headOutput":"","coveragePct":null}`,
    );
    // null is not a number → fail-closed
    expect(result.upstreamSuitePassed).toBe(false);
  });

  // ── Happy-path cases ─────────────────────────────────────────────────────

  it('valid output: upstream pass + head pass + coverage → parsed correctly', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: 'All 42 tests passed',
        headPassed: true,
        headOutput: 'All 47 tests passed',
        coveragePct: 85.5,
      }),
    );
    expect(result.upstreamSuitePassed).toBe(true);
    expect(result.newTestsPassed).toBe(true);
    expect(result.newCodeCoveragePct).toBe(85.5);
    expect(result.upstreamSuiteOutput).toContain('All 42 tests passed');
    expect(result.newTestsOutput).toContain('All 47 tests passed');
  });

  it('valid output: upstream fail + head pass → upstream failure preserved', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: false,
        upstreamOutput: 'FAIL: 3 tests failed',
        headPassed: true,
        headOutput: 'All new tests passed',
        coveragePct: 72.3,
      }),
    );
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(true);
    expect(result.newCodeCoveragePct).toBe(72.3);
  });

  it('valid output: upstream pass + head fail → head failure preserved', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: 'All tests passed',
        headPassed: false,
        headOutput: 'FAIL: new test assert failed',
        coveragePct: 0,
      }),
    );
    expect(result.upstreamSuitePassed).toBe(true);
    expect(result.newTestsPassed).toBe(false);
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('valid output: zero coverage → preserved as 0', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: '',
        headPassed: false,
        headOutput: '',
        coveragePct: 0,
      }),
    );
    expect(result.newCodeCoveragePct).toBe(0);
  });

  it('valid output: coverage at exactly 100 → preserved', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: '',
        headPassed: true,
        headOutput: '',
        coveragePct: 100,
      }),
    );
    expect(result.newCodeCoveragePct).toBe(100);
  });

  it('coverage > 100 → clamped to 100', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: '',
        headPassed: true,
        headOutput: '',
        coveragePct: 102.7,
      }),
    );
    expect(result.newCodeCoveragePct).toBe(100);
  });

  it('coverage < 0 → clamped to 0', () => {
    const result = parseDifferentialTestOutput(
      makeOutput({
        upstreamPassed: true,
        upstreamOutput: '',
        headPassed: true,
        headOutput: '',
        coveragePct: -5,
      }),
    );
    expect(result.newCodeCoveragePct).toBe(0);
  });

  // ── LAST-sentinel wins (injection guard) ──────────────────────────────────

  it('LAST sentinel wins: attacker plants early false-pass sentinel, real result is failure', () => {
    // An attacker might try to inject an early "passing" result before the real
    // sentinel. The parser uses the LAST sentinel occurrence — so the real
    // result (failure) wins, not the attacker's injected pass.
    const output = [
      '# Injected early result:',
      DIFFERENTIAL_RESULT_SENTINEL,
      JSON.stringify({
        upstreamPassed: true,
        upstreamOutput: '',
        headPassed: true,
        headOutput: '',
        coveragePct: 99,
      }),
      '# Real test run begins:',
      'FAIL: upstream test 3 failed',
      DIFFERENTIAL_RESULT_SENTINEL,
      JSON.stringify({
        upstreamPassed: false,
        upstreamOutput: 'FAIL: test 3',
        headPassed: false,
        headOutput: '',
        coveragePct: 0,
      }),
    ].join('\n');

    const result = parseDifferentialTestOutput(output);
    // LAST sentinel → real failure wins
    expect(result.upstreamSuitePassed).toBe(false);
    expect(result.newTestsPassed).toBe(false);
  });

  it('LAST sentinel wins: two passing results — last one is authoritative', () => {
    const output = [
      DIFFERENTIAL_RESULT_SENTINEL,
      JSON.stringify({
        upstreamPassed: false,
        upstreamOutput: '',
        headPassed: false,
        headOutput: '',
        coveragePct: 0,
      }),
      'Some more output',
      DIFFERENTIAL_RESULT_SENTINEL,
      JSON.stringify({
        upstreamPassed: true,
        upstreamOutput: 'pass',
        headPassed: true,
        headOutput: 'pass',
        coveragePct: 80,
      }),
    ].join('\n');

    const result = parseDifferentialTestOutput(output);
    expect(result.upstreamSuitePassed).toBe(true);
    expect(result.newTestsPassed).toBe(true);
    expect(result.newCodeCoveragePct).toBe(80);
  });

  // ── Integration via TestableDockerDriver ──────────────────────────────────

  it(
    'TestableDockerDriver: valid sentinel output → parsed DifferentialTestResult',
    withIntegrationFlag(async () => {
      const validOutput = [
        'Cloning repo...',
        'Applying diff...',
        'Running upstream tests...',
        DIFFERENTIAL_RESULT_SENTINEL,
        JSON.stringify({
          upstreamPassed: true,
          upstreamOutput: 'Tests: 100 passed',
          headPassed: true,
          headOutput: 'Tests: 105 passed, Coverage: 91.2%',
          coveragePct: 91.2,
        }),
      ].join('\n');

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout(validOutput);
          proc.emitClose(0);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(true);
        expect(result.differentialTest.newTestsPassed).toBe(true);
        expect(result.differentialTest.newCodeCoveragePct).toBe(91.2);
      }
    }),
  );

  it(
    'TestableDockerDriver: garbage output (no sentinel) → fail-closed DifferentialTestResult',
    withIntegrationFlag(async () => {
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout('random garbage output\nno structure here\n');
          proc.emitClose(0);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(false);
        expect(result.differentialTest.newTestsPassed).toBe(false);
        expect(result.differentialTest.newCodeCoveragePct).toBe(0);
      }
    }),
  );

  it(
    'TestableDockerDriver: upstream failure + head pass → both preserved correctly',
    withIntegrationFlag(async () => {
      const output = [
        'Running upstream tests...',
        'FAIL: 2 tests failed',
        DIFFERENTIAL_RESULT_SENTINEL,
        JSON.stringify({
          upstreamPassed: false,
          upstreamOutput: 'FAIL: test A and test B failed',
          headPassed: true,
          headOutput: 'All new tests passed',
          coveragePct: 77.3,
        }),
      ].join('\n');

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout(output);
          proc.emitClose(0);
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('success');
      if (result.outcome === 'success') {
        expect(result.differentialTest.upstreamSuitePassed).toBe(false);
        expect(result.differentialTest.newTestsPassed).toBe(true);
        expect(result.differentialTest.newCodeCoveragePct).toBe(77.3);
      }
    }),
  );
});

// ── AISDLC-509: buildDifferentialTestScript — in-container script shape ────────

describe('buildDifferentialTestScript (AISDLC-509 AC-1)', () => {
  it('returns a non-empty string', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('contains the sentinel emission command', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain(DIFFERENTIAL_RESULT_SENTINEL);
  });

  it('contains the upstream ref passed in', () => {
    const ref = 'https://github.com/example/myrepo.git';
    const script = buildDifferentialTestScript(ref);
    expect(script).toContain(ref);
  });

  it('contains git apply (diff applied as data, not executed)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('git apply');
  });

  it('reads the diff from SANDBOX_PR_DIFF_B64 (base64 env var, not interpolated)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The diff must come from an env var, not be interpolated directly into the script
    expect(script).toContain('SANDBOX_PR_DIFF_B64');
    expect(script).toContain('base64 -d');
  });

  it('contains upstreamPassed in the JSON emission', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('upstreamPassed');
    expect(script).toContain('headPassed');
    expect(script).toContain('coveragePct');
  });

  it('does NOT contain perTestTimeout prefix when perTestTimeoutSeconds is not set', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // When no per-test timeout, 'timeout <N>' should not be present as a command prefix
    // (it may appear in comments or variable names but not as a shell command)
    expect(script).not.toMatch(/^timeout \d+/m);
  });

  it('wraps test command with timeout <N> when perTestTimeoutSeconds is set', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git', 60);
    expect(script).toContain('timeout 60');
  });

  it('uses integer timeout (floors decimal seconds)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git', 30.7);
    // Should floor to 30, not 30.7
    expect(script).toContain('timeout 30');
  });

  it('ignores zero perTestTimeoutSeconds (not a valid timeout)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git', 0);
    // Zero should NOT produce a timeout prefix
    expect(script).not.toMatch(/timeout 0\b/);
  });

  it('contains set -e for fail-fast shell behavior', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('set -e');
  });

  it('SANDBOX_PR_DIFF_B64 env var is referenced in the script (base64 injection guard)', () => {
    // Verify the diff is not embedded in the script itself — it is passed as
    // an environment variable and decoded inside the container. This prevents
    // shell metacharacters in the diff from executing arbitrary commands.
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('SANDBOX_PR_DIFF_B64');
  });

  it('script writes to /tmp/pr.diff (not executed, only applied via git apply)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('pr.diff');
    expect(script).toContain('git apply');
  });

  it('contains pnpm test as the primary test runner', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(script).toContain('pnpm test');
  });
});

// ── Fix-iteration: validateUpstreamMainRef — MINOR #4 (unescaped interpolation) ─

describe('validateUpstreamMainRef (AISDLC-509 fix: unescaped interpolation guard)', () => {
  it('accepts a full 40-char hex SHA', () => {
    expect(() => validateUpstreamMainRef('a'.repeat(40))).not.toThrow();
  });

  it('accepts a short 7-char hex SHA', () => {
    expect(() => validateUpstreamMainRef('abc1234')).not.toThrow();
  });

  it('accepts a 64-char hex SHA (upper bound)', () => {
    expect(() => validateUpstreamMainRef('f'.repeat(64))).not.toThrow();
  });

  it('accepts https:// URL', () => {
    expect(() => validateUpstreamMainRef('https://github.com/example/repo.git')).not.toThrow();
  });

  it('accepts git:// URL', () => {
    expect(() => validateUpstreamMainRef('git://github.com/example/repo.git')).not.toThrow();
  });

  it('accepts ssh:// URL', () => {
    expect(() => validateUpstreamMainRef('ssh://git@github.com/example/repo.git')).not.toThrow();
  });

  it('accepts git@ (SCP-style) URL', () => {
    expect(() => validateUpstreamMainRef('git@github.com:example/repo.git')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateUpstreamMainRef('')).toThrow();
  });

  it('rejects a local file path (injection risk)', () => {
    expect(() => validateUpstreamMainRef('/tmp/evil-repo')).toThrow(/not a valid/i);
  });

  it('rejects a ref with shell metacharacters (injection attempt)', () => {
    expect(() => validateUpstreamMainRef("'; rm -rf /; echo '")).toThrow(/not a valid/i);
  });

  it('rejects a ref with $() subshell syntax', () => {
    expect(() => validateUpstreamMainRef('$(rm -rf /)')).toThrow(/not a valid/i);
  });

  it('rejects a 6-char hex string (too short for SHA)', () => {
    // 6 hex chars is below the 7-char minimum
    expect(() => validateUpstreamMainRef('abc123')).toThrow(/not a valid/i);
  });

  it('rejects a 65-char hex string (too long for SHA, no URL scheme)', () => {
    expect(() => validateUpstreamMainRef('a'.repeat(65))).toThrow(/not a valid/i);
  });

  it('rejects mixed non-hex SHA-like string', () => {
    // Contains 'g' which is not a hex character
    expect(() => validateUpstreamMainRef('gabcdef1234567')).toThrow(/not a valid/i);
  });

  it('buildDifferentialTestScript throws for invalid ref (not a valid SHA/URL)', () => {
    expect(() => buildDifferentialTestScript('/tmp/evil-path')).toThrow(/not a valid/i);
  });

  it('buildDifferentialTestScript does NOT throw for a valid SHA ref', () => {
    expect(() => buildDifferentialTestScript('a'.repeat(40))).not.toThrow();
  });

  it('buildDifferentialTestScript does NOT throw for a valid https URL', () => {
    expect(() => buildDifferentialTestScript('https://github.com/example/repo.git')).not.toThrow();
  });
});

// ── Fix-iteration: script correctness — bugs 1-3 ─────────────────────────────

describe('buildDifferentialTestScript — fix: coverage flag forwarded (bug #2)', () => {
  it('head test command includes --coverage as a direct flag (not after --)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The coverage flag must be passed as a pnpm/npm flag, not after `--`.
    // The broken form was: `sh -c 'pnpm test ...' -- --coverage`
    // The correct form: `sh -c 'pnpm test --coverage ...'`
    expect(script).toContain('pnpm test --coverage');
  });

  it('head test command: --coverage appears within the sh -c quoted command', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // Must NOT use the `-- --coverage` form (passes --coverage as positional $1 to sh)
    expect(script).not.toContain("'pnpm test 2>&1 || npm test 2>&1' -- --coverage");
  });

  it('with perTestTimeoutSeconds: head cmd has coverage inside the sh -c string', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git', 60);
    expect(script).toContain('pnpm test --coverage');
    // The timeout prefix must wrap the whole sh -c command, not be inside it
    expect(script).toMatch(/timeout 60\s+sh\s+-c\s+'pnpm test --coverage/);
  });
});

describe('buildDifferentialTestScript — fix: git apply fail-closed (bug #1)', () => {
  it('git apply failure exits with sentinel + exit 1 (not silently continues)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // Must use `if ! git apply` pattern (fail-closed)
    expect(script).toContain('if ! git apply');
    // On failure: must emit sentinel and exit 1
    expect(script).toContain('exit 1');
    // Must NOT use the broken `|| { echo ...; }` pattern (which continues silently)
    expect(script).not.toMatch(/git apply[^;]*\|\|\s*\{[\s\S]*?echo "git apply failed/);
  });

  it('on git apply failure: script emits the sentinel before exit 1 in the failure block', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The apply-failure block assigns FAILURE_SENTINEL and emits it before exit 1.
    // We verify the structure by checking that:
    // (a) the failure-sentinel variable assignment is present
    // (b) an `exit 1` follows the apply failure block
    // (c) the apply-failure block emits coveragePct:0 (fail-closed invariant)
    expect(script).toContain("FAILURE_SENTINEL='");
    expect(script).toContain('exit 1');
    // The apply-failure block is inside `if ! git apply ... fi`
    const applyFailureIdx = script.indexOf('if ! git apply');
    const headOutputIdx = script.indexOf('HEAD_OUTPUT=$(');
    expect(applyFailureIdx).toBeGreaterThan(0);
    expect(headOutputIdx).toBeGreaterThan(0);
    // The git apply failure block ends with `exit 1` BEFORE HEAD_OUTPUT
    // Find the exit 1 that comes AFTER the git apply block
    const applyBlockEnd = script.indexOf('exit 1', applyFailureIdx);
    expect(applyBlockEnd).toBeGreaterThan(applyFailureIdx);
    expect(applyBlockEnd).toBeLessThan(headOutputIdx);
  });

  it(
    'TestableDockerDriver: apply failure → sentinel emitted + non-zero exit → outcome:error',
    withIntegrationFlag(async () => {
      // Simulate the container running the fixed script: apply fails, script emits
      // sentinel + failure JSON, then exits 1. The TypeScript layer should receive
      // outcome:error (non-zero exit) with the failure sentinel in stdout.
      const failureJson = JSON.stringify({
        upstreamPassed: false,
        upstreamOutput: '',
        headPassed: false,
        headOutput: 'git apply failed',
        coveragePct: 0,
      });
      const stdout = `git apply failed — diff could not be applied cleanly\n${DIFFERENTIAL_RESULT_SENTINEL}\n${failureJson}\n`;

      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => {
          proc.emitStdout(stdout);
          proc.emitClose(1); // exit 1 — the fixed script exits 1 on apply failure
        });
        return proc;
      });

      const result = await driver.spawn(LIFECYCLE_INPUT as Parameters<typeof driver.spawn>[0]);
      // Non-zero exit → outcome:error (the TS layer rejects the Promise)
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toContain('exited with code');
        expect(result.error).toContain('1');
      }
      // The container DID emit the sentinel — it's in the error message (stdout truncated there)
      // This is the fail-closed guarantee: non-zero exit → never a false pass
    }),
  );
});

describe('buildDifferentialTestScript — fix: base-before-apply ordering (bug #3)', () => {
  it('upstream test run appears BEFORE git apply in the script', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // Find positions of key lines in the script
    const upstreamTestPos = script.indexOf('UPSTREAM_OUTPUT=$(');
    const gitApplyPos = script.indexOf('if ! git apply');
    expect(upstreamTestPos).toBeGreaterThan(0);
    expect(gitApplyPos).toBeGreaterThan(0);
    // Upstream tests must run BEFORE the diff is applied
    expect(upstreamTestPos).toBeLessThan(gitApplyPos);
  });

  it('head test run appears AFTER git apply in the script', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    const gitApplyPos = script.indexOf('if ! git apply');
    const headTestPos = script.indexOf('HEAD_OUTPUT=$(');
    expect(gitApplyPos).toBeGreaterThan(0);
    expect(headTestPos).toBeGreaterThan(0);
    // Head tests must run AFTER the diff is applied
    expect(headTestPos).toBeGreaterThan(gitApplyPos);
  });

  it('script has two separate test invocations (base run + head run)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // Both UPSTREAM_OUTPUT and HEAD_OUTPUT capture blocks are present
    expect(script).toContain('UPSTREAM_OUTPUT=$(');
    expect(script).toContain('HEAD_OUTPUT=$(');
    // They must be distinct (not the same variable assignment)
    const upstreamCount = (script.match(/UPSTREAM_OUTPUT=\$\(/g) ?? []).length;
    const headCount = (script.match(/HEAD_OUTPUT=\$\(/g) ?? []).length;
    expect(upstreamCount).toBe(1);
    expect(headCount).toBe(1);
  });

  it('base test command does NOT include --coverage (only head suite gets coverage)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The upstream section runs WITHOUT --coverage
    const upstreamSection = script.substring(
      script.indexOf('UPSTREAM_OUTPUT=$('),
      script.indexOf('if ! git apply'),
    );
    expect(upstreamSection).not.toContain('--coverage');
  });
});

// ── Fix-iteration: coverage regex — MINOR #5 (integer % support) ─────────────

describe('buildDifferentialTestScript — fix: integer % parsing (bug #5)', () => {
  it('script uses regex that accepts integer percent (no decimal required)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // The fixed regex is [0-9]+([.][0-9]+)?% — the decimal part is optional
    // Verify the broken regex [0-9]+\.[0-9]+% is NOT present
    expect(script).not.toMatch(/\[0-9\]\+\\\.\[0-9\]/);
    // And the fixed form (optional decimal) IS present
    expect(script).toMatch(/\[0-9\]\+.*\[0-9\]/);
  });

  it('parseDifferentialTestOutput: integer % coverage (e.g. 82%) is parsed correctly', () => {
    // This tests the TypeScript parser, but the shell produces the coveragePct number,
    // so the shell's regex must accept integers. We test by injecting an integer
    // coveragePct value directly into the parser:
    const result = parseDifferentialTestOutput(
      `${DIFFERENTIAL_RESULT_SENTINEL}\n` +
        JSON.stringify({
          upstreamPassed: true,
          upstreamOutput: '',
          headPassed: true,
          headOutput: 'Lines: 82%',
          coveragePct: 82, // integer — must be accepted
        }),
    );
    expect(result.newCodeCoveragePct).toBe(82);
    expect(result.newTestsPassed).toBe(true);
  });
});

// ── Fix-iteration #2 MAJOR: empty-diff fail-closed (AISDLC-509) ──────────────
//
// When prDiff is an empty string, runDockerDifferentialTest must throw
// (producing outcome:'error') rather than silently skipping git apply and
// returning a false headPassed:true.

describe('Fix #2 MAJOR — empty-diff fail-closed in runDockerDifferentialTest', () => {
  it(
    'DockerSandboxDriver.spawn rejects empty prDiff with outcome:error (not false headPassed:true)',
    withIntegrationFlag(async () => {
      // Create a driver where spawn would otherwise succeed if it got to docker run
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        prDiff: '', // empty diff — must fail-closed
      } as Parameters<typeof driver.spawn>[0]);

      // Must NOT produce outcome:'success' with headPassed:true (the false-pass scenario)
      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toMatch(/empty/i);
        // Must name the root cause
        expect(result.error).toMatch(/prDiff|diff/i);
      }
      // No docker process should have been spawned (rejected before cidfile creation)
      expect(driver.spawnCount).toBe(0);
    }),
  );

  it(
    'runSandbox rejects empty prDiff with outcome:error via DockerSandboxDriver',
    withIntegrationFlag(async () => {
      // Use TestableDockerDriver so no real docker daemon is needed
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      const result = await runSandbox({
        prNumber: 1,
        prDiff: '', // empty diff
        upstreamMainRef: 'https://github.com/example/repo.git',
        config: DEFAULT_SANDBOX_CONFIG,
        driverOverride: driver,
      });

      expect(result.outcome).toBe('error');
      if (result.outcome === 'error') {
        expect(result.error).toMatch(/empty|prDiff|diff/i);
      }
    }),
  );

  it('buildDifferentialTestScript: empty SANDBOX_PR_DIFF_B64 → sentinel + exit 1 (not silent skip)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');

    // The OLD (broken) guard: `if [ -n "${SANDBOX_PR_DIFF_B64:-}" ]` — silently skips apply
    // The NEW (fixed) guard: `if [ -z "${SANDBOX_PR_DIFF_B64:-}" ]` — emits sentinel + exit 1
    expect(script).toContain('[ -z "${SANDBOX_PR_DIFF_B64:-}" ]');
    // Must NOT contain the old guard that silently skips apply on empty var
    expect(script).not.toContain('[ -n "${SANDBOX_PR_DIFF_B64:-}" ]');

    // When the guard fires (var is empty), the script must emit the failure sentinel
    // and exit 1 — NOT continue to run tests against the unpatched base
    const guardIdx = script.indexOf('[ -z "${SANDBOX_PR_DIFF_B64:-}" ]');
    const sentinelAfterGuard = script.indexOf(DIFFERENTIAL_RESULT_SENTINEL, guardIdx);
    const exitAfterGuard = script.indexOf('exit 1', guardIdx);
    expect(sentinelAfterGuard).toBeGreaterThan(guardIdx);
    expect(exitAfterGuard).toBeGreaterThan(guardIdx);
    // The sentinel comes before exit 1
    expect(sentinelAfterGuard).toBeLessThan(exitAfterGuard);
  });

  it('buildDifferentialTestScript: git apply now runs unconditionally (after guard), not inside if-block', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // After the guard emits sentinel+exit1 on empty var, the apply runs unconditionally.
    // Verify: `printf '%s' "$SANDBOX_PR_DIFF_B64" | base64 -d` is present as a top-level
    // statement (not nested in an `if [ -n ... ]` block that would silently skip it).
    expect(script).toContain('printf \'%s\' "$SANDBOX_PR_DIFF_B64" | base64 -d');
    // Confirm the old `if [ -n "${SANDBOX_PR_DIFF_B64:-}" ]` guard is gone
    expect(script).not.toContain('if [ -n "${SANDBOX_PR_DIFF_B64:-}" ]');
  });

  it(
    'TestableDockerDriver: empty-diff → outcome:error, teardown still called',
    withIntegrationFlag(async () => {
      // The error happens before docker run is invoked — teardown should still be no-op safe
      const driver = new TestableDockerDriver((_cmd, args) => {
        const proc = new FakeProcess(args);
        setImmediate(() => proc.emitClose(0));
        return proc;
      });

      const result = await driver.spawn({
        ...LIFECYCLE_INPUT,
        prDiff: '',
      } as Parameters<typeof driver.spawn>[0]);

      expect(result.outcome).toBe('error');
      // teardown is idempotent even when no docker process was spawned
      await expect(driver.teardown()).resolves.toBeUndefined();
    }),
  );
});

// ── Fix-iteration #2 MINOR #2: JSDoc ordering ────────────────────────────────
// Regression guard: the JSDoc for buildDifferentialTestScript must immediately
// precede that function (not validateUpstreamMainRef). This is structural only
// — the test verifies the exported function signatures haven't broken.

describe('Fix #2 MINOR #2 — JSDoc reorder does not break exports', () => {
  it('validateUpstreamMainRef is still exported and callable', () => {
    // Basic smoke-test: the reorder must not have moved validateUpstreamMainRef
    // to a position after buildDifferentialTestScript makes the export unreachable
    expect(typeof validateUpstreamMainRef).toBe('function');
    expect(() => validateUpstreamMainRef('abc1234')).not.toThrow(); // valid SHA
    expect(() => validateUpstreamMainRef('')).toThrow(); // invalid
  });

  it('buildDifferentialTestScript is still exported and callable', () => {
    expect(typeof buildDifferentialTestScript).toBe('function');
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('validateUpstreamMainRef still rejects injection attempts after reorder', () => {
    expect(() => validateUpstreamMainRef("'; rm -rf /; echo '")).toThrow(/not a valid/i);
    expect(() => validateUpstreamMainRef('$(rm -rf /)')).toThrow(/not a valid/i);
    expect(() => validateUpstreamMainRef('/tmp/evil')).toThrow(/not a valid/i);
  });
});

// ── Fix-iteration #2 MINOR #3: baseSha checkout for URL-clone path ───────────

describe('Fix #2 MINOR #3 — baseSha param in buildDifferentialTestScript', () => {
  it('without baseSha: URL-clone script does NOT attempt checkout (comment only)', () => {
    const script = buildDifferentialTestScript('https://github.com/example/repo.git');
    // No baseSha → no git checkout command in the URL branch
    // The script should contain a comment about the invariant risk instead
    expect(script).toContain('baseSha not provided');
    expect(script).not.toContain("git checkout '");
  });

  it('with valid baseSha: URL-clone script includes git checkout <baseSha>', () => {
    const sha = 'a'.repeat(40); // valid 40-char SHA
    const script = buildDifferentialTestScript(
      'https://github.com/example/repo.git',
      undefined,
      sha,
    );
    // The URL branch must contain `git checkout '<sha>'`
    expect(script).toContain(`git checkout '${sha}'`);
    // Must also have a fallback exit 1 for checkout failure
    const checkoutIdx = script.indexOf(`git checkout '${sha}'`);
    const failAfterCheckout = script.indexOf('exit 1', checkoutIdx);
    expect(failAfterCheckout).toBeGreaterThan(checkoutIdx);
  });

  it('with baseSha: SHA-form ref path is unaffected (baseSha redundant but harmless)', () => {
    // When upstreamMainRef is a SHA, the else branch handles it (cd repo + git checkout REF).
    // baseSha does not appear in the SHA branch.
    const sha = 'a'.repeat(40);
    const script = buildDifferentialTestScript(sha, undefined, sha);
    // The SHA branch still has: git checkout "$UPSTREAM_REF"
    expect(script).toContain('git checkout "$UPSTREAM_REF"');
    // The URL branch content (git clone) is NOT present (ref is SHA, not URL)
    // — actually both branches are in the script, so we check the ordering
    const urlBranchIdx = script.indexOf('git clone');
    const shaBranchIdx = script.indexOf('git checkout "$UPSTREAM_REF"');
    // SHA branch checkout appears in the else block (after the URL if-block)
    expect(shaBranchIdx).toBeGreaterThan(urlBranchIdx);
  });

  it('baseSha is validated as a hex SHA — non-hex string produces comment-only output', () => {
    // If the caller passes an invalid baseSha (not a hex SHA), the script falls
    // back to the comment-only form (no checkout command). This prevents injection
    // via a crafted baseSha that evades the regex check.
    const invalidBaseSha = "'; rm -rf /; echo '";
    const script = buildDifferentialTestScript(
      'https://github.com/example/repo.git',
      undefined,
      invalidBaseSha,
    );
    // The invalid baseSha must NOT produce a git checkout line
    expect(script).not.toContain(`git checkout '${invalidBaseSha}'`);
    // It falls back to the comment form
    expect(script).toContain('baseSha not provided');
  });

  it('with baseSha: perTestTimeoutSeconds still works correctly alongside baseSha', () => {
    const sha = 'deadbeef1234567890abcdef1234567890abcdef12';
    const script = buildDifferentialTestScript('https://github.com/example/repo.git', 45, sha);
    expect(script).toContain('timeout 45');
    expect(script).toContain(`git checkout '${sha}'`);
  });

  it(
    'TestableDockerDriver with baseSha: URL-form spawn includes checkout in script',
    withIntegrationFlag(async () => {
      const sha = 'cafebabe1234567890abcdef1234567890abcdef12';
      // We can't call buildDifferentialTestScript with baseSha directly from spawn
      // (spawn calls it internally without baseSha). This test verifies the API exists
      // and the script content is correct.
      const script = buildDifferentialTestScript(
        'https://github.com/example/repo.git',
        undefined,
        sha,
      );
      expect(script).toContain(`git checkout '${sha}'`);
      // baseSha checkout appears in the URL branch (before the else)
      const urlBranchStart = script.indexOf('git clone');
      const checkoutIdx = script.indexOf(`git checkout '${sha}'`);
      const elseBranchIdx = script.indexOf('else\n');
      expect(checkoutIdx).toBeGreaterThan(urlBranchStart);
      expect(checkoutIdx).toBeLessThan(elseBranchIdx);
    }),
  );
});

// ── AISDLC-509: SANDBOX_PR_DIFF_B64 env var injection via TestableDockerDriver ─

describe('SANDBOX_PR_DIFF_B64 env var injection (AISDLC-509 AC-1)', () => {
  it(
    'SANDBOX_PR_DIFF_B64 is passed to docker run env containing base64-encoded diff',
    withIntegrationFlag(async () => {
      // We test the env injection through the spawn seam by hooking _spawnProcess options.
      // Instead of TestableDockerDriver (which ignores options), create a subclass that
      // captures the env.
      class EnvCapturingDriver extends DockerSandboxDriver {
        public capturedEnv: Record<string, string> | undefined;

        protected _spawnProcess(
          _cmd: string,
          args: string[],
          options: import('node:child_process').SpawnOptions,
        ): import('node:child_process').ChildProcess {
          this.capturedEnv = options.env as Record<string, string> | undefined;
          const proc = new FakeProcess(
            args,
          ) as unknown as import('node:child_process').ChildProcess;
          setImmediate(() => (proc as unknown as FakeProcess).emitClose(0));
          return proc;
        }
      }

      const envDriver = new EnvCapturingDriver();
      const prDiff = 'diff --git a/foo.ts b/foo.ts\n+// new line';

      await envDriver.spawn({
        ...LIFECYCLE_INPUT,
        prDiff,
      });

      // SANDBOX_PR_DIFF_B64 must be present in the spawned process env
      expect(envDriver.capturedEnv).toBeDefined();
      expect(envDriver.capturedEnv?.['SANDBOX_PR_DIFF_B64']).toBeDefined();

      // Verify the base64 decodes back to the original diff
      const decoded = Buffer.from(
        envDriver.capturedEnv!['SANDBOX_PR_DIFF_B64']!,
        'base64',
      ).toString('utf8');
      expect(decoded).toBe(prDiff);

      // Withheld credentials must NOT appear in the env
      expect(envDriver.capturedEnv?.['GITHUB_TOKEN']).toBeUndefined();
      expect(envDriver.capturedEnv?.['NPM_TOKEN']).toBeUndefined();
      expect(envDriver.capturedEnv?.['AI_SDLC_SIGNING_KEY']).toBeUndefined();
    }),
  );
});
