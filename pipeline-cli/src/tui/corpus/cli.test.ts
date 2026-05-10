/**
 * Smoke test for the `cli-tui-corpus` bin shim (AISDLC-178.7).
 *
 * Mirrors `pipeline-cli/src/cli/orchestrator-corpus.test.ts` CLI surface
 * tests, exercising the compiled shim via `spawnSync` so the full
 * `bin/ → dist/ → src/` call path is validated. Requires `pnpm build`
 * to have run first (the test auto-triggers a build when the dist marker
 * is missing — same pattern as `bin-invocation.test.ts`).
 *
 * Covered:
 *   - `--help` exits 0 and renders a yargs banner
 *   - `aggregate` with a synthetic events.jsonl emits JSON with the
 *     `recommendation` field populated
 *   - `aggregate --format table` renders the ASCII summary
 *   - Missing subcommand exits non-zero (strict mode)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
// src/tui/corpus/cli.test.ts → pipeline-cli root
const PKG_ROOT = resolve(__filename, '..', '..', '..', '..');

const BIN_PATH = join(PKG_ROOT, 'bin', 'cli-tui-corpus.mjs');
const DIST_MARKER = join(PKG_ROOT, 'dist', 'tui', 'corpus', 'aggregate.js');

beforeAll(() => {
  if (!existsSync(DIST_MARKER)) {
    const build = spawnSync('pnpm', ['build'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (build.status !== 0) {
      throw new Error(
        `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
      );
    }
  }
}, 120_000);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tui-corpus-cli-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function writeSyntheticEvents(relPath: string, count: number, days: number): void {
  const base = new Date('2026-05-01').getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = i % days;
    const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
    const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
    const sessionId = `session-${i.toString().padStart(4, '0')}`;
    lines.push(JSON.stringify({ ts, type: 'TuiSessionStarted', sessionId, date: day }));
    lines.push(JSON.stringify({ ts, type: 'TuiPaneOpened', sessionId, pane: 'blockers' }));
    lines.push(JSON.stringify({ ts, type: 'TuiSessionEnded', sessionId, durationMs: 30_000 }));
  }
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): SpawnResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('cli-tui-corpus bin shim smoke tests', () => {
  it('--help exits 0 and renders a yargs banner', () => {
    const result = run('--help');
    const out = result.stdout + result.stderr;
    const detail = `\n--- exit ${result.status} ---\n${out}`;
    expect(result.status, `--help did not exit 0:${detail}`).toBe(0);
    const looksLikeHelp =
      /^Usage:/m.test(out) || /Options:/.test(out) || /cli-tui-corpus/.test(out);
    expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
  });

  it('aggregate with a sparse corpus emits JSON with recommendation=insufficient-data', () => {
    writeSyntheticEvents('events.jsonl', 5, 3);
    const result = run('aggregate', tmp);
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, `aggregate did not exit 0:${detail}`).toBe(0);
    const json = JSON.parse(result.stdout.trim()) as {
      aggregate: { recommendation: string; sessionCount: number };
    };
    expect(json.aggregate.recommendation).toBe('insufficient-data');
    expect(json.aggregate.sessionCount).toBe(5);
  });

  it('aggregate with a passing corpus emits JSON with recommendation=safe-to-promote', () => {
    writeSyntheticEvents('events.jsonl', 100, 7);
    const result = run('aggregate', tmp);
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, `aggregate did not exit 0:${detail}`).toBe(0);
    const json = JSON.parse(result.stdout.trim()) as {
      aggregate: { recommendation: string; crashCount: number };
    };
    expect(json.aggregate.recommendation).toBe('safe-to-promote');
    expect(json.aggregate.crashCount).toBe(0);
  });

  it('aggregate --format table renders ASCII output', () => {
    writeSyntheticEvents('events.jsonl', 3, 2);
    const result = run('aggregate', tmp, '--format', 'table');
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, `aggregate --format table did not exit 0:${detail}`).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(/sessionId/);
    expect(out).toMatch(/Recommendation/);
  });

  it('missing subcommand exits non-zero (strict mode)', () => {
    const result = run();
    expect(result.status).not.toBe(0);
  });

  it('--min-samples override changes threshold', () => {
    writeSyntheticEvents('events.jsonl', 5, 7);
    const result = run('aggregate', tmp, '--min-samples', '5', '--min-days', '5');
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim()) as {
      aggregate: { recommendation: string };
    };
    expect(json.aggregate.recommendation).toBe('safe-to-promote');
  });
});
