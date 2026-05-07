/**
 * `.ai-sdlc/tui-config.yaml` loader tests — RFC-0023 §15 OQ-9 /
 * AISDLC-178.5 AC#7.
 */

import { describe, expect, it, vi } from 'vitest';

import { loadTuiConfig, DEFAULT_BLOCKERS_EMPTY_STATE } from './tui-config.js';

describe('loadTuiConfig', () => {
  it('returns an empty object when the file is missing (ENOENT)', () => {
    const reader = (): string => {
      const err = new Error('no such file');
      (err as { code?: string }).code = 'ENOENT';
      throw err;
    };
    expect(loadTuiConfig({ workDir: '/tmp/nope', reader })).toEqual({});
  });

  it('parses blockersEmptyState from valid YAML', () => {
    const reader = (): string => 'blockersEmptyState: ✓ All good!\n';
    const config = loadTuiConfig({ workDir: '/tmp', reader });
    expect(config.blockersEmptyState).toBe('✓ All good!');
  });

  it('parses kanbanBaseUrl from valid YAML', () => {
    const reader = (): string => 'kanbanBaseUrl: https://kanban.example.com\n';
    const config = loadTuiConfig({ workDir: '/tmp', reader });
    expect(config.kanbanBaseUrl).toBe('https://kanban.example.com');
  });

  it('returns empty config when YAML is malformed (warns to stderr)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reader = (): string => 'not: : valid: yaml';
    const config = loadTuiConfig({ workDir: '/tmp', reader });
    expect(config).toEqual({});
    stderrSpy.mockRestore();
  });

  it('ignores fields with the wrong type', () => {
    const reader = (): string => 'blockersEmptyState:\n  - not\n  - a string\nkanbanBaseUrl: ok\n';
    const config = loadTuiConfig({ workDir: '/tmp', reader });
    expect(config.blockersEmptyState).toBeUndefined();
    expect(config.kanbanBaseUrl).toBe('ok');
  });

  it('returns empty config when YAML root is not a map', () => {
    const reader = (): string => '- list\n- of\n- strings\n';
    expect(loadTuiConfig({ workDir: '/tmp', reader })).toEqual({});
  });

  it('exposes the OQ-9 default text constant', () => {
    expect(DEFAULT_BLOCKERS_EMPTY_STATE).toContain('No decisions pending');
    expect(DEFAULT_BLOCKERS_EMPTY_STATE).toContain('pipeline self-driving');
  });

  it('returns empty config on unrecognised fs errors (non-ENOENT)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reader = (): string => {
      const err = new Error('permission denied');
      (err as { code?: string }).code = 'EACCES';
      throw err;
    };
    const config = loadTuiConfig({ workDir: '/tmp', reader });
    expect(config).toEqual({});
    stderrSpy.mockRestore();
  });
});
