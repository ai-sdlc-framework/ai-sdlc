import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the variable exists before vi.mock factories run (hoisting).
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));

import { gitExec, detectChangedFiles, runAutoFix } from './git-utils.js';

describe('gitExec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a git command and returns trimmed stdout', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '  main  \n', stderr: '' });

    const result = await gitExec('/tmp/repo', ['branch', '--show-current']);
    expect(result).toBe('main');
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['branch', '--show-current'], {
      cwd: '/tmp/repo',
    });
  });

  it('trims whitespace from output', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '\n  file1.ts\nfile2.ts\n  ', stderr: '' });

    const result = await gitExec('/tmp/repo', ['diff', '--name-only']);
    expect(result).toBe('file1.ts\nfile2.ts');
  });

  it('passes the working directory as cwd', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await gitExec('/my/project', ['status']);
    expect(mockExecFileAsync).toHaveBeenCalledWith('git', ['status'], { cwd: '/my/project' });
  });

  it('propagates errors from git', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('fatal: not a git repository'));

    await expect(gitExec('/tmp/bad', ['status'])).rejects.toThrow('not a git repository');
  });

  it('handles empty args', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'git version 2.43.0', stderr: '' });

    const result = await gitExec('/tmp/repo', []);
    expect(result).toBe('git version 2.43.0');
  });

  it('returns empty string for empty stdout', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await gitExec('/tmp/repo', ['diff', '--name-only']);
    expect(result).toBe('');
  });
});

describe('detectChangedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupSequence(results: Array<{ stdout?: string; error?: string }>) {
    let callIndex = 0;
    mockExecFileAsync.mockImplementation(() => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      if (result.error) {
        return Promise.reject(new Error(result.error));
      }
      return Promise.resolve({ stdout: result.stdout ?? '', stderr: '' });
    });
  }

  it('returns empty when no uncommitted or committed changes', async () => {
    setupSequence([
      { stdout: '' }, // git diff --name-only
      { stdout: '' }, // git ls-files --others --exclude-standard
      { stdout: 'abc123' }, // git merge-base HEAD origin/main
      { stdout: '' }, // git diff --name-only abc123..HEAD
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual([]);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('returns uncommitted files when there are local changes', async () => {
    setupSequence([
      { stdout: 'src/foo.ts\nsrc/bar.ts' }, // git diff --name-only
      { stdout: 'src/new.ts' }, // git ls-files --others
      { stdout: 'abc123' }, // git merge-base
      { stdout: '' }, // git diff merge-base..HEAD
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/foo.ts', 'src/bar.ts', 'src/new.ts']);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('detects agent-committed changes when no uncommitted files but commits ahead', async () => {
    setupSequence([
      { stdout: '' }, // git diff --name-only (no uncommitted)
      { stdout: '' }, // git ls-files --others (no untracked)
      { stdout: 'abc123' }, // git merge-base
      { stdout: 'src/committed.ts\nREADME.md' }, // git diff merge-base..HEAD
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/committed.ts', 'README.md']);
    expect(result.agentAlreadyCommitted).toBe(true);
  });

  it('returns uncommitted files even when there are also committed changes', async () => {
    setupSequence([
      { stdout: 'src/modified.ts' }, // git diff --name-only
      { stdout: '' }, // git ls-files --others
      { stdout: 'abc123' }, // git merge-base
      { stdout: 'src/committed.ts' }, // git diff merge-base..HEAD
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    // When there are uncommitted files, agentAlreadyCommitted is false
    expect(result.agentAlreadyCommitted).toBe(false);
    expect(result.filesChanged).toEqual(['src/modified.ts']);
  });

  it('handles merge-base failure gracefully (no origin/main)', async () => {
    setupSequence([
      { stdout: 'src/foo.ts' }, // git diff --name-only
      { stdout: '' }, // git ls-files --others
      { error: 'fatal: Not a valid object name origin/main' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/foo.ts']);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('filters empty lines from git output', async () => {
    setupSequence([
      { stdout: '\n\nfile1.ts\n\nfile2.ts\n\n' }, // diff with extra newlines
      { stdout: '\n' }, // ls-files with just newline
      { error: 'no merge base' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
  });

  it('combines diff and untracked files', async () => {
    setupSequence([
      { stdout: 'a.ts' }, // git diff
      { stdout: 'b.ts' }, // git ls-files
      { error: 'no base' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['a.ts', 'b.ts']);
  });
});

describe('runAutoFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs format command then lint command', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await runAutoFix('/tmp/repo', 'pnpm lint --fix', 'pnpm format');

    // Should have been called twice: once for format, once for lint
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    // First call is format
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, 'pnpm', ['format'], { cwd: '/tmp/repo' });
    // Second call is lint
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(2, 'pnpm', ['lint', '--fix'], {
      cwd: '/tmp/repo',
    });
  });

  it('does nothing when both commands are undefined', async () => {
    await runAutoFix('/tmp/repo', undefined, undefined);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('runs only format when lint is undefined', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await runAutoFix('/tmp/repo', undefined, 'prettier --write .');
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith('prettier', ['--write', '.'], {
      cwd: '/tmp/repo',
    });
  });

  it('runs only lint when format is undefined', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await runAutoFix('/tmp/repo', 'eslint --fix .', undefined);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith('eslint', ['--fix', '.'], {
      cwd: '/tmp/repo',
    });
  });

  it('swallows format failures silently', async () => {
    let callIndex = 0;
    mockExecFileAsync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.reject(new Error('format failed'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(runAutoFix('/tmp/repo', 'pnpm lint', 'pnpm format')).resolves.toBeUndefined();
  });

  it('swallows lint failures silently', async () => {
    let callIndex = 0;
    mockExecFileAsync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 2) return Promise.reject(new Error('lint failed'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(runAutoFix('/tmp/repo', 'pnpm lint', 'pnpm format')).resolves.toBeUndefined();
  });

  it('swallows both format and lint failures silently', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('command failed'));

    await expect(runAutoFix('/tmp/repo', 'pnpm lint', 'pnpm format')).resolves.toBeUndefined();
  });

  it('splits multi-word commands into binary + args', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await runAutoFix('/tmp/repo', undefined, 'npx prettier --write --check .');

    expect(mockExecFileAsync).toHaveBeenCalledWith('npx', ['prettier', '--write', '--check', '.'], {
      cwd: '/tmp/repo',
    });
  });
});
