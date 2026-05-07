/**
 * Tests for the pr-decisions.jsonl reader (AISDLC-178.6).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPrDecisions } from './pr-decisions-reader.js';
import { prDecisionsPath, operatorDirPath } from './paths.js';
import type { PrDecisionRecord } from './pr-decisions-writer.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'pr-decisions-reader-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const VALID: PrDecisionRecord = {
  ts: '2026-05-04T11:00:00.000Z',
  pr: 42,
  url: 'https://example.com/pr/42',
  action: 'merged',
  finalState: 'MERGED',
  attentionRequiredAt: '2026-05-04T09:00:00.000Z',
  resolvedAt: '2026-05-04T11:00:00.000Z',
  elapsedMs: 7_200_000,
};

describe('readPrDecisions', () => {
  it('returns empty + null error when file is missing', () => {
    const result = readPrDecisions({ artifactsDir: workdir });
    expect(result.records).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('parses valid JSONL records', () => {
    mkdirSync(operatorDirPath(workdir), { recursive: true });
    writeFileSync(
      prDecisionsPath(workdir),
      JSON.stringify(VALID) + '\n' + JSON.stringify({ ...VALID, pr: 99, action: 'closed' }) + '\n',
    );
    const result = readPrDecisions({ artifactsDir: workdir });
    expect(result.records).toHaveLength(2);
    expect(result.records[1].action).toBe('closed');
  });

  it('skips lines missing required fields', () => {
    mkdirSync(operatorDirPath(workdir), { recursive: true });
    writeFileSync(
      prDecisionsPath(workdir),
      [
        JSON.stringify(VALID),
        JSON.stringify({ pr: 1 }), // missing ts + action
        '{ broken',
      ].join('\n') + '\n',
    );
    const result = readPrDecisions({ artifactsDir: workdir });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].pr).toBe(42);
  });
});
