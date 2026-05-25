/**
 * decisions-config.ts unit tests — AISDLC-292 AC#6.
 */

import { describe, expect, it } from 'vitest';

import {
  actorLabel,
  DEFAULT_CAPACITY_TIERS,
  DEFAULT_FATIGUE_CONFIG,
  DEFAULT_LOAD_BEARING_FORMULA,
  loadDecisionsConfig,
  resolveDecisionsConfig,
  resolveDecisionsCapacityConfig,
  resolveFatigueConfig,
  type DecisionsConfig,
} from './decisions-config.js';

// ── loadDecisionsConfig ───────────────────────────────────────────────────────

describe('loadDecisionsConfig', () => {
  it('returns empty object when file is missing (ENOENT)', () => {
    const reader = (): string => {
      const e = Object.assign(new Error('not found'), { code: 'ENOENT' });
      throw e;
    };
    expect(loadDecisionsConfig({ reader })).toEqual({});
  });

  it('returns empty object on invalid YAML', () => {
    const reader = (): string => '{ bad: yaml: [unclosed';
    expect(loadDecisionsConfig({ reader })).toEqual({});
  });

  it('returns empty object when YAML is a scalar', () => {
    const reader = (): string => 'just a string';
    expect(loadDecisionsConfig({ reader })).toEqual({});
  });

  it('parses a full valid config', () => {
    const raw = `
notification:
  tui:
    enabled: true
  slack:
    enabled: true
    webhookUrl: "https://hooks.slack.com/services/T/B/X"
  email:
    enabled: true
    recipients:
      - alice@example.com
      - bob@example.com
pillarOwners:
  engineering: alice@example.com
  product: bob@example.com
  operator: alice@example.com
auditDigest:
  mode: all
overrideWindowHours: 48
`.trim();
    const reader = (): string => raw;
    const cfg = loadDecisionsConfig({ reader });
    expect(cfg.notification?.slack?.enabled).toBe(true);
    expect(cfg.notification?.slack?.webhookUrl).toBe('https://hooks.slack.com/services/T/B/X');
    expect(cfg.notification?.email?.recipients).toEqual(['alice@example.com', 'bob@example.com']);
    expect(cfg.pillarOwners?.engineering).toBe('alice@example.com');
    expect(cfg.auditDigest?.mode).toBe('all');
    expect(cfg.overrideWindowHours).toBe(48);
  });

  it('parses a minimal config with only notification.tui', () => {
    const raw = `notification:\n  tui:\n    enabled: false\n`;
    const reader = (): string => raw;
    const cfg = loadDecisionsConfig({ reader });
    expect(cfg.notification?.tui?.enabled).toBe(false);
    expect(cfg.notification?.slack).toBeUndefined();
  });
});

// ── resolveDecisionsConfig ────────────────────────────────────────────────────

describe('resolveDecisionsConfig', () => {
  it('fills in all defaults when loaded is empty', () => {
    const resolved = resolveDecisionsConfig({});
    expect(resolved.notification.tui.enabled).toBe(true);
    expect(resolved.notification.slack.enabled).toBe(false);
    expect(resolved.notification.slack.webhookUrl).toBe('');
    expect(resolved.notification.email.enabled).toBe(false);
    expect(resolved.notification.email.recipients).toEqual([]);
    expect(resolved.auditDigest.mode).toBe('overridden-only');
    expect(resolved.overrideWindowHours).toBe(24);
    expect(resolved.pillarOwners).toEqual({});
  });

  it('preserves configured values', () => {
    const loaded: DecisionsConfig = {
      notification: {
        slack: { enabled: true, webhookUrl: 'https://example.com/hook' },
        email: { enabled: true, recipients: ['x@y.com'] },
      },
      overrideWindowHours: 48,
    };
    const resolved = resolveDecisionsConfig(loaded);
    expect(resolved.notification.slack.enabled).toBe(true);
    expect(resolved.notification.slack.webhookUrl).toBe('https://example.com/hook');
    expect(resolved.notification.email.enabled).toBe(true);
    expect(resolved.notification.email.recipients).toEqual(['x@y.com']);
    expect(resolved.overrideWindowHours).toBe(48);
  });
});

// ── actorLabel ────────────────────────────────────────────────────────────────

describe('actorLabel', () => {
  const config: DecisionsConfig = {
    pillarOwners: {
      engineering: 'eng@example.com',
      product: 'pm@example.com',
      design: 'design@example.com',
      operator: 'op@example.com',
    },
  };

  it('returns "Unassigned" for null/undefined', () => {
    expect(actorLabel(null, config)).toBe('Unassigned');
    expect(actorLabel(undefined, config)).toBe('Unassigned');
  });

  it('returns "Framework" for the literal "framework"', () => {
    expect(actorLabel('framework', config)).toBe('Framework');
  });

  it('returns "Operator" for the literal "operator"', () => {
    expect(actorLabel('operator', config)).toBe('Operator');
  });

  it('maps pillarOwners.operator email to "Operator"', () => {
    expect(actorLabel('op@example.com', config)).toBe('Operator');
  });

  it('maps pillarOwners.engineering email to "Engineering"', () => {
    expect(actorLabel('eng@example.com', config)).toBe('Engineering');
  });

  it('maps pillarOwners.product email to "Product"', () => {
    expect(actorLabel('pm@example.com', config)).toBe('Product');
  });

  it('maps pillarOwners.design email to "Design"', () => {
    expect(actorLabel('design@example.com', config)).toBe('Design');
  });

  it('passes through unknown actor values', () => {
    expect(actorLabel('unknown@example.com', {})).toBe('unknown@example.com');
  });
});

