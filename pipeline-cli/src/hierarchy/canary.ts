/**
 * Pipeline canary handler for the dispatch tick (AISDLC-1023).
 *
 * `main-health-monitor.yml` runs `scripts/pipeline-canary.mjs` on macOS and posts a
 * `pipeline-canary-red` or `pipeline-canary-green` event (with the sha) to the
 * RFC-0054 webhook receiver, which stores it under `<board>/events/`. Each tick
 * reads the unprocessed canary events in arrival order:
 *
 * - red: set the board hold "pipeline canary red at <sha>" and file a hotfix task
 *   (label `pipeline-hotfix`, canary output in the body) through `cli-file`.
 * - green: lift the hold, but only when it is the canary's own hold.
 *
 * Processed delivery ids are kept in `<board>/canary-state.json`, so a replayed
 * tick never files a second hotfix for the same delivery.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { clearHold, readHold, writeHold } from './hold.js';

export const CANARY_RED_KIND = 'pipeline-canary-red';
export const CANARY_GREEN_KIND = 'pipeline-canary-green';
/** The reason prefix that marks a hold as the canary's. */
export const CANARY_HOLD_PREFIX = 'pipeline canary red at ';
export const CANARY_STATE_FILENAME = 'canary-state.json';
export const HOTFIX_LABEL = 'pipeline-hotfix';
/** The last canary-green sha (AISDLC-1024); the hotfix lane pins `AI_SDLC_PIPELINE_REF` to it. */
export const KNOWN_GOOD_FILENAME = 'pipeline-known-good.json';

interface CanaryEvent {
  kind: typeof CANARY_RED_KIND | typeof CANARY_GREEN_KIND;
  headSha: string;
  deliveryId: string;
  receivedAt: string;
  detail?: string;
}

/** What one tick did with the canary events. */
export interface CanaryReport {
  held?: string;
  filed?: { sha: string; task: string };
  lifted?: string;
  /** Hotfix filings that failed; the hold is already set, the next tick does not retry. */
  errors: string[];
}

export interface CanaryDeps {
  boardDir: string;
  now: () => Date;
  /** Files the hotfix task; returns the task id. May throw. */
  fileHotfix: (opts: { sha: string; detail: string }) => string;
}

interface CanaryState {
  processed: string[];
  /** Newest receivedAt already handled; older events are never replayed, even once their id ages out. */
  highWater: string;
}

function readState(boardDir: string): CanaryState {
  try {
    const doc = JSON.parse(readFileSync(path.join(boardDir, CANARY_STATE_FILENAME), 'utf-8')) as {
      processed?: unknown;
      highWater?: unknown;
    };
    return {
      processed: Array.isArray(doc.processed)
        ? doc.processed.filter((x): x is string => typeof x === 'string')
        : [],
      highWater: typeof doc.highWater === 'string' ? doc.highWater : '',
    };
  } catch {
    return { processed: [], highWater: '' };
  }
}

function writeState(boardDir: string, state: CanaryState): void {
  mkdirSync(boardDir, { recursive: true });
  const target = path.join(boardDir, CANARY_STATE_FILENAME);
  const tmp = `${target}.tmp-${process.pid}`;
  // Ids are bounded (same-timestamp replay protection); the high-water mark covers the rest.
  const doc = { processed: state.processed.slice(-200), highWater: state.highWater };
  writeFileSync(tmp, JSON.stringify(doc) + '\n', 'utf-8');
  renameSync(tmp, target);
}

function writeKnownGood(boardDir: string, sha: string, recordedAt: string): void {
  mkdirSync(boardDir, { recursive: true });
  const target = path.join(boardDir, KNOWN_GOOD_FILENAME);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ sha, recordedAt }) + '\n', 'utf-8');
  renameSync(tmp, target);
}

function readCanaryEvents(boardDir: string): CanaryEvent[] {
  const dir = path.join(boardDir, 'events');
  if (!existsSync(dir)) return [];
  const out: CanaryEvent[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as Partial<CanaryEvent>;
      if (r.kind !== CANARY_RED_KIND && r.kind !== CANARY_GREEN_KIND) continue;
      if (typeof r.headSha !== 'string' || typeof r.deliveryId !== 'string') continue;
      out.push({
        kind: r.kind,
        headSha: r.headSha,
        deliveryId: r.deliveryId,
        receivedAt: typeof r.receivedAt === 'string' ? r.receivedAt : '',
        ...(typeof r.detail === 'string' ? { detail: r.detail } : {}),
      });
    } catch {
      /* an unreadable record is skipped */
    }
  }
  return out.sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
  );
}

/** Process the canary events not yet seen. Never throws. */
export function processCanaryEvents(deps: CanaryDeps): CanaryReport {
  const report: CanaryReport = { errors: [] };
  const state = readState(deps.boardDir);
  const processed = state.processed;
  const seen = new Set(processed);
  for (const ev of readCanaryEvents(deps.boardDir)) {
    if (seen.has(ev.deliveryId)) continue;
    if (ev.receivedAt < state.highWater) continue;
    seen.add(ev.deliveryId);
    processed.push(ev.deliveryId);
    if (ev.receivedAt > state.highWater) state.highWater = ev.receivedAt;
    const at = deps.now().toISOString();
    if (ev.kind === CANARY_RED_KIND) {
      const reason = `${CANARY_HOLD_PREFIX}${ev.headSha}`;
      writeHold(deps.boardDir, { reason, since: at, by: 'pipeline-canary' });
      report.held = reason;
      try {
        report.filed = {
          sha: ev.headSha,
          task: deps.fileHotfix({ sha: ev.headSha, detail: ev.detail ?? '' }),
        };
      } catch (err) {
        report.errors.push(
          `hotfix filing for ${ev.headSha} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      writeKnownGood(deps.boardDir, ev.headSha, at);
      const hold = readHold(deps.boardDir);
      if (hold?.reason.startsWith(CANARY_HOLD_PREFIX)) {
        clearHold(deps.boardDir, 'pipeline-canary', at);
        report.lifted = hold.reason;
        delete report.held;
      }
    }
  }
  writeState(deps.boardDir, state);
  return report;
}

/** The hotfix task body: front matter with the `pipeline-hotfix` label, then the canary output. */
export function hotfixTaskMarkdown(id: string, sha: string, detail: string): string {
  const short = sha.slice(0, 8);
  return [
    '---',
    `id: ${id}`,
    `title: Hotfix: pipeline canary red at ${short}`,
    'status: To Do',
    'labels:',
    `  - ${HOTFIX_LABEL}`,
    'priority: high',
    '---',
    '',
    '## Description',
    '',
    `The post-merge pipeline canary (scripts/pipeline-canary.mjs) went red at ${sha}. The dispatch board is held with reason "${CANARY_HOLD_PREFIX}${sha}" until a later canary is green.`,
    '',
    'Canary output:',
    '',
    '```',
    detail.trim() || '(no output captured)',
    '```',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] #1 `node scripts/pipeline-canary.mjs` passes on main',
    '',
  ].join('\n');
}

/** Task id for a hotfix: unique per sha, in the `<prefix>-<n>` shape `cli-file` accepts. */
export function hotfixTaskId(sha: string): string {
  return `HOTFIX-${Number.parseInt(sha.slice(0, 7), 16)}`;
}
