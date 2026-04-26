/**
 * Per-stage rolling token-estimate calibration per RFC §14.6 (Q11). Tracks the last 20
 * invocations per stage with exponentially-weighted average; emits EstimateBootstrapped
 * after first run replaces the cold-start default; emits EstimateVariance when observed
 * deviates from estimated by > 50%.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  COLD_START_DEFAULT_INPUT,
  COLD_START_DEFAULT_OUTPUT,
  ESTIMATE_VARIANCE_THRESHOLD,
  ROLLING_WINDOW_SIZE,
  type LedgerEvent,
  type TokenEstimate,
} from './types.js';

interface StageHistory {
  stage: string;
  samples: Array<{ input: number; output: number; at: string }>;
  /** Set when the stage first ran with the cold-start default. Triggers EstimateBootstrapped. */
  bootstrappedAt?: string;
  rollingEstimate?: TokenEstimate;
}

interface PersistedFile {
  version: 1;
  stages: Record<string, StageHistory>;
}

export const COLD_START_DEFAULT: TokenEstimate = {
  input: COLD_START_DEFAULT_INPUT,
  output: COLD_START_DEFAULT_OUTPUT,
};

export interface CalibrationStoreDeps {
  io?: {
    read: (path: string) => Promise<string | null>;
    write: (path: string, content: string) => Promise<void>;
  };
}

export class CalibrationStore {
  private state: PersistedFile = { version: 1, stages: {} };
  private readonly path: string;
  private readonly io: NonNullable<CalibrationStoreDeps['io']>;

  constructor(artifactsDir: string, deps: CalibrationStoreDeps = {}) {
    this.path = join(artifactsDir, '_ledger', 'stage-estimates.json');
    this.io = deps.io ?? {
      read: async (p) => {
        try {
          return await readFile(p, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw err;
        }
      },
      write: async (p, c) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, c, 'utf8');
      },
    };
  }

  async load(): Promise<void> {
    const raw = await this.io.read(this.path);
    if (!raw) return;
    try {
      this.state = JSON.parse(raw) as PersistedFile;
    } catch {
      // Malformed; reset.
      this.state = { version: 1, stages: {} };
    }
  }

  /**
   * Resolve the effective estimate for a stage at dispatch time. Frozen declarations
   * pin the operator value; otherwise rolling supersedes; otherwise declared; otherwise
   * cold-start default (with a MissingEstimate event for the caller to surface).
   */
  resolveEstimate(
    stage: string,
    declared: TokenEstimate | undefined,
  ): { estimate: TokenEstimate; events: LedgerEvent[] } {
    const events: LedgerEvent[] = [];

    if (declared?.frozen) {
      return { estimate: declared, events };
    }

    const history = this.state.stages[stage];
    if (history?.rollingEstimate) {
      return { estimate: history.rollingEstimate, events };
    }

    if (declared) {
      return { estimate: declared, events };
    }

    events.push({ type: 'MissingEstimate', stage });
    return { estimate: COLD_START_DEFAULT, events };
  }

  /**
   * Record actual consumption after a stage completes. Updates the rolling estimate;
   * emits EstimateBootstrapped on first replacement of cold-start; emits EstimateVariance
   * when actuals diverge from the previous declared estimate by > threshold.
   */
  async record(
    stage: string,
    actual: { input: number; output: number },
    declared: TokenEstimate | undefined,
  ): Promise<LedgerEvent[]> {
    const events: LedgerEvent[] = [];
    let history = this.state.stages[stage];
    const isFirstRun = !history || history.samples.length === 0;

    if (!history) {
      history = { stage, samples: [] };
      this.state.stages[stage] = history;
    }

    history.samples.push({ ...actual, at: new Date().toISOString() });
    if (history.samples.length > ROLLING_WINDOW_SIZE) {
      history.samples.shift();
    }

    const newRolling = exponentiallyWeightedAverage(history.samples);
    const previousRolling = history.rollingEstimate;
    history.rollingEstimate = newRolling;

    if (isFirstRun && !declared) {
      history.bootstrappedAt = new Date().toISOString();
      events.push({
        type: 'EstimateBootstrapped',
        stage,
        coldStartDefault: COLD_START_DEFAULT,
        firstRunActual: { input: actual.input, output: actual.output },
        newRollingEstimate: newRolling,
      });
    }

    if (declared && !declared.frozen) {
      const declaredTotal = declared.input + declared.output;
      const actualTotal = actual.input + actual.output;
      if (declaredTotal > 0) {
        const ratio = actualTotal / declaredTotal;
        if (Math.abs(ratio - 1) > ESTIMATE_VARIANCE_THRESHOLD) {
          events.push({
            type: 'EstimateVariance',
            stage,
            declared,
            observed: { input: actual.input, output: actual.output },
            ratio,
          });
        }
      }
    }

    void previousRolling; // reserved for future delta event.
    await this.persist();
    return events;
  }

  getRollingEstimate(stage: string): TokenEstimate | undefined {
    return this.state.stages[stage]?.rollingEstimate;
  }

  private async persist(): Promise<void> {
    await this.io.write(this.path, JSON.stringify(this.state));
  }
}

/**
 * Exponentially-weighted average over the last N samples (newest weighted most).
 * Decay 0.85 — gentle preference for recent observations without ignoring history.
 */
function exponentiallyWeightedAverage(
  samples: Array<{ input: number; output: number }>,
): TokenEstimate {
  if (samples.length === 0) return COLD_START_DEFAULT;
  const decay = 0.85;
  let sumW = 0;
  let sumI = 0;
  let sumO = 0;
  // Newest sample (last in array) gets weight 1.0; older samples get progressively less.
  for (let i = samples.length - 1; i >= 0; i--) {
    const age = samples.length - 1 - i;
    const w = Math.pow(decay, age);
    sumW += w;
    sumI += samples[i].input * w;
    sumO += samples[i].output * w;
  }
  return {
    input: Math.round(sumI / sumW),
    output: Math.round(sumO / sumW),
  };
}
