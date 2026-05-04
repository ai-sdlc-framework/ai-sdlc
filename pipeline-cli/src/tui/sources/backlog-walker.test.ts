/**
 * Tests for the backlog walker source (RFC-0023 Phase 2 / AISDLC-178.2).
 *
 * Covers:
 *   - parseTaskFrontmatter: healthy YAML, missing block, malformed YAML.
 *   - readBacklogTasks: missing dir, empty dirs, healthy walk, sub-dir
 *     missing, file with malformed YAML skipped, sort order.
 *   - useBacklogTasks hook: mount + interval polling, unmount cleanup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

import {
  BACKLOG_WALKER_POLL_INTERVAL_MS,
  parseTaskFrontmatter,
  readBacklogTasks,
  useBacklogTasks,
  type ReadBacklogTasksResult,
} from './backlog-walker.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'tui-backlog-walker-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  cleanup();
  vi.useRealTimers();
});

/**
 * Polls `predicate()` until it returns true or `attempts` is exhausted
 * (each iteration is one setImmediate round-trip). Ink wraps a custom
 * React reconciler that schedules effects via the scheduler package's
 * `setImmediate`, so each round-trip yields back AFTER one batch of
 * effect callbacks fires. Use for assertions that depend on a setState
 * having committed (e.g. `captured` populated by a `useEffect`, or the
 * mount-fetch's setState landing in `state`).
 *
 * AISDLC-188 root cause: under load on freshly-started CI runners, 1-2
 * setImmediate round-trips occasionally weren't enough for the React
 * commit queue to drain a mount-fetch's setState into the capture
 * effect; a predicate-driven wait adapts to whatever the scheduler
 * actually takes (each round is a synchronous setImmediate — no
 * real-clock wait under fake timers).
 */
