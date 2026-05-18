/**
 * decisions-config.ts unit tests — AISDLC-292 AC#6.
 */

import { describe, expect, it } from 'vitest';

import {
  actorLabel,
  loadDecisionsConfig,
  resolveDecisionsConfig,
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
