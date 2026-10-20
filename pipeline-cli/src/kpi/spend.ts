/**
 * Per-PR, per-rung model spend report (AISDLC-885, RFC-0054 OQ-14).
 *
 * One event shape for every model call (developer round, reviewers, judgment
 * layer, staged review, Agent spawns), appended to `.ai-sdlc/kpi/spend.jsonl`
 * and tagged with the rung the caller declares in its frontmatter (AISDLC-884).
 * Report-only: nothing here caps, refuses or throttles spend.
 *
 * @module kpi/spend
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now } from '../clock.js';
export type SpendOutcome = 'answered' | 'below-floor' | 'escalated';

export interface SpendEvent {
  id: string;
  ts: string;
  prNumber?: number;
  taskId?: string;
  /** Automation ladder rung 0 to 4 (frontmatter `rung:` of the caller). */
  rung: number;
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** PR state at the time of the call (draft, open, ready, merged). */
  state?: string;
  /** Rung 2 and 3 only. */
  outcome?: SpendOutcome;
  /** For a rung-3 call that followed an escalated rung-2 call: that event's id. */
  linkedTo?: string;
}

export const SPEND_FILE = join('.ai-sdlc', 'kpi', 'spend.jsonl');
export const DEVELOPER_AGENT = 'developer';

export function readSpendEvents(dir: string): SpendEvent[] {
  const file = join(dir, SPEND_FILE);
  if (!existsSync(file)) return [];
  const out: SpendEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SpendEvent);
    } catch {
      // skip a torn line; the ledger is append-only
    }
  }
  return out;
}

/** Rung from `ai-sdlc-plugin/{agents,commands}/<agent>.md` frontmatter, or undefined. */
export function rungFromFrontmatter(dir: string, agent: string): number | undefined {
  for (const sub of ['agents', 'commands']) {
    const file = join(dir, 'ai-sdlc-plugin', sub, `${agent}.md`);
    if (!existsSync(file)) continue;
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
    const m = fm ? /^rung:\s*(\d)\s*$/m.exec(fm[1]!) : null;
    if (m) return Number(m[1]);
  }
  return undefined;
}

export type NewSpendEvent = Omit<SpendEvent, 'id' | 'ts' | 'calls' | 'linkedTo'> &
  Partial<Pick<SpendEvent, 'calls' | 'linkedTo' | 'ts'>>;

/**
 * Append one event. A rung-3 call with no explicit link is linked to the most
 * recent unlinked escalated rung-2 event of the same PR or task. No cap check.
 */
export function recordSpendEvent(dir: string, input: NewSpendEvent): SpendEvent {
  const existing = readSpendEvents(dir);
  const sameWork = (e: SpendEvent): boolean =>
    input.prNumber !== undefined ? e.prNumber === input.prNumber : e.taskId === input.taskId;
  let linkedTo = input.linkedTo;
  if (linkedTo === undefined && input.rung === 3) {
    const taken = new Set(existing.map((e) => e.linkedTo).filter(Boolean));
    linkedTo = existing
      .filter((e) => e.rung === 2 && e.outcome === 'escalated' && sameWork(e) && !taken.has(e.id))
      .at(-1)?.id;
  }
  const event: SpendEvent = {
    ...input,
    id: `sp-${existing.length + 1}-${now().getTime().toString(36)}`,
    ts: input.ts ?? now().toISOString(),
    calls: input.calls ?? 1,
    ...(linkedTo !== undefined ? { linkedTo } : {}),
  };
  const file = join(dir, SPEND_FILE);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + '\n');
  return event;
}

export interface PrSpend {
  key: string;
  prNumber?: number;
  taskId?: string;
  totalTokens: number;
  byRung: Record<string, number>;
  byAgent: Record<string, number>;
  developerTokens: number;
  rung4Tokens: number;
  events: SpendEvent[];
}

export interface Distribution {
  median: number;
  p90: number;
  max: number;
}

export interface SpendReport {
  prs: PrSpend[];
  totalByRung: Record<string, number>;
  total: Distribution;
  rung4: Distribution;
  developer: Distribution;
}

const tokens = (e: SpendEvent): number => e.inputTokens + e.outputTokens;

