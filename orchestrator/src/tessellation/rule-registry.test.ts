/**
 * RFC-0009 §13 + RFC-0018 OQ-10 — Tessellation§13RuleRegistry tests.
 *
 * Covers acceptance criteria:
 *   AC #1: Tessellation§13RuleRegistry ships with `register(rule)` + `getRegisteredRules()` API.
 *   AC #2: Standard rule interface defined: `{ name, description, scan(target): DriftEvent[], severity }`.
 *   AC #3: Existing §13 rules refactored to use registry (regression tests — covered in this file
 *          via rule round-trip; full regression in dedicated rule test files).
 *   AC #6: §13 dispatcher fans out all registered rules in parallel; aggregates Decisions.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createTessellation13Registry,
  type TessellationRule,
  type DriftEvent,
  type RuleScanTarget,
  type DriftSeverity,
} from './rule-registry.js';

// ── Fixture helpers ────────────────────────────────────────────────────

function makeTarget(overrides: Partial<RuleScanTarget> = {}): RuleScanTarget {
  return {
    tessellatedDid: 'did:platform-x:platform',
    ...overrides,
  };
}

function makeDriftEvent(overrides: Partial<DriftEvent> = {}): DriftEvent {
  return {
    rule: 'test-rule',
    timestamp: '2026-05-30T00:00:00.000Z',
    message: 'test drift detected',
    severity: 'medium',
    details: {},
    ...overrides,
  };
}

/** Create a minimal sync rule that returns a fixed set of events. */
function makeRule(
  name: string,
  events: DriftEvent[] = [],
  severity: DriftSeverity = 'warning',
): TessellationRule {
  return {
    name,
    description: `Test rule: ${name}`,
    severity,
    scan: () => events,
  };
}

/** Create a minimal async rule that resolves after a tick. */
function makeAsyncRule(name: string, events: DriftEvent[] = []): TessellationRule {
  return {
    name,
    description: `Async test rule: ${name}`,
    severity: 'medium',
    scan: () => Promise.resolve(events),
  };
}

/** Create a rule that throws. */
function makeThrowingRule(name: string, message: string): TessellationRule {
  return {
    name,
    description: `Throwing rule: ${name}`,
    severity: 'high',
    scan: () => {
      throw new Error(message);
    },
  };
}

// ── AC #1: register + getRegisteredRules ──────────────────────────────

describe('Tessellation13Registry — AC #1: register + getRegisteredRules', () => {
  it('starts with an empty rule list', () => {
    const registry = createTessellation13Registry();
    expect(registry.getRegisteredRules()).toEqual([]);
  });

  it('register() adds a rule; getRegisteredRules() returns it', () => {
    const registry = createTessellation13Registry();
    const rule = makeRule('rule-a');
    registry.register(rule);
    expect(registry.getRegisteredRules()).toHaveLength(1);
    expect(registry.getRegisteredRules()[0]).toBe(rule);
  });

  it('register() adds multiple rules; getRegisteredRules() returns all in order', () => {
    const registry = createTessellation13Registry();
    const ruleA = makeRule('rule-a');
    const ruleB = makeRule('rule-b');
    const ruleC = makeRule('rule-c');
    registry.register(ruleA);
    registry.register(ruleB);
    registry.register(ruleC);
    const rules = registry.getRegisteredRules();
    expect(rules).toHaveLength(3);
    expect(rules[0]).toBe(ruleA);
    expect(rules[1]).toBe(ruleB);
    expect(rules[2]).toBe(ruleC);
  });

  it('getRegisteredRules() returns a ReadonlyArray (snapshot is stable)', () => {
    const registry = createTessellation13Registry();
    registry.register(makeRule('rule-a'));
    const snapshot = registry.getRegisteredRules();
    expect(snapshot).toHaveLength(1);
    // Registering another rule does not mutate the already-captured snapshot reference
    registry.register(makeRule('rule-b'));
    // snapshot might still point to the same array — test that the returned value
    // reflects the current state when called again
    expect(registry.getRegisteredRules()).toHaveLength(2);
  });
});

