import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures the variable exists before vi.mock factories run (hoisting).
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  gitExec,
  detectChangedFiles,
  runAutoFix,
  snapshotWorktree,
  detectCrossRepoWrites,
} from './git-utils.js';

describe('gitExec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a git command and returns trimmed stdout', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '  main  \n', stderr: '' });

    const result = await gitExec('/tmp/repo', ['branch', '--show-current']);
    expect(result).toBe('main');
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-c', 'core.quotePath=false', 'branch', '--show-current'],
      { cwd: '/tmp/repo' },
    );
  });

  it('always prepends -c core.quotePath=false so unicode paths come back raw', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    await gitExec('/tmp/repo', ['diff', '--name-only']);
    const args = mockExecFileAsync.mock.calls[0][1];
    expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false']);
  });

  it('trims whitespace from output', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '\n  file1.ts\nfile2.ts\n  ', stderr: '' });

    const result = await gitExec('/tmp/repo', ['diff', '--name-only']);
    expect(result).toBe('file1.ts\nfile2.ts');
  });

  it('passes the working directory as cwd', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

    await gitExec('/my/project', ['status']);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-c', 'core.quotePath=false', 'status'],
      { cwd: '/my/project' },
    );
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
      { stdout: '' }, // git diff --name-only (unstaged)
      { stdout: '' }, // git diff --name-only --cached (staged)
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
      { stdout: 'src/foo.ts\nsrc/bar.ts' }, // git diff --name-only (unstaged)
      { stdout: '' }, // git diff --name-only --cached (no staged)
      { stdout: 'src/new.ts' }, // git ls-files --others
      { stdout: 'abc123' }, // git merge-base
      { stdout: '' }, // git diff merge-base..HEAD
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged.sort()).toEqual(['src/bar.ts', 'src/foo.ts', 'src/new.ts']);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('returns staged files (agent self-staged via git add)', async () => {
    setupSequence([
      { stdout: '' }, // unstaged
      { stdout: 'src/agent-staged.ts\nREADME.md' }, // staged
      { stdout: '' }, // untracked
      { error: 'no merge base' },
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged.sort()).toEqual(['README.md', 'src/agent-staged.ts']);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('dedupes when a file is in both staged and unstaged diffs', async () => {
    setupSequence([
      { stdout: 'src/foo.ts' }, // unstaged
      { stdout: 'src/foo.ts\nsrc/bar.ts' }, // staged (overlaps with unstaged on foo.ts)
      { stdout: '' }, // untracked
      { error: 'no merge base' },
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged.sort()).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('detects agent-committed changes when no uncommitted files but commits ahead', async () => {
    setupSequence([
      { stdout: '' }, // unstaged
      { stdout: '' }, // staged
      { stdout: '' }, // untracked
      { stdout: 'abc123' }, // merge-base
      { stdout: 'src/committed.ts\nREADME.md' }, // commit-diff
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/committed.ts', 'README.md']);
    expect(result.agentAlreadyCommitted).toBe(true);
  });

  it('returns uncommitted files even when there are also committed changes', async () => {
    setupSequence([
      { stdout: 'src/modified.ts' }, // unstaged
      { stdout: '' }, // staged
      { stdout: '' }, // untracked
      { stdout: 'abc123' }, // merge-base
      { stdout: 'src/committed.ts' }, // commit-diff
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    // When there are uncommitted files, agentAlreadyCommitted is false
    expect(result.agentAlreadyCommitted).toBe(false);
    expect(result.filesChanged).toEqual(['src/modified.ts']);
  });

  it('handles merge-base failure gracefully (no origin/main)', async () => {
    setupSequence([
      { stdout: 'src/foo.ts' }, // unstaged
      { stdout: '' }, // staged
      { stdout: '' }, // untracked
      { error: 'fatal: Not a valid object name origin/main' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged).toEqual(['src/foo.ts']);
    expect(result.agentAlreadyCommitted).toBe(false);
  });

  it('filters empty lines from git output', async () => {
    setupSequence([
      { stdout: '\n\nfile1.ts\n\nfile2.ts\n\n' }, // unstaged with extra newlines
      { stdout: '' }, // staged
      { stdout: '\n' }, // ls-files with just newline
      { error: 'no merge base' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged.sort()).toEqual(['file1.ts', 'file2.ts']);
  });

  it('combines diff and untracked files', async () => {
    setupSequence([
      { stdout: 'a.ts' }, // unstaged diff
      { stdout: '' }, // staged
      { stdout: 'b.ts' }, // ls-files
      { error: 'no base' }, // merge-base fails
    ]);

    const result = await detectChangedFiles('/tmp/repo');
    expect(result.filesChanged.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('subtracts pre-existing untracked files from filesChanged when baseline is provided', async () => {
    setupSequence([
      { stdout: 'mod.ts' }, // git diff (post-agent)
      { stdout: '' }, // staged
      { stdout: 'mod.ts\n.db-wal\nstale.md\nnew.ts' }, // ls-files (post-agent: pre-existing + new)
      { error: 'no base' },
    ]);

    const baseline = {
      untracked: new Set(['.db-wal', 'stale.md']),
      modified: new Set<string>(),
    };
    const result = await detectChangedFiles('/tmp/repo', baseline);

    // Only the agent's new file (`new.ts`) survives — the user's stale
    // untracked files (`.db-wal`, `stale.md`) are filtered out.
    expect(result.filesChanged).not.toContain('.db-wal');
    expect(result.filesChanged).not.toContain('stale.md');
    expect(result.filesChanged).toContain('new.ts');
  });
});

describe('snapshotWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the untracked + modified file sets', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '.db-wal\ndraft.md', stderr: '' }) // ls-files
      .mockResolvedValueOnce({ stdout: 'src/foo.ts', stderr: '' }); // diff

    const baseline = await snapshotWorktree('/tmp/repo');
    expect(baseline.untracked.has('.db-wal')).toBe(true);
    expect(baseline.untracked.has('draft.md')).toBe(true);
    expect(baseline.modified.has('src/foo.ts')).toBe(true);
  });

  it('returns an empty baseline when git fails (degrades gracefully)', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('git not a repo'));

    const baseline = await snapshotWorktree('/tmp/not-a-repo');
    expect(baseline.untracked.size).toBe(0);
    expect(baseline.modified.size).toBe(0);
  });
});

describe('detectCrossRepoWrites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when rev-parse fails (workDir is not a git repo)', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('not a git repository'));
    const writes = await detectCrossRepoWrites('/tmp/not-a-repo');
    expect(writes).toEqual([]);
  });

  it('returns [] when readdir on the parent directory fails', async () => {
    // rev-parse succeeds, but the synthetic path's parent doesn't exist —
    // readdir throws ENOENT and the function catches and returns [].
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ stdout: '/nonexistent/lonely-repo\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const writes = await detectCrossRepoWrites('/nonexistent/lonely-repo');
    expect(writes).toEqual([]);
  });

  // Real-fs sibling-repo integration tests live in
  // git-utils.cross-repo.test.ts (separate file so it doesn't inherit this
  // file's child_process mock — the test creates real git repos).
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
