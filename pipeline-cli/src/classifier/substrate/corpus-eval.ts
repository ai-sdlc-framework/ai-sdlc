/**
 * Convert a classifier calibration corpus (`<task-type>.yaml`) into the labelled
 * JSONL that `cli-judgment eval` reads. Only entries carrying an operator override
 * become rows: the override is the label. Each row is `{ input, label }` where
 * `input` is the original classifier input.
 *
 * @module classifier/substrate/corpus-eval
 */

import { readCorpus } from './corpus.js';
import type { CalibrationCorpusEntry, ClassifierTaskType } from './types.js';

export interface EvalRow {
  input: CalibrationCorpusEntry['input'];
  label: string;
}

/** Rows for every entry that carries an operator override, in corpus order. */
export function corpusEntriesToEvalRows(entries: readonly CalibrationCorpusEntry[]): EvalRow[] {
  const rows: EvalRow[] = [];
  for (const e of entries) {
    const label = e.operatorOverrideClassification;
    if (typeof label !== 'string' || label.length === 0) continue;
    rows.push({ input: e.input, label });
  }
  return rows;
}

/** JSONL text for the rows: one JSON object per line, trailing newline when non-empty. */
export function evalRowsToJsonl(rows: readonly EvalRow[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
}

/** Read `<corpusDir>/<taskType>.yaml` and return the eval JSONL text (empty when none). */
export function convertCorpusToEvalJsonl(
  repoRoot: string,
  taskType: ClassifierTaskType,
  corpusDir?: string,
): string {
  return evalRowsToJsonl(corpusEntriesToEvalRows(readCorpus(repoRoot, taskType, corpusDir)));
}