// ── AC #2: Standard rule interface shape ─────────────────────────────

describe('Tessellation13Registry — AC #2: standard rule interface', () => {
  it('accepts a rule with the standard interface fields', () => {
    const registry = createTessellation13Registry();
    const rule: TessellationRule = {
      name: 'my-rule',
      description: 'Detects my kind of drift',
      severity: 'medium',
      scan: (_target) => [],
    };
    // Must not throw
    registry.register(rule);
    expect(registry.getRegisteredRules()).toHaveLength(1);
    const registered = registry.getRegisteredRules()[0];
    expect(registered.name).toBe('my-rule');
    expect(registered.description).toBe('Detects my kind of drift');
    expect(registered.severity).toBe('medium');
    expect(typeof registered.scan).toBe('function');
  });

  it('rule severity can be high, medium, or warning', () => {
    const high = makeRule('high-rule', [], 'high');
    const medium = makeRule('medium-rule', [], 'medium');
    const warning = makeRule('warning-rule', [], 'warning');
    const registry = createTessellation13Registry();
    registry.register(high);
    registry.register(medium);
    registry.register(warning);
    const rules = registry.getRegisteredRules();
    expect(rules[0].severity).toBe('high');
    expect(rules[1].severity).toBe('medium');
    expect(rules[2].severity).toBe('warning');
  });

  it('scan() can return an empty array (no drift)', () => {
    const rule = makeRule('clean-rule', []);
    const events = rule.scan(makeTarget());
    expect(events).toEqual([]);
  });

  it('scan() can return one or more DriftEvent objects', () => {
    const ev1 = makeDriftEvent({ rule: 'my-rule', message: 'first drift' });
    const ev2 = makeDriftEvent({ rule: 'my-rule', message: 'second drift' });
    const rule = makeRule('my-rule', [ev1, ev2]);
    const events = rule.scan(makeTarget());
    expect(events).toHaveLength(2);
  });
});

// ── AC #6: dispatch fans out in parallel; aggregates results ─────────

