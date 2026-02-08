import { describe, it, expect } from 'vitest';
import { sequential, parallel, router, hierarchical, collaborative } from './orchestration.js';
import type { AgentRole } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

function makeAgent(name: string, handoffs?: { target: string; trigger: string }[]): AgentRole {
  return {
    apiVersion: API_VERSION,
    kind: 'AgentRole',
    metadata: { name },
    spec: {
      role: name,
      goal: `${name} goal`,
      tools: ['tool-a'],
      handoffs,
    },
  };
}

describe('sequential()', () => {
  it('creates a linear dependency chain', () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const plan = sequential(agents);
    expect(plan.pattern).toBe('sequential');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].dependsOn).toBeUndefined();
    expect(plan.steps[1].dependsOn).toEqual(['a']);
    expect(plan.steps[2].dependsOn).toEqual(['b']);
  });

  it('single agent has no deps', () => {
    const plan = sequential([makeAgent('solo')]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].dependsOn).toBeUndefined();
  });
});

describe('parallel()', () => {
  it('all steps have no deps', () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const plan = parallel(agents);
    expect(plan.pattern).toBe('parallel');
    expect(plan.steps).toHaveLength(3);
    for (const step of plan.steps) {
      expect(step.dependsOn).toBeUndefined();
    }
  });
});

describe('router()', () => {
  it('specialists depend on dispatcher', () => {
    const dispatcher = makeAgent('dispatcher');
    const specialists = [makeAgent('s1'), makeAgent('s2')];
    const plan = router(dispatcher, specialists);
    expect(plan.pattern).toBe('router');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].agent).toBe('dispatcher');
    expect(plan.steps[0].dependsOn).toBeUndefined();
    expect(plan.steps[1].dependsOn).toEqual(['dispatcher']);
    expect(plan.steps[2].dependsOn).toEqual(['dispatcher']);
  });
});

describe('hierarchical()', () => {
  it('workers depend on manager', () => {
    const manager = makeAgent('manager');
    const workers = [makeAgent('w1'), makeAgent('w2')];
    const plan = hierarchical(manager, workers);
    expect(plan.pattern).toBe('hierarchical');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].agent).toBe('manager');
    expect(plan.steps[0].dependsOn).toBeUndefined();
    expect(plan.steps[1].dependsOn).toEqual(['manager']);
    expect(plan.steps[2].dependsOn).toEqual(['manager']);
  });
});

describe('collaborative()', () => {
  it('derives deps from handoff declarations', () => {
    const agents = [
      makeAgent('planner', [{ target: 'coder', trigger: 'plan-complete' }]),
      makeAgent('coder', [{ target: 'reviewer', trigger: 'code-complete' }]),
      makeAgent('reviewer'),
    ];
    const plan = collaborative(agents);
    expect(plan.pattern).toBe('collaborative');
    // planner hands off to coder → coder depends on planner
    // coder hands off to reviewer → reviewer depends on coder
    expect(plan.steps[0].dependsOn).toBeUndefined(); // planner — nobody hands off to it
    expect(plan.steps[1].dependsOn).toEqual(['planner']); // coder depends on planner
    expect(plan.steps[2].dependsOn).toEqual(['coder']); // reviewer depends on coder
  });

  it('no handoffs means no deps', () => {
    const agents = [makeAgent('a'), makeAgent('b')];
    const plan = collaborative(agents);
    for (const step of plan.steps) {
      expect(step.dependsOn).toBeUndefined();
    }
  });
});
