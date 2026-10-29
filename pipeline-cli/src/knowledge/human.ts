/**
 * Human surface for the knowledge layer (RFC-0053): confirm, correct, supersede,
 * coverage scoring and the plain-text gap dashboard. Every mutation writes a
 * knowledge-log event. Entries are superseded, never deleted.
 */
import { createHash } from 'node:crypto';
import { now } from '../clock.js';
import { AGENT_CONFIDENCE_CAP, type KnowledgeEntry } from './entry.js';
import { appendKnowledgeEvent } from './log.js';
import { findEntryFile, REOBSERVE_WEIGHT, rewrite, type Role } from './promote.js';

/** Confirm: confidence moves 30 percent toward the supplied value; authority never changes. */
export function confirmEntry(
  trackedRootAbs: string,
  id: string,
  confidence: number,
  by: Role,
  observed?: string,
): number | null {
  const file = findEntryFile(trackedRootAbs, id);
  if (!file) return null;
  let next = 0;
  const before = rewrite(file, (f) => {
    const old = Number(f.confidence);
    next = Math.round((old + REOBSERVE_WEIGHT * (confidence - old)) * 1e6) / 1e6;
    if (f.writtenBy === 'agent') next = Math.min(next, AGENT_CONFIDENCE_CAP);
    f.confidence = next;
    if (observed) f.observed = observed;
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'confirmed',
    id,
    by,
    detail: `confidence ${String(before.confidence)} -> ${next}`,
  });
  return next;
}

/** Correct: replace the value and its hash in place; authority and confidence are untouched. */
export function correctEntry(
  trackedRootAbs: string,
  id: string,
  value: string,
  by: Role,
  observed?: string,
): boolean {
  const file = findEntryFile(trackedRootAbs, id);
  if (!file) return false;
  const before = rewrite(file, (f) => {
    f.value = value;
    f.contentHash = createHash('sha256').update(value).digest('hex');
    if (observed) f.observed = observed;
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'corrected',
    id,
    by,
    detail: `value changed from '${String(before.value)}'`,
  });
  return true;
}

/** Supersede: the new entry links the old one; the old entry stays on disk. */
export function supersedeEntry(
  trackedRootAbs: string,
  oldId: string,
  newId: string,
  by: Role,
): { ok: boolean; reason: string } {
  const oldFile = findEntryFile(trackedRootAbs, oldId);
  const newFile = findEntryFile(trackedRootAbs, newId);
  if (!oldFile) return { ok: false, reason: `entry '${oldId}' not found` };
  if (!newFile) return { ok: false, reason: `entry '${newId}' not found` };
  if (oldId === newId) return { ok: false, reason: 'an entry cannot supersede itself' };
  rewrite(newFile, (f) => {
    f.supersedes = oldId;
    const rels = Array.isArray(f.relations)
      ? (f.relations as { type: string; target: string }[])
      : [];
    if (!rels.some((r) => r.type === 'supersedes' && r.target === oldId)) {
      rels.push({ type: 'supersedes', target: oldId });
    }
    f.relations = rels;
  });
  appendKnowledgeEvent(trackedRootAbs, {
    event: 'superseded',
    id: oldId,
    to: newId,
    by,
    detail: `${newId} supersedes ${oldId}`,
  });
  return { ok: true, reason: `${newId} supersedes ${oldId}` };
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
