/**
 * How long an idle executor waits before it looks at the queue again (AISDLC-738).
 *
 * A new manifest must be claimed within a minute, so the wait is capped at
 * {@link IDLE_BACKOFF_MAX_SEC} whatever the dispatch config asks for. The config
 * key `spec.inSessionAgent.emptyQueueHibernateSec` may shorten the wait, never
 * lengthen it past the cap.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { load as yamlLoad } from 'js-yaml';

/** Longest an idle executor sleeps between queue checks. */
export const IDLE_BACKOFF_MAX_SEC = 60;
const DEFAULT_BACKOFF_SEC = 30;
const MIN_BACKOFF_SEC = 5;

/** Seconds to wait when nothing is eligible: the configured value clamped to 5..60 (default 30). */
export function idleBackoffSec(configured?: number): number {
  if (configured === undefined || !Number.isFinite(configured)) return DEFAULT_BACKOFF_SEC;
  return Math.min(IDLE_BACKOFF_MAX_SEC, Math.max(MIN_BACKOFF_SEC, Math.floor(configured)));
}

/** `spec.inSessionAgent.emptyQueueHibernateSec` from the project's dispatch config, if set. */
export function readEmptyQueueHibernateSec(workDir: string): number | undefined {
  const file = path.join(workDir, '.ai-sdlc', 'dispatch-config.yaml');
  if (!existsSync(file)) return undefined;
  try {
    const doc = yamlLoad(readFileSync(file, 'utf-8')) as {
      spec?: { inSessionAgent?: { emptyQueueHibernateSec?: unknown } };
    } | null;
    const v = doc?.spec?.inSessionAgent?.emptyQueueHibernateSec;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
