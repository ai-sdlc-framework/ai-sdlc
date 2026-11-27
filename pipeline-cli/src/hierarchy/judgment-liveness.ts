/**
 * Whether the RFC-0049 judgment layer is really calling its provider (AISDLC-1442), from the
 * judgment log alone. A provider call is a record with `latencyMs > 0`, `cacheHit` false and an
 * outcome reason other than `disabled` or `provider-error`. A config-decided record
 * (`decidedBy: config:*`) is never a provider call, whatever else it carries.
 *
 * @module hierarchy/judgment-liveness
 */

import { readJudgmentLog, type JudgmentLogEntry } from '@ai-sdlc/reference';

/** How far back status reads the log. */
export const JUDGMENT_LIVENESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const NOT_A_CALL = new Set(['disabled', 'provider-error']);

export type JudgmentLiveness =
  { state: 'live'; lastCallAt: string } | { state: 'down'; since: string | null; reason: string };

function decidedByConfig(e: JudgmentLogEntry): boolean {
  const outcome = e.outcome as { decision?: unknown } | null;
  const decision = outcome?.decision;
  if (typeof decision !== 'object' || decision === null) return false;
  const by = (decision as { decidedBy?: unknown }).decidedBy;
  return typeof by === 'string' && by.startsWith('config:');
}

function outcomeReason(e: JudgmentLogEntry): string | undefined {
  const reason = (e.outcome as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** True when the record is a real provider call. */
export function isProviderCall(e: JudgmentLogEntry): boolean {
  if (decidedByConfig(e)) return false;
  if (e.cacheHit) return false;
  if (e.latencyMs === null || !(e.latencyMs > 0)) return false;
  const reason = outcomeReason(e);
  return reason === undefined || !NOT_A_CALL.has(reason);
}

function whyNotLive(e: JudgmentLogEntry): string {
  if (decidedByConfig(e)) return 'config decisions only';
  if (e.cacheHit) return 'cache hits only';
  return outcomeReason(e) ?? 'no provider call';
}

/**
 * Live when the newest record that is not config-decided is a provider call. Otherwise down
 * since the first record after the last provider call (the first record of the window when
 * there was none), with the newest record's reason. Never throws.
 */
export function judgmentLiveness(artifactsDir: string, now: Date): JudgmentLiveness {
  let entries: JudgmentLogEntry[];
  try {
    entries = readJudgmentLog(artifactsDir, {
      since: new Date(now.getTime() - JUDGMENT_LIVENESS_WINDOW_MS),
    }).entries;
  } catch {
    entries = [];
  }
  entries = [...entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (entries.length === 0) return { state: 'down', since: null, reason: 'no judgment records' };
  let lastCall = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isProviderCall(entries[i]!)) {
      lastCall = i;
      break;
    }
  }
  const after = entries.slice(lastCall + 1).filter((e) => !decidedByConfig(e));
  if (lastCall >= 0 && after.length === 0) {
    return { state: 'live', lastCallAt: entries[lastCall]!.ts };
  }
  const first = entries[lastCall + 1]!;
  const newest = entries[entries.length - 1]!;
  return { state: 'down', since: first.ts, reason: whyNotLive(after.at(-1) ?? newest) };
}

function age(fromIso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

/** The `judgment:` line of `cli-hierarchy status`. */
export function formatJudgmentLiveness(j: JudgmentLiveness, nowMs: number): string {
  if (j.state === 'live') return `judgment: live (last provider call ${age(j.lastCallAt, nowMs)})`;
  return `judgment: DOWN since ${j.since ?? 'unknown'} (${j.reason})`;
}
