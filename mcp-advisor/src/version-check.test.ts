/**
 * Tests for version-check module — pure function tests with mocked I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkForUpdates, checkForUpdatesCached } from './version-check.js';

// Mock node:fs for scanProjectDeps, detectPackageManager, getServerVersion
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

// Mock node:child_process for runUpdate
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// Mock global fetch for fetchLatestVersion
const mockFetch = vi.fn();

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({
      ok: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns base result with no project dirs', async () => {
    const result = await checkForUpdates({ projectDirs: [], autoUpdate: false });
    expect(result.serverVersion).toBeTruthy();
    expect(result.projectUpdates).toEqual([]);
    expect(result.autoUpdated).toEqual([]);
  });

  it('detects server update when registry returns newer version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.99.99' }),
    });

    const result = await checkForUpdates({ projectDirs: [], autoUpdate: false });
    expect(result.serverUpdateAvailable).toBe(true);
    expect(result.serverLatest).toBe('99.99.99');
    expect(result.hasUpdates).toBe(true);
  });

  it('reports no update when registry returns same/older version', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.0.1' }),
    });

    const result = await checkForUpdates({ projectDirs: [], autoUpdate: false });
    expect(result.serverUpdateAvailable).toBe(false);
  });

  it('handles fetch failure gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const result = await checkForUpdates({ projectDirs: [], autoUpdate: false });
    expect(result.serverLatest).toBeNull();
    expect(result.serverUpdateAvailable).toBe(false);
  });

  it('scans project dirs for @ai-sdlc/* dependencies', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);

    // Create a temporary-like scenario via mocks
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: {
            '@ai-sdlc/orchestrator': '^1.0.0',
            'some-other-pkg': '^2.0.0',
          },
          devDependencies: {
            '@ai-sdlc/mcp-advisor': '^0.5.0',
          },
        });
      }
      throw new Error('not found');
    });

    // Registry says latest is 99.0.0 for all
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    });

    const result = await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: false,
    });

    expect(result.projectUpdates.length).toBe(2);
    expect(result.projectUpdates.every((u) => u.updateAvailable)).toBe(true);
    expect(result.hasUpdates).toBe(true);
  });

  it('skips workspace: and file: and link: references', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);

    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: {
            '@ai-sdlc/orchestrator': 'workspace:*',
            '@ai-sdlc/state': 'file:../state',
            '@ai-sdlc/utils': 'link:../utils',
          },
        });
      }
      throw new Error('not found');
    });

    const result = await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: false,
    });

    expect(result.projectUpdates).toEqual([]);
  });

  it('handles missing package.json gracefully', async () => {
    const { existsSync } = await import('node:fs');
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockReturnValue(false);

    const result = await checkForUpdates({
      projectDirs: ['/nonexistent'],
      autoUpdate: false,
    });

    expect(result.projectUpdates).toEqual([]);
  });

  it('auto-updates outdated deps when autoUpdate is true', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);
    const mockedExecSync = vi.mocked(execSync);

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('package.json')) return true;
      if (ps.includes('pnpm-lock.yaml')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: { '@ai-sdlc/orchestrator': '^1.0.0' },
        });
      }
      throw new Error('not found');
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    });

    mockedExecSync.mockReturnValue(Buffer.from(''));

    const result = await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: true,
    });

    expect(mockedExecSync).toHaveBeenCalled();
    expect(result.autoUpdated).toContain('@ai-sdlc/orchestrator');
  });

  it('detects yarn when yarn.lock exists', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);
    const mockedExecSync = vi.mocked(execSync);

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('package.json')) return true;
      if (ps.includes('pnpm-lock.yaml')) return false;
      if (ps.includes('yarn.lock')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: { '@ai-sdlc/orchestrator': '^1.0.0' },
        });
      }
      throw new Error('not found');
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    });

    mockedExecSync.mockReturnValue(Buffer.from(''));

    await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: true,
    });

    const call = mockedExecSync.mock.calls[0];
    expect(String(call[0])).toContain('yarn upgrade');
  });

  it('falls back to npm when no lockfile found', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);
    const mockedExecSync = vi.mocked(execSync);

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: { '@ai-sdlc/orchestrator': '^1.0.0' },
        });
      }
      throw new Error('not found');
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    });

    mockedExecSync.mockReturnValue(Buffer.from(''));

    await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: true,
    });

    const call = mockedExecSync.mock.calls[0];
    expect(String(call[0])).toContain('npm update');
  });

  it('handles update command failure gracefully', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { execSync } = await import('node:child_process');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);
    const mockedExecSync = vi.mocked(execSync);

    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: { '@ai-sdlc/orchestrator': '^1.0.0' },
        });
      }
      throw new Error('not found');
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    });

    mockedExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });

    const result = await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: true,
    });

    // Should not crash, but autoUpdated should be empty
    expect(result.autoUpdated).toEqual([]);
  });

  it('deduplicates deps from same location', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);

    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation((p, _opts) => {
      if (String(p).includes('package.json')) {
        return JSON.stringify({
          dependencies: { '@ai-sdlc/orchestrator': '^1.0.0' },
        });
      }
      throw new Error('not found');
    });

    mockFetch.mockResolvedValue({
      ok: false,
    });

    // Same dir passed twice — should deduplicate
    const result = await checkForUpdates({
      projectDirs: ['/fake/project', '/fake/project'],
      autoUpdate: false,
    });

    expect(result.projectUpdates.length).toBe(1);
  });

  it('handles malformed package.json gracefully', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const mockedExistsSync = vi.mocked(existsSync);
    const mockedReadFileSync = vi.mocked(readFileSync);

    mockedExistsSync.mockImplementation((p) => {
      if (String(p).includes('package.json')) return true;
      return false;
    });
    mockedReadFileSync.mockImplementation(() => {
      return 'NOT VALID JSON';
    });

    const result = await checkForUpdates({
      projectDirs: ['/fake/project'],
      autoUpdate: false,
    });

    expect(result.projectUpdates).toEqual([]);
  });
});

describe('checkForUpdatesCached', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({
      ok: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns cached result on subsequent calls', async () => {
    const result1 = await checkForUpdatesCached({ projectDirs: [], autoUpdate: false });
    const result2 = await checkForUpdatesCached({ projectDirs: [], autoUpdate: false });
    // Should be the same object (cached)
    expect(result1).toBe(result2);
  });
});
