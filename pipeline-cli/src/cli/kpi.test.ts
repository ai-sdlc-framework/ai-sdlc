import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));

import { setClock } from '../clock.js';
import { KPI_PAGE, runKpiCli } from './kpi.js';

const PRS = [
  {
    headRefName: 'ai-sdlc/aisdlc-1-x',
    createdAt: '2026-10-14T01:00:00Z',
    mergedAt: '2026-10-14T03:00:00Z',
    closedAt: '2026-10-14T03:00:00Z',
  },
  {
    headRefName: 'dependabot/npm/foo',
    createdAt: '2026-10-13T01:00:00Z',
    mergedAt: null,
    closedAt: null,
  },
];

let dir: string;
let restore: () => void;
let out: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kpi-cli-'));
  restore = setClock(() => new Date('2026-10-14T12:00:00Z'));
  out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  execFileSync.mockReset();
});

afterEach(() => {
  restore();
  out.mockRestore();
  removeFixtureDir(dir);
});

const cache = () => join(dir, '.ai-sdlc', 'kpi', 'pr-list-2026-10-14.json');

describe('runKpiCli pr-throughput', () => {
  it('fetches via gh, caches, writes the page and prints the summary line', async () => {
    execFileSync.mockReturnValue(JSON.stringify(PRS));
    await runKpiCli(['pr-throughput', '--dir', dir]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(existsSync(cache())).toBe(true);
    expect(readFileSync(join(dir, KPI_PAGE), 'utf8')).toContain('pr-throughput:begin');
    expect(String(out.mock.calls[0][0])).toMatch(/\n$/);
  });

  it('uses the cache, honours --since/--json and --no-write', async () => {
    mkdirSync(join(dir, '.ai-sdlc', 'kpi'), { recursive: true });
    writeFileSync(cache(), JSON.stringify(PRS));
    await runKpiCli([
      'pr-throughput',
      '--dir',
      dir,
      '--since',
      '2026-10-13',
      '--json',
      '--no-write',
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(existsSync(join(dir, KPI_PAGE))).toBe(false);
    expect(() => JSON.parse(String(out.mock.calls[0][0]))).not.toThrow();
  });

  it('refreshes an existing page and respects --days', async () => {
    mkdirSync(join(dir, '.ai-sdlc', 'kpi'), { recursive: true });
    writeFileSync(cache(), JSON.stringify(PRS));
    mkdirSync(join(dir, 'docs', 'operations'), { recursive: true });
    writeFileSync(join(dir, KPI_PAGE), '# Existing\n');
    await runKpiCli(['pr-throughput', '--dir', dir, '--days', '2']);
    const page = readFileSync(join(dir, KPI_PAGE), 'utf8');
    expect(page).toContain('# Existing');
    expect(page).toContain('pr-throughput:begin');
  });
});
