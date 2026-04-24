/**
 * SA Drift Monitor (RFC-0008 Addendum B §B.9.2).
 *
 * Periodically inspects `did_scoring_events` and triggers a
 * `SoulDriftDetected` event when SA-1 or SA-2 rolling statistics
 * indicate the scorer is drifting. Separately reports structural vs
 * LLM means so operators can tell whether the drift is coming from
 * the product (DID review needed) or the LLM layer (exemplar bank
 * recalibration needed).
 *
 * Trigger (per dimension):
 *   mean < 0.4  OR  stddev > 0.15   — for 3 consecutive windows
 *
 * Hysteresis: caller supplies `lastTriggerAt`; the monitor won't fire
 * again within `recoveryMs` (default 7d) of the previous emission.
 */

import type { DesignSystemBinding } from '@ai-sdlc/reference';
import type { StateStore } from '../state/store.js';
import type { DidScoringEventRecord, SaDimension } from '../state/types.js';

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_MEAN_THRESHOLD = 0.4;
export const DEFAULT_STDDEV_THRESHOLD = 0.15;
/** Number of consecutive windows that must violate to trigger. */
export const DEFAULT_CONSECUTIVE_WINDOWS = 3;
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

// ── Shapes ──────────────────────────────────────────────────────────

export interface WindowStats {
  count: number;
  mean: number;
  stddev: number;
  structuralMean: number;
  llmMean: number;
  deterministicFlags: number;
  /** Inclusive window range — [start, end) in ms. */
  windowStartMs: number;
  windowEndMs: number;
  /** True if this window violated the drift threshold. */
  violates: boolean;
}

export type DriftTrend = 'increasing' | 'decreasing' | 'stable';

export interface SoulDriftDetectedEvent {
  type: 'SoulDriftDetected';
  dimension: SaDimension;
  rollingMean: number;
  rollingStdDev: number;
  sprintsInViolation: number;
  trend: DriftTrend;
  driftSource: {
    deterministicFlags: number;
    structuralScoreMean: number;
    llmScoreMean: number;
    note: string;
  };
  notifiedPrincipals: string[];
  triggeredAt: string;
}

// ── Pure helpers ────────────────────────────────────────────────────

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
  return Math.sqrt(variance);
}

export function computeWindowStats(
  events: readonly DidScoringEventRecord[],
  windowStartMs: number,
  windowEndMs: number,
  meanThreshold: number,
  stddevThreshold: number,
): WindowStats {
  const composites: number[] = [];
  const structural: number[] = [];
  const llm: number[] = [];
  let deterministicFlags = 0;
  for (const e of events) {
    if (typeof e.compositeScore === 'number') composites.push(e.compositeScore);
    if (e.layer2ResultJson) {
      try {
        const parsed = JSON.parse(e.layer2ResultJson) as { score?: number };
        if (typeof parsed.score === 'number') structural.push(parsed.score);
      } catch {
        // ignore malformed entry
      }
    }
    if (e.layer3ResultJson) {
      try {
        const parsed = JSON.parse(e.layer3ResultJson) as {
          domainIntent?: number;
          principleAlignment?: number;
        };
        const candidate = parsed.domainIntent ?? parsed.principleAlignment;
        if (typeof candidate === 'number') llm.push(candidate);
      } catch {
        // ignore malformed entry
      }
    }
    if (e.layer1ResultJson) {
      try {
        const parsed = JSON.parse(e.layer1ResultJson) as { hardGated?: boolean };
        if (parsed.hardGated) deterministicFlags++;
      } catch {
        // ignore malformed entry
      }
    }
  }
  const m = mean(composites);
  const s = stddev(composites);
  return {
    count: composites.length,
    mean: m,
    stddev: s,
    structuralMean: mean(structural),
    llmMean: mean(llm),
    deterministicFlags,
    windowStartMs,
    windowEndMs,
    violates: composites.length > 0 && (m < meanThreshold || s > stddevThreshold),
  };
}

export function computeTrend(windows: readonly WindowStats[]): DriftTrend {
  if (windows.length < 2) return 'stable';
  // Windows ordered newest-first; trend is the direction of mean over time.
  const newestMean = windows[0].mean;
  const oldestMean = windows[windows.length - 1].mean;
  const delta = newestMean - oldestMean;
  if (Math.abs(delta) < 0.05) return 'stable';
  return delta > 0 ? 'increasing' : 'decreasing';
}

