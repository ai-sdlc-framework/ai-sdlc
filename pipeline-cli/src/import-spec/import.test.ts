/**
 * Integration tests for `importSpec()`.
 *
 * Phase 4 (AISDLC-329) — read-parse-write loop.
 * Phase 5 (AISDLC-330) — DoR Gate at import time; the orchestrator runs
 * DoR before each task lands. These tests inject an `evaluateDor` stub
 * so the read-parse-write assertions stay focused; Phase 5 specifics are
 * covered in `dor-at-import.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveFeatureId, importSpec, resolveTasksMdPath } from './import.js';
import type { RefineBacklogTaskResult } from '../dor/ingress-claude.js';

let workDir: string;
let specRoot: string;
let prevFlag: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'import-spec-it-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  specRoot = mkdtempSync(join(tmpdir(), 'import-spec-fixture-'));
  prevFlag = process.env.AI_SDLC_DECISION_CATALOG;
  delete process.env.AI_SDLC_DECISION_CATALOG;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(specRoot, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = prevFlag;
});

/**
 * Build an `evaluateDor` stub that always returns `admit`. Keeps the
 * Phase-4 read-parse-write assertions decoupled from the seven-gate
 * rubric — the Phase 5 specifics live in `dor-at-import.test.ts`.
 */
function admitStub(): (path: string) => Promise<RefineBacklogTaskResult> {
  return async (_path: string): Promise<RefineBacklogTaskResult> => ({
    taskId: 'STUB',
    verdict: {
      issueId: 'STUB',
      rubricVersion: 'v1',
      overallVerdict: 'admit',
      gates: [],
      signedAt: '2026-05-24T00:00:00.000Z',
      evaluatorVersion: 'test-stub',
    },
    posts: [],
    shouldRefuseExecution: false,
    evaluationMode: 'enforce',
    upstreamOqCheck: {
      rejected: false,
      manualOverride: false,
      rfcChecks: [],
      events: [],
    },
  });
}

describe('resolveTasksMdPath', () => {
  it('returns null for non-existent paths', () => {
    expect(resolveTasksMdPath(join(specRoot, 'missing'))).toBeNull();
  });

  it('returns the tasks.md path when given a directory', () => {
    const featDir = join(specRoot, 'feat-a');
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, 'tasks.md'), '### T-001 — x', 'utf8');
    expect(resolveTasksMdPath(featDir)).toBe(join(featDir, 'tasks.md'));
  });

  it('returns the file path when given tasks.md directly', () => {
    const featDir = join(specRoot, 'feat-b');
    mkdirSync(featDir, { recursive: true });
    const tasksMd = join(featDir, 'tasks.md');
    writeFileSync(tasksMd, '### T-001 — x', 'utf8');
    expect(resolveTasksMdPath(tasksMd)).toBe(tasksMd);
  });

  it('returns null when given a non-tasks.md file', () => {
    const featDir = join(specRoot, 'feat-c');
    mkdirSync(featDir, { recursive: true });
    const wrong = join(featDir, 'spec.md');
    writeFileSync(wrong, '# spec', 'utf8');
    expect(resolveTasksMdPath(wrong)).toBeNull();
  });
});

describe('deriveFeatureId', () => {
  it('returns the parent directory name', () => {
    expect(deriveFeatureId('/abs/path/.specify/specs/auth/tasks.md')).toBe('auth');
  });
});