async function waitForFlushed(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function writeTaskFile(dir: 'tasks' | 'completed', name: string, body: string): string {
  const path = join(workdir, 'backlog', dir);
  mkdirSync(path, { recursive: true });
  const file = join(path, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

function makeFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${JSON.stringify(item)}`);
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

describe('parseTaskFrontmatter (pure)', () => {
  it('parses a normal YAML block', () => {
    const fm = parseTaskFrontmatter(
      makeFrontmatter({ id: 'AISDLC-1', title: 'foo', status: 'To Do' }),
    );
    expect(fm).not.toBeNull();
    expect(fm!.id).toBe('AISDLC-1');
    expect(fm!.title).toBe('foo');
  });

  it('returns null when there is no `---` block', () => {
    expect(parseTaskFrontmatter('# just a heading\n')).toBeNull();
  });

  it('returns null when the YAML body is malformed', () => {
    // Indentation chaos that js-yaml will reject.
    const raw = '---\nfoo: [1,\n  bar:\n bad\n---\n';
    expect(parseTaskFrontmatter(raw)).toBeNull();
  });

  it('returns null when the YAML parses to a non-object (e.g. array)', () => {
    expect(parseTaskFrontmatter('---\n- 1\n- 2\n---\n')).toBeNull();
  });
});

describe('readBacklogTasks (pure)', () => {
  it('returns source-unavailable when backlog/ dir is missing', () => {
    const result = readBacklogTasks({ workDir: workdir });
    expect(result.tasks).toEqual([]);
    expect(result.error).toBe('source-unavailable');
  });

  it('returns empty array (no error) when backlog/ exists but contains no tasks', () => {
    mkdirSync(join(workdir, 'backlog', 'tasks'), { recursive: true });
    const result = readBacklogTasks({ workDir: workdir });
    expect(result.tasks).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('parses tasks from both backlog/tasks and backlog/completed', () => {
    writeTaskFile(
      'tasks',
      'aisdlc-1.md',
      makeFrontmatter({
        id: 'AISDLC-1',
        title: 'open one',
        status: 'In Progress',
        priority: 'high',
        labels: ['rfc-0023'],
      }) + '## body\n',
    );
    writeTaskFile(
      'completed',
      'aisdlc-2.md',
      makeFrontmatter({
        id: 'AISDLC-2',
        title: 'done one',
        status: 'Done',
      }) + '## body\n',
    );

    const result = readBacklogTasks({ workDir: workdir });
    expect(result.error).toBeNull();
    expect(result.tasks).toHaveLength(2);
    const open = result.tasks.find((t) => t.id === 'AISDLC-1')!;
    const done = result.tasks.find((t) => t.id === 'AISDLC-2')!;
    expect(open.fileLocation).toBe('open');
    expect(open.priority).toBe('high');
    expect(open.labels).toEqual(['rfc-0023']);
    expect(done.fileLocation).toBe('completed');
    expect(done.status).toBe('Done');
  });

  it('skips files with malformed frontmatter without crashing', () => {
    writeTaskFile('tasks', 'good.md', makeFrontmatter({ id: 'AISDLC-1', title: 'good' }));
    writeTaskFile('tasks', 'bad.md', '---\nfoo: [1,\n  bar:\n bad\n---\nbody\n');
    writeTaskFile('tasks', 'no-fm.md', '# no frontmatter at all\n');
    writeTaskFile('tasks', 'no-id.md', makeFrontmatter({ title: 'missing id' }));

    const result = readBacklogTasks({ workDir: workdir });
    expect(result.error).toBeNull();
    expect(result.tasks.map((t) => t.id)).toEqual(['AISDLC-1']);
  });

  it('sorts results numerically by id (AISDLC-9 before AISDLC-100)', () => {
    writeTaskFile('tasks', 'a.md', makeFrontmatter({ id: 'AISDLC-9', title: 'nine' }));
    writeTaskFile('tasks', 'b.md', makeFrontmatter({ id: 'AISDLC-100', title: 'hundred' }));
    writeTaskFile('tasks', 'c.md', makeFrontmatter({ id: 'AISDLC-2', title: 'two' }));

    const result = readBacklogTasks({ workDir: workdir });
    expect(result.tasks.map((t) => t.id)).toEqual(['AISDLC-2', 'AISDLC-9', 'AISDLC-100']);
  });

  it('tolerates a missing backlog/completed sub-dir', () => {
    writeTaskFile('tasks', 'a.md', makeFrontmatter({ id: 'AISDLC-1', title: 'one' }));
    // No backlog/completed/ dir.
    const result = readBacklogTasks({ workDir: workdir });
    expect(result.error).toBeNull();
    expect(result.tasks).toHaveLength(1);
  });

  it('captures unknown frontmatter fields under `extras`', () => {
    writeTaskFile(
      'tasks',
      'a.md',
      makeFrontmatter({
        id: 'AISDLC-1',
        title: 'one',
        custom_field: 'hello',
      }),
    );
    const result = readBacklogTasks({ workDir: workdir });
    expect(result.tasks[0].extras.custom_field).toBe('hello');
    expect(result.tasks[0].extras.id).toBeUndefined();
  });
});

// ── Hook ──────────────────────────────────────────────────────────────

function HookProbe({
  capture,
  walker,
  intervalMs,
}: {
  capture: (state: ReturnType<typeof useBacklogTasks>) => void;
  walker: () => ReadBacklogTasksResult;
  intervalMs?: number;
}): React.ReactElement {
  const state = useBacklogTasks({ walker, intervalMs });
  React.useEffect(() => {
    capture(state);
  });
  return React.createElement(Text, null, `count=${state.data.length}`);
}

describe('useBacklogTasks (hook)', () => {
  it('exposes the default 30s cadence per RFC-0023 §6.2', () => {
    expect(BACKLOG_WALKER_POLL_INTERVAL_MS).toBe(30_000);
  });

  it('walks on mount + every intervalMs poll', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const walker = (): ReadBacklogTasksResult => {
      callCount += 1;
      return { tasks: [], error: null };
    };

    const { unmount } = render(
      React.createElement(HookProbe, { capture: () => {}, walker, intervalMs: 100 }),
    );
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(4);

    unmount();
  });

  it('clears the polling timer on unmount', async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    let callCount = 0;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: () => {},
        walker: () => {
          callCount += 1;
          return { tasks: [], error: null };
        },
        intervalMs: 100,
      }),
    );
    await waitForFlushed(() => callCount >= 1);
    expect(callCount).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callCount).toBe(1);
  });

  it('surfaces walker errors via state.error', async () => {
    let captured: ReturnType<typeof useBacklogTasks> | null = null;
    const { unmount } = render(
      React.createElement(HookProbe, {
        capture: (s) => {
          captured = s;
        },
        walker: () => ({ tasks: [], error: 'source-permission-denied' as const }),
      }),
    );
    // Capture-via-useEffect needs the mount setState to commit AND the
    // child capture effect to fire — wait for the predicate rather than
    // a fixed flush count (AISDLC-188).
    await waitForFlushed(() => captured?.error != null);
    expect(captured!.error).toBe('source-permission-denied');
    expect(captured!.data).toEqual([]);
    expect(captured!.lastFetched).toBeInstanceOf(Date);
    unmount();
  });
});