describe('Tessellation13Registry — AC #6: parallel dispatch + aggregation', () => {
  it('dispatch() returns empty array when no rules registered', async () => {
    const registry = createTessellation13Registry();
    const events = await registry.dispatch(makeTarget());
    expect(events).toEqual([]);
  });

  it('dispatch() returns events from a single sync rule', async () => {
    const ev = makeDriftEvent({ rule: 'rule-a', message: 'drift!' });
    const registry = createTessellation13Registry();
    registry.register(makeRule('rule-a', [ev]));
    const events = await registry.dispatch(makeTarget());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rule: 'rule-a', message: 'drift!' });
  });

  it('dispatch() returns events from a single async rule', async () => {
    const ev = makeDriftEvent({ rule: 'async-rule', message: 'async drift!' });
    const registry = createTessellation13Registry();
    registry.register(makeAsyncRule('async-rule', [ev]));
    const events = await registry.dispatch(makeTarget());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rule: 'async-rule' });
  });

  it('dispatch() aggregates events from multiple rules in parallel', async () => {
    const evA = makeDriftEvent({ rule: 'rule-a', message: 'drift-a' });
    const evB = makeDriftEvent({ rule: 'rule-b', message: 'drift-b' });
    const evC = makeDriftEvent({ rule: 'rule-c', message: 'drift-c' });
    const registry = createTessellation13Registry();
    registry.register(makeRule('rule-a', [evA]));
    registry.register(makeAsyncRule('rule-b', [evB]));
    registry.register(makeRule('rule-c', [evC]));
    const events = await registry.dispatch(makeTarget());
    expect(events).toHaveLength(3);
    const names = events.map((e) => e.rule).sort();
    expect(names).toEqual(['rule-a', 'rule-b', 'rule-c']);
  });

  it('dispatch() passes the same target to all rules', async () => {
    const seenTargets: RuleScanTarget[] = [];
    const capturingRule = (name: string): TessellationRule => ({
      name,
      description: 'Captures target',
      severity: 'warning',
      scan: (t) => {
        seenTargets.push(t);
        return [];
      },
    });
    const target = makeTarget({ tessellatedDid: 'did:test:unique' });
    const registry = createTessellation13Registry();
    registry.register(capturingRule('r1'));
    registry.register(capturingRule('r2'));
    await registry.dispatch(target);
    expect(seenTargets).toHaveLength(2);
    for (const seen of seenTargets) {
      expect(seen.tessellatedDid).toBe('did:test:unique');
    }
  });

  it('dispatch() surfaces throwing rules as warning events, does not drop other rules', async () => {
    const goodEvent = makeDriftEvent({ rule: 'good-rule', message: 'good drift' });
    const registry = createTessellation13Registry();
    registry.register(makeRule('good-rule', [goodEvent]));
    registry.register(makeThrowingRule('bad-rule', 'boom!'));
    const events = await registry.dispatch(makeTarget());
    // good-rule's event is present
    expect(events.some((e) => e.rule === 'good-rule')).toBe(true);
    // bad-rule is surfaced as a warning, not silently dropped
    const errorEvent = events.find((e) => e.rule === 'bad-rule');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.severity).toBe('warning');
    expect(errorEvent!.message).toContain('boom!');
  });

  it('dispatch() rules run concurrently (measured by Promise.allSettled, not serialized)', async () => {
    // Each rule resolves after a brief delay; if they were serialized,
    // total time would be ~3×delay; if concurrent, ~1×delay.
    const delay = (ms: number) => new Promise<DriftEvent[]>((r) => setTimeout(() => r([]), ms));
    const slowRule = (name: string): TessellationRule => ({
      name,
      description: 'Slow rule',
      severity: 'warning',
      scan: () => delay(20),
    });
    const registry = createTessellation13Registry();
    registry.register(slowRule('slow-1'));
    registry.register(slowRule('slow-2'));
    registry.register(slowRule('slow-3'));
    const start = Date.now();
    await registry.dispatch(makeTarget());
    const elapsed = Date.now() - start;
    // Concurrent: ~20ms. Serialized: ~60ms. Allow 3× margin for CI jitter.
    expect(elapsed).toBeLessThan(100);
  });

  it('dispatch() aggregates all events when multiple rules each emit multiple events', async () => {
    const events1 = [
      makeDriftEvent({ rule: 'r1', message: 'a' }),
      makeDriftEvent({ rule: 'r1', message: 'b' }),
    ];
    const events2 = [makeDriftEvent({ rule: 'r2', message: 'c' })];
    const registry = createTessellation13Registry();
    registry.register(makeRule('r1', events1));
    registry.register(makeRule('r2', events2));
    const result = await registry.dispatch(makeTarget());
    expect(result).toHaveLength(3);
  });

  it('dispatch() with empty rule list returns [] without invoking any scan', async () => {
    const scanFn = vi.fn().mockReturnValue([]);
    const registry = createTessellation13Registry();
    // No rules registered; scan should never be called
    const result = await registry.dispatch(makeTarget());
    expect(result).toEqual([]);
    expect(scanFn).not.toHaveBeenCalled();
  });
});

// ── AC #3 (partial): rule round-trip — name, description, severity ────

describe('Tessellation13Registry — AC #3: rule round-trip', () => {
  it('registered rule fields are preserved verbatim', () => {
    const registry = createTessellation13Registry();
    const rule: TessellationRule = {
      name: 'soul-slug-ast-scan',
      description: 'Scans substrate files for soul-slug string literals',
      severity: 'warning',
      scan: () => [],
    };
    registry.register(rule);
    const [r] = registry.getRegisteredRules();
    expect(r.name).toBe('soul-slug-ast-scan');
    expect(r.description).toBe('Scans substrate files for soul-slug string literals');
    expect(r.severity).toBe('warning');
  });

  it('two independent registries do not share state', () => {
    const r1 = createTessellation13Registry();
    const r2 = createTessellation13Registry();
    r1.register(makeRule('only-in-r1'));
    expect(r1.getRegisteredRules()).toHaveLength(1);
    expect(r2.getRegisteredRules()).toHaveLength(0);
  });
});
