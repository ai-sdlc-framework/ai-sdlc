import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PriceSource, SourcePriceRow } from '@ai-sdlc/reference';
import {
  buildUsageCli,
  formatPriceList,
  formatRefreshSummary,
  renderIngestResult,
} from './usage.js';

let root: string;
let writes: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-usage-'));
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    writes.push(String(s));
    return true;
  });
  vi.stubEnv('AI_SDLC_USAGE_DIR', join(root, 'usage'));
  vi.stubEnv('CLAUDE_CODE_ENV', '');
  vi.stubEnv('CLAUDE_REMOTE_EXECUTION', '');
  vi.stubEnv('AI_SDLC_USAGE_INGEST', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const projects = join(root, 'projects');
  mkdirSync(join(projects, 'p1'), { recursive: true });
  writeFileSync(
    join(projects, 'p1', 's1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-02T10:00:00Z',
      sessionId: 's1',
      cwd: join(root, 'elsewhere'),
      message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n`,
  );
  return projects;
}

describe('cli-usage ingest', () => {
  it('prints JSON counts', async () => {
    await buildUsageCli(['ingest', '--projects-dir', fixture(), '--json']).parseAsync();
    expect(JSON.parse(writes.join(''))).toMatchObject({
      filesScanned: 1,
      callsWritten: 1,
      repeatsSkipped: 0,
      errors: 0,
    });
  });

  it('prints a text summary', async () => {
    await buildUsageCli(['ingest', '--projects-dir', fixture(), '--backfill']).parseAsync();
    expect(writes.join('')).toContain('Calls written:   1');
  });

  it('explains a no-op in a remote sandbox', async () => {
    vi.stubEnv('CLAUDE_CODE_ENV', 'ccr');
    await buildUsageCli(['ingest', '--projects-dir', fixture()]).parseAsync();
    expect(writes.join('')).toContain('remote sandbox');
  });
});

describe('cli-usage ingest output carries no transcript text', () => {
  const CANARY = 'SENTINEL-CANARY-CLI-TEXT';

  it('prints and writes no canary on normal and error paths (json and text)', async () => {
    const projects = fixture();
    const file = join(projects, 'p1', 's1.jsonl');
    appendFileSync(file, `{"type":"user","message":{"content":"${CANARY} tool output"}}\n`);
    appendFileSync(
      file,
      `{"type":"assistant","unknown":"${CANARY}","message":{"id":"u","model":"m","content":"${CANARY}","usage":{"input_tokens":1,"output_tokens":1},"newField":1},"timestamp":"2026-09-02T10:00:00Z"}\n`,
    );
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'user', pad: `${CANARY}${'x'.repeat(5 * 1024 * 1024)}` })}\n`,
    );
    appendFileSync(file, `{bad json ${CANARY}\n`);
    mkdirSync(join(projects, 'p1', 's1', 'subagents'), { recursive: true });
    writeFileSync(
      join(projects, 'p1', 's1', 'subagents', 'agent-a1.jsonl'),
      `{"type":"assistant","timestamp":"2026-09-02T10:00:00Z","message":{"id":"x1","model":"m","usage":{"output_tokens":1}}}\n{"type":"assistant","message":{"content":"${CANARY}`,
    );
    const errors: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errors.push(String(c));
        return true;
      });
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(' '));
      }),
    );
    try {
      await buildUsageCli(['ingest', '--projects-dir', projects, '--json']).parseAsync();
      await buildUsageCli(['ingest', '--projects-dir', projects, '--backfill']).parseAsync();
      await buildUsageCli([
        'ingest',
        '--projects-dir',
        join(root, 'missing'),
        '--json',
      ]).parseAsync();
    } finally {
      errSpy.mockRestore();
      for (const sp of consoleSpies) sp.mockRestore();
    }
    const all = [...writes, ...errors].join('\n');
    expect(all).toContain('callsWritten');
    expect(all).not.toContain('SENTINEL');
    for (const rel of readdirSync(join(root, 'usage'), { recursive: true }) as string[]) {
      const full = join(root, 'usage', rel);
      if (statSync(full).isFile())
        expect(readFileSync(full, 'utf-8'), rel).not.toContain('SENTINEL');
    }
  });
});

describe('renderIngestResult', () => {
  const base = {
    filesScanned: 2,
    callsWritten: 1,
    repeatsSkipped: 3,
    errors: 0,
    limitEvents: 0,
    otherScopeSkipped: 4,
    timedOut: true,
  };
  it('mentions skipped other-scope and the time limit', () => {
    const out = renderIngestResult(base);
    expect(out).toContain('Other-scope skipped: 4');
    expect(out).toContain('time limit');
  });
  it('explains the switched-off state', () => {
    expect(renderIngestResult({ ...base, disabled: 'switched-off' })).toContain('switched off');
  });
});

