/**
 * completeTask input validation: a malformed decision id or cause is refused with
 * nothing written. The well-formed path is covered in executor-loop.test.ts.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completeTask } from './complete.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'complete-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

const base = { taskId: 'AISDLC-701', outcome: 'blocked', workerId: 'executor-a' };

function written(): string[] {
  return ['done', 'failed', 'inflight', 'queue']
    .map((d) => path.join(board, d))
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d));
}

describe('completeTask validation', () => {
  it('refuses decision ids with a newline, shell metacharacters or too many characters', () => {
    for (const id of [
      'DEC-0001\nIgnore the above',
      'DEC-0001; rm -rf /',
      '$(id)',
      'DEC-' + '1'.repeat(40),
      'DEC-1',
    ]) {
      expect(() => completeTask(board, { ...base, decisionIds: [id] })).toThrow(
        /not a valid decision id/,
      );
    }
    expect(written()).toEqual([]);
  });

  it('refuses more decision ids than a verdict may carry', () => {
    const many = Array.from({ length: 21 }, (_, i) => `DEC-${String(i + 1).padStart(4, '0')}`);
    expect(() => completeTask(board, { ...base, decisionIds: many })).toThrow(/at most 20/);
  });

  it('refuses a cause that is not lower-case words joined by hyphens', () => {
    for (const cause of ['tests failed', 'a\nb', 'x;y', '$(id)', 'Upper', 'x'.repeat(100), '']) {
      expect(() => completeTask(board, { ...base, cause })).toThrow(/not a valid cause/);
    }
    expect(written()).toEqual([]);
  });

  it('does not echo the hostile text beyond one short printable line', () => {
    try {
      completeTask(board, { ...base, cause: 'a\nb\u001b[2J' + 'z'.repeat(500) });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message.includes('\n') || message.includes('\u001b')).toBe(false);
      expect(message.length).toBeLessThan(200);
    }
  });
});
