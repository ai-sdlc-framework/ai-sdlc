/**
 * Cache-versus-JIT report (RFC-0053, in the RFC-0050 usage ledger).
 *
 * Joins the per-session load ledger (injected tokens by moment) with the model-call ledger
 * (cache-read tokens of the same sessions) and with later tool or decision references (was the
 * injected entry cited or acted on). A weekly check flags a profile whose change raised net
 * tokens. It instruments the trade; it does not assume just-in-time loading is cheaper.
 *
 * @module usage/jit-report
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import { readLedger, type LedgerRow } from '../knowledge/retrieval/ledger.js';

export const WEEK_MS = 7 * 24 * 3_600_000;

/** A later tool call or decision that referenced a ledger entry id. */
export interface EntryReference {
  sessionId: string;
  /** The ledger entry id that was cited or acted on. */
  id: string;
  at: string;
}

/** A change to a retrieval profile; sessions are mapped to the profile they ran under. */
export interface ProfileChange {
  profile: string;
  at: string;
}

export interface ProfileInput {
  changes: readonly ProfileChange[];
  /** Session id to profile name. */
  sessions: Readonly<Record<string, string>>;
}

export interface SessionLedger {
  sessionId: string;
  rows: readonly LedgerRow[];
}

export interface MomentRow {
  role: string;
  moment: string;
  injections: number;
  injectedTokens: number;
  cited: number;
  citedShare: number;
}

export interface SessionJitRow {
  sessionId: string;
  role: string;
  injectedTokens: number;
  injections: number;
  cited: number;
  citedShare: number;
  cacheReadTokens: number;
}

export interface ProfileFlag {
  profile: string;
  changedAt: string;
  sessionsBefore: number;
  sessionsAfter: number;
  netPerSessionBefore: number;
  netPerSessionAfter: number;
  /** True when net tokens per session rose over the week after the change. */
  raised: boolean;
}

export interface JitReport {
  byMoment: MomentRow[];
  sessions: SessionJitRow[];
  flags: ProfileFlag[];
}

export interface BuildJitInput {
  ledgers: readonly SessionLedger[];
  records: readonly ModelCallRecord[];
  references?: readonly EntryReference[];
  profiles?: ProfileInput;
  /** End of the weekly check; defaults to the latest call or load in the data. */
  now?: Date;
}

const isLoad = (r: LedgerRow): boolean => r.kind !== 'premark';
const share = (n: number, d: number): number => (d === 0 ? 0 : n / d);

/** Net tokens a session cost: what was injected plus what its calls re-read from the cache. */
const net = (s: Pick<SessionJitRow, 'injectedTokens' | 'cacheReadTokens'>): number =>
  s.injectedTokens + s.cacheReadTokens;

export function buildJitReport(input: BuildJitInput): JitReport {
  const roleOf = new Map<string, string>();
  const cacheRead = new Map<string, number>();
  const firstTs = new Map<string, number>();
  for (const r of input.records) {
    if (!roleOf.has(r.sessionId)) roleOf.set(r.sessionId, r.agentRole);
    cacheRead.set(r.sessionId, (cacheRead.get(r.sessionId) ?? 0) + r.tokens.cacheRead);
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t)) firstTs.set(r.sessionId, Math.min(firstTs.get(r.sessionId) ?? t, t));
  }

  const refs = new Map<string, number[]>();
  for (const ref of input.references ?? []) {
    const key = `${ref.sessionId}\u0000${ref.id}`;
    const list = refs.get(key) ?? [];
    list.push(Date.parse(ref.at));
    refs.set(key, list);
  }
  const isCited = (sessionId: string, row: LedgerRow): boolean => {
    const at = Date.parse(row.at);
    return (refs.get(`${sessionId}\u0000${row.id}`) ?? []).some((t) => t >= at);
  };

  const moments = new Map<string, MomentRow>();
  const sessions: SessionJitRow[] = [];
  for (const { sessionId, rows } of input.ledgers) {
    const role = roleOf.get(sessionId) ?? '(unknown)';
    const s: SessionJitRow = {
      sessionId,
      role,
      injectedTokens: 0,
      injections: 0,
      cited: 0,
      citedShare: 0,
      cacheReadTokens: cacheRead.get(sessionId) ?? 0,
    };
    for (const row of rows.filter(isLoad)) {
      const cited = isCited(sessionId, row);
      const key = `${role}\u0000${row.moment}`;
      const m = moments.get(key) ?? {
        role,
        moment: row.moment,
        injections: 0,
        injectedTokens: 0,
        cited: 0,
        citedShare: 0,
      };
      m.injections += 1;
      m.injectedTokens += row.tokens;
      s.injections += 1;
      s.injectedTokens += row.tokens;
      if (cited) {
        m.cited += 1;
        s.cited += 1;
      }
      moments.set(key, m);
    }
    s.citedShare = share(s.cited, s.injections);
    sessions.push(s);
  }
  for (const m of moments.values()) m.citedShare = share(m.cited, m.injections);

  const byMoment = [...moments.values()].sort(
    (a, b) => a.role.localeCompare(b.role) || a.moment.localeCompare(b.moment),
  );
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  return {
    byMoment,
    sessions,
    flags: input.profiles ? weeklyFlags(sessions, firstTs, input) : [],
  };
}

