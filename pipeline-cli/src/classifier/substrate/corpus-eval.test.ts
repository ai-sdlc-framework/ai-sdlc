import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import { appendCorpusEntry } from './corpus.js';
import {
  convertCorpusToEvalJsonl,
  corpusEntriesToEvalRows,
  evalRowsToJsonl,
} from './corpus-eval.js';
import type { CalibrationCorpusEntry } from './types.js';
import { runJudgmentCli } from '../../cli/judgment.js';

function entry(id: string, text: string, override?: string): CalibrationCorpusEntry {
  return {
    id,
    timestamp: '2026-09-30T00:00:00.000Z',
    taskType: 'capture-triage',
    input: { text },
    model: 'm',
    classification: 'pending',
    confidence: 0,
    reasoning: '',
    threshold: 0.7,
    metBehindThreshold: false,
    polarity: override ? 'negative' : 'pending',
    ...(override ? { operatorOverrideClassification: override } : {}),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'corpus-eval-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('corpus converter', () => {
  it('keeps only entries with an operator override', () => {
    const rows = corpusEntriesToEvalRows([
      entry('1', 'a', 'quick-fix-task'),
      entry('2', 'b'),
      entry('3', 'c', "won't-fix"),
    ]);
    expect(rows).toEqual([
      { input: { text: 'a' }, label: 'quick-fix-task' },
      { input: { text: 'c' }, label: "won't-fix" },
    ]);
    expect(evalRowsToJsonl([])).toBe('');
    expect(evalRowsToJsonl(rows).split('\n')).toHaveLength(3);
  });

  it('converts a corpus yaml file in a temp dir', () => {
    appendCorpusEntry(tmp, entry('1', 'a', 'tbd'));
    appendCorpusEntry(tmp, entry('2', 'b'));
    const jsonl = convertCorpusToEvalJsonl(tmp, 'capture-triage');
    expect(
      jsonl
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([{ input: { text: 'a' }, label: 'tbd' }]);
    expect(convertCorpusToEvalJsonl(tmp, 'capture-severity')).toBe('');
  });

  it('feeds `cli-judgment eval capture.triage` with a fake provider', async () => {
    appendCorpusEntry(tmp, entry('1', 'rename it', 'quick-fix-task'));
    appendCorpusEntry(tmp, entry('2', 'new product', 'new-feature-issue'));
    appendCorpusEntry(tmp, entry('3', 'unclear', 'tbd'));
    const corpusPath = join(tmp, 'eval.jsonl');
    let out = '';
    const common = {
      out: (t: string) => (out += t),
      err: (t: string) => (out += t),
      cwd: tmp,
      env: {},
    };
    const code0 = await runJudgmentCli(
      ['export-corpus', 'capture-triage', '--out', 'eval.jsonl'],
      common,
    );
    expect(code0).toBe(0);
    expect(out).toContain('wrote 3 rows');
    expect(readFileSync(corpusPath, 'utf8').trim().split('\n')).toHaveLength(3);

    const provider = new FakeJudgmentProvider();
    provider.script('answer', (req): JudgmentAnswer => {
      const text = (req.state as { text: string }).text;
      const c = text === 'rename it' ? 'quick-fix-task' : 'new-feature-issue';
      return { type: 'choice', choice: c, probabilities: { [c]: 0.9 }, confidence: 0.9 };
    });
    out = '';
    const code = await runJudgmentCli(
      ['eval', 'capture.triage', '--corpus', corpusPath, '--artifacts-dir', join(tmp, 'art')],
      {
        ...common,
        loadConfig: () =>
          resolveJudgmentConfig({
            spec: {
              provider: 'fake',
              model: 'fake-1',
              judgments: {
                'capture.triage': { thresholds: { 'fake@fake-1': { confidence: 0.8 } } },
              },
            },
          }),
        getProvider: () => provider,
        now: () => new Date('2026-10-14T12:00:00Z'),
      },
    );
    expect(code).toBe(0);
    expect(provider.requests).toHaveLength(3);
    // 2 of 3 items are in the act band with matching labels (rename, new product); 'unclear' acts as new-feature-issue (wrong).
    expect(out).toContain('capture.triage');
  });

  it('rejects an unknown task type', async () => {
    let err = '';
    const code = await runJudgmentCli(['export-corpus', 'nope'], {
      out: () => undefined,
      err: (t) => (err += t),
      cwd: tmp,
      env: {},
    });
    expect(code).toBe(1);
    expect(err).toContain("unknown task type 'nope'");
  });

  it('writes the jsonl to stdout without --out', async () => {
    appendCorpusEntry(tmp, entry('1', 'a', 'tbd'), join(tmp, 'c'));
    let out = '';
    const code = await runJudgmentCli(['export-corpus', 'capture-triage', '--corpus-dir', 'c'], {
      out: (t) => (out += t),
      err: () => undefined,
      cwd: tmp,
      env: {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ input: { text: 'a' }, label: 'tbd' });
    writeFileSync(join(tmp, 'unused'), '');
  });
});
