/**
 * RFC-0014 Phase 2 — depth-aware dispatcher integration tests.
 *
 * Covers AC #2, #6, #7 from AISDLC-167.2:
 *  - Q1 sort order: effectivePriority DESC → criticalPathLength DESC →
 *    recency DESC
 *  - critical-path leaf-of-deep-chain bubbles to the top of the dispatch queue
 *  - feature flag OFF → dispatcher behaviour exactly matches the PPA-only
 *    baseline (id-ASC from `frontier()`)
 *
 * Hermetic: every test builds an isolated tmp project root + drives the env
 * flag through the suite-level beforeEach so we don't leak across cases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { utimesSync } from 'node:fs';
import { buildDependencyGraph, frontier } from './dependency-graph.js';
import {
  compareForDispatch,
  rankAllByEffectivePriority,
  sortFrontierByEffectivePriority,
  type RankedFrontierEntry,
} from './dispatch.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
let priorEnv: string | undefined;

beforeEach(() => {
  tmp = makeTmpProject();
  priorEnv = process.env.AI_SDLC_DEPS_COMPOSITION;
});

afterEach(() => {
  cleanupTmpProject(tmp);
  if (priorEnv === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
  else process.env.AI_SDLC_DEPS_COMPOSITION = priorEnv;
});

/**
 * Set the file mtime explicitly so we can drive the recency tertiary tiebreak
 * deterministically. ISO-8601 string output is what the snapshot writer + this
 * comparator both consume.
 */
function setMtime(path: string, isoString: string): void {
  const t = new Date(isoString);
  utimesSync(path, t, t);
}

describe('sortFrontierByEffectivePriority — feature flag OFF (baseline / regression)', () => {
  beforeEach(() => {
    // AISDLC-410: post-cutover the default is ON, so explicitly opt-out to
    // exercise the baseline (flag-OFF) behavior these tests assert.
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
  });

  it('preserves the baseline (id-ASC) order when the flag is OFF', () => {
    // Three independent frontier-eligible tasks with mixed priorities.
    // Baseline order is id-ASC: A, B, C — REGARDLESS of priority.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', priority: 'medium' });
    const g = buildDependencyGraph({ workDir: tmp });
    const f = frontier(g);
    const ranked = sortFrontierByEffectivePriority(g, f);
    expect(ranked.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B', 'AISDLC-C']);
  });

  it('still attaches effective-priority metadata so callers can introspect under flag-OFF', () => {
    // Even with the flag OFF, callers (dashboards, soak tooling, A/B
    // comparison) want to see WHAT the composition WOULD have done.
    writeTaskFile(tmp, { id: 'AISDLC-LEAF', title: 'l', priority: 'critical' });
    writeTaskFile(tmp, { id: 'AISDLC-ROOT', title: 'r', priority: 'low' });
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g));
    const leaf = ranked.find((r) => r.id === 'AISDLC-LEAF')!;
    expect(leaf.basePriority).toBeGreaterThan(0);
    expect(leaf.effectivePriority).toBeGreaterThan(0);
  });
});

