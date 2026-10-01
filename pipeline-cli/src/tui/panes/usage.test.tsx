import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Box } from 'ink';
import { UsagePane, USAGE_EMPTY_TEXT, USAGE_ERROR_TEXT, USAGE_PANE_HEADING } from './usage.js';
import type { UsagePaneData } from '../../usage/pane-data.js';
import type { ReportRow } from '../../usage/report.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function row(key: 'role' | 'model', name: string, units: number): ReportRow {
  return {
    keys: { [key]: name },
    calls: 3,
    input: 111,
    cacheWrite5m: 222,
    cacheWrite1h: 333,
    cacheRead: 444,
    output: 555,
    units,
    costUsd: 0,
    costStatus: 'unpriced',
  };
}

const DATA: UsagePaneData = {
  empty: false,
  windows: [
    { window: 'session', lengthHours: 5, units: 0, calls: 0 },
    {
      window: 'weekly',
      lengthHours: 168,
      start: '2026-09-04T00:00:00.000Z',
      end: '2026-09-11T00:00:00.000Z',
      units: 1234,
      calls: 7,
      impliedAllotment: 10000,
      percentOfAllotment: 12.3,
      hoursToLimit: 40.5,
    },
    { window: 'extra', lengthHours: 24, start: 'a', end: 'b', units: 5, calls: 1 },
  ],
  consumerWindow: 'weekly',
  topByRole: [row('role', 'ai-sdlc:developer', 900)],
  topByModel: [row('model', 'claude-sonnet-x', 900)],
  lastLimitEvent: { ts: '2026-09-09T00:00:00.000Z', window: 'weekly', usedPercent: 80 },
  allotmentChange: {
    window: 'weekly',
    ts: '2026-09-10T00:00:00.000Z',
    usedPercent: 10,
    units: 3000,
    source: 'manual',
    impliedAllotment: 30000,
    previousAllotment: 10000,
    suspected: true,
  },
};

