import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDorCheckCli } from './dor-check.js';

// AISDLC-940: cli-dor-check blocks a completed security-finding task with no PR and no dismissal.
describe('cli-dor-check security-finding completion rule (AISDLC-940)', () => {
  const origArgv = process.argv;
  let dir = '';
  afterEach(() => {
    process.argv = origArgv;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 for a completed finding with neither PR nor dismissal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dor-sec-'));
    mkdirSync(join(dir, 'backlog', 'completed'), { recursive: true });
    const file = join(dir, 'backlog', 'completed', 'aisdlc-9999 - finding.md');
    writeFileSync(
      file,
      '---\nid: AISDLC-9999\ntitle: finding\nstatus: Done\nlabels:\n  - security-finding\n---\n\nSource: dependabot #94\n',
    );
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', 'cli-dor-check', '--task', file];
    expect(await runDorCheckCli()).toBe(1);
    expect(out).toHaveBeenCalled();
  });
});
