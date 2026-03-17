import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all orchestrator dependencies
const mockHandle = {
  enqueue: vi.fn(),
  stop: vi.fn(),
  queueSize: 0,
  activeCount: 0,
};

vi.mock('@ai-sdlc/orchestrator', () => ({
  startWatch: vi.fn().mockReturnValue(mockHandle),
  createPipelineSecurity: vi.fn().mockReturnValue({}),
  createPipelineMetricStore: vi.fn().mockReturnValue({}),
  createPipelineMemory: vi.fn().mockReturnValue({}),
  resolveRepoRoot: vi.fn().mockResolvedValue('/tmp/mock-repo'),
  loadConfig: vi.fn().mockReturnValue({
    pipeline: { metadata: { name: 'test-pipeline' } },
  }),
  createPipelineAdapterRegistry: vi.fn().mockReturnValue({}),
  resolveInfrastructure: vi.fn().mockReturnValue({
    sandbox: {},
    auditLog: { append: vi.fn() },
    secretStore: { get: vi.fn() },
  }),
  DEFAULT_CONFIG_DIR_NAME: '.ai-sdlc',
}));

describe('cli-watch.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    // @ts-expect-error -- mock process.exit for test
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    vi.clearAllMocks();
    // Reset mockHandle state
    mockHandle.enqueue.mockClear();
    mockHandle.stop.mockClear();
    mockHandle.queueSize = 0;
    mockHandle.activeCount = 0;
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('exits with error when no --issue is provided', async () => {
    process.argv = ['node', 'cli-watch.ts'];

    await import('./cli-watch.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: watch'));
  });

  it('exits with error when --issue value is empty after trim', async () => {
    process.argv = ['node', 'cli-watch.ts', '--issue', '  '];

    await import('./cli-watch.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid issue ID'));
  });

  it('exits with error when no pipeline config is found', async () => {
    const { loadConfig } = await import('@ai-sdlc/orchestrator');
    vi.mocked(loadConfig).mockReturnValueOnce({});

    process.argv = ['node', 'cli-watch.ts', '--issue', '42'];

    await import('./cli-watch.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No Pipeline resource found'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('enqueues issues and starts watch with valid args', async () => {
    process.argv = ['node', 'cli-watch.ts', '--issue', '42', '--issue', '43'];

    await import('./cli-watch.js');
    await new Promise((r) => setTimeout(r, 50));

    const { startWatch } = await import('@ai-sdlc/orchestrator');
    expect(startWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        executeOptions: expect.objectContaining({
          useStructuredLogger: true,
          includeProvenance: true,
        }),
      }),
    );
    expect(mockHandle.enqueue).toHaveBeenCalledTimes(2);
  });

  it('collects multiple issue IDs from repeated --issue flags', async () => {
    process.argv = ['node', 'cli-watch.ts', '--issue', '1', '--issue', '2', '--issue', '3'];

    await import('./cli-watch.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(mockHandle.enqueue).toHaveBeenCalledTimes(3);
  });
});
