/**
 * Reader for `.ai-sdlc/pr-lifecycle.yaml` (RFC-0054, Configuration). The file
 * holds operational keys only; a missing file or key falls back to the code
 * default. Trust constants (docs-only paths, release branch prefix, task-id
 * pattern) are code-owned and deliberately not readable from here. Every
 * top-level `spec` key must have a reader registered in
 * {@link PR_LIFECYCLE_KEY_READERS}; a test fails the build on an unread key.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { DEFAULT_STALL_GRACE_MS, DEFAULT_STALL_STALE_MS } from './stall.js';
import { BUSY_INTERVAL_MS, IDLE_INTERVAL_MS } from './scheduler.js';

export interface PrLifecycleConfig {
  /** How many times one `(action, headSha)` may run; the next one parks to the planner. */
  maxSameHeadActions: number;
  webhook: { port: number; debounceMs: number };
  stall: { staleMs: number; graceMs: number };
  reconcile: { timerOpenMs: number; timerIdleMs: number };
}

/** Default webhook receiver port (webhook.ts re-exports it). */
export const DEFAULT_WEBHOOK_PORT = 8765;

/** Receiver debounce default (mirrors `DEFAULT_DEBOUNCE_MS` in the webhook receiver). */
const DEFAULT_WEBHOOK_DEBOUNCE_MS = 5000;

export const PR_LIFECYCLE_DEFAULTS: PrLifecycleConfig = {
  maxSameHeadActions: 1,
  webhook: { port: DEFAULT_WEBHOOK_PORT, debounceMs: DEFAULT_WEBHOOK_DEBOUNCE_MS },
  stall: { staleMs: DEFAULT_STALL_STALE_MS, graceMs: DEFAULT_STALL_GRACE_MS },
  reconcile: { timerOpenMs: BUSY_INTERVAL_MS, timerIdleMs: IDLE_INTERVAL_MS },
};

/** Each `spec` key in the yaml, mapped to the function that reads it from the loaded config. */
export const PR_LIFECYCLE_KEY_READERS: Readonly<Record<string, (c: PrLifecycleConfig) => unknown>> =
  {
    noTaskBranchPrefixes: () => undefined, // read by CI through scripts/read-pr-lifecycle.mjs
    loopGuard: (c) => c.maxSameHeadActions,
    webhook: (c) => c.webhook,
    stall: (c) => c.stall,
    reconcile: (c) => c.reconcile,
  };

const pick = (v: unknown, d: number, int = false): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && (!int || Number.isInteger(v)) ? v : d;

type Raw = Record<string, unknown> | undefined;
const obj = (v: unknown): Raw =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export function loadPrLifecycleConfig(projectDir: string): PrLifecycleConfig {
  const d = PR_LIFECYCLE_DEFAULTS;
  const defaults = (): PrLifecycleConfig => ({
    maxSameHeadActions: d.maxSameHeadActions,
    webhook: { ...d.webhook },
    stall: { ...d.stall },
    reconcile: { ...d.reconcile },
  });
  const file = path.join(projectDir, '.ai-sdlc', 'pr-lifecycle.yaml');
  if (!existsSync(file)) return defaults();
  try {
    const spec = obj(obj(yamlLoad(readFileSync(file, 'utf-8')))?.spec);
    const webhook = obj(spec?.webhook);
    const stall = obj(spec?.stall);
    const reconcile = obj(spec?.reconcile);
    return {
      maxSameHeadActions: pick(
        obj(spec?.loopGuard)?.maxSameHeadActions,
        d.maxSameHeadActions,
        true,
      ),
      webhook: {
        port: pick(webhook?.port, d.webhook.port, true),
        debounceMs: pick(webhook?.debounceMs, d.webhook.debounceMs),
      },
      stall: {
        staleMs: pick(stall?.staleMs, d.stall.staleMs),
        graceMs: pick(stall?.graceMs, d.stall.graceMs),
      },
      reconcile: {
        timerOpenMs: pick(reconcile?.timerOpenMs, d.reconcile.timerOpenMs),
        timerIdleMs: pick(reconcile?.timerIdleMs, d.reconcile.timerIdleMs),
      },
    };
  } catch {
    return defaults();
  }
}
