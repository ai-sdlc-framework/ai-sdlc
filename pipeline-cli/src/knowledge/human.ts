/**
 * Human surface for the knowledge layer (RFC-0053): confirm, correct, supersede,
 * coverage scoring and the plain-text gap dashboard. Every mutation is one named store write
 * (DEC-0443), which logs its knowledge-log event. Entries are superseded, never deleted.
 * Each write passes the version it read; on `conflict` it re-reads and retries
 * (`retryOnConflict`, AISDLC-1457).
 */
import { createHash } from 'node:crypto';
import { now } from '../clock.js';
import type { KnowledgeEntry } from './entry.js';
import {
  openKnowledgeStore,
  retryOnConflict,
  type KnowledgeBackendSelection,
  type WriteResult,
} from './knowledge-store.js';
import { type Actor, movedConfidence, notFound } from './promote.js';

/**
 * Confirm: confidence moves 30 percent toward the supplied value; authority never changes.
 * `confidence` is the new value when the write was applied or proposed.
 */
export async function confirmEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  id: string,
  confidence: number,
  actor: Actor,
  observed: string | undefined,
  projectRoot: string,
): Promise<WriteResult & { confidence?: number }> {
  const store = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs }, projectRoot);
  return retryOnConflict(async () => {
    const e = store.get(id);
    if (!e) return notFound(id);
    const next = movedConfidence(e.fields, confidence);
    const fields: Record<string, unknown> = { confidence: next };
    if (observed) fields.observed = observed;
    const r = await store.write(
      id,
      { kind: 'confirm', fields, principal: actor.principal },
      { scope: e.scope, expectedVersion: e.version },
    );
    return r.status === 'applied' || r.status === 'proposed' ? { ...r, confidence: next } : r;
  });
}

/**
 * Correct: replace the value and its hash in place; authority and confidence are untouched.
 * The store logs field names only, so no value (or hash of one) enters the committed log
 * (RFC-0053 OQ-1, OQ-7; AISDLC-1424).
 */
export async function correctEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  id: string,
  value: string,
  actor: Actor,
  observed: string | undefined,
  projectRoot: string,
): Promise<WriteResult> {
  const store = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs }, projectRoot);
  return retryOnConflict(async () => {
    const e = store.get(id);
    if (!e) return notFound(id);
    const fields: Record<string, unknown> = {
      value,
      contentHash: createHash('sha256').update(value).digest('hex'),
    };
    if (observed) fields.observed = observed;
    return store.write(
      id,
      { kind: 'correct', fields, principal: actor.principal },
      { scope: e.scope, expectedVersion: e.version },
    );
  });
}

/**
 * Supersede, one store call (DEC-0443): `newId` is created from the old entry with the new
 * value, linked by `supersedes`, and the old entry is marked `status: superseded` (it stays
 * on disk). `newId` must not exist yet.
 */
export async function supersedeEntry(
  sel: KnowledgeBackendSelection,
  trackedRootAbs: string,
  oldId: string,
  newId: string,
  value: string,
  actor: Actor,
  observed: string | undefined,
  projectRoot: string,
): Promise<WriteResult> {
  const store = openKnowledgeStore({ ...sel, trackedRoot: trackedRootAbs }, projectRoot);
  return retryOnConflict(async () => {
    const old = store.get(oldId, { scope: 'tracked' });
    if (!old) return notFound(oldId);
    const { status: _status, supersedes: _supersedes, ...kept } = old.fields;
    const fields: Record<string, unknown> = {
      ...kept,
      id: newId,
      value,
      contentHash: createHash('sha256').update(value).digest('hex'),
      relations: Array.isArray(old.fields.relations)
        ? (old.fields.relations as { type: string; target: string }[]).filter(
            (r) => r.type !== 'supersedes',
          )
        : [],
    };
    if (observed) fields.observed = observed;
    return store.write(
      oldId,
      { kind: 'supersede', fields, body: old.body, principal: actor.principal },
      { scope: 'tracked', expectedVersion: old.version },
    );
  });
}

/** Follow `supersedes` links forward: the head is the newest entry in the chain. */
export function chainHead(entries: KnowledgeEntry[], id: string): string {
  let cur = id;
  const seen = new Set<string>([cur]);
  for (;;) {
    const next = entries.find((e) => e.supersedes === cur && !seen.has(e.id));
    if (!next) return cur;
    seen.add(next.id);
    cur = next.id;
  }
}

