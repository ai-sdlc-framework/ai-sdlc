import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the orchestrator module before importing the CLI
vi.mock('@ai-sdlc/orchestrator', () => ({
  executeFixReview: vi.fn().mockResolvedValue(undefined),
  createPipelineSecurity: vi.fn().mockReturnValue({ sandbox: {} }),
  createPipelineMetricStore: vi.fn().mockReturnValue({}),
  createPipelineMemory: vi.fn().mockReturnValue({}),
  resolveRepoRoot: vi.fn().mockResolvedValue('/repo'),
  createPipelineAdapterRegistry: vi.fn().mockReturnValue({}),
  resolveInfrastructure: vi.fn().mockReturnValue({
    auditLog: {},
    secretStore: {},
  }),
}));

describe('cli-fix-review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses PR number from args', async () => {
    const { executeFixReview } = await import('@ai-sdlc/orchestrator');

    // Mock process.argv
    const originalArgv = process.argv;
    process.argv = ['node', 'cli-fix-review.ts', '--pr', '42'];

    // Dynamically import to trigger arg parsing
    await import('./cli-fix-review.js');

    expect(executeFixReview).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        workDir: '/repo',
      }),
    );

    process.argv = originalArgv;
  });

  it('exits with error on missing PR arg', async () => {
    const originalArgv = process.argv;
    const originalExit = process.exit;
    const exitMock = vi.fn() as unknown as typeof process.exit;
    process.exit = exitMock;
    process.argv = ['node', 'cli-fix-review.ts']; // Missing --pr

    // The module throws before we can catch it
    await expect(async () => {
      // This will call process.exit(1)
      await import('./cli-fix-review.js');
    }).rejects.toThrow();

    process.argv = originalArgv;
    process.exit = originalExit;
  });

  it('exits with error on invalid PR number', async () => {
    const originalArgv = process.argv;
    const originalExit = process.exit;
    const exitMock = vi.fn() as unknown as typeof process.exit;
    process.exit = exitMock;
    process.argv = ['node', 'cli-fix-review.ts', '--pr', 'invalid'];

    await expect(async () => {
      await import('./cli-fix-review.js');
    }).rejects.toThrow();

    process.argv = originalArgv;
    process.exit = originalExit;
  });
});
