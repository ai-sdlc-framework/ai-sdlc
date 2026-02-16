import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ValidationContext } from './validate-agent-output.js';

// Mock child_process.execFile for git diff --stat
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      (cb as (err: null, stdout: string, stderr: string) => void)(
        null,
        ' 3 files changed, 40 insertions(+), 12 deletions(-)\n',
        '',
      );
    }
    return { stdout: '', stderr: '' };
  }),
}));

import { execFile } from 'node:child_process';
import { validateAgentOutput } from './validate-agent-output.js';

const mockedExecFile = vi.mocked(execFile);

function setDiffStatOutput(output: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedExecFile.mockImplementation(((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      cb(null, output, '');
    }
    return { stdout: '', stderr: '' };
  }) as unknown as typeof execFile);
}

function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
    workDir: '/tmp/test-repo',
    constraints: {
      maxFilesPerChange: 15,
      requireTests: true,
      blockedPaths: ['.github/workflows/**', '.ai-sdlc/**'],
    },
    guardrails: {},
    ...overrides,
  };
}

describe('validateAgentOutput()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDiffStatOutput(' 3 files changed, 40 insertions(+), 12 deletions(-)\n');
  });

  it('passes when all constraints are met', async () => {
    const result = await validateAgentOutput(makeContext());
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects blocked path hit', async () => {
    const result = await validateAgentOutput(
      makeContext({ filesChanged: ['.github/workflows/ci.yml', 'src/fix.test.ts'] }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'blocked-path' }));
  });

  it('passes when file does not match blocked path', async () => {
    const result = await validateAgentOutput(
      makeContext({ filesChanged: ['src/index.ts', 'src/index.test.ts'] }),
    );
    expect(result.passed).toBe(true);
  });

  it('detects file count over limit', async () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    files.push('src/file.test.ts');
    const result = await validateAgentOutput(
      makeContext({
        filesChanged: files,
        constraints: {
          maxFilesPerChange: 15,
          requireTests: true,
          blockedPaths: [],
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'max-files' }));
  });

  it('passes when file count is under limit', async () => {
    const result = await validateAgentOutput(
      makeContext({
        filesChanged: ['src/a.ts', 'src/a.test.ts'],
        constraints: { maxFilesPerChange: 15, requireTests: true, blockedPaths: [] },
      }),
    );
    expect(result.passed).toBe(true);
  });

  it('detects max lines exceeded', async () => {
    setDiffStatOutput(' 5 files changed, 180 insertions(+), 50 deletions(-)\n');

    const result = await validateAgentOutput(makeContext({ guardrails: { maxLinesPerPR: 200 } }));
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: 'max-lines', message: expect.stringContaining('230') }),
    );
  });

  it('passes when lines are under limit', async () => {
    setDiffStatOutput(' 2 files changed, 30 insertions(+), 10 deletions(-)\n');

    const result = await validateAgentOutput(makeContext({ guardrails: { maxLinesPerPR: 200 } }));
    expect(result.passed).toBe(true);
  });

  it('skips max lines check when maxLinesPerPR is undefined', async () => {
    const result = await validateAgentOutput(makeContext({ guardrails: {} }));
    expect(result.passed).toBe(true);
    // execFile should not have been called (no git diff needed)
    expect(execFile).not.toHaveBeenCalled();
  });

  it('detects missing test files', async () => {
    const result = await validateAgentOutput(makeContext({ filesChanged: ['src/fix.ts'] }));
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ rule: 'require-tests' }));
  });

  it('passes when test file is present (*.spec.*)', async () => {
    const result = await validateAgentOutput(
      makeContext({ filesChanged: ['src/fix.ts', 'src/fix.spec.ts'] }),
    );
    expect(result.passed).toBe(true);
  });

  it('reports multiple violations at once', async () => {
    setDiffStatOutput(' 20 files changed, 300 insertions(+), 100 deletions(-)\n');

    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    files.push('.ai-sdlc/pipeline.yaml');
    const result = await validateAgentOutput(
      makeContext({
        filesChanged: files,
        constraints: { maxFilesPerChange: 15, requireTests: true, blockedPaths: ['.ai-sdlc/**'] },
        guardrails: { maxLinesPerPR: 200 },
      }),
    );
    expect(result.passed).toBe(false);
    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain('blocked-path');
    expect(rules).toContain('max-files');
    expect(rules).toContain('max-lines');
    expect(rules).toContain('require-tests');
  });
});
