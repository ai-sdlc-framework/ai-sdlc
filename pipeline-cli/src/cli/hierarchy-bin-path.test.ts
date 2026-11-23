import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pipelineCliBin } from '../bin-dir.js';
import { finishVerifyArgs, reconcileBeforeSpawn, usageIngestOptions } from './hierarchy.js';

// AISDLC-1359: an adopter working directory holds no `pipeline-cli/`.
const adopter = (): string => mkdtempSync(path.join(tmpdir(), 'adopter-'));

describe('hierarchy bin paths (AISDLC-1359)', () => {
  it('finish verify uses the module bin, not the working directory', () => {
    const args = finishVerifyArgs('h', 'b');
    expect(args).toEqual([
      pipelineCliBin('cli-attestation.mjs'),
      'verify',
      '--head',
      'h',
      '--base',
      'b',
    ]);
    expect(existsSync(args[0] as string)).toBe(true);
  });

  it('usage ingest receives an existing bin path from a repo without pipeline-cli', () => {
    const root = adopter();
    const o = usageIngestOptions(root);
    expect(existsSync(o.binPath)).toBe(true);
    expect(o.binPath.startsWith(root)).toBe(false);
    expect(o.cwd).toBe(root);
  });

  it('pre-spawn reconcile runs from a repo without pipeline-cli', () => {
    const root = adopter();
    const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const log = vi.fn();
    reconcileBeforeSpawn(run as never, '/board', root, log);
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [pipelineCliBin('cli-dispatch.mjs'), 'reconcile', '--board-dir', '/board'],
      { cwd: root },
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('logs one warning line and skips when the bin is missing', () => {
    const run = vi.fn();
    const log = vi.fn();
    reconcileBeforeSpawn(run as never, '/board', '/r', log, '/nope/cli-dispatch.mjs');
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('/nope/cli-dispatch.mjs');
  });
});
