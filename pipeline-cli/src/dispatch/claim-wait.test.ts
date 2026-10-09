/**
 * Hermetic tests for the blocking claim: real temp-dir boards, no LLM, no network.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDispatchCli } from '../cli/dispatch.js';
import { claimNext, ensureBoardDirs, writeManifest } from './board.js';
import { claimWithWait } from './claim-wait.js';
import type { DispatchManifest } from './types.js';

const mkManifest = (taskId: string): DispatchManifest => ({
  schemaVersion: 'v1',
  taskId,
  branch: `ai-sdlc/${taskId.toLowerCase()}`,
  worktree: `.worktrees/${taskId.toLowerCase()}`,
  baseSha: 'abc1234',
  workerKind: 'in-session-agent',
  dispatchedAt: '2026-05-20T10:00:00.000Z',
  dispatchedBy: 'test',
  spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
});

let root: string;
let board: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'claim-wait-'));
  board = path.join(root, 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('claimWithWait', () => {
  it('returns at once with --wait 0 and an empty queue', async () => {
    const t0 = Date.now();
    const r = await claimWithWait(board, 'in-session-agent', { waitSec: 0 });
    expect(r.claimed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('returns claimed:false only after the wait lapses', async () => {
    let now = 1_000_000;
    let attempts = 0;
    const r = await claimWithWait(board, 'in-session-agent', {
      waitSec: 1,
      pollMs: 100,
      nowMs: () => now,
      claim: () => {
        attempts += 1;
        now += 100; // each pass advances the injected clock one poll
        return { claimed: false };
      },
    });
    expect(r.claimed).toBe(false);
    expect(attempts).toBeGreaterThanOrEqual(10);
  });

  it('catches an enqueue that lands between a failed claim and the wait', async () => {
    let attempts = 0;
    const r = await claimWithWait(board, 'in-session-agent', {
      waitSec: 60,
      workerId: 'w1',
      pollMs: 60_000,
      claim: (dir, kind, workerId) => {
        attempts += 1;
        if (attempts === 1) {
          // First attempt finds nothing; the manifest arrives right after it.
          queueMicrotask(() => writeManifest(board, mkManifest('AISDLC-9')));
          return { claimed: false };
        }
        return claimNext(dir, kind, undefined, workerId === undefined ? {} : { workerId });
      },
    });
    expect(r.claimed).toBe(true);
    expect(r.manifest?.taskId).toBe('AISDLC-9');
  });

  it('claims a manifest already queued without waiting', async () => {
    writeManifest(board, mkManifest('AISDLC-1'));
    const r = await claimWithWait(board, 'in-session-agent', { waitSec: 30, workerId: 'w1' });
    expect(r.claimed).toBe(true);
    expect(r.manifest?.taskId).toBe('AISDLC-1');
  });

  it('wakes within 5 s of an enqueue while blocked, with the poll floor far longer', async () => {
    const pending = claimWithWait(board, 'in-session-agent', {
      waitSec: 60,
      workerId: 'w1',
      pollMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    writeManifest(board, mkManifest('AISDLC-2'));
    const r = await pending;
    expect(r.claimed).toBe(true);
    expect(r.manifest?.taskId).toBe('AISDLC-2');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('makes no claim attempts beyond one per wake-up while blocked', async () => {
    let attempts = 0;
    await claimWithWait(board, 'in-session-agent', {
      waitSec: 1,
      pollMs: 400,
      claim: () => {
        attempts += 1;
        return { claimed: false };
      },
    });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
  });
});

describe('cli-dispatch claim --wait', () => {
  async function cli(argv: string[]): Promise<{ exit: number; out: string; err: string }> {
    const outs: string[] = [];
    const errs: string[] = [];
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => (outs.push(String(c)), true)) as never;
    process.stderr.write = ((c: string) => (errs.push(String(c)), true)) as never;
    try {
      const exit = await runDispatchCli(argv);
      return { exit, out: outs.join(''), err: errs.join('') };
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
  }

  it('rejects a non-numeric --wait', async () => {
    const r = await cli([
      'claim',
      '--board-dir',
      board,
      '--worker-kind',
      'in-session-agent',
      '--wait',
      'soon',
    ]);
    expect(r.exit).toBe(2);
    expect(r.err).toMatch(/--wait must be a whole number/);
  });

  it('blocks until a manifest is enqueued and prints the claim', async () => {
    const pending = cli([
      'claim',
      '--board-dir',
      board,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'w1',
      '--wait',
      '30',
    ]);
    await new Promise((r) => setTimeout(r, 300));
    writeManifest(board, mkManifest('AISDLC-3'));
    const r = await pending;
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ claimed: true, manifest: { taskId: 'AISDLC-3' } });
  });

  it('prints claimed:false when the wait lapses', async () => {
    const r = await cli([
      'claim',
      '--board-dir',
      board,
      '--worker-kind',
      'in-session-agent',
      '--wait',
      '1',
    ]);
    expect(JSON.parse(r.out)).toEqual({ claimed: false });
  });
});

describe('emptyQueueHibernateSec default', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  it('is 1800 in the schema and the example config', () => {
    const schema = JSON.parse(
      readFileSync(path.join(repoRoot, 'spec/schemas/dispatch-config.v1.schema.json'), 'utf8'),
    );
    expect(
      schema.properties.spec.properties.inSessionAgent.properties.emptyQueueHibernateSec.default,
    ).toBe(1800);
    const yaml = readFileSync(
      path.join(repoRoot, 'spec/examples/dispatch-configs/default-in-session-agent.yaml'),
      'utf8',
    );
    expect(yaml).toMatch(/emptyQueueHibernateSec: 1800\b/);
  });
});