describe('importSpec — end-to-end (AC #7)', () => {
  it('imports a multi-task spec-kit project and writes backlog tasks with specRefs', async () => {
    const featDir = join(specRoot, 'auth-feature');
    mkdirSync(featDir, { recursive: true });
    writeFileSync(
      join(featDir, 'tasks.md'),
      [
        '## Tasks',
        '',
        '### T-001 — Implement bearer-token validator',
        'Body for T-001.',
        'AC: returns 200 on well-formed token',
        'AC: returns 401 on malformed token',
        '',
        '### T-002 — Add expiry check',
        'AC: tokens older than 1h return 401',
      ].join('\n'),
      'utf8',
    );

    const result = await importSpec({
      from: featDir,
      workDir,
      importedAt: '2026-05-24T00:00:00.000Z',
      evaluateDor: admitStub(),
    });

    expect(result.outcome.kind).toBe('imported');
    if (result.outcome.kind !== 'imported') return; // type narrowing
    expect(result.outcome.writtenTasks).toHaveLength(2);
    expect(result.outcome.refusedTasks).toHaveLength(0);
    expect(result.outcome.featureId).toBe('auth-feature');

    const filesInTasks = readdirSync(join(workDir, 'backlog', 'tasks'));
    expect(filesInTasks).toHaveLength(2);

    const first = result.outcome.writtenTasks[0];
    expect(first.upstreamTaskId).toBe('T-001');
    const content = readFileSync(first.filePath, 'utf8');
    expect(content).toContain('id: IMP-1');
    expect(content).toContain('specRef:');
    expect(content).toContain('source: spec-kit');
    expect(content).toContain('featureId: auth-feature');
    expect(content).toContain('taskId: T-001');
    expect(content).toContain('returns 200 on well-formed token');
    expect(content).toContain('returns 401 on malformed token');
    // Each task carries a specRef back-reference (AC #4)
    expect(content).toMatch(/artifactPath:.+tasks\.md/);

    const second = result.outcome.writtenTasks[1];
    const c2 = readFileSync(second.filePath, 'utf8');
    expect(c2).toContain('id: IMP-2');
    expect(c2).toContain('taskId: T-002');
    expect(c2).toContain('tokens older than 1h return 401');
  });

  it('emits incomplete-spec-detected when tasks.md is missing (AC #2)', async () => {
    const featDir = join(specRoot, 'missing-feature');
    mkdirSync(featDir, { recursive: true });
    // No tasks.md written.

    const result = await importSpec({ from: featDir, workDir, evaluateDor: admitStub() });
    expect(result.outcome.kind).toBe('incomplete-spec');
    if (result.outcome.kind !== 'incomplete-spec') return;
    expect(result.outcome.decision.clarificationTaskFile).toBeTruthy();
    expect(existsSync(result.outcome.decision.clarificationTaskFile!)).toBe(true);
    const clar = readFileSync(result.outcome.decision.clarificationTaskFile!, 'utf8');
    expect(clar).toContain('incomplete-spec');
  });

  it('emits incomplete-spec-detected when the path does not exist at all', async () => {
    const result = await importSpec({
      from: join(specRoot, 'never-existed'),
      workDir,
      evaluateDor: admitStub(),
    });
    expect(result.outcome.kind).toBe('incomplete-spec');
  });

  it('emits upstream-schema-unknown when tasks.md exists but is unparsable (AC #3)', async () => {
    const featDir = join(specRoot, 'mystery-format');
    mkdirSync(featDir, { recursive: true });
    writeFileSync(
      join(featDir, 'tasks.md'),
      '# This is not a recognized spec-kit format\n\nJust prose.\n',
      'utf8',
    );

    const result = await importSpec({ from: featDir, workDir, evaluateDor: admitStub() });
    expect(result.outcome.kind).toBe('unknown-schema');
    if (result.outcome.kind !== 'unknown-schema') return;
    expect(result.outcome.decision.clarificationTaskFile).toBeTruthy();
    const clar = readFileSync(result.outcome.decision.clarificationTaskFile!, 'utf8');
    expect(clar).toContain('upstream-schema-unknown');
  });

  it('reads adopter-authoring.yaml config (AC #5)', async () => {
    // Write a malformed config — should surface as an error rather than
    // silently fall through. This is the simplest assertion that the loader
    // was actually called.
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'adopter-authoring.yaml'),
      '  not: : valid : yaml :::',
      'utf8',
    );
    const featDir = join(specRoot, 'feat-cfg');
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, 'tasks.md'), '### T-001 — x', 'utf8');

    await expect(importSpec({ from: featDir, workDir, evaluateDor: admitStub() })).rejects.toThrow(
      /adopter-authoring/,
    );
  });

  it('honours a valid adopter-authoring.yaml without overriding defaults', async () => {
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'adopter-authoring.yaml'),
      'import:\n  artifactGranularity: tasks-md-only\n',
      'utf8',
    );
    const featDir = join(specRoot, 'feat-cfg-valid');
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, 'tasks.md'), '### T-001 — One', 'utf8');

    const result = await importSpec({ from: featDir, workDir, evaluateDor: admitStub() });
    expect(result.outcome.kind).toBe('imported');
  });
});
