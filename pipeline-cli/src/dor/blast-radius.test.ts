/**
 * Blast-radius computation tests (RFC-0014 Phase 3 / §6).
 *
 * Pure-function coverage matrix per the AISDLC-167.3 brief:
 *   - leaf with no downstream → count 0, targetExists true
 *   - root of N-task chain → count N, downstream sorted
 *   - branching reverse-edge graph → all transitive dependents counted
 *   - cycle in reverse edges → cycle-safe, no infinite loop
 *   - deleted-target (id not in snapshot) → count 0, targetExists false
 *   - large radius → comment-list capped at maxIds with truncated count
 *   - case-insensitive lookup mirrors snapshot writer's lowercase keying
 *   - sample-id reduction caps the calibration sample at 5
 */

import { describe, expect, it } from 'vitest';
import {
  blastRadiusForCalibration,
  computeBlastRadius,
  DEFAULT_BLAST_RADIUS_MAX_IDS,
  DEFAULT_CALIBRATION_SAMPLE_IDS,
  renderBlastRadiusCallout,
  renderBypassBlastRadiusCallout,
  renderExternalDependenciesCallout,
} from './blast-radius.js';
import type { SnapshotRecord } from '../deps/snapshot.js';

/**
 * Build a SnapshotRecord with sensible defaults for the fields we don't
 * exercise (depth/criticalPathLength/lastModified/externalDependencies).
 */
function rec(id: string, dependencies: string[] = [], dependents: string[] = []): SnapshotRecord {
  return {
    id,
    dependencies,
    dependents,
    depth: 0,
    criticalPathLength: 0,
    externalDependencies: [],
    lastModified: '',
  };
}

