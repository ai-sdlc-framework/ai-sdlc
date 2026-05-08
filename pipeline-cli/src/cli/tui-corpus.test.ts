/**
 * CLI surface tests for `cli-tui-corpus aggregate` (AISDLC-178.7 / RFC-0023
 * §13 Phase 7).
 *
 * Hermetic — tests seed a tmpdir of corpus files and drive
 * `buildTuiCorpusCli().parseAsync()` with stdout/stderr captured. Mirrors
 * the conventions of `cli-orchestrator-corpus.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTuiCorpusCli } from './tui-corpus.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tui-corpus-cli-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli', ...args];
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stdoutJson(): unknown {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function writeJsonl(relPath: string, lines: string[]): void {
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

describe('cli-tui-corpus aggregate — CLI surface', () => {
  it('emits JSON envelope by default', async () => {
    const sessions: string[] = [];
    const interactions: string[] = [];
    const panes = ['blockers', 'prs', 'deps', 'analytics'];
    for (let day = 1; day <= 7; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      sessions.push(JSON.stringify({ ts, type: 'TuiStarted' }));
      interactions.push(
        JSON.stringify({ ts, kind: 'pane-opened', pane: 'overview' }),
        JSON.stringify({
          ts: `2026-05-0${day}T08:05:00Z`,
          kind: 'pane-opened',
          pane: panes[(day - 1) % panes.length],
        }),
      );
    }
    writeJsonl('_tui/events.jsonl', sessions);
    writeJsonl('_operator/interactions.jsonl', interactions);

    setArgv('aggregate', tmp);
    await buildTuiCorpusCli().parseAsync();

    const json = stdoutJson() as {
      recommendation?: string;
      sessions?: number;
      daysWithUsage?: number;
    };
    expect(json?.recommendation).toBe('safe-to-promote');
    expect(json?.sessions).toBe(7);
    expect(json?.daysWithUsage).toBe(7);
  });

  it('emits an ASCII summary with --format table', async () => {
    writeJsonl('_tui/events.jsonl', [
      JSON.stringify({ ts: '2026-05-07T00:00:00Z', type: 'TuiStarted' }),
    ]);
    setArgv('aggregate', tmp, '--format', 'table');
    await buildTuiCorpusCli().parseAsync();
    const text = stdoutText();
    expect(text).toMatch(/TUI soak corpus/);
    expect(text).toMatch(/Recommendation:/);
    expect(text).toMatch(/insufficient-data/);
  });

  it('hard-gates on TuiCrashed even when sessions are sufficient', async () => {
    const sessions: string[] = [];
    const interactions: string[] = [];
    for (let day = 1; day <= 7; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      sessions.push(JSON.stringify({ ts, type: 'TuiStarted' }));
      interactions.push(
        JSON.stringify({ ts, kind: 'pane-opened', pane: 'blockers' }),
        JSON.stringify({
          ts: `2026-05-0${day}T08:05:00Z`,
          kind: 'pane-opened',
          pane: 'prs',
        }),
      );
    }
    sessions.push(
      JSON.stringify({ ts: '2026-05-04T12:00:00Z', type: 'TuiCrashed', errorMessage: 'boom' }),
    );
    writeJsonl('_tui/events.jsonl', sessions);
    writeJsonl('_operator/interactions.jsonl', interactions);

    setArgv('aggregate', tmp);
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as {
      recommendation?: string;
      tuiCrashedCount?: number;
    };
    expect(json?.tuiCrashedCount).toBe(1);
    expect(json?.recommendation).toBe('continue-soak');
  });

  it('respects --min-sessions override', async () => {
    const sessions: string[] = [];
    const interactions: string[] = [];
    for (let day = 1; day <= 3; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      sessions.push(JSON.stringify({ ts, type: 'TuiStarted' }));
      interactions.push(
        JSON.stringify({ ts, kind: 'pane-opened', pane: 'blockers' }),
        JSON.stringify({
          ts: `2026-05-0${day}T08:05:00Z`,
          kind: 'pane-opened',
          pane: 'prs',
        }),
      );
    }
    writeJsonl('_tui/events.jsonl', sessions);
    writeJsonl('_operator/interactions.jsonl', interactions);

    setArgv('aggregate', tmp, '--min-sessions', '3', '--min-days-with-usage', '3');
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as { recommendation?: string };
    expect(json?.recommendation).toBe('safe-to-promote');
  });
});
