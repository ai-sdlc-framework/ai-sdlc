import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all orchestrator dependencies
vi.mock('@ai-sdlc/orchestrator', () => ({
  executeFixCI: vi.fn().mockResolvedValue({ success: true }),
  createPipelineSecurity: vi.fn().mockReturnValue({}),
  createPipelineMetricStore: vi.fn().mockReturnValue({}),
  createPipelineMemory: vi.fn().mockReturnValue({}),
  resolveRepoRoot: vi.fn().mockResolvedValue('/tmp/mock-repo'),
  createPipelineAdapterRegistry: vi.fn().mockReturnValue({}),
  resolveInfrastructure: vi.fn().mockReturnValue({
    sandbox: {},
    auditLog: { append: vi.fn() },
    secretStore: { get: vi.fn() },
  }),
}));

describe('cli-fix-ci.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as unknown as () => never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits with error when --pr is missing', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--run-id', '123'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: fix-ci'));
  });

  it('exits with error when --run-id is missing', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--pr', '42'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: fix-ci'));
  });

  it('exits with error when --pr value is not a positive integer', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--pr', 'abc', '--run-id', '123'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PR number'));
  });

  it('exits with error when --run-id value is not a positive integer', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--pr', '42', '--run-id', '-5'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid run ID'));
  });

  it('exits with error when --pr is zero', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--pr', '0', '--run-id', '123'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PR number'));
  });

  it('calls executeFixCI with valid args', async () => {
    process.argv = ['node', 'cli-fix-ci.ts', '--pr', '42', '--run-id', '12345'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    const { executeFixCI } = await import('@ai-sdlc/orchestrator');
    expect(executeFixCI).toHaveBeenCalledWith(
      42,
      12345,
      expect.objectContaining({
        useStructuredLogger: true,
      }),
    );
  });

  it('handles executeFixCI rejection gracefully', async () => {
    const { executeFixCI } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executeFixCI).mockRejectedValueOnce(new Error('CI fix failed'));

    process.argv = ['node', 'cli-fix-ci.ts', '--pr', '10', '--run-id', '999'];

    await import('./cli-fix-ci.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith('CI fix failed');
  });
});
