/**
 * The weekly token budget pacer (AISDLC-1072).
 *
 * The account's `five_hour` and `seven_day` utilization comes from the Claude Code OAuth
 * credential (login keychain) and one GET of the usage endpoint. The tick samples it at most
 * once per 5 minutes into `<board>/usage.json` (a 24-hour ring). The pacer holds new claims
 * (hold reason `budget: ...`) while a window's burn is above the straight line from the
 * window start to 100 percent at its reset, plus a margin, and lifts the hold when the burn
 * falls under the line minus the margin. The token is never printed, logged or stored.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { appendHoldEvent, clearHold, readHold, writeHold } from './hold.js';
import { configPath } from './thresholds.js';

export const USAGE_FILENAME = 'usage.json';
export const BUDGET_OVERRIDE_FILENAME = 'budget-override.json';
export const BUDGET_HOLD_PREFIX = 'budget';
export const USAGE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const USAGE_RING_MS = 24 * 60 * 60 * 1000;
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const DEFAULT_SEVEN_DAY_MARGIN = 2;
export const DEFAULT_FIVE_HOUR_MARGIN = 10;
const TOTAL_MS = { fiveHour: 5 * 3600_000, sevenDay: 7 * 24 * 3600_000 } as const;

export type WindowName = 'fiveHour' | 'sevenDay';

export interface WindowReading {
  utilization: number;
  resetsAt: string;
}

export interface UsageSample {
  at: string;
  fiveHour?: WindowReading;
  sevenDay?: WindowReading;
}

/** Outcome of one fetch: a sample or the reason there is none. */
export type UsageFetch =
  { available: true; sample: UsageSample } | { available: false; reason: string };

/** The start of a window as the pacer sees it (first sample of that reset time). */
export interface WindowStart {
  resetsAt: string;
  at: string;
  utilization: number;
}

export interface UsageFile {
  available: boolean;
  reason?: string;
  /** Latest sample (absent when none was ever taken). */
  sample?: UsageSample;
  lastAttemptAt?: string;
  samples: UsageSample[];
  windows: Partial<Record<WindowName, WindowStart>>;
}

export interface UsageDeps {
  /** Returns the OAuth access token, or undefined when no credential is available. */
  readToken: () => string | undefined;
  fetchImpl: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  now: () => Date;
}

/** Read the token from the macOS login keychain; undefined on any failure. */
export function readKeychainToken(): string | undefined {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const doc = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const t = doc.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t !== '' ? t : undefined;
  } catch {
    return undefined;
  }
}

function reading(v: unknown): WindowReading | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { utilization?: unknown; resets_at?: unknown };
  if (typeof o.utilization !== 'number' || !Number.isFinite(o.utilization)) return undefined;
  if (typeof o.resets_at !== 'string' || !Number.isFinite(Date.parse(o.resets_at)))
    return undefined;
  return { utilization: o.utilization, resetsAt: o.resets_at };
}

