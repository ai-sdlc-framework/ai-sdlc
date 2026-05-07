/**
 * Config-browser file walker tests — RFC-0023 §9 / AISDLC-178.5 AC#4.
 */

import { describe, expect, it, vi } from 'vitest';

import { listConfigFiles, readConfigFile } from './file-walker.js';

describe('listConfigFiles', () => {
  it('lists *.yaml + *.yml files (sorted), ignores other extensions', () => {
    const readdir = vi
      .fn()
      .mockReturnValue(['b.yaml', 'a.yml', 'README.md', 'schemas', 'review-policy.md', 'c.yaml']);
    const stat = vi.fn().mockReturnValue({ isFile: () => true });
    const result = listConfigFiles({ workDir: '/proj', readdir, stat });
    expect(result.files.map((f) => f.name)).toEqual(['a.yml', 'b.yaml', 'c.yaml']);
    expect(result.error).toBeNull();
  });

  it('returns source-unavailable when .ai-sdlc/ is missing', () => {
    const readdir = (): string[] => {
      const err = new Error('ENOENT');
      (err as { code?: string }).code = 'ENOENT';
      throw err;
    };
    const result = listConfigFiles({ workDir: '/proj', readdir });
    expect(result.error).toBe('source-unavailable');
    expect(result.files).toEqual([]);
  });

  it('returns source-permission-denied for EACCES', () => {
    const readdir = (): string[] => {
      const err = new Error('EACCES');
      (err as { code?: string }).code = 'EACCES';
      throw err;
    };
    const result = listConfigFiles({ workDir: '/proj', readdir });
    expect(result.error).toBe('source-permission-denied');
  });

  it('skips entries whose stat fails', () => {
    const readdir = (): string[] => ['ok.yaml', 'bad.yaml'];
    const stat = (path: string): { isFile: () => boolean } => {
      if (path.endsWith('bad.yaml')) throw new Error('fs error');
      return { isFile: () => true };
    };
    const result = listConfigFiles({ workDir: '/proj', readdir, stat });
    expect(result.files.map((f) => f.name)).toEqual(['ok.yaml']);
  });

  it('skips entries that are directories', () => {
    const readdir = (): string[] => ['real.yaml', 'dir.yaml'];
    const stat = (path: string): { isFile: () => boolean } => ({
      isFile: () => !path.endsWith('dir.yaml'),
    });
    const result = listConfigFiles({ workDir: '/proj', readdir, stat });
    expect(result.files.map((f) => f.name)).toEqual(['real.yaml']);
  });

  it('relPath joins on .ai-sdlc/<name>', () => {
    const readdir = (): string[] => ['x.yaml'];
    const stat = (): { isFile: () => boolean } => ({ isFile: () => true });
    const result = listConfigFiles({ workDir: '/proj', readdir, stat });
    expect(result.files[0].relPath).toBe('.ai-sdlc/x.yaml');
    expect(result.files[0].absPath).toBe('/proj/.ai-sdlc/x.yaml');
  });
});

describe('readConfigFile', () => {
  it('returns text + null error on success', () => {
    const result = readConfigFile({ absPath: '/x', reader: () => 'hello' });
    expect(result.text).toBe('hello');
    expect(result.error).toBeNull();
  });

  it('classifies ENOENT as source-unavailable', () => {
    const result = readConfigFile({
      absPath: '/x',
      reader: (): string => {
        const err = new Error('ENOENT');
        (err as { code?: string }).code = 'ENOENT';
        throw err;
      },
    });
    expect(result.text).toBeNull();
    expect(result.error).toBe('source-unavailable');
  });
});