/** Entries that retrieval should surface: every entry that is not superseded by another. */
export function liveEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const superseded = new Set(entries.map((e) => e.supersedes).filter(Boolean));
  return entries.filter((e) => !superseded.has(e.id));
}

export type CoverageBand = 'blocked' | 'draft' | 'ready';
/** Score below BLOCKED_BELOW is blocked, below READY_AT is draft, otherwise ready. */
export const BLOCKED_BELOW = 0.4;
export const READY_AT = 0.75;
export const COUNT_TARGET = 10;

export interface CoverageInput {
  /** Fraction (0..1) of required trunks that have at least one entry. */
  required: number;
  /** Fraction (0..1) of enriching trunks that have at least one entry. */
  enriching: number;
  /** Fraction (0..1) of the target entry count reached. */
  count: number;
}

/** required x 0.6 + enriching x 0.25 + count x 0.15, mapped to a band. */
export function coverageScore(i: CoverageInput): { score: number; band: CoverageBand } {
  const score = Math.round((i.required * 0.6 + i.enriching * 0.25 + i.count * 0.15) * 1e6) / 1e6;
  const band: CoverageBand =
    score < BLOCKED_BELOW ? 'blocked' : score < READY_AT ? 'draft' : 'ready';
  return { score, band };
}

export const REQUIRED_TRUNKS = ['systems', 'decisions', 'process'];

export type GapTag = 'owner' | 'research' | 'analysis';
export interface Gap {
  tag: GapTag;
  message: string;
}

const HALF_LIFE_DAYS: Record<string, number> = { volatile: 30, seasonal: 180, durable: 730 };
const STALE_BELOW = 0.3;

/** freshness = 0.5^(age / half-life); evergreen never decays. */
export function freshness(e: KnowledgeEntry, today: Date): number {
  const half = HALF_LIFE_DAYS[e.decay];
  if (half === undefined) return 1;
  const age = (today.getTime() - new Date(e.observed).getTime()) / 86_400_000;
  return age <= 0 || Number.isNaN(age) ? 1 : 0.5 ** (age / half);
}

export interface Dashboard {
  score: number;
  band: CoverageBand;
  gaps: Gap[];
  stale: { id: string; freshness: number }[];
}

export function buildDashboard(
  entries: KnowledgeEntry[],
  trunks: string[],
  today: Date = now(),
): Dashboard {
  const live = liveEntries(entries);
  const has = (t: string) => live.some((e) => e.trunk === t);
  const required = trunks.filter((t) => REQUIRED_TRUNKS.includes(t));
  const enriching = trunks.filter((t) => !REQUIRED_TRUNKS.includes(t));
  const frac = (xs: string[]) => (xs.length === 0 ? 1 : xs.filter(has).length / xs.length);
  const { score, band } = coverageScore({
    required: frac(required),
    enriching: frac(enriching),
    count: Math.min(live.length / COUNT_TARGET, 1),
  });
  const gaps: Gap[] = [];
  for (const t of required) {
    if (!has(t)) gaps.push({ tag: 'owner', message: `required trunk '${t}' has no entries` });
  }
  for (const t of enriching) {
    if (!has(t)) gaps.push({ tag: 'research', message: `enriching trunk '${t}' has no entries` });
  }
  for (const t of trunks) {
    const inT = live.filter((e) => e.trunk === t);
    if (inT.length > 0 && inT.every((e) => e.authority === 'inferred')) {
      gaps.push({ tag: 'analysis', message: `trunk '${t}' holds only inferred entries` });
    }
  }
  const stale = live
    .map((e) => ({ id: e.id, freshness: freshness(e, today) }))
    .filter((s) => s.freshness < STALE_BELOW)
    .sort((a, b) => a.freshness - b.freshness);
  return { score, band, gaps, stale };
}

export function renderDashboard(d: Dashboard): string[] {
  const lines = [`coverage ${d.score.toFixed(2)} (${d.band})`, 'gaps:'];
  if (d.gaps.length === 0) lines.push('  none');
  for (const g of d.gaps) lines.push(`  [${g.tag}] ${g.message}`);
  lines.push('staleness queue:');
  if (d.stale.length === 0) lines.push('  none');
  for (const s of d.stale) lines.push(`  ${s.id} freshness ${s.freshness.toFixed(2)}`);
  return lines;
}