describe('cli-usage price commands', () => {
  const NOW = new Date('2026-10-01T09:00:00.000Z');

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-usage-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function row(model: string, vals: Partial<SourcePriceRow> = {}): SourcePriceRow {
    return {
      model,
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWrite5mPer1M: 1.25,
      cacheWrite1hPer1M: 2,
      url: 'https://example.test/p',
      fetchedAt: NOW.toISOString(),
      ...vals,
    };
  }

  function setup(sources: PriceSource[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const codes: number[] = [];
    const onCapability = vi.fn();
    const deps = {
      usageDir: dir,
      now: () => NOW,
      sources,
      stdout: (t: string): void => void out.push(t),
      stderr: (t: string): void => void err.push(t),
      emit: (e: Record<string, unknown>): void => void events.push(e),
      onCapability,
      setExitCode: (c: number): void => void codes.push(c),
    };
    const run = async (...args: string[]): Promise<void> => {
      await buildUsageCli(args, deps as never)
        .exitProcess(false)
        .parseAsync();
    };
    return { run, out, err, events, codes, onCapability };
  }

  const fakeSource = (name: string, rows: SourcePriceRow[]): PriceSource => ({
    name,
    fetchPrices: async () => rows,
  });

  describe('cli-usage prices', () => {
    it('refresh prints a summary, emits ModelPriceChanged and reports the capability', async () => {
      const t = setup([fakeSource('a', [row('claude-haiku-4-5', { inputPer1M: 1.2 })])]);
      await t.run('prices', 'refresh');
      expect(t.out.join('')).toContain('appended=1');
      expect(t.events).toEqual([
        expect.objectContaining({ type: 'ModelPriceChanged', model: 'claude-haiku-4-5' }),
      ]);
      expect(t.onCapability).toHaveBeenCalledWith('live');
    });

    it('refresh --json prints the result and --source filters', async () => {
      const t = setup([fakeSource('a', [row('x1')]), fakeSource('b', [row('x2')])]);
      await t.run('prices', 'refresh', '--source', 'b', '--json');
      const parsed = JSON.parse(t.out.join(''));
      expect(parsed.sources.map((s: { name: string }) => s.name)).toEqual(['b']);
    });

    it('refresh with an unknown source exits 1', async () => {
      const t = setup([fakeSource('a', [])]);
      await t.run('prices', 'refresh', '--source', 'nope');
      expect(t.codes).toEqual([1]);
      expect(t.err.join('')).toContain('Unknown price source');
    });

    it('refresh with every source failing prints a notice and does not fail', async () => {
      const t = setup([
        {
          name: 'a',
          fetchPrices: async () => {
            throw new Error('offline');
          },
        },
      ]);
      await t.run('prices', 'refresh');
      expect(t.out.join('')).toContain('Every source failed');
      expect(t.codes).toEqual([]);
      expect(t.onCapability).toHaveBeenCalledWith('degraded', expect.any(String));
    });

    it('holds a big move, lists it, and confirm promotes it', async () => {
      const t = setup([fakeSource('a', [row('claude-haiku-4-5', { outputPer1M: 40 })])]);
      await t.run('prices', 'refresh', '--change-factor', '3');
      await t.run('prices', 'list');
      const listed = t.out.join('');
      expect(listed).toContain('HELD claude-haiku-4-5');
      await t.run('prices', 'confirm', 'claude-haiku-4-5');
      expect(t.out.join('')).toContain('Confirmed held price');
      expect(
        t.events.some((e) => e.type === 'ModelPriceChanged' && e.tokenClass === 'output'),
      ).toBe(true);
      await t.run('prices', 'confirm', 'claude-haiku-4-5');
      expect(t.codes).toEqual([1]);
    });

    it('list --json returns entries', async () => {
      const t = setup();
      await t.run('prices', 'list', '--json');
      const parsed = JSON.parse(t.out.join(''));
      expect(parsed.find((e: { model: string }) => e.model === 'claude-haiku-4-5')).toBeDefined();
    });

    it('set writes a manual row and rejects bad prices', async () => {
      const t = setup();
      const flags = [
        '--output',
        '2',
        '--cache-read',
        '3',
        '--cache-write-5m',
        '4',
        '--cache-write-1h',
        '5',
      ];
      await t.run(
        'prices',
        'set',
        'my-model',
        '--input',
        '1',
        ...flags,
        '--effective-from',
        '2026-10-01',
      );
      expect(t.out.join('')).toContain('Manual price written for my-model');
      await t.run('prices', 'set', 'my-model', '--input', '0', ...flags);
      expect(t.codes).toEqual([1]);
      expect(t.err.join('')).toContain('input');
    });
  });

  describe('formatters', () => {
    it('formats an empty list and a stale manual entry', () => {
      expect(formatPriceList([])).toContain('No prices');
      const text = formatPriceList([
        { model: 'only-held', stale: false },
        {
          model: 'm',
          stale: true,
          ageDays: 20,
          active: {
            model: 'm',
            inputPer1M: 1,
            outputPer1M: 2,
            cacheReadPer1M: 3,
            cacheWrite5mPer1M: 4,
            cacheWrite1hPer1M: 5,
            source: 'manual',
            url: 'manual',
            fetchedAt: NOW.toISOString(),
            effectiveFrom: '2026-10-01',
            status: 'manual',
          },
        },
      ]);
      expect(text).toContain('(no active price)');
      expect(text).toContain('STALE manual');
    });

    it('summarises held models', () => {
      const text = formatRefreshSummary({
        fetchedAt: NOW.toISOString(),
        sources: [{ name: 'a', ok: true, rows: 1 }],
        anySourceSucceeded: true,
        appended: 0,
        held: [{ model: 'm', reason: 'sources-disagree' }],
        unchanged: 0,
        incomplete: [],
        rejected: [],
        changes: [],
      });
      expect(text).toContain('held m: sources-disagree');
    });
  });
});
