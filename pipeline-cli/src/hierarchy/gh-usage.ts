/**
 * `cli-hierarchy gh-usage report` (AISDLC-1439): per-token GitHub usage over a window, read from
 * the `gh-calls.jsonl` ledger (local user token) and any CI quota snapshots (`gh-quota.jsonl`
 * artifacts of the gate workflow, token `actions`). The report is the evidence attached to a
 * `dependency-limit:github` escalation.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isRateLimitRead, readGhCalls, type GhCall } from './gh-calls.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Token name for ledger lines without a `token` field. */
export const USER_TOKEN = 'user';

export interface LowWater {
  remaining: number;
  at: string;
}

export interface TokenUsage {
  token: string;
  calls: number;
  callsPerHour: { mean: number; p95: number; max: number };
  /** Lowest remaining quota seen per resource. */
  lowestRemaining: Record<string, LowWater>;
  rateLimitErrors: { count: number; at: string[] };
  topShapes: { shape: string; count: number }[];
}

export interface GhUsageReport {
  since: string;
  until: string;
  tokens: TokenUsage[];
}

/** `7d`, `36h` or `90m` in ms; undefined for anything else. */
export function parseSince(raw: string | undefined): number | undefined {
  const m = /^(\d+)([dhm])$/.exec((raw ?? '7d').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  return n * (m[2] === 'd' ? DAY_MS : m[2] === 'h' ? HOUR_MS : 60_000);
}

/** A call's shape: `api <endpoint>` with ids replaced, else the first two words. */
export function callShape(argv: readonly string[]): string {
  const words = argv.filter((a) => !a.startsWith('-') && a !== '***');
  if (words[0] === 'api') {
    const endpoint = (words[1] ?? '')
      .split('?')[0]!
      .replace(/^\/+/, '')
      .replace(/\/\d+(?=\/|$)/g, '/:n')
      .replace(/\/[0-9a-f]{40}(?=\/|$)/g, '/:sha');
    return `api ${endpoint}`.trim();
  }
  return words.slice(0, 2).join(' ') || '(none)';
}

/** Nearest-rank percentile of a list of numbers (0 for an empty list). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

function lower(low: Record<string, LowWater>, resource: string, remaining: number, at: string) {
  const cur = low[resource];
  if (!cur || remaining < cur.remaining) low[resource] = { remaining, at };
}

function tokenUsage(token: string, calls: GhCall[], sinceMs: number, untilMs: number): TokenUsage {
  const metered = calls.filter((c) => !isRateLimitRead(c.argv ?? []));
  // Hour buckets across the whole window, empty hours included.
  const hours = Math.max(1, Math.ceil((untilMs - sinceMs) / HOUR_MS));
  const buckets = new Array<number>(hours).fill(0);
  for (const c of metered) {
    const i = Math.min(hours - 1, Math.floor((Date.parse(c.at) - sinceMs) / HOUR_MS));
    buckets[i]! += 1;
  }
  const low: Record<string, LowWater> = {};
  const limited: string[] = [];
  const shapes = new Map<string, number>();
  for (const c of calls) {
    if (typeof c.remaining === 'number') lower(low, c.resource ?? 'core', c.remaining, c.at);
    for (const [resource, b] of Object.entries(c.quota ?? {})) {
      if (typeof b?.remaining === 'number') lower(low, resource, b.remaining, c.at);
    }
    if (c.rateLimited || (c.rateLimitedJobs?.length ?? 0) > 0) limited.push(c.at);
  }
  for (const c of metered) {
    const s = callShape(c.argv ?? []);
    shapes.set(s, (shapes.get(s) ?? 0) + 1);
  }
  return {
    token,
    calls: metered.length,
    callsPerHour: {
      mean: Math.round((metered.length / hours) * 10) / 10,
      p95: percentile(buckets, 95),
      max: Math.max(...buckets),
    },
    lowestRemaining: low,
    rateLimitErrors: { count: limited.length, at: limited.sort() },
    topShapes: [...shapes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([shape, count]) => ({ shape, count })),
  };
}

/** Build the report over `[now - sinceMs, now]`, one entry per token. */
export function ghUsageReport(calls: GhCall[], now: Date, sinceMs: number): GhUsageReport {
  const untilMs = now.getTime();
  const fromMs = untilMs - sinceMs;
  const byToken = new Map<string, GhCall[]>();
  for (const c of calls) {
    const t = Date.parse(c.at);
    if (!(t >= fromMs && t <= untilMs)) continue;
    const token = c.token ?? USER_TOKEN;
    let bucket = byToken.get(token);
    if (!bucket) byToken.set(token, (bucket = []));
    bucket.push(c);
  }
  return {
    since: new Date(fromMs).toISOString(),
    until: now.toISOString(),
    tokens: [...byToken.keys()]
      .sort()
      .map((token) => tokenUsage(token, byToken.get(token)!, fromMs, untilMs)),
  };
}

/** Ledger lines from files or directories (every `*.jsonl` below a directory). */
export function readLedgers(paths: readonly string[]): GhCall[] {
  const out: GhCall[] = [];
  const visit = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const child = path.join(p, name);
        if (name.endsWith('.jsonl') || statSync(child).isDirectory()) visit(child);
      }
    } else {
      for (const c of readGhCalls(p)) out.push(c);
    }
  };
  for (const p of paths) visit(p);
  return out;
}

/** Human-readable report. */
export function formatGhUsageReport(r: GhUsageReport): string {
  const lines = [`GitHub usage ${r.since} .. ${r.until}`];
  if (r.tokens.length === 0) lines.push('  no gh calls recorded in the window');
  for (const t of r.tokens) {
    lines.push('', `token ${t.token}: ${t.calls} calls`);
    lines.push(
      `  calls/h: mean ${t.callsPerHour.mean}, p95 ${t.callsPerHour.p95}, max ${t.callsPerHour.max}`,
    );
    const low = Object.entries(t.lowestRemaining).sort(([a], [b]) => a.localeCompare(b));
    lines.push(
      `  lowest remaining: ${
        low.length === 0
          ? 'none recorded'
          : low.map(([k, v]) => `${k} ${v.remaining} at ${v.at}`).join(', ')
      }`,
    );
    lines.push(
      `  rate-limit errors: ${t.rateLimitErrors.count}${
        t.rateLimitErrors.count > 0 ? ` (${t.rateLimitErrors.at.join(', ')})` : ''
      }`,
    );
    lines.push('  top call shapes:');
    for (const s of t.topShapes) lines.push(`    ${String(s.count).padStart(6)}  ${s.shape}`);
  }
  return `${lines.join('\n')}\n`;
}
