/**
 * Tests for the decisions.jsonl reader (AISDLC-178.6).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDecisions } from './decisions-reader.js';
import { decisionsPath, operatorDirPath } from './paths.js';
import type { DecisionRecord } from './decisions-writer.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'decisions-reader-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const VALID_RECORD: DecisionRecord = {
  ts: '2026-05-04T11:00:00.000Z',
  taskId: 'AISDLC-100',
  fromStatus: 'Needs Clarification',
  toStatus: 'In Progress',
  clarificationPostedAt: '2026-05-04T08:00:00.000Z',
  resolvedAt: '2026-05-04T11:00:00.000Z',
  durationMs: 10_800_000,
};

describe('readDecisions', () => {
  it('returns empty + null error when file is missing (cold-start)', () => {
    const result = readDecisions({ artifactsDir: workdir });
    expect(result.records).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('parses every JSONL record in file order', () => {
    mkdirSync(operatorDirPath(workdir), { recursive: true });
    const second = { ...VALID_RECORD, taskId: 'AISDLC-101', toStatus: 'Done' };
    writeFileSync(
      decisionsPath(workdir),
      JSON.stringify(VALID_RECORD) + '\n' + JSON.stringify(second) + '\n',
    );
    const result = readDecisions({ artifactsDir: workdir });
    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(2);
    expect(result.records[0].taskId).toBe('AISDLC-100');
    expect(result.records[1].toStatus).toBe('Done');
  });

  it('skips malformed lines silently', () => {
    mkdirSync(operatorDirPath(workdir), { recursive: true });
    writeFileSync(
      decisionsPath(workdir),
      [
        JSON.stringify(VALID_RECORD),
        '{not-json',
        JSON.stringify({ missingFields: true }),
        JSON.stringify({ ...VALID_RECORD, taskId: 'AISDLC-200' }),
      ].join('\n') + '\n',
    );
    const result = readDecisions({ artifactsDir: workdir });
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.taskId)).toEqual(['AISDLC-100', 'AISDLC-200']);
  });
});
