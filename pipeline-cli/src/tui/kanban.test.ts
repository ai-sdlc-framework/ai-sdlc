/**
 * Kanban link-out tests — RFC-0023 §11 / OQ-5 / AISDLC-178.5 AC#8.
 *
 * Covers the platform-conditional fallback chain:
 *   browser opener → clipboard tool → 'none'.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildKanbanUrl, launchKanban } from './kanban.js';

describe('buildKanbanUrl', () => {
  it('appends ?task=<id> with URL encoding', () => {
    const url = buildKanbanUrl({ taskId: 'AISDLC-178.5' });
    expect(url).toBe('http://localhost:6420/?task=AISDLC-178.5');
  });

  it('respects an override base URL and trims trailing slashes', () => {
    const url = buildKanbanUrl({ taskId: 'AISDLC-1', baseUrl: 'https://kanban.example.com//' });
    expect(url).toBe('https://kanban.example.com/?task=AISDLC-1');
  });

  it('encodes special characters in the task id', () => {
    const url = buildKanbanUrl({ taskId: 'task with space' });
    expect(url).toContain('task%20with%20space');
  });
});

describe('launchKanban — fallback chain', () => {
  it('macOS: prefers `open <url>`', () => {
    const runner = vi.fn();
    const result = launchKanban({
      url: 'http://x.test',
      platform: 'darwin',
      runner,
      clipboardRunner: vi.fn(),
    });
    expect(runner).toHaveBeenCalledWith('open', ['http://x.test']);
    expect(result.outcome).toBe('browser');
    expect(result.tool).toBe('open');
  });

  it('Linux: prefers `xdg-open <url>`', () => {
    const runner = vi.fn();
    const result = launchKanban({
      url: 'http://x.test',
      platform: 'linux',
      runner,
      clipboardRunner: vi.fn(),
    });
    expect(runner).toHaveBeenCalledWith('xdg-open', ['http://x.test']);
    expect(result.outcome).toBe('browser');
  });

  it('Windows: shells out via cmd /c start', () => {
    const runner = vi.fn();
    launchKanban({
      url: 'http://x.test',
      platform: 'win32',
      runner,
      clipboardRunner: vi.fn(),
    });
    expect(runner).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://x.test']);
  });

  it('falls back to clipboard when browser opener fails (macOS → pbcopy)', () => {
    const runner = vi.fn(() => {
      throw new Error('open: not found');
    });
    const clipboardRunner = vi.fn();
    const result = launchKanban({
      url: 'http://x.test',
      platform: 'darwin',
      runner,
      clipboardRunner,
    });
    expect(clipboardRunner).toHaveBeenCalledWith('pbcopy', [], 'http://x.test');
    expect(result.outcome).toBe('clipboard');
    expect(result.tool).toBe('pbcopy');
  });

  it('Linux clipboard fallback tries xclip then xsel', () => {
    const runner = vi.fn(() => {
      throw new Error('xdg-open missing');
    });
    let xclipCalls = 0;
    const clipboardRunner = vi.fn((cmd: string) => {
      if (cmd === 'xclip') {
        xclipCalls += 1;
        throw new Error('no display');
      }
    });
    const result = launchKanban({
      url: 'http://x.test',
      platform: 'linux',
      runner,
      clipboardRunner,
    });
    expect(xclipCalls).toBe(1);
    expect(result.outcome).toBe('clipboard');
    expect(result.tool).toBe('xsel');
  });

  it('returns outcome=none when every fallback fails — caller renders the URL', () => {
    const runner = vi.fn(() => {
      throw new Error('not found');
    });
    const clipboardRunner = vi.fn(() => {
      throw new Error('also not found');
    });
    const result = launchKanban({
      url: 'http://x.test',
      platform: 'linux',
      runner,
      clipboardRunner,
    });
    expect(result.outcome).toBe('none');
    expect(result.tool).toBeNull();
    expect(result.url).toBe('http://x.test');
  });
});