describe('computeBlastRadius', () => {
  it('returns count 0 + targetExists true for a graph leaf', () => {
    // AISDLC-100 has dependents (101), AISDLC-101 is the leaf — nothing
    // depends on it. The full reverse-edge metadata is what
    // `computeSnapshotRecords` would emit so we mirror it here.
    const records = [rec('AISDLC-100', [], ['AISDLC-101']), rec('AISDLC-101', ['AISDLC-100'], [])];
    const r = computeBlastRadius('AISDLC-101', records);
    expect(r.count).toBe(0);
    expect(r.downstream).toEqual([]);
    expect(r.truncated).toBe(0);
    expect(r.targetExists).toBe(true);
  });

  it('counts the full forward chain for the root of an N-task chain', () => {
    // Root → A → B → C → D (4 downstream)
    const records: SnapshotRecord[] = [
      rec('AISDLC-1', [], ['AISDLC-2']),
      rec('AISDLC-2', ['AISDLC-1'], ['AISDLC-3']),
      rec('AISDLC-3', ['AISDLC-2'], ['AISDLC-4']),
      rec('AISDLC-4', ['AISDLC-3'], ['AISDLC-5']),
      rec('AISDLC-5', ['AISDLC-4'], []),
    ];
    const r = computeBlastRadius('AISDLC-1', records);
    expect(r.count).toBe(4);
    expect(r.downstream).toEqual(['AISDLC-2', 'AISDLC-3', 'AISDLC-4', 'AISDLC-5']);
    expect(r.truncated).toBe(0);
    expect(r.targetExists).toBe(true);
  });

  it('walks branching reverse-edge graphs (transitive closure)', () => {
    //         ROOT
    //         /  \
    //        A    B
    //       / \    \
    //      C   D    E
    //               |
    //               F
    const records: SnapshotRecord[] = [
      rec('ROOT', [], ['A', 'B']),
      rec('A', ['ROOT'], ['C', 'D']),
      rec('B', ['ROOT'], ['E']),
      rec('C', ['A'], []),
      rec('D', ['A'], []),
      rec('E', ['B'], ['F']),
      rec('F', ['E'], []),
    ];
    const r = computeBlastRadius('ROOT', records);
    expect(r.count).toBe(6);
    expect(r.downstream).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(r.targetExists).toBe(true);
  });

  it('is cycle-safe — short-circuits on a re-entered node without looping', () => {
    // A → B → C → A cycle
    const records: SnapshotRecord[] = [
      rec('A', ['C'], ['B']),
      rec('B', ['A'], ['C']),
      rec('C', ['B'], ['A']),
    ];
    // Bound the test on wall-clock — if cycle handling is broken, this
    // hangs forever. computeBlastRadius is pure + iterative; should
    // return well under the 5s vitest test default.
    const r = computeBlastRadius('A', records);
    // Each node is visited exactly once via the reverse-edge closure.
    // From A's dependents [B] we visit B, B's dependents [C] visit C,
    // C's dependents [A] short-circuit (visited). count = 2 (B + C).
    expect(r.count).toBe(2);
    expect(r.downstream.sort()).toEqual(['B', 'C']);
    expect(r.targetExists).toBe(true);
  });

  it('returns count 0 + targetExists false for a deleted/unknown target', () => {
    const records: SnapshotRecord[] = [rec('AISDLC-1', [], [])];
    const r = computeBlastRadius('AISDLC-NEVER-EXISTED', records);
    expect(r.count).toBe(0);
    expect(r.downstream).toEqual([]);
    expect(r.targetExists).toBe(false);
  });

  it('caps the downstream list at maxIds (default 10) and reports truncated count', () => {
    // Root → 1 → 2 → ... → 15 (15 downstream)
    const records: SnapshotRecord[] = [rec('ROOT', [], ['T1'])];
    for (let i = 1; i <= 15; i++) {
      const id = `T${i}`;
      const next = i < 15 ? [`T${i + 1}`] : [];
      const prev = i === 1 ? ['ROOT'] : [`T${i - 1}`];
      records.push(rec(id, prev, next));
    }
    const r = computeBlastRadius('ROOT', records);
    expect(r.count).toBe(15);
    expect(r.downstream).toHaveLength(DEFAULT_BLAST_RADIUS_MAX_IDS);
    expect(r.truncated).toBe(15 - DEFAULT_BLAST_RADIUS_MAX_IDS);
  });

  it('honors a custom maxIds via opts', () => {
    const records: SnapshotRecord[] = [rec('ROOT', [], ['A', 'B', 'C', 'D', 'E'])];
    for (const id of ['A', 'B', 'C', 'D', 'E']) records.push(rec(id, ['ROOT'], []));
    const r = computeBlastRadius('ROOT', records, { maxIds: 2 });
    expect(r.count).toBe(5);
    expect(r.downstream).toEqual(['A', 'B']);
    expect(r.truncated).toBe(3);
  });

  it('is case-insensitive on the target id (mirrors snapshot writer keying)', () => {
    const records: SnapshotRecord[] = [
      rec('AISDLC-100', [], ['AISDLC-101']),
      rec('AISDLC-101', ['AISDLC-100'], []),
    ];
    const r = computeBlastRadius('aisdlc-100', records);
    expect(r.count).toBe(1);
    expect(r.targetExists).toBe(true);
  });

  it('preserves dangling reverse-edge targets in the count (snapshot mid-edit consistency)', () => {
    // ROOT lists DELETED as a dependent but DELETED isn't in the snapshot
    // (e.g. file moved between graph build + serialisation).
    const records: SnapshotRecord[] = [rec('ROOT', [], ['DELETED', 'OK']), rec('OK', ['ROOT'], [])];
    const r = computeBlastRadius('ROOT', records);
    expect(r.count).toBe(2);
    expect(r.downstream.sort()).toEqual(['DELETED', 'OK']);
  });
});

