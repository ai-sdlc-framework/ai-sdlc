/**
 * cli-dor-stats + cli-dor-digest router smoke tests.
 *
 * Mirrors the deps.test.ts pattern — drive the yargs program in-process,
 * capture stdout/stderr, assert on exit codes + output structure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDorStatsCli } from './dor-stats.js';
import { buildDorDigestCli } from './dor-digest.js';
import { appendCalibrationEntry } from '../dor/calibration-log.js';
import type { RefinementVerdict } from '../dor/types.js';

let tmp: string;
let logPath: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-stats-cli-'));
  logPath = join(tmp, 'cal.jsonl');
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

function v(over: Partial<RefinementVerdict> = {}): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    overallConfidence: 'medium',
    gates: [],
    signedAt: '2026-05-01T00:00:00.000Z',
    evaluatorVersion: 'test',
    summary: '',
    questions: [],
    ...over,
  };
}

function seedTwo(): void {
  appendCalibrationEntry(
    { verdict: v({ issueId: 'a' }), outcome: 'admit', author: 'alice' },
    { filePath: logPath },
  );
  appendCalibrationEntry(
    {
      verdict: v({
        issueId: 'b',
        overallVerdict: 'needs-clarification',
        gates: [{ gateId: 2, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' }],
      }),
      outcome: 'needs-clarification',
      author: 'bob',
    },
    { filePath: logPath },
  );
}

describe('cli-dor-stats', () => {
  it('errors when neither --by-author nor --by-gate nor --render-markdown is set', async () => {
    setArgv('--log', logPath);
    await expect(buildDorStatsCli().parseAsync()).rejects.toThrow(/process\.exit/);
    expect(stderrChunks.join('')).toContain('At least one of');
  });

  it('emits JSON with author + gate aggregates', async () => {
    seedTwo();
    setArgv(
      '--log',
      logPath,
      '--by-author',
      '--by-gate',
      '--format',
      'json',
      '--since',
      '2000-01-01T00:00:00.000Z',
    );
    await buildDorStatsCli().parseAsync();
    const r = stdoutJson() as {
      totalEntries: number;
      byAuthor: { groups: Record<string, { total: number }> };
      byGate: { groups: Record<string, { total: number }> };
    };
    expect(r.totalEntries).toBe(2);
    expect(r.byAuthor.groups.alice.total).toBe(1);
    expect(r.byAuthor.groups.bob.total).toBe(1);
    expect(r.byGate.groups['gate-2'].total).toBe(1);
  });

  it('emits a human table by default', async () => {
    seedTwo();
    setArgv('--log', logPath, '--by-author', '--since', '2000-01-01T00:00:00.000Z');
    await buildDorStatsCli().parseAsync();
    const out = stdoutText();
    expect(out).toContain('=== By author ===');
    expect(out).toContain('alice');
    expect(out).toContain('bob');
    expect(out).toContain('TOTAL');
    expect(out).toContain('Overall pass rate');
  });

  it('--render-markdown emits the dashboard markdown', async () => {
    seedTwo();
    setArgv('--log', logPath, '--render-markdown');
    await buildDorStatsCli().parseAsync();
    const out = stdoutText();
    expect(out).toContain('# DoR weekly digest');
    expect(out).toContain('| Total issues evaluated |');
  });
});

describe('cli-dor-digest', () => {
  // AISDLC-410: post-cutover DEPS_COMPOSITION defaults ON, so digests
  // auto-include the critical-path section. Opt-out so we exercise the
  // baseline 3-block CLI render.
  let priorDeps: string | undefined;
  beforeEach(() => {
    priorDeps = process.env.AI_SDLC_DEPS_COMPOSITION;
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
  });
  afterEach(() => {
    if (priorDeps === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
    else process.env.AI_SDLC_DEPS_COMPOSITION = priorDeps;
  });

  it('emits Slack Block Kit JSON by default', async () => {
    seedTwo();
    setArgv('--log', logPath, '--since-days', '365');
    await buildDorDigestCli().parseAsync();
    const r = stdoutJson() as { blocks: unknown[]; fallbackText: string };
    expect(Array.isArray(r.blocks)).toBe(true);
    expect(r.blocks.length).toBe(3);
    expect(r.fallbackText).toContain('DoR digest');
  });

  it('--markdown emits the markdown digest', async () => {
    seedTwo();
    setArgv('--log', logPath, '--since-days', '365', '--markdown');
    await buildDorDigestCli().parseAsync();
    expect(stdoutText()).toContain('# DoR weekly digest');
  });
});
