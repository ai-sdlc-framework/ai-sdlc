import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type MockRow = { dimension: string; wStructural: number; wLlm: number } | undefined;
const mocks = vi.hoisted(() => {
  const realStore = {
    close: vi.fn(),
    getSaPhaseWeights: vi.fn(
      (dim: string): { dimension: string; wStructural: number; wLlm: number } | undefined => ({
        dimension: dim,
        wStructural: 0.35,
        wLlm: 0.65,
      }),
    ),
    upsertSaPhaseWeights: vi.fn(),
  };
  const shadowStore = {
    close: vi.fn(),
    getSaPhaseWeights: vi.fn(
      (): { dimension: string; wStructural: number; wLlm: number } | undefined => undefined,
    ),
    upsertSaPhaseWeights: vi.fn(),
  };
  const stateStoreOpen = vi.fn((path: string) => (path === ':memory:' ? shadowStore : realStore));
  return {
    realStore,
    shadowStore,
    stateStoreOpen,
    SAFeedbackStore: vi.fn().mockImplementation(() => ({ sentinel: 'feedback' })),
    autoCalibratePhaseWeights: vi.fn(async () => ({
      diffs: [
        {
          dimension: 'SA-1',
          precision: { structural: 0.6, llm: 0.8 },
          previous: { wStructural: 0.35, wLlm: 0.65 },
          next: { wStructural: 0.3, wLlm: 0.7 },
          changed: true,
        },
        {
          dimension: 'SA-2',
          precision: { structural: 0.7, llm: 0.7 },
          previous: { wStructural: 0.35, wLlm: 0.65 },
          next: { wStructural: 0.35, wLlm: 0.65 },
          changed: false,
        },
      ],
    })),
    renderCalibrationDiff: vi.fn((result: unknown) => {
      void result;
      return 'rendered-diff-output';
    }),
    resolveRepoRoot: vi.fn(),
  };
});

vi.mock('@ai-sdlc/orchestrator', () => ({
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
  StateStore: { open: mocks.stateStoreOpen },
  SAFeedbackStore: mocks.SAFeedbackStore,
  autoCalibratePhaseWeights: mocks.autoCalibratePhaseWeights,
  renderCalibrationDiff: mocks.renderCalibrationDiff,
  resolveRepoRoot: mocks.resolveRepoRoot,
}));

describe('cli-sa-calibrate', () => {
  let originalArgv: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    originalArgv = process.argv;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'sa-calibrate-test-'));
    mocks.autoCalibratePhaseWeights.mockClear();
    mocks.renderCalibrationDiff.mockClear();
    mocks.stateStoreOpen.mockClear();
    mocks.realStore.getSaPhaseWeights.mockClear();
    mocks.realStore.upsertSaPhaseWeights.mockClear();
    mocks.realStore.close.mockClear();
    mocks.shadowStore.getSaPhaseWeights.mockClear();
    mocks.shadowStore.upsertSaPhaseWeights.mockClear();
    mocks.resolveRepoRoot.mockResolvedValue(tempDir);
  });

  afterEach(() => {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('runs calibration with defaults and prints the rendered diff', async () => {
    // Use an argv that does NOT end with cli-sa-calibrate.ts so the module
    // auto-main guard does not fire on import.
    process.argv = ['node', 'vitest-runner'];
    const mod = await import('./cli-sa-calibrate.js');
    await mod._main();

    expect(mocks.autoCalibratePhaseWeights).toHaveBeenCalledTimes(1);
    const call = mocks.autoCalibratePhaseWeights.mock.calls[0] as unknown[];
    const callArgs = call[0] as Record<string, unknown>;
    expect(callArgs.windowDays).toBeUndefined();
    expect(callArgs.shiftSize).toBeUndefined();
    // Real store is used (not dry-run)
    expect(callArgs.stateStore).toBe(mocks.realStore);

    expect(logSpy).toHaveBeenCalledWith('rendered-diff-output');
    // Not --dry-run → no dry-run trailer
    const joined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(joined).not.toContain('--dry-run');
    expect(mocks.realStore.close).toHaveBeenCalled();
  });

  it('passes --window-days and --shift-size to autoCalibratePhaseWeights', async () => {
    process.argv = ['node', 'vitest-runner', '--window-days', '30', '--shift-size', '0.10'];
    const mod = await import('./cli-sa-calibrate.js');
    await mod._main();

    const call = mocks.autoCalibratePhaseWeights.mock.calls[0] as unknown[];
    const callArgs = call[0] as Record<string, unknown>;
    expect(callArgs.windowDays).toBe(30);
    expect(callArgs.shiftSize).toBeCloseTo(0.1, 6);
  });

  it('--dry-run builds an in-memory shadow seeded from the real store', async () => {
    process.argv = ['node', 'vitest-runner', '--dry-run'];
    const mod = await import('./cli-sa-calibrate.js');
    await mod._main();

    // Shadow store was opened at :memory:
    expect(mocks.stateStoreOpen).toHaveBeenCalledWith(':memory:');
    // Existing SA-1 and SA-2 rows copied into the shadow
    expect(mocks.realStore.getSaPhaseWeights).toHaveBeenCalledWith('SA-1');
    expect(mocks.realStore.getSaPhaseWeights).toHaveBeenCalledWith('SA-2');
    expect(mocks.shadowStore.upsertSaPhaseWeights).toHaveBeenCalledTimes(2);

    // autoCalibratePhaseWeights was given the shadow — NOT the real store
    const call = mocks.autoCalibratePhaseWeights.mock.calls[0] as unknown[];
    const callArgs = call[0] as Record<string, unknown>;
    expect(callArgs.stateStore).toBe(mocks.shadowStore);

    // Dry-run trailer is logged
    const joined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(joined).toContain('--dry-run');
    expect(joined).toContain('no write');
  });

  it('shadowFromRealStore skips dimensions without persisted rows', async () => {
    // Return existing row only for SA-1; SA-2 absent
    mocks.realStore.getSaPhaseWeights.mockImplementation(
      (dim: string): MockRow =>
        dim === 'SA-1' ? { dimension: dim, wStructural: 0.4, wLlm: 0.6 } : undefined,
    );

    const mod = await import('./cli-sa-calibrate.js');
    const shadow = mod._shadowFromRealStore(mocks.realStore as never);
    expect(shadow).toBe(mocks.shadowStore);
    expect(mocks.shadowStore.upsertSaPhaseWeights).toHaveBeenCalledTimes(1);
    expect(mocks.shadowStore.upsertSaPhaseWeights).toHaveBeenCalledWith({
      dimension: 'SA-1',
      wStructural: 0.4,
      wLlm: 0.6,
    });
  });

  it('closes the real store even when calibration throws', async () => {
    mocks.autoCalibratePhaseWeights.mockRejectedValueOnce(new Error('boom'));
    process.argv = ['node', 'vitest-runner'];
    const mod = await import('./cli-sa-calibrate.js');
    await expect(mod._main()).rejects.toThrow('boom');
    expect(mocks.realStore.close).toHaveBeenCalled();
  });
});
