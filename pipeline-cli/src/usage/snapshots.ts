/**
 * Calibration snapshots and implied allotment (RFC-0050 A4).
 *
 * A snapshot pairs the percentage the provider shows for a window with the
 * units the ledger counted in that window at that moment. The implied
 * allotment is units divided by the fraction used. When consecutive snapshots
 * of one window imply allotments that differ by more than the tolerance while
 * the model mix is similar, a change in what the plan provides is suspected.
 *
 * Snapshots hold counts, a window name and model ids only.
 *
 * @module usage/snapshots
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveUsageDir,
  withUsageLock,
  type ModelCallRecord,
  type UsageStoreOptions,
} from '@ai-sdlc/reference';
import type { UnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';
import { recordTimes, usageInRange, windowRangeAt } from './windows.js';

export const SNAPSHOTS_FILE = 'snapshots.jsonl';
export const LIMIT_EVENTS_FILE = 'limit-events.jsonl';

export interface Snapshot {
  ts: string;
  window: string;
  usedPercent: number;
  units: number;
  /** `manual` entered by the operator; `harness` taken from a limit event. */
  source: 'manual' | 'harness';
  /** Share of units per model id. */
  modelMix: Record<string, number>;
}

function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.ts === 'string' &&
    !Number.isNaN(Date.parse(s.ts)) &&
    typeof s.window === 'string' &&
    s.window.length > 0 &&
    typeof s.usedPercent === 'number' &&
    Number.isFinite(s.usedPercent) &&
    typeof s.units === 'number' &&
    Number.isFinite(s.units) &&
    (s.source === 'manual' || s.source === 'harness') &&
    typeof s.modelMix === 'object' &&
    s.modelMix !== null
  );
}

function readJsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a corrupt line
    }
  }
  return out;
}

export function readSnapshots(opts: UsageStoreOptions = {}): Snapshot[] {
  return readJsonl(join(resolveUsageDir(opts), SNAPSHOTS_FILE)).filter(isSnapshot);
}

