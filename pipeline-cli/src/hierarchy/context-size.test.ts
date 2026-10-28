import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatStatus, type StatusResult, type StatusRow } from './status.js';
import {
  encodeProjectDir,
  formatContext,
  overContextWarnings,
  readContextTokens,
  TAIL_MAX_BYTES,
  transcriptPath,
} from './context-size.js';

const bytesRead = vi.hoisted(() => ({ total: 0 }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readSync: ((...a: Parameters<typeof actual.readSync>) => {
      const n = (actual.readSync as (...x: unknown[]) => number)(...a);
      bytesRead.total += n;
      return n;
    }) as typeof actual.readSync,
  };
});

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const assistant = (i: number, c: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: { input_tokens: i, cache_read_input_tokens: c, cache_creation_input_tokens: 5 },
    },
  });
const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) } });

describe('readContextTokens', () => {
  it('sums input, cache read and cache creation of the last assistant record', () => {
    const f = path.join(tmp(), 's.jsonl');
    writeFileSync(f, [assistant(1, 1), assistant(10, 200_000), user].join('\n') + '\n');
    expect(readContextTokens(f)).toBe(200_015);
  });

  it('returns undefined for a missing file and for a file with no assistant record', () => {
    const d = tmp();
    expect(readContextTokens(path.join(d, 'none.jsonl'))).toBeUndefined();
    const f = path.join(d, 'u.jsonl');
    writeFileSync(f, user + '\n');
    expect(readContextTokens(f)).toBeUndefined();
  });

  it('reads a multi-megabyte transcript with bounded bytes', () => {
    const f = path.join(tmp(), 'big.jsonl');
    const filler = Array.from({ length: 20_000 }, () => user).join('\n');
    writeFileSync(f, [assistant(1, 1), filler, assistant(7, 449_000), user].join('\n') + '\n');
    expect(filler.length).toBeGreaterThan(4_000_000);
    bytesRead.total = 0;
    expect(readContextTokens(f)).toBe(449_012);
    expect(bytesRead.total).toBeLessThanOrEqual(64 * 1024);
  });

  it('does not read past the cap when the only assistant record is far from the end', () => {
    const f = path.join(tmp(), 'far.jsonl');
    const filler = Array.from({ length: 20_000 }, () => user).join('\n');
    writeFileSync(f, [assistant(1, 1), filler].join('\n') + '\n');
    expect(filler.length).toBeGreaterThan(TAIL_MAX_BYTES);
    expect(readContextTokens(f)).toBeUndefined();
  });

  it('handles a record that spans a chunk boundary', () => {
    const f = path.join(tmp(), 'span.jsonl');
    const big = JSON.stringify({
      type: 'assistant',
      pad: 'p'.repeat(100_000),
      message: { role: 'assistant', usage: { input_tokens: 3 } },
    });
    writeFileSync(f, [user, big, user].join('\n') + '\n');
    expect(readContextTokens(f)).toBe(3);
  });
});

describe('paths and formatting', () => {
  it('encodes the cwd and formats the three states', () => {
    expect(encodeProjectDir('/a/b.c')).toBe('-a-b-c');
    expect(transcriptPath('/p', '/a/b', 'sid')).toBe('/p/-a-b/sid.jsonl');
    expect(formatContext(450_000, true)).toBe('450k OVER');
    expect(formatContext(90_400, false)).toBe('90k');
    expect(formatContext(undefined, undefined)).toBe('?');
  });
});

describe('status rendering', () => {
  const entry = (name: string) =>
    ({
      role: 'executor',
      name,
      tmuxSession: 's',
      tmuxWindow: name,
      paneId: '%1',
      pid: 1,
      model: 'm',
      permissionMode: 'p',
      startedAt: '',
      status: 'running',
    }) as StatusRow['entry'];
  const row = (name: string, extra: Partial<StatusRow>): StatusRow => ({
    entry: entry(name),
    state: 'busy',
    attached: false,
    module: { state: 'absent' },
    ...extra,
  });

  it('prints CONTEXT in k, OVER and ? and warns on the over session', () => {
    const result = {
      rows: [
        row('a', { contextTokens: 90_000, overThreshold: false }),
        row('b', { contextTokens: 450_000, overThreshold: true }),
        row('c', {}),
      ],
      board: { queued: 0, inflight: 0, done: 0, failed: 0 },
      webhook: { running: false },
      scheduler: { running: false },
      contextThresholds: { planner: 150_000, 'operator-dispatch': 120_000, executor: 120_000 },
    } as unknown as StatusResult;
    const text = formatStatus(result).join('\n');
    expect(text).toMatch(/CONTEXT/);
    expect(text).toMatch(/90k\s/);
    expect(text).toMatch(/450k OVER/);
    expect(text).toMatch(/\?\s/);
    expect(text).toContain('warning: b context 450k is over its 120k clear threshold');
    expect(text).not.toContain('warning: a ');
    const json = JSON.parse(JSON.stringify(result)) as { rows: StatusRow[] };
    expect(json.rows.map((r) => [r.contextTokens, r.overThreshold])).toEqual([
      [90_000, false],
      [450_000, true],
      [undefined, undefined],
    ]);
  });
});

describe('overContextWarnings', () => {
  it('warns only for a registered session whose transcript is over its role threshold', () => {
    const root = tmp();
    const registryDir = path.join(root, 'sessions');
    mkdirSync(registryDir);
    const cwd = '/repo/x';
    for (const [name, sid] of [
      ['hot', 's1'],
      ['cool', 's2'],
    ] as const) {
      writeFileSync(
        path.join(registryDir, `${name}.json`),
        JSON.stringify({ pid: 1, name, sessionId: sid, cwd, status: 'busy' }),
      );
      const dir = path.join(root, 'projects', encodeProjectDir(cwd));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${sid}.jsonl`),
        assistant(1, name === 'hot' ? 500_000 : 1000) + '\n',
      );
    }
    const roster = ['hot', 'cool', 'ghost'].map((name) => ({ name, role: 'executor' }));
    const lines = overContextWarnings(
      { registryDir, cwd, boardDir: path.join(root, 'board') },
      roster as never,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hot context 500k is over its 120k');
  });
});

describe('contextWarnings measure mismatch (AISDLC-1100)', () => {
  it('warns when the module and CONTEXT disagree across the threshold', async () => {
    const { contextWarnings } = await import('./status.js');
    const row = (moduleTokens: number | undefined) =>
      ({
        entry: { name: 'p-planner', role: 'planner' },
        contextTokens: 154000,
        overThreshold: true,
        ...(moduleTokens !== undefined ? { moduleTokens } : {}),
      }) as never;
    const base = { contextThresholds: { planner: 150000 } };
    const w = contextWarnings({ ...base, rows: [row(0)] } as never);
    expect(w.some((l) => l.includes('measure mismatch on p-planner'))).toBe(true);
    expect(contextWarnings({ ...base, rows: [row(154000)] } as never)).toHaveLength(1);
    expect(contextWarnings({ ...base, rows: [row(undefined)] } as never)).toHaveLength(1);
  });
});
