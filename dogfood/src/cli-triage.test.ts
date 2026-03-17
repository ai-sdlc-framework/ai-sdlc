import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('@ai-sdlc/orchestrator', () => ({
  executeTriage: vi.fn().mockResolvedValue({
    issueId: '42',
    verdict: {
      safe: true,
      riskScore: 2,
      findings: [],
      sanitizedDescription: 'clean',
      rationale: 'No issues found',
    },
    rejected: false,
    labelApplied: 'triage:safe',
  }),
  resolveRepoRoot: vi.fn().mockResolvedValue('/tmp/mock-repo'),
  SecurityTriageRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      success: true,
      summary: JSON.stringify({
        safe: true,
        riskScore: 1,
        findings: [],
        sanitizedDescription: '',
        rationale: 'OK',
      }),
    }),
  })),
}));

describe('cli-triage.ts', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as unknown as () => never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('exits with error when neither --issue nor --title is provided', async () => {
    process.argv = ['node', 'cli-triage.ts'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: triage'));
  });

  it('runs full triage when --issue is provided', async () => {
    process.argv = ['node', 'cli-triage.ts', '--issue', '42'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    const { executeTriage } = await import('@ai-sdlc/orchestrator');
    expect(executeTriage).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        workDir: '/tmp/mock-repo',
        dryRun: false,
      }),
    );
  });

  it('runs full triage with --dry-run flag', async () => {
    process.argv = ['node', 'cli-triage.ts', '--issue', '42', '--dry-run'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    const { executeTriage } = await import('@ai-sdlc/orchestrator');
    expect(executeTriage).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        dryRun: true,
      }),
    );
  });

  it('runs analyze-only mode when --title is provided', async () => {
    process.argv = ['node', 'cli-triage.ts', '--title', 'Test issue', '--body', 'Some body'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    // In title mode, it should use SecurityTriageRunner directly
    const { SecurityTriageRunner } = await import('@ai-sdlc/orchestrator');
    expect(SecurityTriageRunner).toHaveBeenCalled();
  });

  it('handles full triage error result', async () => {
    const { executeTriage } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executeTriage).mockResolvedValueOnce({
      issueId: '42',
      verdict: {
        safe: false,
        riskScore: 8,
        findings: ['SQL injection detected'],
        sanitizedDescription: '',
        rationale: 'Dangerous input',
      },
      rejected: true,
      error: 'Security violation',
    });

    process.argv = ['node', 'cli-triage.ts', '--issue', '42'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Security violation'));
  });

  it('handles full triage exception gracefully', async () => {
    const { executeTriage } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executeTriage).mockRejectedValueOnce(new Error('Network error'));

    process.argv = ['node', 'cli-triage.ts', '--issue', '99'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith('Network error');
  });

  it('outputs error verdict JSON when analyze-only runner fails', async () => {
    const { SecurityTriageRunner } = await import('@ai-sdlc/orchestrator');
    vi.mocked(SecurityTriageRunner).mockImplementationOnce(
      () =>
        ({
          run: vi.fn().mockResolvedValue({
            success: false,
            error: 'Analysis failed',
          }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    process.argv = ['node', 'cli-triage.ts', '--title', 'Bad issue', '--dry-run'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    // It should log an error verdict as JSON and call process.exit(1)
    const logCalls = logSpy.mock.calls.flat();
    const jsonCall = logCalls.find((c) => typeof c === 'string' && c.includes('"safe":false'));
    expect(jsonCall).toBeTruthy();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints triage result with findings and label', async () => {
    const { executeTriage } = await import('@ai-sdlc/orchestrator');
    vi.mocked(executeTriage).mockResolvedValueOnce({
      issueId: '42',
      verdict: {
        safe: true,
        riskScore: 3,
        findings: ['Minor issue found', 'Another finding'],
        sanitizedDescription: 'OK',
        rationale: 'Low risk',
      },
      rejected: false,
      labelApplied: 'triage:low',
    });

    process.argv = ['node', 'cli-triage.ts', '--issue', '42'];

    await import('./cli-triage.js');
    await new Promise((r) => setTimeout(r, 50));

    const logCalls = logSpy.mock.calls.flat();
    expect(logCalls.some((c: string) => c.includes('Security Triage Result'))).toBe(true);
    expect(logCalls.some((c: string) => c.includes('triage:low'))).toBe(true);
  });
});
