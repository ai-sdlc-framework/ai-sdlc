/**
 * External signal ingestion for the PPA (RFC-0053 human surface, RFC-0008).
 *
 * Adapters (support, CRM, analytics, roadmap exports) turn raw records into
 * `ExternalSignalEntry` knowledge entries carrying a source, an observed date
 * and a decay half-life. `computePriority` accepts the entries as an optional
 * input; with none supplied the score is unchanged.
 *
 * Real per-source adapters are adopter-owned follow-ups. This module ships the
 * interface and one fixture CSV adapter.
 */

import { now as clockNow } from './clock.js';

/** A single ingested signal, ready to feed the PPA demand dimension. */
export interface ExternalSignalEntry {
  /** Work item the signal applies to. */
  itemId: string;
  /** Origin of the signal, e.g. `support`, `crm`, `analytics`, `roadmap`. */
  source: string;
  /** ISO-8601 date the signal was observed. */
  observedAt: string;
  /** Strength in [0, 1]; higher means more demand pressure. */
  strength: number;
  /** Half-life in days; the signal's weight halves every `halfLifeDays`. */
  halfLifeDays: number;
  /** Optional free-text note. */
  note?: string;
}

/** Adapter interface: one implementation per external export format. */
export interface ExternalSignalAdapter {
  /** Stable adapter name, used in diagnostics. */
  readonly name: string;
  /** Parse raw export content into knowledge entries. Malformed rows are skipped. */
  ingest(raw: string): ExternalSignalEntry[];
}

/** Default decay half-life when a record does not specify one. */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/** Maximum demand-signal uplift external signals can contribute. */
const MAX_UPLIFT = 0.4;

const MS_PER_DAY = 86_400_000;

/** Decay factor in (0, 1] for an entry observed at `observedAt`, as of `now`. */
export function decayFactor(entry: ExternalSignalEntry, now: Date = clockNow()): number {
  const observed = Date.parse(entry.observedAt);
  if (Number.isNaN(observed) || entry.halfLifeDays <= 0) return 0;
  const ageDays = Math.max(0, (now.getTime() - observed) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / entry.halfLifeDays);
}

/**
 * Aggregate uplift in [0, MAX_UPLIFT] for one item: decayed strengths are
 * summed and saturate smoothly.
 */
export function externalSignalUplift(
  itemId: string,
  entries: readonly ExternalSignalEntry[],
  now: Date = clockNow(),
): number {
  let total = 0;
  for (const e of entries) {
    if (e.itemId !== itemId) continue;
    total += Math.min(1, Math.max(0, e.strength)) * decayFactor(e, now);
  }
  return MAX_UPLIFT * (1 - Math.exp(-total));
}

/**
 * Fixture adapter reading a CSV export with the header
 * `itemId,source,observedAt,strength[,halfLifeDays[,note]]`.
 * Does not support quoted commas; it is a fixture, not a production parser.
 */
export const csvSignalAdapter: ExternalSignalAdapter = {
  name: 'csv-fixture',
  ingest(raw: string): ExternalSignalEntry[] {
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const entries: ExternalSignalEntry[] = [];
    for (const line of lines.slice(1)) {
      const [itemId, source, observedAt, strengthRaw, halfLifeRaw, note] = line
        .split(',')
        .map((c) => c.trim());
      const strength = Number(strengthRaw);
      if (!itemId || !source || Number.isNaN(Date.parse(observedAt ?? '')) || !strengthRaw)
        continue;
      if (Number.isNaN(strength)) continue;
      const halfLife = halfLifeRaw ? Number(halfLifeRaw) : DEFAULT_HALF_LIFE_DAYS;
      entries.push({
        itemId,
        source,
        observedAt,
        strength,
        halfLifeDays: Number.isFinite(halfLife) && halfLife > 0 ? halfLife : DEFAULT_HALF_LIFE_DAYS,
        ...(note ? { note } : {}),
      });
    }
    return entries;
  },
};
