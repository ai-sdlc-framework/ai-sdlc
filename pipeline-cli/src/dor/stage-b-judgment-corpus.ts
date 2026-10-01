/**
 * Convert the DoR corpus (`spec/dor-corpus/`) into the JSONL that
 * `cli-judgment eval dor.stage-b` reads. One line per fixture:
 *
 *   {"input": {title, body, references, gateIds}, "label": {"<gateId>": "pass"|"fail"}}
 *
 * The gate ids are the ones Stage A hands to Stage B for that fixture, and the label
 * holds the expected per-gate verdict from the fixture's end-to-end expectation (a gate
 * the sidecar lists as failing is `fail`, a Stage B ground-truth entry wins, every other
 * Stage B gate is expected to pass). `agrees` compares the judgment's per-gate result
 * with that label.
 */

import { effectiveE2E, type FixtureExpectationWithE2E } from './corpus-e2e.js';
import { loadCorpus } from './corpus.js';
import { evaluateIssue } from './evaluate.js';
import { buildDorJudgmentInput, type DorJudgmentInput } from './stage-b-judgment.js';
import type { IssueInput } from './types.js';

export interface DorJudgmentCorpusItem {
  input: DorJudgmentInput;
  label: Record<string, 'pass' | 'fail'>;
}

/** Build the eval items for every fixture under `corpusRoot` (hermetic Stage A). */
export async function dorCorpusToJudgmentItems(
  corpusRoot: string,
): Promise<DorJudgmentCorpusItem[]> {
  const items: DorJudgmentCorpusItem[] = [];
  for (const fx of loadCorpus(corpusRoot)) {
    const issue: IssueInput = {
      source: 'backlog',
      id: fx.name,
      title: fx.name.replace(/-/g, ' '),
      body: fx.body,
    };
    const stageA = await evaluateIssue(issue, { hermetic: true });
    const input = buildDorJudgmentInput(issue, stageA);
    if (input.gateIds.length === 0) continue;
    const e2e = effectiveE2E(fx.expected as FixtureExpectationWithE2E);
    const truth = e2e.stageB ?? {};
    const failing = new Set(e2e.failsGates ?? []);
    const label: DorJudgmentCorpusItem['label'] = {};
    for (const id of input.gateIds) {
      label[`${id}`] = truth[`${id}`] ?? (failing.has(id) ? 'fail' : 'pass');
    }
    items.push({ input, label });
  }
  return items;
}

/** Render the items as JSONL text, ready for `cli-judgment eval --corpus`. */
export async function dorCorpusToEvalJsonl(corpusRoot: string): Promise<string> {
  const items = await dorCorpusToJudgmentItems(corpusRoot);
  return items.map((i) => JSON.stringify(i)).join('\n') + (items.length > 0 ? '\n' : '');
}
