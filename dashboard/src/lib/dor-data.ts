/**
 * DoR calibration data loader for the dashboard (AISDLC-162).
 *
 * Wraps the `cli-dor-corpus` aggregator from `@ai-sdlc/pipeline-cli`
 * (AISDLC-161) so the dashboard can render the per-gate FP rate +
 * recommendation envelope produced by the same code path the CLI uses.
 *
 * Source-of-truth resolution (in order):
 *   1. `DOR_CORPUS_DIR` env var — operator-specified directory (typically
 *      a `gh run download` output directory of `dor-calibration-*`
 *      artifacts)
 *   2. `<process.cwd()>/artifacts/_dor` — the conventional local
 *      calibration log path used by `cli-dor-stats`
 *
 * Returns `null` when the resolved directory is absent or empty so the
 * page can render a "no data yet" state instead of a stack trace. The
 * CLI's `aggregateCorpus` returns a synthesised `insufficient-data`
 * report for an empty corpus — but distinguishing "operator never set
 * up the dir" from "dir exists but empty" matters for the UI hint we
 * show the operator, hence the explicit null path.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateCorpus,
  findCalibrationFiles,
  loadCorpus,
  type AggregateOpts,
  type CalibrationEntry,
  type CorpusReport,
} from '@ai-sdlc/pipeline-cli/dor-corpus';

export interface DorDataResult {
  /** Resolved corpus root used for the aggregation (absolute path). */
  corpusRoot: string;
  /** Aggregator output (per-gate + aggregate). */
  report: CorpusReport;
  /**
   * Most-recent N calibration entries, sorted descending by `ts`. Used
   * by the dashboard's collapsible "raw entries" table for operator
   * spot-checking.
   */
  recentEntries: CalibrationEntry[];
}

export interface LoadDorDataOpts extends AggregateOpts {
  /** Absolute path override; bypasses env + cwd resolution. */
  corpusRoot?: string;
  /** Cap on the recent-entry tail surfaced to the UI. Default 25. */
  recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 25;

/**
 * Resolve the corpus root the dashboard should read from. Pure function
 * (no I/O) so tests can assert the resolution order without touching the
 * filesystem.
 */
export function resolveCorpusRoot(opts: { corpusRoot?: string } = {}): string {
  if (opts.corpusRoot) return opts.corpusRoot;
  const env = process.env.DOR_CORPUS_DIR;
  if (env && env.length > 0) return env;
  return join(process.cwd(), 'artifacts', '_dor');
}

/**
 * Load + aggregate the DoR calibration corpus for the dashboard.
 *
 * Returns `null` when the resolved root doesn't exist on disk — the
 * page treats that as "no data yet" and renders an operator hint
 * pointing at the `gh run download` recipe in
 * `docs/operations/dor-promotion.md`.
 *
 * When the root exists but contains no readable JSONL, returns a
 * `DorDataResult` whose `report.aggregate.recommendation` is
 * `insufficient-data` (the aggregator's natural empty-corpus shape) so
 * the page renders the gray badge + the "below minSamples" reason.
 */
export function loadDorData(opts: LoadDorDataOpts = {}): DorDataResult | null {
  const corpusRoot = resolveCorpusRoot(opts);
  if (!existsSync(corpusRoot)) return null;

  const files = findCalibrationFiles(corpusRoot);
  const { entries, skipped } = loadCorpus(files);
  const report = aggregateCorpus(
    entries,
    {
      ...(opts.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
      ...(opts.fpThreshold !== undefined ? { fpThreshold: opts.fpThreshold } : {}),
      ...(opts.overrideThreshold !== undefined
        ? { overrideThreshold: opts.overrideThreshold }
        : {}),
    },
    { skipped, filesRead: files.length },
  );

  const recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  // Sort descending by `ts` so the operator sees the freshest events
  // first. `ts` is ISO-8601 — string comparison is lexicographically
  // equivalent to chronological order, which is cheaper than parsing.
  const recentEntries = [...entries].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, recentLimit);

  return { corpusRoot, report, recentEntries };
}
