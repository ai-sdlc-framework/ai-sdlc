import { describe, it, expect } from 'vitest';
import { csvSignalAdapter, decayFactor, externalSignalUplift } from './external-signals.js';
import { computePriority } from './priority.js';

const NOW = new Date('2026-10-28T00:00:00Z');
const csv = [
  'itemId,source,observedAt,strength,halfLifeDays,note',
  'A-1,support,2026-10-28,0.8,30,ticket spike',
  'A-1,crm,2026-09-28,1,,renewal ask',
  'bad,row',
  'A-2,analytics,not-a-date,0.5',
  'A-3,roadmap,2026-10-01,abc',
].join('\n');
const item = { itemId: 'A-1', title: 't', description: 'd' };

describe('csvSignalAdapter', () => {
  it('turns rows into entries with source, observed date and decay', () => {
    const entries = csvSignalAdapter.ingest(csv);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      source: 'support',
      observedAt: '2026-10-28',
      halfLifeDays: 30,
      note: 'ticket spike',
    });
    expect(entries[1].halfLifeDays).toBe(30);
    expect(decayFactor(entries[0], NOW)).toBeCloseTo(1);
    expect(decayFactor(entries[1], NOW)).toBeLessThan(0.55);
    expect(decayFactor({ ...entries[0], halfLifeDays: 0 }, NOW)).toBe(0);
  });
});

describe('PPA external signals', () => {
  it('raises the score when a signal is present', () => {
    const entries = csvSignalAdapter.ingest(csv);
    const base = computePriority(item);
    const boosted = computePriority(item, undefined, entries, NOW);
    expect(boosted.composite).toBeGreaterThan(base.composite);
  });
  it('ignores signals for other items and decays old ones', () => {
    const entries = csvSignalAdapter.ingest(csv);
    expect(externalSignalUplift('other', entries, NOW)).toBe(0);
    const old = [{ ...entries[0], observedAt: '2020-01-01' }];
    expect(externalSignalUplift('A-1', old, NOW)).toBeLessThan(0.001);
  });
  it('is unchanged with no adapter configured', () => {
    const a = computePriority(item);
    const b = computePriority(item, undefined, undefined);
    const c = computePriority(item, undefined, []);
    expect(b.dimensions).toEqual(a.dimensions);
    expect(c.composite).toBe(a.composite);
  });
});
