import { describe, it, expect } from 'vitest';
import { resolveReviewerHarnessSetting, routedModel } from './role-model.js';
import {
  clearModelMarker,
  readActiveMarkers,
  writeModelMarker,
  type ModelMarker,
} from './model-unavailable.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const table = `apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
metadata:
  name: model-routing
spec:
  strength: [haiku, sonnet, opus]
  exploreShare: 0
  salt: s
  cells:
    developer:
      '*': { model: opus }
`;

describe('routedModel', () => {
  it('reads the wildcard cell of the table', () => {
    expect(routedModel('developer', { readBaseTable: () => table })).toBe('opus');
  });
  it('falls back to the built-in default when the table has no cell', () => {
    expect(routedModel('review-executor', { readBaseTable: () => table })).toBe('haiku');
    expect(routedModel('planner-session', { readBaseTable: () => null })).toBe('fable');
  });
  it('throws for a role with neither cell nor default', () => {
    expect(() => routedModel('nope', { readBaseTable: () => null })).toThrow(/nope/);
  });
});

describe('resolveReviewerHarnessSetting (AISDLC-1003)', () => {
  const withHarness = (h: string): string => table.replace('  cells:', `  harness: ${h}\n  cells:`);

  it('defaults to codex when neither the key nor the env var is set', () => {
    expect(resolveReviewerHarnessSetting(undefined, { readBaseTable: () => table })).toEqual({
      harness: 'codex',
      source: 'default',
    });
    expect(resolveReviewerHarnessSetting('', { readBaseTable: () => null })).toEqual({
      harness: 'codex',
      source: 'default',
    });
  });
  it('uses the yaml key when the env var is unset', () => {
    expect(
      resolveReviewerHarnessSetting(undefined, { readBaseTable: () => withHarness('claude') }),
    ).toEqual({ harness: 'claude', source: 'yaml' });
  });
  it('lets the env var override the yaml key', () => {
    expect(
      resolveReviewerHarnessSetting('codex', { readBaseTable: () => withHarness('claude') }),
    ).toEqual({ harness: 'codex', source: 'env' });
    expect(
      resolveReviewerHarnessSetting('CLAUDE', { readBaseTable: () => withHarness('codex') }),
    ).toEqual({ harness: 'claude', source: 'env' });
  });
  it('ignores an invalid yaml value (falls back to the default table)', () => {
    expect(
      resolveReviewerHarnessSetting(undefined, { readBaseTable: () => withHarness('gpt') }),
    ).toEqual({ harness: 'codex', source: 'default' });
  });
});

describe('model fallback (AISDLC-1364)', () => {
  const fableTable = `apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
metadata:
  name: model-routing
spec:
  strength: [haiku, sonnet, opus, fable]
  exploreShare: 0
  salt: s
  cells:
    planner-session:
      '*': { model: fable }
    security-reviewer:
      '*': { model: opus }
    developer:
      '*': { model: haiku }
`;
  const until = '2026-11-24T20:00:00.000Z';
  const mk = (model: string): ModelMarker => ({ model, until, reason: 'usage limit reached' });
  const before = new Date('2026-11-21T00:00:00Z');
  const after = new Date('2026-11-24T20:00:01Z');
  const base = { readBaseTable: () => fableTable };

  it('steps down by strength order and returns to fable after the marker expires', () => {
    const opts = { ...base, unavailable: [mk('fable')], now: before };
    expect(routedModel('planner-session', opts)).toBe('opus');
    expect(routedModel('planner-session', { ...opts, now: after })).toBe('fable');
  });
  it('skips a second unavailable model', () => {
    const opts = { ...base, unavailable: [mk('fable'), mk('opus')], now: before };
    expect(routedModel('planner-session', opts)).toBe('sonnet');
  });
  it('the security reviewer never resolves below opus', () => {
    const opts = { ...base, unavailable: [mk('opus')], now: before };
    expect(() => routedModel('security-reviewer', opts)).toThrow(
      /no allowed fallback.*security floor/,
    );
  });
  it('a role with nothing weaker fails instead of downgrading', () => {
    const opts = { ...base, unavailable: [mk('haiku')], now: before };
    expect(() => routedModel('developer', opts)).toThrow(
      /no allowed fallback for role "developer"/,
    );
  });
  it('leaves an unmarked or unlisted model alone', () => {
    expect(routedModel('developer', { ...base, unavailable: [mk('fable')], now: before })).toBe(
      'haiku',
    );
    expect(
      routedModel('planner-session', {
        readBaseTable: () => null,
        unavailable: [mk('fable')],
        now: before,
      }),
    ).toBe('fable');
  });
  it('markers round-trip, expire and clear', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'marker-'));
    try {
      expect(readActiveMarkers(dir, before)).toEqual([]);
      writeModelMarker(dir, mk('fable'));
      writeModelMarker(dir, { ...mk('fable'), reason: 'again' });
      expect(readActiveMarkers(dir, before)).toEqual([{ ...mk('fable'), reason: 'again' }]);
      expect(readActiveMarkers(dir, after)).toEqual([]);
      expect(clearModelMarker(dir, 'fable')).toBe(true);
      expect(clearModelMarker(dir, 'fable')).toBe(false);
      writeFileSync(path.join(dir, 'model-unavailable.json'), '{bad');
      expect(readActiveMarkers(dir, before)).toEqual([]);
      writeFileSync(path.join(dir, 'model-unavailable.json'), '{"a":1}');
      expect(readActiveMarkers(dir, before)).toEqual([]);
      writeModelMarker(dir, { model: 'x', until: 'not-a-date', reason: 'r' });
      expect(readActiveMarkers(dir, before)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
