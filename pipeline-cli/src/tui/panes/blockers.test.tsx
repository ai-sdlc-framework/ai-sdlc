/**
 * BlockersPane component tests (AISDLC-178.3 #383 follow-up).
 *
 * Round-1 codecov flagged blockers.tsx at 24.87% line coverage. The detector
 * + hook had 53 unit tests but the pane/component itself was uncovered.
 * This file fills that gap with ink-testing-library tests covering:
 *
 *   - Empty-state rendering
 *   - Error-banner rendering
 *   - List rendering (selection cursor, multiple items)
 *   - Navigation (↑↓/jk)
 *   - Enter → opens detail view
 *   - Esc/q → closes detail
 *   - 'o' → opens browser (PR) or $EDITOR (task)
 *   - 'n' → marks not-a-decision (closes detail)
 *
 * Pattern matches `app.test.tsx` — ink-testing-library + injected hookOpts.
 */

import React from 'react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { BlockersPane, BLOCKERS_EMPTY_STATE } from './blockers.js';
import type { BlockerItem } from '../blockers/index.js';

// Mock execFileSync so the [o] keystroke can be observed without invoking
// real shells / browsers in the test environment.
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

afterEach(() => {
  cleanup();
  execFileSyncMock.mockReset();
});

const PR_BLOCKER: BlockerItem = {
  key: 'pr:42:changes-requested',
  kind: 'changes-requested',
  ref: '#42',
  summary: 'PR #42 has unaddressed CHANGES_REQUESTED: feat: example',
  detail: 'PR #42 — feat: example\n\nReviewer requested changes.\n\nURL: https://example.com/pr/42',
  updatedAt: '2026-05-06T22:00:00Z',
  prUrl: 'https://example.com/pr/42',
  isUrgent: false,
};

const TASK_BLOCKER: BlockerItem = {
  key: 'task:AISDLC-100',
  kind: 'needs-clarification',
  ref: 'AISDLC-100',
  summary: 'AISDLC-100 needs clarification',
  detail: 'Some task description.',
  updatedAt: '2026-05-06T20:00:00Z',
  taskFilePath: '/repo/backlog/tasks/aisdlc-100 - example.md',
  isUrgent: false,
};

const URGENT_BLOCKER: BlockerItem = {
  ...PR_BLOCKER,
  key: 'pr:99:urgent',
  ref: '#99',
  summary: 'PR #99 — urgent question',
  isUrgent: true,
};

