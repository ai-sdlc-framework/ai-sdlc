/**
 * Tests for workspace detection logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectWorkspace, generateWorkspaceYaml } from './workspace-detect.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workspace-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectWorkspace', () => {
  it('returns isWorkspace=false for a git repo', () => {
    mkdirSync(join(tmpDir, '.git'));
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(false);
    expect(result.repos).toHaveLength(0);
  });

  it('returns isWorkspace=false with only one child repo', () => {
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(false);
    expect(result.repos).toHaveLength(1);
  });

  it('detects workspace with 2+ child git repos', () => {
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-b', '.git'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(true);
    expect(result.repos).toHaveLength(2);
    expect(result.repos.map((r) => r.name).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('detects workspace with 3 child repos', () => {
    mkdirSync(join(tmpDir, 'alpha', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'beta', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'gamma', '.git'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(true);
    expect(result.repos).toHaveLength(3);
  });

  it('ignores hidden directories', () => {
    mkdirSync(join(tmpDir, '.hidden-repo', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(false);
    expect(result.repos).toHaveLength(1);
  });

  it('ignores non-git child directories', () => {
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'not-a-repo'), { recursive: true });
    mkdirSync(join(tmpDir, 'also-not-repo', 'subdir'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    expect(result.isWorkspace).toBe(false);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe('repo-a');
  });

  it('sets correct paths on detected repos', () => {
    mkdirSync(join(tmpDir, 'my-repo', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'other', '.git'), { recursive: true });
    const result = detectWorkspace(tmpDir);
    const repo = result.repos.find((r) => r.name === 'my-repo')!;
    expect(repo.path).toBe('./my-repo');
    expect(repo.absPath).toBe(join(tmpDir, 'my-repo'));
  });
});

describe('generateWorkspaceYaml', () => {
  it('generates valid workspace YAML', () => {
    const yaml = generateWorkspaceYaml('my-workspace', [
      { name: 'repo-a', path: './repo-a', absPath: '/tmp/repo-a' },
      { name: 'repo-b', path: './repo-b', absPath: '/tmp/repo-b' },
    ]);

    expect(yaml).toContain('kind: Workspace');
    expect(yaml).toContain('name: my-workspace');
    expect(yaml).toContain('- name: repo-a');
    expect(yaml).toContain('path: ./repo-a');
    expect(yaml).toContain('- name: repo-b');
    expect(yaml).toContain('path: ./repo-b');
  });
});
