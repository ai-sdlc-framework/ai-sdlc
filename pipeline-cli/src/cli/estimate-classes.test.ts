/**
 * cli-estimate-classes tests — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Covers:
 *  - AC #4: `review` command lists pending class proposals.
 *  - AC #5: `promote` command auto-promotes ≥3-proposal clusters.
 *  - Degrade-open when estimation flag is disabled.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEstimateClassesCli } from './estimate-classes.js';
import { ESTIMATION_FLAG } from '../estimation/feature-flag.js';
import { appendProposal } from '../estimation/class-proposals.js';
import type { ClassProposal } from '../estimation/class-proposals.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const SAVED_ENV = { ...process.env };
let tmpDir: string;
let stdoutBuf = '';
/* eslint-disable @typescript-eslint/no-explicit-any */
let stdoutSpy: any;
let stderrSpy: any;
let exitSpy: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const SAMPLE_PROPOSAL: Omit<ClassProposal, 'accepted'> = {
  ts: '2026-05-01T10:00:00Z',
  taskId: 'AISDLC-200',
  proposedClass: 'docs-rewrite',
  structure: {
    definition: 'Structural rewrite of documentation files.',
    exemplars: ['Rewrite RFC-0016 to include implementation examples'],
    anti_patterns: ['Update changelog (this is chore)'],
    synonyms: ['doc-rewrite'],
  },
  confidence: 0.78,
  rationale: 'Task is a structural rewrite of multiple .md files',
};

function makeTmpDir(): string {
  const dir = join(tmpdir(), `estimate-classes-cli-test-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function resetArgv(args: string[]): void {
  process.argv = ['node', 'cli-estimate-classes', ...args];
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  process.env[ESTIMATION_FLAG] = 'experimental';
  stdoutBuf = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks();
});

// ── degrade-open ──────────────────────────────────────────────────────────

describe('cli-estimate-classes — degrade-open when flag disabled', () => {
  it('exits 0 with disabled JSON when flag is unset', async () => {
    delete process.env[ESTIMATION_FLAG];
    resetArgv(['review', '--workdir', tmpDir]);
    await buildEstimateClassesCli().parseAsync();
    const parsed = JSON.parse(stdoutBuf);
    expect(parsed.disabled).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── review command ────────────────────────────────────────────────────────

describe('cli-estimate-classes review — AC #4', () => {
  it('shows "No pending class proposals" when list is empty', async () => {
    resetArgv(['review', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('No pending class proposals');
  });

  it('lists pending proposals in table format', async () => {
    appendProposal({ aiSdlcDir: join(tmpDir, '.ai-sdlc'), proposal: SAMPLE_PROPOSAL });
    appendProposal({
      aiSdlcDir: join(tmpDir, '.ai-sdlc'),
      proposal: { ...SAMPLE_PROPOSAL, taskId: 'AISDLC-201', ts: '2026-05-02T10:00:00Z' },
    });
    resetArgv(['review', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('docs-rewrite');
    expect(stdoutBuf).toContain('2 proposal');
  });

  it('returns JSON output with --format json', async () => {
    appendProposal({ aiSdlcDir: join(tmpDir, '.ai-sdlc'), proposal: SAMPLE_PROPOSAL });
    resetArgv(['review', '--workdir', tmpDir, '--format', 'json']);
    await buildEstimateClassesCli().parseAsync();
    const parsed = JSON.parse(stdoutBuf);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.clusters)).toBe(true);
    expect(parsed.clusters[0].canonicalName).toBe('docs-rewrite');
  });

  it('marks AUTO-PROMOTABLE when count ≥ threshold', async () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: join(tmpDir, '.ai-sdlc'),
        proposal: {
          ...SAMPLE_PROPOSAL,
          taskId: `AISDLC-${200 + i}`,
          ts: `2026-05-0${i + 1}T10:00:00Z`,
        },
      });
    }
    resetArgv(['review', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('AUTO-PROMOTABLE');
  });
});

// ── promote command ───────────────────────────────────────────────────────

describe('cli-estimate-classes promote — AC #5', () => {
  it('reports "Nothing promoted" when no auto-promotable clusters', async () => {
    resetArgv(['promote', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('Nothing promoted');
  });

  it('promotes ≥3-proposal clusters', async () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: join(tmpDir, '.ai-sdlc'),
        proposal: { ...SAMPLE_PROPOSAL, taskId: `AISDLC-${200 + i}` },
      });
    }
    resetArgv(['promote', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('docs-rewrite');
    expect(stdoutBuf).toContain('Promoted');
  });

  it('returns JSON with promotedCount when format=json', async () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: join(tmpDir, '.ai-sdlc'),
        proposal: { ...SAMPLE_PROPOSAL, taskId: `AISDLC-${200 + i}` },
      });
    }
    resetArgv(['promote', '--workdir', tmpDir, '--format', 'json']);
    await buildEstimateClassesCli().parseAsync();
    const parsed = JSON.parse(stdoutBuf);
    expect(parsed.ok).toBe(true);
    expect(parsed.promotedCount).toBe(1);
    expect(parsed.promotedClasses).toContain('docs-rewrite');
  });
});

// ── list command ──────────────────────────────────────────────────────────

describe('cli-estimate-classes list', () => {
  it('shows the 3 starter classes when no yaml exists', async () => {
    resetArgv(['list', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('bug');
    expect(stdoutBuf).toContain('feature');
    expect(stdoutBuf).toContain('chore');
    expect(stdoutBuf).toContain('[starter]');
  });

  it('shows promoted classes with [promoted] tag', async () => {
    for (let i = 0; i < 3; i++) {
      appendProposal({
        aiSdlcDir: join(tmpDir, '.ai-sdlc'),
        proposal: { ...SAMPLE_PROPOSAL, taskId: `AISDLC-${200 + i}` },
      });
    }
    // Promote first
    await buildEstimateClassesCli().parse(['promote', '--workdir', tmpDir]);
    stdoutBuf = ''; // reset buffer
    resetArgv(['list', '--workdir', tmpDir, '--format', 'table']);
    await buildEstimateClassesCli().parseAsync();
    expect(stdoutBuf).toContain('docs-rewrite');
    expect(stdoutBuf).toContain('[promoted]');
  });
});