/** One sample of the account usage; never throws and never includes the token. */
export async function fetchUsage(deps: UsageDeps): Promise<UsageFetch> {
  const token = deps.readToken();
  if (!token) return { available: false, reason: 'no Claude Code credential in the keychain' };
  try {
    const res = await deps.fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!res.ok) return { available: false, reason: `usage endpoint answered HTTP ${res.status}` };
    const body = (await res.json()) as { five_hour?: unknown; seven_day?: unknown };
    const fiveHour = reading(body.five_hour);
    const sevenDay = reading(body.seven_day);
    if (!fiveHour && !sevenDay) return { available: false, reason: 'usage response had no window' };
    return {
      available: true,
      sample: {
        at: deps.now().toISOString(),
        ...(fiveHour ? { fiveHour } : {}),
        ...(sevenDay ? { sevenDay } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `usage endpoint unreachable: ${msg.replaceAll(token, '[token]')}`,
    };
  }
}

export function usagePath(boardDir: string): string {
  return path.join(boardDir, USAGE_FILENAME);
}

export function readUsage(boardDir: string): UsageFile {
  const empty: UsageFile = { available: false, samples: [], windows: {} };
  try {
    const doc = JSON.parse(readFileSync(usagePath(boardDir), 'utf-8')) as Partial<UsageFile>;
    return {
      ...empty,
      ...doc,
      samples: Array.isArray(doc.samples) ? doc.samples : [],
      windows: doc.windows && typeof doc.windows === 'object' ? doc.windows : {},
    };
  } catch {
    return empty;
  }
}

function writeUsage(boardDir: string, file: UsageFile): void {
  mkdirSync(boardDir, { recursive: true });
  const target = usagePath(boardDir);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

/** Fold a fetch into `usage.json`: ring trimmed to 24 hours, window starts recorded. */
export function recordUsage(boardDir: string, result: UsageFetch, nowDate: Date): UsageFile {
  const prev = readUsage(boardDir);
  const file: UsageFile = { ...prev, lastAttemptAt: nowDate.toISOString() };
  if (!result.available) {
    file.available = false;
    file.reason = result.reason;
  } else {
    file.available = true;
    delete file.reason;
    file.sample = result.sample;
    const cutoff = nowDate.getTime() - USAGE_RING_MS;
    file.samples = [...prev.samples, result.sample].filter((s) => Date.parse(s.at) >= cutoff);
    for (const name of ['fiveHour', 'sevenDay'] as const) {
      const r = result.sample[name];
      if (r && file.windows[name]?.resetsAt !== r.resetsAt) {
        file.windows[name] = {
          resetsAt: r.resetsAt,
          at: result.sample.at,
          utilization: r.utilization,
        };
      }
    }
  }
  writeUsage(boardDir, file);
  return file;
}

/** Margins from `<board>/config.json` `budget`: `marginPoints` (seven day) and `fiveHourMarginPoints`. */
export function resolveMargins(boardDir: string): Record<WindowName, number> {
  const out = { sevenDay: DEFAULT_SEVEN_DAY_MARGIN, fiveHour: DEFAULT_FIVE_HOUR_MARGIN };
  try {
    if (!existsSync(configPath(boardDir))) return out;
    const doc = JSON.parse(readFileSync(configPath(boardDir), 'utf-8')) as {
      budget?: { marginPoints?: unknown; fiveHourMarginPoints?: unknown };
    };
    const m = doc.budget?.marginPoints;
    const f = doc.budget?.fiveHourMarginPoints;
    if (typeof m === 'number' && Number.isFinite(m) && m >= 0) out.sevenDay = m;
    if (typeof f === 'number' && Number.isFinite(f) && f >= 0) out.fiveHour = f;
  } catch {
    /* malformed config: defaults */
  }
  return out;
}

export interface WindowPace {
  name: WindowName;
  utilization: number;
  /** Allowed utilization now on the straight line. */
  line: number;
  /** utilization - line; positive means ahead of the line. */
  ahead: number;
  margin: number;
  resetsAt: string;
  /** Time the current burn rate reaches 100 percent; undefined when the burn is flat or unknown. */
  exhaustsAt?: string;
}

/** Pace of one window at `nowMs`. */
export function paceOf(
  name: WindowName,
  file: UsageFile,
  margin: number,
  nowMs: number,
): WindowPace | undefined {
  const cur = file.sample?.[name];
  if (!cur) return undefined;
  const resets = Date.parse(cur.resetsAt);
  const start = file.windows[name];
  const windowStart = resets - TOTAL_MS[name];
  const t0 =
    start && start.resetsAt === cur.resetsAt
      ? Math.max(windowStart, Date.parse(start.at))
      : windowStart;
  const u0 = start && start.resetsAt === cur.resetsAt ? start.utilization : 0;
  const total = resets - t0;
  const elapsed = Math.min(Math.max(nowMs - t0, 0), total);
  const line = total > 0 ? u0 + ((100 - u0) * elapsed) / total : 100;
  const pace: WindowPace = {
    name,
    utilization: cur.utilization,
    line,
    ahead: cur.utilization - line,
    margin,
    resetsAt: cur.resetsAt,
  };
  const oldest = file.samples.find((s) => s[name]?.resetsAt === cur.resetsAt);
  const o = oldest?.[name];
  if (oldest && o) {
    const dt = nowMs - Date.parse(oldest.at);
    const du = cur.utilization - o.utilization;
    if (dt > 0 && du > 0) {
      pace.exhaustsAt = new Date(nowMs + ((100 - cur.utilization) * dt) / du).toISOString();
    }
  }
  return pace;
}

export interface BudgetStatus {
  at: string;
  sevenDay?: WindowPace;
  fiveHour?: WindowPace;
  overridden: boolean;
}

function readOverride(boardDir: string): { sevenDay?: string; fiveHour?: string } {
  try {
    return JSON.parse(readFileSync(path.join(boardDir, BUDGET_OVERRIDE_FILENAME), 'utf-8')) as {
      sevenDay?: string;
      fiveHour?: string;
    };
  } catch {
    return {};
  }
}

/** The pace of both windows from `usage.json`; undefined when no sample exists. */
export function budgetStatus(boardDir: string, nowMs: number): BudgetStatus | undefined {
  const file = readUsage(boardDir);
  if (!file.sample) return undefined;
  const margins = resolveMargins(boardDir);
  const ov = readOverride(boardDir);
  const sevenDay = paceOf('sevenDay', file, margins.sevenDay, nowMs);
  const fiveHour = paceOf('fiveHour', file, margins.fiveHour, nowMs);
  return {
    at: file.sample.at,
    ...(sevenDay ? { sevenDay } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    overridden: Boolean(
      (sevenDay && ov.sevenDay === sevenDay.resetsAt) ||
      (fiveHour && ov.fiveHour === fiveHour.resetsAt),
    ),
  };
}

/** Record `resume --budget`: the current windows are exempt until their reset; logged. */
export function overrideBudget(boardDir: string, by: string, at: string): void {
  const file = readUsage(boardDir);
  const doc = {
    ...(file.sample?.sevenDay ? { sevenDay: file.sample.sevenDay.resetsAt } : {}),
    ...(file.sample?.fiveHour ? { fiveHour: file.sample.fiveHour.resetsAt } : {}),
    by,
    at,
  };
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(
    path.join(boardDir, BUDGET_OVERRIDE_FILENAME),
    JSON.stringify(doc, null, 2) + '\n',
    'utf-8',
  );
  appendHoldEvent(boardDir, { event: 'budget-override', ...doc });
  const held = readHold(boardDir);
  if (held?.reason.startsWith(BUDGET_HOLD_PREFIX)) clearHold(boardDir, by, at);
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

export interface PacerOutcome {
  sampled: boolean;
  set?: string;
  lifted?: string;
}

/**
 * Sample (at most every 5 minutes) and apply the pacing rule. Never throws; a hold set by
 * anything but the pacer is never touched.
 */
export async function runBudgetPacer(boardDir: string, deps: UsageDeps): Promise<PacerOutcome> {
  const nowDate = deps.now();
  const nowMs = nowDate.getTime();
  const prev = readUsage(boardDir);
  const last = prev.lastAttemptAt ? Date.parse(prev.lastAttemptAt) : Number.NaN;
  let sampled = false;
  if (!Number.isFinite(last) || nowMs - last >= USAGE_SAMPLE_INTERVAL_MS || nowMs < last) {
    recordUsage(boardDir, await fetchUsage(deps), nowDate);
    sampled = true;
  }
  const file = readUsage(boardDir);
  if (!file.available || !file.sample) return { sampled };
  const margins = resolveMargins(boardDir);
  const ov = readOverride(boardDir);
  const paces = (['sevenDay', 'fiveHour'] as const)
    .map((n) => paceOf(n, file, margins[n], nowMs))
    .filter((p): p is WindowPace => p !== undefined && ov[p.name] !== p.resetsAt);
  const over = paces.filter((p) => p.ahead > p.margin);
  const held = readHold(boardDir);
  const budgetHeld = held?.reason.startsWith(BUDGET_HOLD_PREFIX) === true;
  if (over.length > 0) {
    if (held && !budgetHeld) return { sampled };
    const reason = `${BUDGET_HOLD_PREFIX}: ${over
      .map(
        (p) =>
          `${p.name} ${fmt(p.utilization)}% is ${fmt(p.ahead)} points above the line ${fmt(p.line)}% (margin ${p.margin})`,
      )
      .join('; ')}`;
    if (budgetHeld && held?.reason === reason) return { sampled };
    writeHold(boardDir, {
      reason,
      since: budgetHeld ? held.since : nowDate.toISOString(),
      by: 'pacer',
    });
    return { sampled, set: reason };
  }
  if (budgetHeld && paces.every((p) => p.ahead < -p.margin)) {
    clearHold(boardDir, 'pacer', nowDate.toISOString());
    return { sampled, lifted: held.reason };
  }
  return { sampled };
}

/** The `BUDGET` line of `status`. */
export function formatBudget(b: BudgetStatus): string {
  const part = (label: string, p: WindowPace | undefined): string =>
    p
      ? `${label} ${fmt(p.utilization)}% (line ${fmt(p.line)}%, ${p.ahead >= 0 ? 'ahead' : 'behind'} ${fmt(Math.abs(p.ahead))} points)`
      : `${label} unknown`;
  const w = b.sevenDay;
  const proj = w?.exhaustsAt
    ? `, projected 100% at ${w.exhaustsAt} (resets ${w.resetsAt})`
    : w
      ? `, no projected exhaustion (resets ${w.resetsAt})`
      : '';
  return `BUDGET ${part('7d', b.sevenDay)}; ${part('5h', b.fiveHour)}${proj}${b.overridden ? ' [override active]' : ''}`;
}
