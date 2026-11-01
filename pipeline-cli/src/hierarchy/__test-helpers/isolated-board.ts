/**
 * Hermetic board fixture for hierarchy tests (AISDLC-1112). Builds a private temp
 * board dir and scrubs every `AI_SDLC_*`, `HIERARCHY_*` and `CLAUDE_*` variable, so
 * an executor session's live hold, claim or board pointer cannot change a test's
 * outcome. Tests pass `board` explicitly and never fall back to discovery.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const AMBIENT_ENV_PATTERN = /^(AI_SDLC_|HIERARCHY_|CLAUDE_)/;

export interface IsolatedBoard {
  /** Temp project root. */
  readonly tmp: string;
  /** `<tmp>/.ai-sdlc/dispatch`, created. */
  readonly board: string;
  /** Remove the temp dir and restore the scrubbed environment. */
  cleanup(): void;
}

export function withIsolatedBoard(prefix = 'hierarchy-test-'): IsolatedBoard {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (AMBIENT_ENV_PATTERN.test(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const board = path.join(tmp, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  return {
    tmp,
    board,
    cleanup() {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
