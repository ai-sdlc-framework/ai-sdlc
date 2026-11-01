/**
 * Guard (AISDLC-1112): a hierarchy test must not read the live board from the
 * environment. Any test naming `AI_SDLC_DISPATCH_BOARD_DIR` must use the shared
 * `withIsolatedBoard()` helper, and none may walk up to the live `.ai-sdlc/dispatch`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { withIsolatedBoard } from './__test-helpers/isolated-board.js';

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here).filter(
  (f) => f.endsWith('.test.ts') && f !== 'isolated-board-guard.test.ts',
);

describe('hierarchy tests isolate from the live board', () => {
  it('no test reads AI_SDLC_DISPATCH_BOARD_DIR without withIsolatedBoard', () => {
    const offenders = tests.filter((f) => {
      const src = readFileSync(join(here, f), 'utf8');
      return (
        /process\.env\.AI_SDLC_DISPATCH_BOARD_DIR|process\.env\[['"]AI_SDLC_DISPATCH_BOARD_DIR/.test(
          src,
        ) && !src.includes('withIsolatedBoard')
      );
    });
    expect(offenders).toEqual([]);
  });

  it('executor-start.test.ts uses the helper', () => {
    expect(readFileSync(join(here, 'executor-start.test.ts'), 'utf8')).toContain(
      'withIsolatedBoard',
    );
  });
});

describe('withIsolatedBoard', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('scrubs ambient session variables and restores them on cleanup', () => {
    process.env.AI_SDLC_DISPATCH_BOARD_DIR = '/live/board';
    process.env.HIERARCHY_X = '1';
    process.env.CLAUDE_Y = '1';
    const iso = withIsolatedBoard();
    expect(process.env.AI_SDLC_DISPATCH_BOARD_DIR).toBeUndefined();
    expect(process.env.HIERARCHY_X).toBeUndefined();
    expect(process.env.CLAUDE_Y).toBeUndefined();
    iso.cleanup();
    expect(process.env.AI_SDLC_DISPATCH_BOARD_DIR).toBe('/live/board');
  });
});