describe('renderBlastRadiusCallout', () => {
  it('returns the empty string when count is 0 (graph leaves get no callout)', () => {
    const out = renderBlastRadiusCallout({
      count: 0,
      downstream: [],
      truncated: 0,
      targetExists: true,
    });
    expect(out).toBe('');
  });

  it('renders the standard template with count + downstream ids', () => {
    const out = renderBlastRadiusCallout({
      count: 3,
      downstream: ['AISDLC-101', 'AISDLC-102', 'AISDLC-103'],
      truncated: 0,
      targetExists: true,
    });
    expect(out).toContain('⚠ This issue currently gates 3 downstream tasks');
    expect(out).toContain('AISDLC-101, AISDLC-102, AISDLC-103');
    expect(out).toContain('Resolving the questions above unblocks the entire chain.');
  });

  it('uses singular "task" when count is exactly 1', () => {
    const out = renderBlastRadiusCallout({
      count: 1,
      downstream: ['AISDLC-101'],
      truncated: 0,
      targetExists: true,
    });
    expect(out).toContain('gates 1 downstream task ');
    expect(out).not.toContain('1 downstream tasks');
  });

  it('appends "(and N more)" when truncated', () => {
    const out = renderBlastRadiusCallout({
      count: 15,
      downstream: ['A', 'B', 'C'],
      truncated: 12,
      targetExists: true,
    });
    expect(out).toContain('A, B, C, ... (and 12 more)');
  });
});

describe('renderBypassBlastRadiusCallout', () => {
  it('returns empty string below the threshold', () => {
    const out = renderBypassBlastRadiusCallout(
      { count: 2, downstream: ['A', 'B'], truncated: 0, targetExists: true },
      3,
    );
    expect(out).toBe('');
  });

  it('renders the maintainer-tone variant at or above the threshold', () => {
    const out = renderBypassBlastRadiusCallout(
      { count: 5, downstream: ['A', 'B', 'C', 'D', 'E'], truncated: 0, targetExists: true },
      3,
    );
    expect(out).toContain('ℹ This bypass admits a task gating 5 downstream items');
    expect(out).toContain('Confirm intentional');
    expect(out).toContain('rubric may be missing something');
  });

  it('uses singular "item" when count is exactly 1 (and threshold permits)', () => {
    const out = renderBypassBlastRadiusCallout(
      { count: 1, downstream: ['A'], truncated: 0, targetExists: true },
      1,
    );
    expect(out).toContain('1 downstream item ');
    expect(out).not.toContain('1 downstream items');
  });
});

describe('renderExternalDependenciesCallout', () => {
  it('returns empty string when count is 0', () => {
    expect(renderExternalDependenciesCallout(0)).toBe('');
  });

  it('renders the count and the v1 disclaimer', () => {
    const out = renderExternalDependenciesCallout(2);
    expect(out).toContain('External dependencies tracked: 2');
    expect(out).toContain('dispatcher does not block on them in v1');
  });
});

describe('blastRadiusForCalibration', () => {
  it('caps the sample to DEFAULT_CALIBRATION_SAMPLE_IDS by default', () => {
    const radius = {
      count: 12,
      downstream: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      truncated: 2,
      targetExists: true,
    };
    const out = blastRadiusForCalibration(radius);
    expect(out.count).toBe(12);
    expect(out.downstreamSampleIds).toHaveLength(DEFAULT_CALIBRATION_SAMPLE_IDS);
    expect(out.downstreamSampleIds).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('honors a custom sampleSize', () => {
    const radius = {
      count: 4,
      downstream: ['A', 'B', 'C', 'D'],
      truncated: 0,
      targetExists: true,
    };
    const out = blastRadiusForCalibration(radius, 2);
    expect(out.downstreamSampleIds).toEqual(['A', 'B']);
  });

  it('preserves the count even when sample is shorter than the closure', () => {
    const radius = { count: 100, downstream: ['A'], truncated: 99, targetExists: true };
    const out = blastRadiusForCalibration(radius);
    expect(out.count).toBe(100);
    expect(out.downstreamSampleIds).toEqual(['A']);
  });
});