describe('UsagePane', () => {
  it('renders the window view and top consumers', async () => {
    const { lastFrame } = render(<UsagePane load={async () => DATA} />);
    await flush();
    const f = lastFrame() ?? '';
    expect(f).toContain(USAGE_PANE_HEADING);
    expect(f).toContain('weekly (168h)');
    expect(f).toContain('1,234 units');
    expect(f).toContain('allotment 10,000 (12.3%)');
    expect(f).toContain('limit in 40.5h');
    expect(f).toContain('allotment unknown');
    expect(f).toContain('no window open');
    expect(f).toContain('TOP CONSUMERS BY ROLE (weekly window)');
    expect(f).toContain('ai-sdlc:developer');
    expect(f).toContain('claude-sonnet-x');
    for (const n of ['111', '222', '333', '444', '555']) expect(f).toContain(n);
    expect(f).toContain('Last limit event: weekly 80.0%');
    expect(f).toContain('Probable allotment change: weekly 10,000 -> 30,000');
  });

  it('renders none-states when nothing is in the window or recorded', async () => {
    const data: UsagePaneData = {
      empty: false,
      windows: [],
      topByRole: [],
      topByModel: [],
    };
    const { lastFrame } = render(<UsagePane load={async () => data} />);
    await flush();
    const f = lastFrame() ?? '';
    expect(f).toContain('none in this window');
    expect(f).toContain('Last limit event: none recorded');
    expect(f).not.toContain('Probable allotment change');
  });

  it('renders the empty state for an empty ledger', async () => {
    const { lastFrame } = render(
      <UsagePane
        load={async () => ({ empty: true, windows: [], topByRole: [], topByModel: [] })}
      />,
    );
    await flush();
    expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('No usage recorded yet.');
    expect(USAGE_EMPTY_TEXT.length).toBeGreaterThan(0);
  });

  it('renders a short error line when the ledger is unreadable', async () => {
    const { lastFrame } = render(
      <UsagePane
        load={async () => {
          throw new Error('EACCES: /secret/path');
        }}
      />,
    );
    await flush();
    const f = lastFrame() ?? '';
    expect(f).toContain(USAGE_ERROR_TEXT.slice(0, 30));
    expect(f).not.toContain('/secret/path');
    expect(f).not.toContain('EACCES');
  });

  it('shows a loading line before the first load resolves', () => {
    const { lastFrame } = render(<UsagePane load={() => new Promise(() => {})} />);
    expect(lastFrame() ?? '').toContain('Loading usage');
  });

  it('truncates rows to a narrow width without wrapping', async () => {
    const { lastFrame } = render(
      <Box width={40}>
        <UsagePane load={async () => DATA} />
      </Box>,
    );
    await flush();
    const lines = (lastFrame() ?? '').split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    const consumer = lines.find((l) => l.includes('ai-sdlc:developer'));
    expect(consumer).toBeDefined();
    expect(consumer).not.toContain('out 555');
    expect(lines.filter((l) => l.includes('ai-sdlc:developer'))).toHaveLength(1);
  });

  it('polls on its interval and clears the timer on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const load = vi.fn(async () => DATA);
    const { unmount } = render(<UsagePane load={load} intervalMs={1000} />);
    await flush();
    const initial = load.mock.calls.length;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load.mock.calls.length).toBeGreaterThan(initial);
    unmount();
    const after = load.mock.calls.length;
    vi.advanceTimersByTime(5000);
    await flush();
    expect(load.mock.calls.length).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads through the real reader from an injected usage dir', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'usage-pane-ui-'));
    try {
      const { lastFrame } = render(<UsagePane deps={{ usageDir: dir, priceRows: [] }} />);
      await flush();
      expect(lastFrame() ?? '').toContain('No usage recorded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows unknown when a suspected change has no previous allotment', async () => {
    const data: UsagePaneData = {
      ...DATA,
      allotmentChange: { ...DATA.allotmentChange!, previousAllotment: undefined },
    };
    const { lastFrame } = render(<UsagePane load={async () => data} />);
    await flush();
    const f = lastFrame() ?? '';
    expect(f).toContain('unknown -> 30,000');
    expect(f).not.toContain('0 -> 30,000');
  });

  it('lists consumers in descending units order', async () => {
    const data: UsagePaneData = {
      ...DATA,
      topByRole: [row('role', 'first-role', 900), row('role', 'second-role', 100)],
    };
    const { lastFrame } = render(<UsagePane load={async () => data} />);
    await flush();
    const f = lastFrame() ?? '';
    expect(f.indexOf('first-role')).toBeGreaterThan(-1);
    expect(f.indexOf('second-role')).toBeGreaterThan(f.indexOf('first-role'));
  });

  it('renders hostile labels without control characters and without extra rows', async () => {
    const hostile = (n: string): string =>
      `${n}\u001b]52;c;QUJD\u0007\u001b[2J\u001b]0;pwned\u0007\u009b\u202e\nfake-row`;
    const data: UsagePaneData = {
      ...DATA,
      windows: [
        { window: hostile('win'), lengthHours: 5, units: 1, calls: 1, start: 'a', end: 'b' },
      ],
      topByRole: [row('role', hostile('role'), 5)],
      topByModel: [row('model', hostile('gpt-5'), 5)],
      lastLimitEvent: { ts: hostile('ts'), window: hostile('lim'), usedPercent: 50 },
      allotmentChange: { ...DATA.allotmentChange!, window: hostile('chg'), ts: hostile('cts') },
    };
    const clean: UsagePaneData = {
      ...data,
      windows: [{ window: 'win', lengthHours: 5, units: 1, calls: 1, start: 'a', end: 'b' }],
      topByRole: [row('role', 'role', 5)],
      topByModel: [row('model', 'gpt-5', 5)],
      lastLimitEvent: { ts: 'ts', window: 'lim', usedPercent: 50 },
      allotmentChange: { ...DATA.allotmentChange!, window: 'chg', ts: 'cts' },
    };
    const shot = async (d: UsagePaneData): Promise<string> => {
      const { lastFrame, unmount } = render(
        <Box width={40}>
          <UsagePane load={async () => d} />
        </Box>,
      );
      await flush();
      const f = lastFrame() ?? '';
      unmount();
      return f;
    };
    const f = await shot(data);
    for (const bad of ['\u001b', '\u0007', '\u009b', '\u202e']) {
      expect(f).not.toContain(bad);
    }
    expect(f).not.toContain('fake-row');
    expect(f.split('\n')).toHaveLength((await shot(clean)).split('\n').length);
  });

  it('skips a refresh while a load is still in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<UsagePaneData>((resolve) => {
          release = () => resolve(DATA);
        }),
    );
    const { unmount, lastFrame } = render(<UsagePane load={load} intervalMs={1000} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(lastFrame() ?? '').toContain('weekly (168h)');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('shows only the fixed error line when the real reader meets a bad ledger line', async () => {
    const { mkdtempSync, rmSync, appendFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { appendModelCalls, ledgerFileForTs } = await import('@ai-sdlc/reference');
    const dir = mkdtempSync(join(tmpdir(), 'usage-pane-bad-'));
    try {
      const ts = '2026-09-10T11:00:00.000Z';
      appendModelCalls(
        [
          {
            schemaVersion: 'v1',
            callId: 'c1',
            ts,
            harness: 'claude-code',
            provider: 'anthropic',
            model: 'm',
            tokens: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 },
            billingPool: 'unknown',
            sessionId: 's',
            agentRole: 'r',
            scope: 'other',
          },
        ],
        { dir },
      );
      appendFileSync(join(dir, ledgerFileForTs(ts)), 'null\n');
      const { lastFrame } = render(<UsagePane deps={{ usageDir: dir, priceRows: [] }} />);
      await flush();
      const f = lastFrame() ?? '';
      expect(f).toContain(USAGE_ERROR_TEXT.slice(0, 30));
      expect(f).not.toContain(dir);
      expect(f).not.toContain('TypeError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'shows only the fixed error line for an unreadable usage directory',
    async () => {
      const { mkdtempSync, rmSync, chmodSync, mkdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const base = mkdtempSync(join(tmpdir(), 'usage-pane-perm-'));
      const dir = join(base, 'usage');
      mkdirSync(dir);
      chmodSync(dir, 0o000);
      try {
        const { lastFrame } = render(<UsagePane deps={{ usageDir: dir, priceRows: [] }} />);
        await flush();
        const f = lastFrame() ?? '';
        expect(f).toContain(USAGE_ERROR_TEXT.slice(0, 30));
        expect(f).not.toContain('EACCES');
        expect(f).not.toContain(base);
      } finally {
        chmodSync(dir, 0o700);
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
