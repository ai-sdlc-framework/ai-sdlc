import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The scoreIssueForAdmission / enrichAdmissionInput spies are set per-test
// via vi.hoisted so `vi.mock` can reference them at module-initialization.
const mocks = vi.hoisted(() => ({
  scoreIssueForAdmission: vi.fn(() => ({
    admitted: true,
    score: {
      composite: 0.42,
      dimensions: {
        soulAlignment: 0.6,
        demandPressure: 0.4,
        marketForce: 1,
        executionReality: 0.7,
        entropyTax: 0,
        humanCurve: 0.1,
        calibration: 1,
      },
      confidence: 0.5,
      timestamp: '2026-04-24T00:00:00Z',
    },
    reason: 'ok',
    pillarBreakdown: {
      product: {
        pillar: 'product',
        governedDimensions: ['SA-1', 'D-pi', 'HC_explicit'],
        signal: 0.5,
        interpretation: 'neutral Product signal',
      },
      design: {
        pillar: 'design',
        governedDimensions: ['ER-4', 'HC_design'],
        signal: 0.8,
        interpretation: 'strong Design signal',
      },
      engineering: {
        pillar: 'engineering',
        governedDimensions: ['ER-1', 'ER-2', 'ER-3'],
        signal: 0.5,
        interpretation: 'neutral Engineering signal',
      },
      shared: {
        hcComposite: { explicit: 0, consensus: 0, decision: 0, design: 0, value: 0 },
      },
      tensions: [],
    },
  })),
  enrichAdmissionInput: vi.fn((input: unknown, _ctx: unknown) => {
    void _ctx;
    return input;
  }),
  stateStoreOpen: vi.fn(() => ({ close: vi.fn() })),
  loadConfigAsync: vi.fn().mockResolvedValue({
    pipeline: { spec: { priorityPolicy: { minimumScore: 0.05, minimumConfidence: 0.2 } } },
    designSystemBindings: [
      {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'DesignSystemBinding',
        metadata: { name: 'acme-ds' },
        spec: {},
      },
    ],
    designIntentDocuments: [
      {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'DesignIntentDocument',
        metadata: { name: 'acme-did' },
        spec: {},
      },
    ],
    autonomyPolicy: {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'AutonomyPolicy',
      metadata: { name: 'acme-ap' },
      spec: {},
      status: { agents: [{ name: 'devloop', currentLevel: 2 }] },
    },
  }),
  resolveRepoRoot: vi.fn(),
}));

vi.mock('@ai-sdlc/orchestrator', () => ({
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
  loadConfigAsync: mocks.loadConfigAsync,
  resolveRepoRoot: mocks.resolveRepoRoot,
  scoreIssueForAdmission: mocks.scoreIssueForAdmission,
  enrichAdmissionInput: mocks.enrichAdmissionInput,
  StateStore: { open: mocks.stateStoreOpen },
}));

describe('cli-admit.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;
  let bodyFile: string;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error — spying on process.exit in tests
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'admit-test-'));
    bodyFile = join(tempDir, 'body.txt');
    writeFileSync(bodyFile, '### Complexity\n3\n');

    mocks.scoreIssueForAdmission.mockClear();
    mocks.enrichAdmissionInput.mockClear();
    mocks.stateStoreOpen.mockClear();
    mocks.resolveRepoRoot.mockResolvedValue(tempDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('AC #1: without --enrich-from-state, does NOT call enrichAdmissionInput (stateless)', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      'fix thing',
      '--body-file',
      bodyFile,
      '--issue-number',
      '7',
      '--labels',
      '["bug"]',
      '--reactions',
      '2',
      '--comments',
      '1',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--author-association',
      'OWNER',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.scoreIssueForAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.enrichAdmissionInput).not.toHaveBeenCalled();
    expect(mocks.stateStoreOpen).not.toHaveBeenCalled();
  });

  it('AC #2: with --enrich-from-state, calls enrichAdmissionInput with resolved refs', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      'fix thing',
      '--body-file',
      bodyFile,
      '--issue-number',
      '7',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--author-association',
      'MEMBER',
      '--author-login',
      'alice',
      '--code-area',
      'components/Button.tsx',
      '--enrich-from-state',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.enrichAdmissionInput).toHaveBeenCalledTimes(1);
    const [admissionInput, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(admissionInput.authorLogin).toBe('alice');
    expect(ctx.codeArea).toBe('components/Button.tsx');
    expect((ctx.designSystemBinding as { metadata: { name: string } }).metadata.name).toBe(
      'acme-ds',
    );
    expect((ctx.designIntentDocument as { metadata: { name: string } }).metadata.name).toBe(
      'acme-did',
    );
    expect((ctx.autonomyPolicy as { metadata: { name: string } }).metadata.name).toBe('acme-ap');
  });

  it('AC #4: JSON output includes pillarBreakdown with tension array', async () => {
    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.pillarBreakdown).toBeDefined();
    expect(parsed.pillarBreakdown.product).toBeDefined();
    expect(parsed.pillarBreakdown.design).toBeDefined();
    expect(parsed.pillarBreakdown.engineering).toBeDefined();
    expect(Array.isArray(parsed.pillarBreakdown.tensions)).toBe(true);
  });

  it('honours --design-system-ref when multiple bindings exist', async () => {
    mocks.loadConfigAsync.mockResolvedValueOnce({
      pipeline: { spec: { priorityPolicy: {} } },
      designSystemBindings: [
        {
          apiVersion: 'ai-sdlc.io/v1alpha1',
          kind: 'DesignSystemBinding',
          metadata: { name: 'team-a' },
          spec: {},
        },
        {
          apiVersion: 'ai-sdlc.io/v1alpha1',
          kind: 'DesignSystemBinding',
          metadata: { name: 'team-b' },
          spec: {},
        },
      ],
    });

    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--enrich-from-state',
      '--design-system-ref',
      'team-b',
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    const [, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((ctx.designSystemBinding as { metadata: { name: string } }).metadata.name).toBe(
      'team-b',
    );
  });

  it('AC #3: workflow stays backward-compat when .ai-sdlc config is absent', async () => {
    mocks.loadConfigAsync.mockResolvedValueOnce({});
    mocks.resolveRepoRoot.mockResolvedValueOnce(tempDir);

    process.argv = [
      'node',
      'cli-admit.ts',
      '--title',
      't',
      '--body-file',
      bodyFile,
      '--issue-number',
      '1',
      '--labels',
      '[]',
      '--reactions',
      '0',
      '--comments',
      '0',
      '--created-at',
      '2026-04-01T00:00:00Z',
      '--enrich-from-state', // flag present even though config absent
    ];
    await import('./cli-admit.js');
    await new Promise((r) => setTimeout(r, 50));

    // enrichAdmissionInput still called (with empty ctx → returns input unchanged)
    expect(mocks.enrichAdmissionInput).toHaveBeenCalled();
    const [, ctx] = mocks.enrichAdmissionInput.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ctx.designSystemBinding).toBeUndefined();
    expect(ctx.designIntentDocument).toBeUndefined();
    expect(ctx.autonomyPolicy).toBeUndefined();
    expect(mocks.scoreIssueForAdmission).toHaveBeenCalled();
  });
});
