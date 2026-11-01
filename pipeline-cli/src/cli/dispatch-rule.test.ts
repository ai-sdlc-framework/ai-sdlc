import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDispatchCli } from './dispatch.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let boardDir: string;
let stdout: string;
beforeEach(() => {
  boardDir = path.join(mkdtempSync(path.join(tmpdir(), 'dispatch-rule-')), 'dispatch');
  mkdirSync(path.join(boardDir, 'queue'), { recursive: true });
  writeFileSync(
    path.join(boardDir, 'queue', 'AISDLC-1.dispatch.json'),
    JSON.stringify({ taskId: 'AISDLC-1' }),
  );
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  removeFixtureDir(path.dirname(boardDir));
});

describe('cli-dispatch rule (AISDLC-903)', () => {
  it('sets, refuses and clears a ruling', async () => {
    const base = ['--board-dir', boardDir];
    const set = await runDispatchCli([
      'rule',
      'AISDLC-1',
      '--text',
      'hold',
      '--until',
      'AISDLC-2',
      '--by',
      'p',
      ...base,
    ]);
    expect(set).toBe(0);
    expect(JSON.parse(stdout).ruling.until).toBe('AISDLC-2');
    expect(await runDispatchCli(['rule', 'AISDLC-1', ...base])).toBe(2);
    expect(await runDispatchCli(['rule', 'bad', '--text', 'x', ...base])).toBe(2);
    expect(await runDispatchCli(['rule', 'AISDLC-9', '--text', 'x', ...base])).toBe(1);
    stdout = '';
    expect(await runDispatchCli(['rule', 'AISDLC-1', '--clear', ...base])).toBe(0);
    expect(JSON.parse(stdout).cleared).toBe(true);
  });
});