describe('sortFrontierByEffectivePriority — feature flag ON (Phase 2 behaviour)', () => {
  beforeEach(() => {
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
  });

  it('AC #6: critical-path leaf-of-deep-chain bubbles to the top of the dispatch queue', () => {
    // Three frontier-eligible tasks:
    //  - LEAF-OF-DEEP-CHAIN: medium-priority root of a 3-task downstream
    //    chain ending in CRITICAL — its effectivePriority bubbles to critical.
    //  - LEAF-OF-SHALLOW-CHAIN: medium-priority root of a 1-task downstream
    //    that's only HIGH — effectivePriority high.
    //  - LEAF-ALONE: medium-priority leaf with no downstream — stays medium.
    //
    // Per Q1 sort the dispatcher should pick LEAF-OF-DEEP-CHAIN first
    // (effectivePriority=critical), then LEAF-OF-SHALLOW-CHAIN (high), then
    // LEAF-ALONE (medium).
    //
    // To make these frontier-eligible we mark all DOWNSTREAM tasks as
    // not-frontier (give them dependencies that aren't satisfied) — actually
    // no: downstream tasks are NOT in the frontier because their parent (the
    // root we're testing) is open. Frontier = open tasks whose deps are all
    // completed. The roots have NO deps so they are in the frontier; the
    // mid + leaf are open with an open dependency, so they're NOT frontier.
    writeTaskFile(tmp, { id: 'AISDLC-DROOT', title: 'd-root', priority: 'medium' });
    writeTaskFile(tmp, {
      id: 'AISDLC-DMID',
      title: 'd-mid',
      priority: 'medium',
      dependencies: ['AISDLC-DROOT'],
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-DLEAF',
      title: 'd-leaf',
      priority: 'critical',
      dependencies: ['AISDLC-DMID'],
    });
    writeTaskFile(tmp, { id: 'AISDLC-SROOT', title: 's-root', priority: 'medium' });
    writeTaskFile(tmp, {
      id: 'AISDLC-SLEAF',
      title: 's-leaf',
      priority: 'high',
      dependencies: ['AISDLC-SROOT'],
    });
    writeTaskFile(tmp, { id: 'AISDLC-ALONE', title: 'alone', priority: 'medium' });

    const g = buildDependencyGraph({ workDir: tmp });
    const baseline = frontier(g);
    expect(baseline.map((e) => e.id).sort()).toEqual([
      'AISDLC-ALONE',
      'AISDLC-DROOT',
      'AISDLC-SROOT',
    ]);

    const ranked = sortFrontierByEffectivePriority(g, baseline);
    expect(ranked.map((r) => r.id)).toEqual([
      'AISDLC-DROOT', // effectivePriority=critical (4), CPL=2
      'AISDLC-SROOT', // effectivePriority=high (3), CPL=1
      'AISDLC-ALONE', // effectivePriority=medium (2), CPL=0
    ]);
  });

  it('AC #2: applies the Q1 sort: effectivePriority DESC → criticalPathLength DESC → recency DESC', () => {
    // Two frontier roots with the SAME effective priority. Tiebreak chain:
    //  1. CPL DESC: deeper chain wins.
    //  2. Recency DESC: newer file wins.
    //
    // Setup: A is medium with no downstream (CPL=0). B is medium with a
    // medium downstream (CPL=1). With effectivePriority equal, B should
    // win on CPL.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'medium' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'medium' });
    writeTaskFile(tmp, {
      id: 'AISDLC-B-LEAF',
      title: 'b-leaf',
      priority: 'medium',
      dependencies: ['AISDLC-B'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g));
    expect(ranked[0].id).toBe('AISDLC-B'); // CPL=1 wins over A's CPL=0
    expect(ranked[1].id).toBe('AISDLC-A');
  });

  it('breaks ties by recency DESC after effectivePriority + CPL match', () => {
    // Two roots with identical priority + CPL=0. The newer file wins.
    const olderPath = writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'medium' });
    const newerPath = writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'medium' });
    setMtime(olderPath, '2026-01-01T00:00:00.000Z');
    setMtime(newerPath, '2026-04-30T00:00:00.000Z');
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g));
    expect(ranked[0].id).toBe('AISDLC-B'); // newer
    expect(ranked[1].id).toBe('AISDLC-A');
  });

  it('falls back to id ASC when every other field is equal (deterministic output)', () => {
    // Same priority, same CPL=0, same mtime — id ASC keeps tests
    // reproducible across machines.
    const aPath = writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'medium' });
    const bPath = writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'medium' });
    setMtime(aPath, '2026-01-01T00:00:00.000Z');
    setMtime(bPath, '2026-01-01T00:00:00.000Z');
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g));
    expect(ranked.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B']);
  });

  it('returns a NEW array; never mutates the input frontier', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    const g = buildDependencyGraph({ workDir: tmp });
    const baseline = frontier(g);
    const baselineCopy = baseline.slice();
    const ranked = sortFrontierByEffectivePriority(g, baseline);
    expect(baseline).toEqual(baselineCopy);
    expect(ranked).not.toBe(baseline);
  });
});

