/**
 * Tests for the shared best-effort JSONL appender (AISDLC-178.6).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendJsonlRecord } from './jsonl-append.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'jsonl-append-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('appendJsonlRecord', () => {
  it('writes one JSON line + creates parent dirs on demand', () => {
    const path = join(workdir, 'nested', 'sub', 'file.jsonl');
    expect(existsSync(path)).toBe(false);
    const ok = appendJsonlRecord(path, { a: 1 });
    expect(ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('appends successive records', () => {
    const path = join(workdir, 'a.jsonl');
    appendJsonlRecord(path, { ts: 't0', n: 1 });
    appendJsonlRecord(path, { ts: 't1', n: 2 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: 't0', n: 1 });
    expect(JSON.parse(lines[1])).toEqual({ ts: 't1', n: 2 });
  });

  it('returns false + warns when the write throws', () => {
    const warn = vi.fn();
    const ok = appendJsonlRecord(
      '/dev/null/not-a-real-path/x.jsonl',
      { a: 1 },
      {
        logger: { info: () => {}, warn, error: () => {}, progress: () => {} },
        loggerTag: '[unit-test]',
      },
    );
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[unit-test]');
  });
});
