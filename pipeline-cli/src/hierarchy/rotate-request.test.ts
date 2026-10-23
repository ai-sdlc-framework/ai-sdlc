import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  consumeRotateRequests,
  requestDispatchRotate,
  rotateRequestPath,
} from './rotate-request.js';

describe('requestDispatchRotate', () => {
  it('writes a rotate request under handoff/ for the named session', () => {
    const board = mkdtempSync(path.join(tmpdir(), 'rotate-'));
    try {
      const file = requestDispatchRotate(
        board,
        'operator-dispatch',
        new Date('2026-10-23T00:00:00Z'),
      );
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

  it('consumes pending requests once', () => {
    const board = mkdtempSync(path.join(tmpdir(), 'rotate-'));
    try {
      expect(consumeRotateRequests(board)).toBe(false);
      requestDispatchRotate(board, 'operator-dispatch', new Date());
      expect(consumeRotateRequests(board)).toBe(true);
      expect(consumeRotateRequests(board)).toBe(false);
    } finally {
      rmSync(board, { recursive: true, force: true });
    }
  });
});
