import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all orchestrator dependencies before importing cli
vi.mock('@ai-sdlc/orchestrator', () => ({
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

describe('cli.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error -- mock process.exit for test
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('calls executePipeline with the issue ID on valid args', async () => {
    process.argv = ['node', 'cli.ts', '--issue', '42'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    const { executePipeline } = await import('@ai-sdlc/orchestrator');
    expect(executePipeline).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        useStructuredLogger: true,
        includeProvenance: true,
      }),
    );
  });

  it('handles executePipeline rejection gracefully', async () => {
    const { executePipeline } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executePipeline).mockRejectedValueOnce(new Error('Pipeline failed'));

    process.argv = ['node', 'cli.ts', '--issue', '99'];

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith('Pipeline failed');
  });

  it('handles non-Error exception in pipeline', async () => {
    const { executePipeline } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executePipeline).mockRejectedValueOnce('string error');

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
});
