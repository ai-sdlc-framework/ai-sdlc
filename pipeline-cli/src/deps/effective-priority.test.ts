/**
 * RFC-0014 Phase 2 — `computeEffectivePriorities` pure-function tests.
 *
 * Covers AC #1, #3, #4, #5 from AISDLC-167.2:
 *  - effectivePriority(T) = max(basePriority, max basePriority across downstream(T))
 *  - per-task PPA priority unchanged (composition is read-only)
 *  - monotonic: adding an edge can only INCREASE upstream effective priority
 *  - no-cache (recompute per call) — covered implicitly because the function
 *    accepts no caching parameters and produces a fresh Map every call
 *
 * Hermetic: every test builds an isolated tmp project root + a fresh
 * `DependencyGraph` from disk via `buildDependencyGraph`. No env mutation,
 * no shared state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDependencyGraph } from './dependency-graph.js';
import {
  computeEffectivePriorities,
  DEFAULT_PRIORITY_WEIGHT,
  PRIORITY_WEIGHT,
  priorityWeightFor,
  readPriorityWeight,
} from './effective-priority.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpProject();
});

afterEach(() => {
  cleanupTmpProject(tmp);
});

describe('readPriorityWeight', () => {
  it('maps the four canonical buckets to ascending integer weights', () => {
    expect(readPriorityWeight('low')).toBe(PRIORITY_WEIGHT.low);
    expect(readPriorityWeight('medium')).toBe(PRIORITY_WEIGHT.medium);
    expect(readPriorityWeight('high')).toBe(PRIORITY_WEIGHT.high);
    expect(readPriorityWeight('critical')).toBe(PRIORITY_WEIGHT.critical);
    expect(readPriorityWeight('low')).toBeLessThan(readPriorityWeight('medium'));
    expect(readPriorityWeight('medium')).toBeLessThan(readPriorityWeight('high'));
    expect(readPriorityWeight('high')).toBeLessThan(readPriorityWeight('critical'));
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(readPriorityWeight('HIGH')).toBe(PRIORITY_WEIGHT.high);
    expect(readPriorityWeight('  Critical  ')).toBe(PRIORITY_WEIGHT.critical);
  });

  it('falls back to DEFAULT_PRIORITY_WEIGHT for unknown / empty / nullish values', () => {
    expect(readPriorityWeight(undefined)).toBe(DEFAULT_PRIORITY_WEIGHT);
    expect(readPriorityWeight(null)).toBe(DEFAULT_PRIORITY_WEIGHT);
    expect(readPriorityWeight('')).toBe(DEFAULT_PRIORITY_WEIGHT);
    expect(readPriorityWeight('   ')).toBe(DEFAULT_PRIORITY_WEIGHT);
    expect(readPriorityWeight('urgent')).toBe(DEFAULT_PRIORITY_WEIGHT);
  });
});

describe('priorityWeightFor (resolver path)', () => {
  it('honours a custom resolver before the node frontmatter', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 't', priority: 'low' });
    const g = buildDependencyGraph({ workDir: tmp });
    const node = g.nodes.get('aisdlc-1')!;
    expect(priorityWeightFor(node)).toBe(PRIORITY_WEIGHT.low);
    expect(priorityWeightFor(node, () => 'critical')).toBe(PRIORITY_WEIGHT.critical);
  });

  it('falls back to DEFAULT_PRIORITY_WEIGHT when resolver returns nothing AND node has no priority', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 't' });
    const g = buildDependencyGraph({ workDir: tmp });
    const node = g.nodes.get('aisdlc-1')!;
    expect(priorityWeightFor(node, () => undefined)).toBe(DEFAULT_PRIORITY_WEIGHT);
  });
});

describe('computeEffectivePriorities — leaf / no-downstream', () => {
  it('a single isolated task carries effectivePriority == basePriority', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'solo', priority: 'high' });
    const g = buildDependencyGraph({ workDir: tmp });
    const records = computeEffectivePriorities(g);
    const r = records.get('aisdlc-1')!;
    expect(r.basePriority).toBe(PRIORITY_WEIGHT.high);
    expect(r.effectivePriority).toBe(PRIORITY_WEIGHT.high);
    expect(r.criticalPathLength).toBe(0);
  });

  it('a leaf task with no downstream and no priority carries the default weight', () => {
    writeTaskFile(tmp, { id: 'AISDLC-1', title: 'solo' });
    const g = buildDependencyGraph({ workDir: tmp });
    const r = computeEffectivePriorities(g).get('aisdlc-1')!;
    expect(r.basePriority).toBe(DEFAULT_PRIORITY_WEIGHT);
    expect(r.effectivePriority).toBe(DEFAULT_PRIORITY_WEIGHT);
  });
});

describe('computeEffectivePriorities — linear chain', () => {
  it('a low-priority root inherits the high-priority leaf', () => {
    // A → B → C  (A depends on nothing, C depends on B which depends on A).
    // Wait — convention: edges point from a task to its DEPENDENCIES (the
    // things it must wait on). So `dependencies: [A]` on B means B depends
    // on A. The downstream of A is everything that depends on A, i.e. B + C.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'root', priority: 'low' });
    writeTaskFile(tmp, {
      id: 'AISDLC-B',
      title: 'mid',
      priority: 'medium',
      dependencies: ['AISDLC-A'],
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-C',
      title: 'leaf',
      priority: 'critical',
      dependencies: ['AISDLC-B'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    const records = computeEffectivePriorities(g);

    // A has downstream {B, C}; max basePriority across them is critical (4).
    const a = records.get('aisdlc-a')!;
    expect(a.basePriority).toBe(PRIORITY_WEIGHT.low);
    expect(a.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(a.criticalPathLength).toBe(2); // A → B → C, 2 forward steps

    // B has downstream {C}.
    const b = records.get('aisdlc-b')!;
    expect(b.basePriority).toBe(PRIORITY_WEIGHT.medium);
    expect(b.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(b.criticalPathLength).toBe(1);

    // C is a leaf — no downstream, effectivePriority == basePriority.
    const c = records.get('aisdlc-c')!;
    expect(c.basePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(c.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(c.criticalPathLength).toBe(0);
  });

  it('per-task basePriority is unchanged by composition (RFC §5.3 read-only contract)', () => {
    // AC #3: composition is read-only for PPA. The per-task basePriority must
    // equal the priority weight written by the author, regardless of where in
    // the chain the task sits.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'root', priority: 'low' });
    writeTaskFile(tmp, {
      id: 'AISDLC-B',
      title: 'leaf',
      priority: 'critical',
      dependencies: ['AISDLC-A'],
    });
    const records = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    expect(records.get('aisdlc-a')!.basePriority).toBe(PRIORITY_WEIGHT.low);
    expect(records.get('aisdlc-b')!.basePriority).toBe(PRIORITY_WEIGHT.critical);
  });
});

describe('computeEffectivePriorities — branching graph', () => {
  it('aggregates max across multiple downstream branches (not sum)', () => {
    // Diamond: ROOT has two downstream branches — one ending in a HIGH leaf,
    // the other ending in a CRITICAL leaf. ROOT should inherit CRITICAL (max),
    // NOT high+critical (sum). Per RFC §5.3 boundary contract.
    //
    //         ROOT (low)
    //        /          \
    //   MID-H (medium)   MID-C (medium)
    //      |                |
    //  LEAF-H (high)    LEAF-C (critical)
    writeTaskFile(tmp, { id: 'AISDLC-ROOT', title: 'r', priority: 'low' });
    writeTaskFile(tmp, {
      id: 'AISDLC-MIDH',
      title: 'mh',
      priority: 'medium',
      dependencies: ['AISDLC-ROOT'],
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-MIDC',
      title: 'mc',
      priority: 'medium',
      dependencies: ['AISDLC-ROOT'],
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-LEAFH',
      title: 'lh',
      priority: 'high',
      dependencies: ['AISDLC-MIDH'],
    });
    writeTaskFile(tmp, {
      id: 'AISDLC-LEAFC',
      title: 'lc',
      priority: 'critical',
      dependencies: ['AISDLC-MIDC'],
    });
    const records = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));

    const root = records.get('aisdlc-root')!;
    expect(root.basePriority).toBe(PRIORITY_WEIGHT.low);
    // MAX, not SUM: critical (4) wins over (high + critical) = 7.
    expect(root.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(root.criticalPathLength).toBe(2); // ROOT → MIDC → LEAFC

    // MIDH branch: downstream is just LEAFH (high). MIDH inherits HIGH.
    expect(records.get('aisdlc-midh')!.effectivePriority).toBe(PRIORITY_WEIGHT.high);

    // MIDC branch: downstream is just LEAFC (critical). MIDC inherits CRITICAL.
    expect(records.get('aisdlc-midc')!.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
  });

  it('handles a fan-in: two roots both inherit a shared high-priority downstream', () => {
    //  ROOT-A (low)   ROOT-B (low)
    //         \         /
    //          MERGE (critical)
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', priority: 'low' });
    writeTaskFile(tmp, {
      id: 'AISDLC-MERGE',
      title: 'm',
      priority: 'critical',
      dependencies: ['AISDLC-A', 'AISDLC-B'],
    });
    const records = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    expect(records.get('aisdlc-a')!.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(records.get('aisdlc-b')!.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
    expect(records.get('aisdlc-merge')!.effectivePriority).toBe(PRIORITY_WEIGHT.critical);
  });
});

describe('computeEffectivePriorities — cycle detection', () => {
  it('does not stack-overflow on a 2-node cycle and produces finite priorities', () => {
    // A → B → A (each depends on the other). validate() flags this separately;
    // the comparator just needs to terminate with finite numbers.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'low', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, {
      id: 'AISDLC-B',
      title: 'b',
      priority: 'high',
      dependencies: ['AISDLC-A'],
    });
    const records = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    expect(Number.isFinite(records.get('aisdlc-a')!.effectivePriority)).toBe(true);
    expect(Number.isFinite(records.get('aisdlc-b')!.effectivePriority)).toBe(true);
    // Both nodes see the other in their downstream once the cycle short-circuit
    // terminates, so each effective priority is the max of the two basePriorities.
    expect(records.get('aisdlc-a')!.effectivePriority).toBe(PRIORITY_WEIGHT.high);
    expect(records.get('aisdlc-b')!.effectivePriority).toBe(PRIORITY_WEIGHT.high);
  });

  it('does not stack-overflow on a self-loop', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-LOOP',
      title: 'loop',
      priority: 'medium',
      dependencies: ['AISDLC-LOOP'],
    });
    const records = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    const r = records.get('aisdlc-loop')!;
    expect(Number.isFinite(r.effectivePriority)).toBe(true);
    expect(r.effectivePriority).toBe(PRIORITY_WEIGHT.medium);
  });
});

describe('computeEffectivePriorities — monotonicity (AC #4)', () => {
  it('adding a high-priority downstream edge only INCREASES effective priority', () => {
    // Start with a single low-priority isolated task.
    writeTaskFile(tmp, { id: 'AISDLC-ROOT', title: 'r', priority: 'low' });
    const before = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    const rootBefore = before.get('aisdlc-root')!.effectivePriority;
    expect(rootBefore).toBe(PRIORITY_WEIGHT.low);

    // Now add a critical-priority task that depends on ROOT. ROOT's
    // effective priority should INCREASE to critical.
    writeTaskFile(tmp, {
      id: 'AISDLC-LEAF',
      title: 'l',
      priority: 'critical',
      dependencies: ['AISDLC-ROOT'],
    });
    const after = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    const rootAfter = after.get('aisdlc-root')!.effectivePriority;
    expect(rootAfter).toBeGreaterThanOrEqual(rootBefore);
    expect(rootAfter).toBe(PRIORITY_WEIGHT.critical);
  });

  it('adding a LOW-priority downstream edge does not DECREASE effective priority', () => {
    // ROOT is critical to start with (effectivePriority = 4). Adding a low
    // downstream that depends on it should keep ROOT at critical.
    writeTaskFile(tmp, { id: 'AISDLC-ROOT', title: 'r', priority: 'critical' });
    const before = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    const rootBefore = before.get('aisdlc-root')!.effectivePriority;
    expect(rootBefore).toBe(PRIORITY_WEIGHT.critical);

    writeTaskFile(tmp, {
      id: 'AISDLC-CHILD',
      title: 'c',
      priority: 'low',
      dependencies: ['AISDLC-ROOT'],
    });
    const after = computeEffectivePriorities(buildDependencyGraph({ workDir: tmp }));
    expect(after.get('aisdlc-root')!.effectivePriority).toBe(rootBefore);
  });
});

describe('computeEffectivePriorities — no-cache contract (AC #5)', () => {
  it('every call returns a fresh Map; no shared mutable state across calls', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', priority: 'high' });
    const g = buildDependencyGraph({ workDir: tmp });
    const m1 = computeEffectivePriorities(g);
    const m2 = computeEffectivePriorities(g);
    expect(m1).not.toBe(m2);
    expect(m1.get('aisdlc-a')).not.toBe(m2.get('aisdlc-a'));
    // But same content.
    expect(m1.get('aisdlc-a')!.effectivePriority).toBe(m2.get('aisdlc-a')!.effectivePriority);
  });
});
