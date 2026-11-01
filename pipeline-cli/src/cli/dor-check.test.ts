import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refine = vi.fn();
const route = vi.fn();

vi.mock('../dor/ingress-claude.js', () => ({
  refineBacklogTask: (...a: unknown[]) => refine(...a),
}));
vi.mock('../dor/comment-loop.js', () => ({ renderClarificationComment: () => 'COMMENT\n' }));
vi.mock('../dor/dor-config.js', () => ({ loadDorConfig: () => ({ evaluationMode: 'warn' }) }));
vi.mock('../dor/decision-point.js', () => ({
  routeDecisionPointForTaskFile: (...a: unknown[]) => route(...a),
}));

import { runDorCheckCli } from './dor-check.js';

describe('cli-dor-check decision-point wiring (AISDLC-785)', () => {
  let dir: string;
  let file: string;
  const origArgv = process.argv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dor-check-'));
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    file = join(dir, 'backlog', 'tasks', 'aisdlc-785 - sample.md');
    writeFileSync(file, '---\nid: AISDLC-785\n---\nbody\n');
    refine.mockReset();
    route.mockReset();
    route.mockResolvedValue(undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = origArgv;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes decision points after the DoR verdict and leaves a passing result unchanged', async () => {
    refine.mockResolvedValue({ shouldRefuseExecution: false, verdict: {} });
    process.argv = ['node', 'cli-dor-check', '--task', file];
    expect(await runDorCheckCli()).toBe(0);
    expect(route).toHaveBeenCalledWith('AISDLC-785', file, dir);
  });

  it('still blocks when the DoR verdict refuses, after routing', async () => {
    refine.mockResolvedValue({ shouldRefuseExecution: true, verdict: {} });
    process.argv = ['node', 'cli-dor-check', '--task', file];
    expect(await runDorCheckCli()).toBe(1);
    expect(route).toHaveBeenCalledTimes(1);
  });
});