function weeklyFlags(
  sessions: readonly SessionJitRow[],
  startOf: ReadonlyMap<string, number>,
  input: BuildJitInput,
): ProfileFlag[] {
  const profiles = input.profiles as ProfileInput;
  const times = [...startOf.values()];
  const now = input.now?.getTime() ?? (times.length ? Math.max(...times) : 0);
  const flags: ProfileFlag[] = [];
  for (const change of profiles.changes) {
    const at = Date.parse(change.at);
    if (Number.isNaN(at)) continue;
    const mine = sessions.filter((s) => profiles.sessions[s.sessionId] === change.profile);
    const mean = (from: number, to: number): { n: number; mean: number } => {
      const inRange = mine.filter((s) => {
        const t = startOf.get(s.sessionId) ?? Number.NaN;
        return t >= from && t < to;
      });
      return {
        n: inRange.length,
        mean: inRange.length ? inRange.reduce((a, s) => a + net(s), 0) / inRange.length : 0,
      };
    };
    const before = mean(at - WEEK_MS, at);
    const after = mean(at, Math.min(at + WEEK_MS, Math.max(now, at) + 1));
    flags.push({
      profile: change.profile,
      changedAt: change.at,
      sessionsBefore: before.n,
      sessionsAfter: after.n,
      netPerSessionBefore: before.mean,
      netPerSessionAfter: after.mean,
      // No evidence on either side means no flag.
      raised: before.n > 0 && after.n > 0 && after.mean > before.mean,
    });
  }
  return flags.sort(
    (a, b) => a.profile.localeCompare(b.profile) || a.changedAt.localeCompare(b.changedAt),
  );
}

/** Every session ledger under `<projectRoot>/.ai-sdlc/context/sessions`. */
export function readSessionLedgers(projectRoot: string): SessionLedger[] {
  const dir = join(projectRoot, '.ai-sdlc', 'context', 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort()
    .flatMap((sessionId) => {
      try {
        return [{ sessionId, rows: readLedger(projectRoot, sessionId) }];
      } catch {
        return []; // a file name that is not a valid session id
      }
    });
}

const INT = (n: number): string => Math.round(n).toLocaleString('en-US');
const PCT = (n: number): string => `${(n * 100).toFixed(1)}%`;

function table(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [fmt(header), ...body.map(fmt)];
}

export function renderJitText(report: JitReport): string {
  if (report.sessions.length === 0) return 'No load ledgers recorded.\n';
  const out = [
    'Injected tokens by role and moment',
    ...table(
      ['role', 'moment', 'injections', 'injected_tokens', 'cited', 'cited_share'],
      report.byMoment.map((m) => [
        m.role,
        m.moment,
        INT(m.injections),
        INT(m.injectedTokens),
        INT(m.cited),
        PCT(m.citedShare),
      ]),
    ),
    '',
    'Per session, injected tokens beside cache-read tokens',
    ...table(
      ['session', 'role', 'injected_tokens', 'cited_share', 'cache_read'],
      report.sessions.map((s) => [
        s.sessionId,
        s.role,
        INT(s.injectedTokens),
        PCT(s.citedShare),
        INT(s.cacheReadTokens),
      ]),
    ),
  ];
  if (report.flags.length > 0) {
    out.push(
      '',
      'Weekly net-token check (injected plus cache-read per session, week before versus week after)',
      ...table(
        ['profile', 'changed_at', 'before', 'after', 'flag'],
        report.flags.map((f) => [
          f.profile,
          f.changedAt,
          `${INT(f.netPerSessionBefore)} (${f.sessionsBefore})`,
          `${INT(f.netPerSessionAfter)} (${f.sessionsAfter})`,
          f.raised ? 'RAISED NET TOKENS' : 'ok',
        ]),
      ),
    );
  }
  return `${out.join('\n')}\n`;
}

export function renderJitJson(report: JitReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
