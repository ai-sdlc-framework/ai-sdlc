import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn().mockResolvedValue({ success: true });
const mockClose = vi.fn().mockResolvedValue(undefined);

// Mock all orchestrator dependencies before importing cli
vi.mock('@ai-sdlc/orchestrator', () => ({
  Orchestrator: vi.fn().mockImplementation(() => ({
    run: mockRun,
    close: mockClose,
  })),
  executePipeline: vi.fn().mockResolvedValue({ success: true }),
  createPipelineSecurity: vi.fn().mockReturnValue({}),
  createPipelineMetricStore: vi.fn().mockReturnValue({}),
  createPipelineMemory: vi.fn().mockReturnValue({}),
  resolveRepoRoot: vi.fn().mockResolvedValue('/tmp/mock-repo'),
  createPipelineAdmission: vi.fn().mockReturnValue({}),
  loadConfig: vi.fn().mockReturnValue({}),
  createPipelineAdapterRegistry: vi.fn().mockReturnValue({}),
  resolveInfrastructure: vi.fn().mockReturnValue({
    sandbox: {},
    auditLog: { append: vi.fn() },
    secretStore: { get: vi.fn() },
  }),
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
}));

// Mock enterprise plugins (not installed in test env)
vi.mock('@ai-sdlc-enterprise/plugins', () => {
  throw new Error('not installed');
});

describe('cli.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error -- mock process.exit for test
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRun.mockClear();
    mockClose.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits with error when --issue is missing', async () => {
    process.argv = ['node', 'cli.ts'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Usage: execute --issue <id>');
  });

  it('calls Orchestrator.run with the issue ID on valid args', async () => {
    process.argv = ['node', 'cli.ts', '--issue', '42'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRun).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        useStructuredLogger: true,
        includeProvenance: true,
      }),
    );
  });

  it('handles Orchestrator.run rejection gracefully', async () => {
    mockRun.mockRejectedValueOnce(new Error('Pipeline failed'));

    process.argv = ['node', 'cli.ts', '--issue', '99'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith('Pipeline failed');
  });

  it('handles non-Error exception in pipeline', async () => {
    mockRun.mockRejectedValueOnce('string error');

    process.argv = ['node', 'cli.ts', '--issue', '55'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith('string error');
  });

  it('creates admission when qualityGate config is present', async () => {
    const { loadConfig, createPipelineAdmission } = await import('@ai-sdlc/orchestrator');
    vi.mocked(loadConfig).mockReturnValueOnce({
      // @ts-expect-error -- partial mock for test
      qualityGate: { spec: { gates: [] } },
    });

    process.argv = ['node', 'cli.ts', '--issue', '10'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(createPipelineAdmission).toHaveBeenCalled();
  });

  it('logs enterprise plugins not available when package missing', async () => {
    process.argv = ['node', 'cli.ts', '--issue', '7'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Enterprise plugins not available'),
    );
  });
});