describe('sortFrontierByEffectivePriority — force flags', () => {
  beforeEach(() => {
    // AISDLC-410: ensure flag is OFF so we exercise the force-flag override path.
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
  });

  it('forceComposition=true overrides flag-OFF env', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g), { forceComposition: true });
    expect(ranked[0].id).toBe('AISDLC-B'); // critical
    expect(ranked[1].id).toBe('AISDLC-A');
  });

  it('forceBaseline=true overrides flag-ON env', () => {
    process.env.AI_SDLC_DEPS_COMPOSITION = '1';
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g), { forceBaseline: true });
    expect(ranked.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B']); // id-ASC
  });

  it('forceComposition wins when both force flags are set (documented edge case)', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    const g = buildDependencyGraph({ workDir: tmp });
    const ranked = sortFrontierByEffectivePriority(g, frontier(g), {
      forceComposition: true,
      forceBaseline: true,
    });
    expect(ranked[0].id).toBe('AISDLC-B');
  });
});

describe('compareForDispatch — pure comparator', () => {
  function r(
    id: string,
    effectivePriority: number,
    criticalPathLength = 0,
    lastModified = '',
  ): RankedFrontierEntry {
    return {
      id,
      title: id,
      dependencies: [],
      basePriority: effectivePriority,
      effectivePriority,
      criticalPathLength,
      lastModified,
    };
  }

  it('primary sort = effectivePriority DESC', () => {
    expect(compareForDispatch(r('A', 4), r('B', 1))).toBeLessThan(0); // A first
    expect(compareForDispatch(r('A', 1), r('B', 4))).toBeGreaterThan(0); // B first
  });

  it('secondary sort = criticalPathLength DESC when effectivePriority ties', () => {
    expect(compareForDispatch(r('A', 2, 5), r('B', 2, 1))).toBeLessThan(0);
  });

  it('tertiary sort = recency DESC when effectivePriority + CPL tie', () => {
    expect(
      compareForDispatch(
        r('A', 2, 0, '2026-01-01T00:00:00Z'),
        r('B', 2, 0, '2026-04-30T00:00:00Z'),
      ),
    ).toBeGreaterThan(0); // B newer, B first
  });

  it('final sort = id ASC for total determinism', () => {
    expect(compareForDispatch(r('AISDLC-A', 2), r('AISDLC-B', 2))).toBeLessThan(0);
  });
});

describe('rankAllByEffectivePriority — convenience helper', () => {
  it('honours the feature flag identically to sortFrontierByEffectivePriority', () => {
    // AISDLC-410: opt-out explicitly to exercise the flag-OFF baseline path.
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'critical' });
    const g = buildDependencyGraph({ workDir: tmp });

    // Flag OFF: id-ASC.
    const off = rankAllByEffectivePriority(g);
    expect(off.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B']);

    // Flag ON: critical first.
    const on = rankAllByEffectivePriority(g, { forceComposition: true });
    expect(on.map((r) => r.id)).toEqual(['AISDLC-B', 'AISDLC-A']);
  });

  it('returns every node in the graph, not just the frontier', () => {
    writeTaskFile(tmp, { id: 'AISDLC-ROOT', title: 'r', priority: 'low' });
    writeTaskFile(tmp, {
      id: 'AISDLC-LEAF',
      title: 'l',
      priority: 'critical',
      dependencies: ['AISDLC-ROOT'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    const records = rankAllByEffectivePriority(g, { forceComposition: true });
    expect(records.length).toBe(2);
    expect(records.map((r) => r.id).sort()).toEqual(['AISDLC-LEAF', 'AISDLC-ROOT']);
  });
});
