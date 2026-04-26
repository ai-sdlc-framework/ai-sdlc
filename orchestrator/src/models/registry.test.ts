import { describe, it, expect } from 'vitest';
import {
  ModelRegistry,
  ModelRemovedError,
  UnknownAliasError,
  DEFAULT_REGISTRY,
  type ModelEntry,
} from './registry.js';

describe('ModelRegistry', () => {
  const fixedClock = (iso: string) => () => new Date(iso);

  it('default registry exposes the four canonical aliases', () => {
    const reg = new ModelRegistry();
    expect(
      reg
        .list()
        .map((e) => e.alias)
        .sort(),
    ).toEqual(['haiku', 'opus', 'opus[1m]', 'sonnet'].sort());
  });

  describe('resolve', () => {
    it('returns modelId and an ok event for an active alias', () => {
      const reg = new ModelRegistry();
      const r = reg.resolve('sonnet');
      expect(r.modelId).toBe('claude-sonnet-4-6');
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toEqual({ type: 'ok', alias: 'sonnet', modelId: 'claude-sonnet-4-6' });
    });

    it('throws UnknownAliasError on unrecognized alias', () => {
      const reg = new ModelRegistry();
      expect(() => reg.resolve('mystery-model')).toThrow(UnknownAliasError);
    });

    it('throws ModelRemovedError when removedAt has passed', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'old',
          modelId: 'claude-old',
          deprecatedAt: '2026-01-01',
          removedAt: '2026-04-01',
          replacementAlias: 'sonnet',
        },
      ];
      const reg = new ModelRegistry(entries);
      expect(() => reg.resolve('old', { now: fixedClock('2026-04-15') })).toThrow(
        ModelRemovedError,
      );
    });

    it('emits ModelDeprecated for an alias past deprecatedAt but before removedAt', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'old',
          modelId: 'claude-old',
          deprecatedAt: '2026-01-01',
          removedAt: '2026-12-01',
          replacementAlias: 'sonnet',
        },
      ];
      const reg = new ModelRegistry(entries);
      const r = reg.resolve('old', { now: fixedClock('2026-06-15') });
      expect(r.modelId).toBe('claude-old');
      const deprecated = r.events.find((e) => e.type === 'ModelDeprecated');
      expect(deprecated).toBeDefined();
      // Not yet in grace period (more than 30 days from removal).
      expect(r.events.some((e) => e.type === 'ModelDeprecationGracePeriod')).toBe(false);
    });

    it('emits ModelDeprecationGracePeriod when within 30 days of removal', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'soon-removed',
          modelId: 'claude-soon',
          deprecatedAt: '2026-01-01',
          removedAt: '2026-05-01',
          replacementAlias: 'sonnet',
        },
      ];
      const reg = new ModelRegistry(entries);
      // 15 days before removedAt → within grace period
      const r = reg.resolve('soon-removed', { now: fixedClock('2026-04-16') });
      expect(r.events.some((e) => e.type === 'ModelDeprecated')).toBe(true);
      expect(r.events.some((e) => e.type === 'ModelDeprecationGracePeriod')).toBe(true);
    });

    it('does not emit deprecation events when deprecatedAt is in the future', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'future-deprecated',
          modelId: 'claude-future',
          deprecatedAt: '2027-01-01',
          removedAt: null,
          replacementAlias: null,
        },
      ];
      const reg = new ModelRegistry(entries);
      const r = reg.resolve('future-deprecated', { now: fixedClock('2026-04-15') });
      expect(r.events).toEqual([
        { type: 'ok', alias: 'future-deprecated', modelId: 'claude-future' },
      ]);
    });
  });

  describe('resolveAll', () => {
    it('pins resolution for multiple stages at once', () => {
      const reg = new ModelRegistry();
      const result = reg.resolveAll([
        { stage: 'triage', alias: 'haiku' },
        { stage: 'plan', alias: 'sonnet' },
        { stage: 'implement', alias: 'opus[1m]' },
      ]);
      expect(result.get('triage')?.modelId).toBe('claude-haiku-4-5-20251001');
      expect(result.get('plan')?.modelId).toBe('claude-sonnet-4-6');
      expect(result.get('implement')?.modelId).toBe('claude-opus-4-7[1m]');
    });

    it('throws on first unknown alias', () => {
      const reg = new ModelRegistry();
      expect(() =>
        reg.resolveAll([
          { stage: 'triage', alias: 'haiku' },
          { stage: 'plan', alias: 'mystery' },
        ]),
      ).toThrow(UnknownAliasError);
    });
  });

  describe('bumpPlan', () => {
    it('returns no entries when nothing is deprecated', () => {
      const reg = new ModelRegistry();
      const plan = reg.bumpPlan([{ stage: 'triage', alias: 'haiku' }]);
      expect(plan).toEqual([]);
    });

    it('reports stages whose alias resolves to a deprecated model with replacement details', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'haiku',
          modelId: 'claude-haiku-4-5-20251001',
          deprecatedAt: '2026-03-01',
          removedAt: '2026-09-01',
          replacementAlias: 'haiku-next',
        },
        {
          alias: 'haiku-next',
          modelId: 'claude-haiku-5-0-20270115',
          deprecatedAt: null,
          removedAt: null,
          replacementAlias: null,
        },
      ];
      const reg = new ModelRegistry(entries);
      const plan = reg.bumpPlan([{ stage: 'triage', alias: 'haiku' }], {
        now: fixedClock('2026-06-15'),
      });
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        stage: 'triage',
        alias: 'haiku',
        currentModelId: 'claude-haiku-4-5-20251001',
        replacementAlias: 'haiku-next',
        replacementModelId: 'claude-haiku-5-0-20270115',
        inGracePeriod: false,
      });
    });

    it('flags inGracePeriod when within 30 days of removal', () => {
      const entries: ModelEntry[] = [
        {
          alias: 'old',
          modelId: 'claude-old',
          deprecatedAt: '2026-01-01',
          removedAt: '2026-05-01',
          replacementAlias: 'sonnet',
        },
      ];
      const reg = new ModelRegistry(entries);
      const plan = reg.bumpPlan([{ stage: 's1', alias: 'old' }], {
        now: fixedClock('2026-04-20'),
      });
      expect(plan[0].inGracePeriod).toBe(true);
    });
  });

  it('the shipped DEFAULT_REGISTRY entries are all active (no deprecation)', () => {
    for (const e of DEFAULT_REGISTRY) {
      expect(e.deprecatedAt).toBeNull();
      expect(e.removedAt).toBeNull();
    }
  });
});