/** Append one calibration point. Throws on an invalid percentage. */
export function appendSnapshot(snapshot: Snapshot, opts: UsageStoreOptions = {}): void {
  if (!(snapshot.usedPercent > 0 && snapshot.usedPercent <= 100)) {
    throw new Error('Used percent must be greater than 0 and at most 100.');
  }
  const dir = resolveUsageDir(opts);
  withUsageLock(dir, () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, SNAPSHOTS_FILE), `${JSON.stringify(snapshot)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  });
}

/** A window observation a harness wrote to `limit-events.jsonl`. */
export interface LimitObservation {
  ts: string;
  window: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export function readLimitObservations(opts: UsageStoreOptions = {}): LimitObservation[] {
  const out: LimitObservation[] = [];
  for (const raw of readJsonl(join(resolveUsageDir(opts), LIMIT_EVENTS_FILE))) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) continue;
    if (typeof e.window !== 'string' || !e.window) continue;
    if (typeof e.usedPercent !== 'number' || !(e.usedPercent > 0 && e.usedPercent <= 100)) continue;
    out.push({
      ts: e.ts,
      window: e.window,
      usedPercent: e.usedPercent,
      ...(typeof e.windowMinutes === 'number' && e.windowMinutes > 0
        ? { windowMinutes: e.windowMinutes }
        : {}),
      ...(typeof e.resetsAt === 'string' ? { resetsAt: e.resetsAt } : {}),
    });
  }
  return out;
}

/** Units in the window an observation refers to, or undefined when it cannot be bounded. */
function snapshotFromObservation(
  obs: LimitObservation,
  records: readonly ModelCallRecord[],
  times: readonly number[],
  windows: readonly WindowSpec[],
  weights: UnitWeights,
): Snapshot | undefined {
  const at = Date.parse(obs.ts);
  let start: number | undefined;
  if (obs.windowMinutes !== undefined) {
    const len = obs.windowMinutes * 60_000;
    const resets = obs.resetsAt ? Date.parse(obs.resetsAt) : Number.NaN;
    start = Number.isNaN(resets) ? at - len : resets - len;
  } else {
    const spec = windows.find((w) => w.name === obs.window);
    start = spec ? windowRangeAt(spec, times, at)?.start : undefined;
  }
  if (start === undefined) return undefined;
  const usage = usageInRange(records, start, at, weights);
  return {
    ts: obs.ts,
    window: obs.window,
    usedPercent: obs.usedPercent,
    units: usage.units,
    source: 'harness',
    modelMix: usage.modelMix,
  };
}

/** Snapshots derived from harness limit observations. */
export function snapshotsFromObservations(
  observations: readonly LimitObservation[],
  records: readonly ModelCallRecord[],
  windows: readonly WindowSpec[],
  weights: UnitWeights,
): Snapshot[] {
  const times = recordTimes(records);
  const out: Snapshot[] = [];
  for (const obs of observations) {
    const s = snapshotFromObservation(obs, records, times, windows, weights);
    if (s && s.units > 0) out.push(s);
  }
  return out;
}

/** Overlap of two model mixes: 1 when identical, 0 when disjoint. */
export function modelMixOverlap(a: Record<string, number>, b: Record<string, number>): number {
  let sum = 0;
  for (const [m, share] of Object.entries(a)) sum += Math.min(share, b[m] ?? 0);
  return sum;
}

export interface AllotmentRow {
  window: string;
  ts: string;
  usedPercent: number;
  units: number;
  source: Snapshot['source'];
  /** Units divided by the fraction used. */
  impliedAllotment: number;
  previousAllotment?: number;
  /** (implied - previous) / previous. */
  changeRatio?: number;
  mixOverlap?: number;
  suspected: boolean;
}

export interface ChangeRules {
  allotmentTolerance: number;
  modelMixSimilarity: number;
}

/** The implied-allotment series per window, oldest first, with change detection. */
export function buildAllotmentSeries(
  snapshots: readonly Snapshot[],
  rules: ChangeRules,
): AllotmentRow[] {
  const byWindow = new Map<string, Snapshot[]>();
  for (const s of snapshots) {
    if (!(s.usedPercent > 0) || !(s.units > 0)) continue;
    const list = byWindow.get(s.window) ?? [];
    list.push(s);
    byWindow.set(s.window, list);
  }
  const rows: AllotmentRow[] = [];
  for (const window of [...byWindow.keys()].sort()) {
    const list = (byWindow.get(window) ?? []).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let prev: { snap: Snapshot; implied: number } | undefined;
    for (const s of list) {
      const implied = s.units / (s.usedPercent / 100);
      const row: AllotmentRow = {
        window,
        ts: s.ts,
        usedPercent: s.usedPercent,
        units: s.units,
        source: s.source,
        impliedAllotment: implied,
        suspected: false,
      };
      if (prev) {
        const ratio = (implied - prev.implied) / prev.implied;
        const overlap = modelMixOverlap(prev.snap.modelMix, s.modelMix);
        row.previousAllotment = prev.implied;
        row.changeRatio = ratio;
        row.mixOverlap = overlap;
        row.suspected =
          Math.abs(ratio) > rules.allotmentTolerance && overlap >= rules.modelMixSimilarity;
      }
      rows.push(row);
      prev = { snap: s, implied };
    }
  }
  return rows;
}

/** The most recent implied allotment per window name. */
export function latestAllotments(rows: readonly AllotmentRow[]): Map<string, number> {
  const latest = new Map<string, { ts: number; implied: number }>();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    const cur = latest.get(r.window);
    if (!cur || t >= cur.ts) latest.set(r.window, { ts: t, implied: r.impliedAllotment });
  }
  return new Map([...latest].map(([k, v]) => [k, v.implied]));
}
