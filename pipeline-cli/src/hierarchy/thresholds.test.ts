import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_THRESHOLDS, configPath, resolveThresholds } from './thresholds.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const dirs: string[] = [];
const board = (config?: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'thresholds-'));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(configPath(dir), config);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeFixtureDir(d);
});

describe('resolveThresholds', () => {
  it('returns the defaults without a config file', () => {
    expect(resolveThresholds(board())).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
  });

  it('applies valid positive integer overrides per role', () => {
    const t = resolveThresholds(board('{"contextThresholds":{"planner":90000,"executor":50000}}'));
    expect(t).toEqual({ ...DEFAULT_CONTEXT_THRESHOLDS, planner: 90000, executor: 50000 });
  });

  it('falls back to the default for invalid values and for a malformed file', () => {
    const bad = '{"contextThresholds":{"planner":-1,"executor":1.5,"operator-dispatch":"x"}}';
    expect(resolveThresholds(board(bad))).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
    expect(resolveThresholds(board('{nope'))).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
  });
});