function dist(values: number[]): Distribution {
  if (values.length === 0) return { median: 0, p90: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { median: at(0.5), p90: at(0.9), max: s[s.length - 1]! };
}

export function computeSpend(events: SpendEvent[]): SpendReport {
  const groups = new Map<string, PrSpend>();
  const totalByRung: Record<string, number> = {};
  for (const e of events) {
    const key = e.prNumber !== undefined ? `#${e.prNumber}` : (e.taskId ?? 'unattributed');
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        ...(e.prNumber !== undefined ? { prNumber: e.prNumber } : {}),
        ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
        totalTokens: 0,
        byRung: {},
        byAgent: {},
        developerTokens: 0,
        rung4Tokens: 0,
        events: [],
      };
      groups.set(key, g);
    }
    const t = tokens(e);
    g.totalTokens += t;
    g.byRung[e.rung] = (g.byRung[e.rung] ?? 0) + t;
    g.byAgent[e.agent] = (g.byAgent[e.agent] ?? 0) + t;
    if (e.agent === DEVELOPER_AGENT) g.developerTokens += t;
    if (e.rung === 4) g.rung4Tokens += t;
    totalByRung[e.rung] = (totalByRung[e.rung] ?? 0) + t;
    g.events.push(e);
  }
  const prs = [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    prs,
    totalByRung,
    total: dist(prs.map((p) => p.totalTokens)),
    rung4: dist(prs.map((p) => p.rung4Tokens)),
    developer: dist(prs.map((p) => p.developerTokens)),
  };
}

export function filterSpend(
  events: SpendEvent[],
  f: { pr?: number; since?: string },
): SpendEvent[] {
  const since = f.since ? Date.parse(f.since) : undefined;
  return events.filter(
    (e) =>
      (f.pr === undefined || e.prNumber === f.pr) &&
      (since === undefined || Date.parse(e.ts) >= since),
  );
}

const n = (v: number): string => v.toLocaleString('en-US');

function rungLine(byRung: Record<string, number>): string {
  const keys = Object.keys(byRung).sort();
  return keys.length ? keys.map((k) => `rung ${k}: ${n(byRung[k]!)}`).join(', ') : 'none';
}

export function renderSpendText(report: SpendReport, detail: boolean): string {
  const lines: string[] = [];
  if (report.prs.length === 0) return 'No spend events recorded.\n';
  for (const p of report.prs) {
    lines.push(`${p.key}: ${n(p.totalTokens)} tokens (${rungLine(p.byRung)})`);
    lines.push(`  developer round: ${n(p.developerTokens)}`);
    if (detail) {
      const ids = new Map(p.events.map((e) => [e.id, e]));
      for (const e of p.events) {
        const link = e.linkedTo
          ? `, follows ${e.linkedTo} (rung ${ids.get(e.linkedTo)?.rung ?? '?'} escalated)`
          : '';
        lines.push(
          `  - rung ${e.rung} ${e.agent} ${e.model} in ${n(e.inputTokens)} out ${n(e.outputTokens)} calls ${e.calls}` +
            `${e.state ? ` state ${e.state}` : ''}${e.outcome ? ` outcome: ${e.outcome}` : ''}${link} [${e.id}]`,
        );
      }
    }
  }
  if (report.prs.length > 1 || !detail) {
    const d = (x: Distribution): string =>
      `median ${n(x.median)}, p90 ${n(x.p90)}, max ${n(x.max)}`;
    lines.push('', `Total per PR: ${d(report.total)}`, `Rung-4 per PR: ${d(report.rung4)}`);
    lines.push(`Developer round per PR: ${d(report.developer)}`);
  }
  return lines.join('\n') + '\n';
}

/** Digest block: totals by rung and the five most expensive PRs. */
export function renderSpendDigestBlock(events: SpendEvent[], since: string): string {
  const r = computeSpend(events);
  const lines = ['', `## Spend since last digest (${since})`, ''];
  if (r.prs.length === 0) return [...lines, 'None.', ''].join('\n');
  lines.push(`Totals by rung (tokens): ${rungLine(r.totalByRung)}`, '', 'Most expensive PRs:');
  for (const p of r.prs.slice(0, 5)) {
    lines.push(
      `- ${p.key}: ${n(p.totalTokens)} tokens (developer ${n(p.developerTokens)}, rung 4 ${n(p.rung4Tokens)})`,
    );
  }
  return lines.join('\n') + '\n';
}