// ── RFC-0035 Phase 7 (AISDLC-291) — capacity + fatigue + loadBearingFormula ─

describe('resolveFatigueConfig (Phase 7)', () => {
  it('returns explicit-only defaults per OQ-8', () => {
    const cfg = resolveFatigueConfig({});
    expect(cfg.inferFromBehavior).toBe(false);
    expect(cfg.overrideRateThreshold).toBe(0.5);
    expect(cfg.throughputDropThreshold).toBe(0.4);
    expect(cfg.measurementWindowHours).toBe(1);
  });

  it('preserves opted-in inferFromBehavior + custom thresholds', () => {
    const cfg = resolveFatigueConfig({
      inferFromBehavior: true,
      overrideRateThreshold: 0.7,
      throughputDropThreshold: 0.3,
      measurementWindowHours: 2,
    });
    expect(cfg).toEqual({
      inferFromBehavior: true,
      overrideRateThreshold: 0.7,
      throughputDropThreshold: 0.3,
      measurementWindowHours: 2,
    });
  });

  it('handles undefined loaded (callers pass nothing)', () => {
    expect(resolveFatigueConfig(undefined)).toEqual(DEFAULT_FATIGUE_CONFIG);
  });
});

describe('resolveDecisionsCapacityConfig (Phase 7 — OQ-6 RFC-0016 t-shirt sizes)', () => {
  it('fills in all 5 tier defaults from §7.1', () => {
    const resolved = resolveDecisionsCapacityConfig({});
    expect(resolved.tiers.xs).toEqual(DEFAULT_CAPACITY_TIERS.xs);
    expect(resolved.tiers.s).toEqual(DEFAULT_CAPACITY_TIERS.s);
    expect(resolved.tiers.m).toEqual(DEFAULT_CAPACITY_TIERS.m);
    expect(resolved.tiers.l).toEqual(DEFAULT_CAPACITY_TIERS.l);
    expect(resolved.tiers.xl).toEqual(DEFAULT_CAPACITY_TIERS.xl);
    expect(resolved.loadBearingFormula).toBe(DEFAULT_LOAD_BEARING_FORMULA);
  });

  it('preserves per-tier overrides', () => {
    const resolved = resolveDecisionsCapacityConfig({
      xs: { perDay: 50 },
      l: { perDay: 1, estMinutes: 45 },
    });
    expect(resolved.tiers.xs.perDay).toBe(50);
    expect(resolved.tiers.xs.estMinutes).toBe(DEFAULT_CAPACITY_TIERS.xs.estMinutes);
    expect(resolved.tiers.l).toEqual({ perDay: 1, estMinutes: 45 });
    expect(resolved.tiers.m).toEqual(DEFAULT_CAPACITY_TIERS.m);
  });

  it('honors loadBearingFormula override (OQ-2 opt-into-linear)', () => {
    const resolved = resolveDecisionsCapacityConfig({ loadBearingFormula: 'linear' });
    expect(resolved.loadBearingFormula).toBe('linear');
  });

  it('handles undefined loaded (callers pass nothing)', () => {
    const resolved = resolveDecisionsCapacityConfig(undefined);
    expect(resolved.tiers.xs).toEqual(DEFAULT_CAPACITY_TIERS.xs);
    expect(resolved.loadBearingFormula).toBe(DEFAULT_LOAD_BEARING_FORMULA);
  });
});

describe('resolveDecisionsConfig (Phase 7) — capacity + fatigue', () => {
  it('fills capacity + fatigue defaults when not configured', () => {
    const resolved = resolveDecisionsConfig({});
    expect(resolved.capacity.tiers.m.perDay).toBe(6);
    expect(resolved.capacity.tiers.xl.perDay).toBe(1);
    expect(resolved.capacity.loadBearingFormula).toBe('log-blocked-count');
    expect(resolved.fatigue.inferFromBehavior).toBe(false);
  });

  it('preserves loaded capacity overrides', () => {
    const loaded: DecisionsConfig = {
      capacity: {
        m: { perDay: 10 },
        loadBearingFormula: 'linear',
      },
      fatigue: { inferFromBehavior: true },
    };
    const resolved = resolveDecisionsConfig(loaded);
    expect(resolved.capacity.tiers.m.perDay).toBe(10);
    expect(resolved.capacity.tiers.xs.perDay).toBe(DEFAULT_CAPACITY_TIERS.xs.perDay);
    expect(resolved.capacity.loadBearingFormula).toBe('linear');
    expect(resolved.fatigue.inferFromBehavior).toBe(true);
  });
});

describe('loadDecisionsConfig (Phase 7) — yaml parsing of capacity + fatigue', () => {
  it('parses a Phase 7 yaml with capacity tiers + fatigue + overrideWindow', () => {
    const raw = `
capacity:
  xs:
    perDay: 60
  l:
    perDay: 1
    estMinutes: 45
  loadBearingFormula: linear
fatigue:
  inferFromBehavior: true
  overrideRateThreshold: 0.6
  measurementWindowHours: 2
overrideWindowHours: 48
`.trim();
    const cfg = loadDecisionsConfig({ reader: (): string => raw });
    expect(cfg.capacity?.xs?.perDay).toBe(60);
    expect(cfg.capacity?.l).toEqual({ perDay: 1, estMinutes: 45 });
    expect(cfg.capacity?.loadBearingFormula).toBe('linear');
    expect(cfg.fatigue?.inferFromBehavior).toBe(true);
    expect(cfg.fatigue?.overrideRateThreshold).toBe(0.6);
    expect(cfg.fatigue?.measurementWindowHours).toBe(2);
    expect(cfg.overrideWindowHours).toBe(48);
  });
});