export function describeDriftSource(windows: readonly WindowStats[]): {
  structuralScoreMean: number;
  llmScoreMean: number;
  note: string;
  deterministicFlags: number;
} {
  const structural = mean(windows.map((w) => w.structuralMean));
  const llm = mean(windows.map((w) => w.llmMean));
  const flags = windows.reduce((acc, w) => acc + w.deterministicFlags, 0);
  let note: string;
  if (llm < structural - 0.15) note = 'LLM-layer drift (consider recalibrating exemplar bank)';
  else if (structural < llm - 0.15)
    note = 'Structural drift (review DID corpus + compile artifacts)';
  else if (flags > 0) note = `Mixed drift with ${flags} hard-gated events (review DID scope)`;
  else note = 'Uniform drift across layers (product review recommended)';
  return {
    structuralScoreMean: structural,
    llmScoreMean: llm,
    note,
    deterministicFlags: flags,
  };
}

// ── Detector orchestration ──────────────────────────────────────────

export interface DriftDetectorDeps {
  stateStore: StateStore;
  /** Resolve the DSB that owns this DID (for notification principals). */
  getBinding?: (dimension: SaDimension) => DesignSystemBinding | undefined;
  /** Previous trigger timestamp (for hysteresis). */
  getLastTriggerAt?: (dimension: SaDimension) => string | undefined;
  /** Clock injection for tests. */
  now?: () => number;
  /** Configuration overrides. */
  config?: Partial<{
    meanThreshold: number;
    stddevThreshold: number;
    consecutiveWindows: number;
    windowDays: number;
    recoveryMs: number;
  }>;
}

export function detectSoulDrift(
  dimension: SaDimension,
  deps: DriftDetectorDeps,
): SoulDriftDetectedEvent | undefined {
  const cfg = deps.config ?? {};
  const meanThreshold = cfg.meanThreshold ?? DEFAULT_MEAN_THRESHOLD;
  const stddevThreshold = cfg.stddevThreshold ?? DEFAULT_STDDEV_THRESHOLD;
  const consecutive = cfg.consecutiveWindows ?? DEFAULT_CONSECUTIVE_WINDOWS;
  const windowDays = cfg.windowDays ?? DEFAULT_WINDOW_DAYS;
  const recoveryMs = cfg.recoveryMs ?? DEFAULT_RECOVERY_MS;
  const nowMs = (deps.now ?? (() => Date.now()))();

  // Hysteresis
  const lastTriggerAt = deps.getLastTriggerAt?.(dimension);
  if (lastTriggerAt) {
    const lastMs = Date.parse(lastTriggerAt);
    if (!Number.isNaN(lastMs) && nowMs - lastMs < recoveryMs) return undefined;
  }

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const earliestMs = nowMs - consecutive * windowMs;

  // Fetch events for the combined range.
  const since = new Date(earliestMs).toISOString();
  const events = deps.stateStore.getDidScoringEvents({
    saDimension: dimension,
    since,
    limit: 10_000,
  });

  // Partition into consecutive windows (newest → oldest).
  const windows: WindowStats[] = [];
  for (let i = 0; i < consecutive; i++) {
    const endMs = nowMs - i * windowMs;
    const startMs = endMs - windowMs;
    const inWindow = events.filter((e) => {
      const t = e.createdAt ? Date.parse(e.createdAt) : NaN;
      return !Number.isNaN(t) && t >= startMs && t < endMs;
    });
    windows.push(computeWindowStats(inWindow, startMs, endMs, meanThreshold, stddevThreshold));
  }

  const allViolate = windows.every((w) => w.violates);
  if (!allViolate) return undefined;

  // All windows violated — fire the event.
  const compositeMeans = windows.map((w) => w.mean);
  const compositeStddevs = windows.map((w) => w.stddev);
  const rollingMean = mean(compositeMeans);
  const rollingStdDev = mean(compositeStddevs);
  const trend = computeTrend(windows);
  const driftSource = describeDriftSource(windows);

  const binding = deps.getBinding?.(dimension);
  const principals = binding ? collectPrincipals(binding) : [];

  return {
    type: 'SoulDriftDetected',
    dimension,
    rollingMean,
    rollingStdDev,
    sprintsInViolation: consecutive,
    trend,
    driftSource,
    notifiedPrincipals: principals,
    triggeredAt: new Date(nowMs).toISOString(),
  };
}

function collectPrincipals(binding: DesignSystemBinding): string[] {
  const design = binding.spec.stewardship.designAuthority.principals;
  const engineering = binding.spec.stewardship.engineeringAuthority.principals;
  return Array.from(new Set([...design, ...engineering]));
}
