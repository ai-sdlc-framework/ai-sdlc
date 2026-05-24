/**
 * Concurrency hardening tests — RFC-0016 §10.1 (AISDLC-328).
 *
 * Phase 5 prerequisite. PR #498 (AISDLC-280) round-1 review surfaced
 * two latent races in the estimate-log writer + class-assignment cache.
 * Both are dormant today (cli-orchestrator runs `maxConcurrent: 1`) but
 * activate when the orchestrator raises concurrency or when a scripted
 * parallel-estimation sweep fires.
 *
 * These tests spawn N parallel callers via `Promise.all`, then assert:
 *
 *  - **log writer**: every row landed (no append loss) AND every
 *    `runDiscriminator` is unique (no per-row identity collision). The
 *    legacy `runIndex` field MAY collide under heavy concurrency —
 *    that's why the discriminator was introduced.
 *
 *  - **class cache**: every distinct task's entry survives the
 *    concurrent write storm — no last-writer-wins eviction.
 *
 * Tests use a per-test tmpdir so they're hermetic + parallel-safe.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assignClassCached, readCacheEntry, type CacheFile } from './cache.js';
import { captureEstimate, estimateLogPath, readEstimateLog } from './log-writer.js';
import type { SignalOutput, StageAResult } from './types.js';

const SIGNALS: SignalOutput[] = [
  {
    id: 1,
    name: 'file scope count',
    inputs: { fileCount: 1 },
    result: { kind: 'bucket', bucket: 'S' },
  },
];

function buildStageA(overrides: Partial<StageAResult> = {}): StageAResult {
  return {
    taskId: 'AISDLC-CONC',
    taskClass: 'bug',
    classSource: 'heuristic',
    signals: SIGNALS,
    candidateBucket: 'S',
    confidence: 'high',
    escalateToStageB: false,
    rationale: 'concurrency-test',
    ...overrides,
  };
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'estimate-concurrency-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('captureEstimate — N parallel same-hash captures', () => {
  it('appends every row even under 50 concurrent calls (no append loss)', async () => {
    const N = 50;
    const calls = Array.from({ length: N }, () =>
      Promise.resolve().then(() =>
        captureEstimate({
          stageA: buildStageA(),
          taskTitle: 'parallel-hash',
          taskDescription: 'd',
          artifactsDir: workdir,
        }),
      ),
    );
    const results = await Promise.all(calls);
    expect(results).toHaveLength(N);

    // Every result wrote one row.
    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows).toHaveLength(N);
    // All rows share the same hash (same inputs).
    const hashes = new Set(rows.map((r) => r.estimateInputHash));
    expect(hashes.size).toBe(1);
  });

  it('every row gets a UNIQUE runDiscriminator under heavy concurrency', async () => {
    const N = 100;
    const calls = Array.from({ length: N }, () =>
      Promise.resolve().then(() =>
        captureEstimate({
          stageA: buildStageA(),
          taskTitle: 'parallel-discriminator',
          taskDescription: 'd',
          artifactsDir: workdir,
        }),
      ),
    );
    await Promise.all(calls);

    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows).toHaveLength(N);

    const discriminators = rows.map((r) => r.runDiscriminator);
    // Every row has a discriminator on the new writer.
    expect(discriminators.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
    // No collisions.
    const unique = new Set(discriminators);
    expect(unique.size).toBe(N);
    // Format is `${epochMs}-${pid}-${seq}` — three '-'-joined parts.
    for (const d of discriminators) {
      expect(d).toMatch(/^\d+-\d+-\d+$/);
    }
  });

  it('runDiscriminator stays unique across DIFFERENT-hash concurrent captures too', async () => {
    const N = 30;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        captureEstimate({
          stageA: buildStageA({ taskId: `AISDLC-T${i}` }),
          taskTitle: `t${i}`,
          taskDescription: 'd',
          artifactsDir: workdir,
        }),
      ),
    );
    await Promise.all(calls);

    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows).toHaveLength(N);
    const discriminators = new Set(rows.map((r) => r.runDiscriminator));
    expect(discriminators.size).toBe(N);
  });

  it('appendFileSync atomicity: no JSONL line is ever torn / interleaved', async () => {
    const N = 80;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        captureEstimate({
          stageA: buildStageA({ taskId: `AISDLC-PAR${i}` }),
          taskTitle: `tear-check-${i}`,
          taskDescription: 'd-'.repeat(40), // larger payload but still well under PIPE_BUF
          artifactsDir: workdir,
        }),
      ),
    );
    await Promise.all(calls);

    // Read the raw file and parse every non-empty line — if any line
    // was torn, JSON.parse would throw.
    const raw = readFileSync(estimateLogPath(workdir), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(N);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('assignClassCached — N parallel calls for DIFFERENT tasks', () => {
  it('every task entry survives 50 concurrent writes (no last-writer-wins eviction)', async () => {
    const N = 50;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        assignClassCached({
          taskId: `AISDLC-${i}`,
          title: `task ${i}`,
          description: `d ${i}`,
          artifactsDir: workdir,
          assigner: () => ({ taskClass: 'feature', source: 'heuristic' }),
        }),
      ),
    );
    await Promise.all(calls);

    // Every task ID is still in the cache after the storm settles.
    for (let i = 0; i < N; i += 1) {
      const entry = readCacheEntry(`AISDLC-${i}`, workdir);
      expect(entry).toBeDefined();
      expect(entry?.taskClass).toBe('feature');
    }

    // The cache file is valid JSON with all N entries.
    const path = join(workdir, '_estimates', 'class-assignments.json');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    expect(Object.keys(parsed.tasks)).toHaveLength(N);
  });

  it('concurrent writes for the SAME task converge on the latest entry', async () => {
    const N = 20;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        assignClassCached({
          taskId: 'AISDLC-SHARED',
          title: `title v${i}`, // every call has a different contentHash → fresh assign
          description: 'd',
          artifactsDir: workdir,
          assigner: () => ({ taskClass: 'bug', source: 'heuristic' }),
        }),
      ),
    );
    await Promise.all(calls);

    // Exactly one entry survives — last writer wins for the same key,
    // but the entry itself is well-formed (not interleaved with other
    // writers).
    const entry = readCacheEntry('AISDLC-SHARED', workdir);
    expect(entry).toBeDefined();
    expect(entry?.taskClass).toBe('bug');

    const raw = readFileSync(join(workdir, '_estimates', 'class-assignments.json'), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    expect(Object.keys(parsed.tasks)).toEqual(['aisdlc-shared']);
  });

  it('cache file never ends up in a torn / unparseable state during the storm', async () => {
    const N = 40;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        assignClassCached({
          taskId: `AISDLC-TEAR${i}`,
          title: `t${i}`,
          description: 'd'.repeat(200), // larger payload → larger write surface
          artifactsDir: workdir,
          assigner: () => ({ taskClass: 'chore', source: 'heuristic' }),
        }),
      ),
    );
    await Promise.all(calls);

    const path = join(workdir, '_estimates', 'class-assignments.json');
    const raw = readFileSync(path, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as CacheFile;
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.tasks)).toHaveLength(N);
  });
});

describe('mixed log + cache concurrent storm', () => {
  it('parallel cache + log captures both stay consistent', async () => {
    const N = 30;
    const calls = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(async () => {
        const cls = await Promise.resolve(
          assignClassCached({
            taskId: `AISDLC-MIX${i}`,
            title: `mix ${i}`,
            description: 'd',
            artifactsDir: workdir,
            assigner: () => ({ taskClass: 'bug', source: 'heuristic' }),
          }),
        );
        captureEstimate({
          stageA: buildStageA({ taskId: `AISDLC-MIX${i}`, taskClass: cls.taskClass }),
          taskTitle: `mix ${i}`,
          taskDescription: 'd',
          artifactsDir: workdir,
        });
      }),
    );
    await Promise.all(calls);

    // Every cache entry is present.
    for (let i = 0; i < N; i += 1) {
      expect(readCacheEntry(`AISDLC-MIX${i}`, workdir)).toBeDefined();
    }
    // Every log row is present + has a unique discriminator.
    const rows = readEstimateLog({ artifactsDir: workdir });
    expect(rows).toHaveLength(N);
    const discriminators = new Set(rows.map((r) => r.runDiscriminator));
    expect(discriminators.size).toBe(N);
  });
});