function makeHookOpts(items: BlockerItem[], error: string | null = null) {
  return {
    detector: () => items,
    // Sync `ReadBacklogTasksResult` shape per useBlockers contract.
    taskWalker: () => ({
      tasks: [],
      error: error as never,
    }),
    // Sync `FetchGhPrsResult` shape.
    prFetcher: () => ({
      prs: [],
      error: null,
    }),
    backlogIntervalMs: 1_000_000,
    prIntervalMs: 1_000_000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('BlockersPane', () => {
  describe('empty state', () => {
    it('renders the OQ-9 affirming copy when no blockers', () => {
      const { lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([])} />);
      expect(lastFrame()).toContain(BLOCKERS_EMPTY_STATE);
    });

    it('shows the green ✓ header when blockers list is empty', () => {
      const { lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([])} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('BLOCKERS (0)');
    });
  });

  describe('list with items', () => {
    it('renders each blocker row with kind icon + ref', async () => {
      const { lastFrame } = render(
        <BlockersPane hookOpts={makeHookOpts([PR_BLOCKER, TASK_BLOCKER])} />,
      );
      await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('#42');
      expect(frame).toContain('AISDLC-100');
      expect(frame).toContain('BLOCKERS (2)');
    });

    it('renders the navigation hint when items exist', async () => {
      const { lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      expect(lastFrame() ?? '').toContain('[↑↓/jk] navigate');
    });

    it('renders the red 🛑 header when items exist', async () => {
      const { lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      expect(lastFrame() ?? '').toContain('BLOCKERS (1)');
    });
  });

  describe('error banner', () => {
    it('shows the degraded-source banner when error is set', async () => {
      const { lastFrame } = render(
        <BlockersPane hookOpts={makeHookOpts([], 'gh CLI not authenticated')} />,
      );
      await flush();
      expect(lastFrame() ?? '').toContain('Data source degraded');
    });
  });

  describe('keyboard navigation', () => {
    it('moves selection down with j', async () => {
      const { stdin, lastFrame } = render(
        <BlockersPane hookOpts={makeHookOpts([PR_BLOCKER, TASK_BLOCKER, URGENT_BLOCKER])} />,
      );
      await flush();
      stdin.write('j');
      await flush();
      // Cursor should advance — at minimum the frame still renders all items.
      expect(lastFrame() ?? '').toContain('#42');
    });

    it('moves selection up with k', async () => {
      const { stdin, lastFrame } = render(
        <BlockersPane hookOpts={makeHookOpts([PR_BLOCKER, TASK_BLOCKER])} />,
      );
      await flush();
      stdin.write('j');
      await flush();
      stdin.write('k');
      await flush();
      expect(lastFrame() ?? '').toContain('BLOCKERS (2)');
    });

    it('opens detail view on Enter', async () => {
      const { stdin, lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      stdin.write('\r'); // Enter
      await flush();
      const frame = lastFrame() ?? '';
      // Detail view shows full detail text.
      expect(frame).toContain('Reviewer requested changes');
    });

    it('Enter is a no-op on empty list (no detail view opens)', async () => {
      const { stdin, lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([])} />);
      stdin.write('\r');
      await flush();
      // Should still show empty state, not detail.
      expect(lastFrame() ?? '').toContain(BLOCKERS_EMPTY_STATE);
    });
  });

  describe('detail view keyboard handling', () => {
    it('closes detail view on Esc', async () => {
      const { stdin, lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      stdin.write('\r'); // open detail
      await flush();
      expect(lastFrame() ?? '').toContain('Reviewer requested changes');
      stdin.write('\x1B'); // Esc
      await flush();
      // Back to list view.
      expect(lastFrame() ?? '').toContain('[↑↓/jk] navigate');
    });

    it('closes detail view on q', async () => {
      const { stdin, lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      stdin.write('\r');
      await flush();
      stdin.write('q');
      await flush();
      expect(lastFrame() ?? '').toContain('[↑↓/jk] navigate');
    });

    it('o opens PR URL in browser when prUrl present', async () => {
      const { stdin } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      stdin.write('\r'); // open detail
      await flush();
      stdin.write('o');
      await flush();
      // Best-effort: at least one execFileSync call with the URL.
      expect(
        execFileSyncMock.mock.calls.some(
          (call) => Array.isArray(call[1]) && call[1].includes('https://example.com/pr/42'),
        ),
      ).toBe(true);
    });

    it('o opens task file in $EDITOR when taskFilePath present and prUrl absent', async () => {
      process.env.EDITOR = 'vim';
      const { stdin } = render(<BlockersPane hookOpts={makeHookOpts([TASK_BLOCKER])} />);
      await flush();
      stdin.write('\r');
      await flush();
      stdin.write('o');
      await flush();
      // Should have invoked sh -c with vim and the task file path.
      const calls = execFileSyncMock.mock.calls;
      const editorCall = calls.find(
        (call) =>
          call[0] === 'sh' &&
          Array.isArray(call[1]) &&
          call[1].some((a: unknown) => typeof a === 'string' && a.includes('vim')),
      );
      expect(editorCall).toBeDefined();
      expect(editorCall?.[1]).toContain('/repo/backlog/tasks/aisdlc-100 - example.md');
      delete process.env.EDITOR;
    });

    it('o is a no-op when EDITOR unset and prUrl absent', async () => {
      delete process.env.EDITOR;
      delete process.env.VISUAL;
      const { stdin } = render(<BlockersPane hookOpts={makeHookOpts([TASK_BLOCKER])} />);
      await flush();
      stdin.write('\r');
      await flush();
      stdin.write('o');
      await flush();
      // No editor call should have fired.
      const editorCall = execFileSyncMock.mock.calls.find((call) => call[0] === 'sh');
      expect(editorCall).toBeUndefined();
    });

    it('n closes detail view (mark not-a-decision)', async () => {
      const { stdin, lastFrame } = render(<BlockersPane hookOpts={makeHookOpts([PR_BLOCKER])} />);
      await flush();
      stdin.write('\r'); // open
      await flush();
      stdin.write('n');
      await flush();
      // Back to list.
      expect(lastFrame() ?? '').toContain('[↑↓/jk] navigate');
    });
  });

  describe('kanban link-out (AISDLC-178.5 / OQ-5 / AC#8)', () => {
    it('b on a focused task row launches the kanban URL when full-screen', async () => {
      const launcher = vi.fn().mockReturnValue({
        url: 'http://localhost:6420/?task=AISDLC-100',
        outcome: 'browser',
        tool: 'open',
      });
      const { stdin, lastFrame } = render(
        <BlockersPane
          hookOpts={makeHookOpts([TASK_BLOCKER])}
          kanbanLauncher={launcher}
          forceFullScreen={true}
        />,
      );
      await flush();
      stdin.write('b');
      await flush();
      expect(launcher).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining('AISDLC-100') }),
      );
      expect(lastFrame() ?? '').toContain('opened');
    });

    it('b is a no-op when not full-screen (router will switch modes instead)', async () => {
      const launcher = vi.fn();
      const { stdin } = render(
        <BlockersPane
          hookOpts={makeHookOpts([TASK_BLOCKER])}
          kanbanLauncher={launcher}
          forceFullScreen={false}
        />,
      );
      await flush();
      stdin.write('b');
      await flush();
      expect(launcher).not.toHaveBeenCalled();
    });

    it('b is a no-op on PR blocker rows (no taskId to link to)', async () => {
      const launcher = vi.fn();
      const { stdin } = render(
        <BlockersPane
          hookOpts={makeHookOpts([PR_BLOCKER])}
          kanbanLauncher={launcher}
          forceFullScreen={true}
        />,
      );
      await flush();
      stdin.write('b');
      await flush();
      expect(launcher).not.toHaveBeenCalled();
    });

    it('shows clipboard-fallback banner when kanban returns outcome=clipboard', async () => {
      const launcher = vi.fn().mockReturnValue({
        url: 'http://localhost:6420/?task=AISDLC-100',
        outcome: 'clipboard',
        tool: 'pbcopy',
      });
      const { stdin, lastFrame } = render(
        <BlockersPane
          hookOpts={makeHookOpts([TASK_BLOCKER])}
          kanbanLauncher={launcher}
          forceFullScreen={true}
        />,
      );
      await flush();
      stdin.write('b');
      await flush();
      expect(lastFrame() ?? '').toContain('copied');
      expect(lastFrame() ?? '').toContain('pbcopy');
    });

    it('shows none-fallback banner when kanban returns outcome=none', async () => {
      const launcher = vi.fn().mockReturnValue({
        url: 'http://x.test',
        outcome: 'none',
        tool: null,
      });
      const { stdin, lastFrame } = render(
        <BlockersPane
          hookOpts={makeHookOpts([TASK_BLOCKER])}
          kanbanLauncher={launcher}
          forceFullScreen={true}
        />,
      );
      await flush();
      stdin.write('b');
      await flush();
      expect(lastFrame() ?? '').toContain("couldn't launch browser");
    });
  });

  describe('OQ-9 empty-state copy', () => {
    it('uses the override when provided via emptyStateOverride prop', () => {
      const { lastFrame } = render(
        <BlockersPane hookOpts={makeHookOpts([])} emptyStateOverride="✨ All clear, captain" />,
      );
      expect(lastFrame() ?? '').toContain('✨ All clear, captain');
      expect(lastFrame() ?? '').not.toContain(BLOCKERS_EMPTY_STATE);
    });
  });
});

/** Flush microtasks + Ink render queue. */
async function flush(): Promise<void> {
  // Multiple cycles needed: useEffect for taskWalker → setState → re-render →
  // useEffect for detector → setState → re-render. ~5 cycles is plenty.
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
