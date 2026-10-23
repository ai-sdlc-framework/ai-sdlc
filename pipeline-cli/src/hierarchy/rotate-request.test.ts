import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { consumeRotateRequests, requestRotate, rotateRequestPath } from './rotate-request.js';

describe('rotate requests', () => {
  it('writes a rotate request under handoff/ for the named session', () => {
    const board = mkdtempSync(path.join(tmpdir(), 'rotate-'));
    try {
      const file = requestRotate(board, 'operator-dispatch', new Date('2026-10-23T00:00:00Z'));
      expect(file).toBe(rotateRequestPath(board, 'operator-dispatch'));
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
        kind: 'rotate',
        name: 'operator-dispatch',
        requestedAt: '2026-10-23T00:00:00.000Z',
      });
    } finally {
      rmSync(board, { recursive: true, force: true });
    }
  });

  it('consumes pending requests once, telling the host own request from the ones to forward', () => {
    const board = mkdtempSync(path.join(tmpdir(), 'rotate-'));
    try {
      expect(consumeRotateRequests(board, ['operator-dispatch'])).toEqual({
        self: false,
        forward: [],
      });
      requestRotate(board, 'operator-dispatch', new Date());
      requestRotate(board, 'executor-alpha', new Date());
      const got = consumeRotateRequests(board, ['operator-dispatch']);
      expect(got).toEqual({ self: true, forward: ['executor-alpha'] });
      expect(existsSync(rotateRequestPath(board, 'executor-alpha'))).toBe(false);
      expect(consumeRotateRequests(board, ['operator-dispatch'])).toEqual({
        self: false,
        forward: [],
      });
    } finally {
      rmSync(board, { recursive: true, force: true });
    }
  });
});
