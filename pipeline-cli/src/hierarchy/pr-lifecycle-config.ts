/**
 * Reader for `.ai-sdlc/pr-lifecycle.yaml` (RFC-0054, Configuration). Only the
 * keys a consumer needs are read; a missing file or key falls back to the
 * documented default. The same-head loop guard (AISDLC-883) reads
 * `loopGuard.maxSameHeadActions`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

export interface PrLifecycleConfig {
  /** How many times one `(action, headSha)` may run; the next one parks to the planner. */
  maxSameHeadActions: number;
}

export const PR_LIFECYCLE_DEFAULTS: PrLifecycleConfig = { maxSameHeadActions: 1 };

export function loadPrLifecycleConfig(projectDir: string): PrLifecycleConfig {
  const file = path.join(projectDir, '.ai-sdlc', 'pr-lifecycle.yaml');
  if (!existsSync(file)) return { ...PR_LIFECYCLE_DEFAULTS };
  try {
    const doc = yaml.load(readFileSync(file, 'utf-8')) as {
      spec?: { loopGuard?: { maxSameHeadActions?: unknown } };
    } | null;
    const n = doc?.spec?.loopGuard?.maxSameHeadActions;
    return {
      maxSameHeadActions:
        typeof n === 'number' && Number.isInteger(n) && n >= 1
          ? n
          : PR_LIFECYCLE_DEFAULTS.maxSameHeadActions,
    };
  } catch {
    return { ...PR_LIFECYCLE_DEFAULTS };
  }
}
