/**
 * Tests for the Phase 5 DoR-at-import wiring (AISDLC-330).
 *
 * Exercises:
 *   - AC#1 DoR Gate runs at import time (strict default).
 *   - AC#2 `--rubric warn` opt-out admits with warnings.
 *   - AC#3 Analyze metadata auto-resolves matching gates via the catalog.
 *   - AC#4 Falls back to full DoR rubric when analyze metadata absent.
 *   - AC#5 Failed DoR refuses import (no placeholder); emits upstream
 *          clarification task.
 *   - AC#6 Structured clarification hints in the emitted upstream task.
 *   - AC#7 Composes with RFC-0035 Stage A/B/C — analyze auto-resolutions
 *          appear as decision-opened + operator-answered pairs.
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

import { importSpec } from './import.js';
import {
  classifyAnalyzeCoverage,
  hashClarificationQuestion,
  normaliseClarificationQuestion,
  readAnalyzeMetadataFromDisk,
  resolveTmpImportDir,
  runDorAtImport,
} from './dor-at-import.js';
import { resolveEventLogPath } from '../decisions/event-log.js';
import type { RefinementVerdict } from '../dor/types.js';
import type { RefineBacklogTaskResult } from '../dor/ingress-claude.js';
import type { SpecKitTaskEntry } from './parser.js';

let workDir: string;
let specRoot: string;
let prevFlag: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dor-at-import-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  specRoot = mkdtempSync(join(tmpdir(), 'dor-at-import-spec-'));
  prevFlag = process.env.AI_SDLC_DECISION_CATALOG;
  delete process.env.AI_SDLC_DECISION_CATALOG; // default-ON
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(specRoot, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = prevFlag;
});

// ── Stub helpers ─────────────────────────────────────────────────────────────

function admitVerdict(): RefinementVerdict {
  return {
    issueId: 'STUB',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    gates: [],
    signedAt: '2026-05-24T00:00:00.000Z',
    evaluatorVersion: 'test-stub',
  };
}

function failVerdict(opts: {
  gateIds?: number[];
  questions?: string[];
  findings?: string[];
}): RefinementVerdict {
  const gateIds = opts.gateIds ?? [3];
  return {
    issueId: 'STUB',
    rubricVersion: 'v1',
    overallVerdict: 'needs-clarification',
    gates: gateIds.map((id, idx) => ({
      gateId: id as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      verdict: 'fail' as const,
      confidence: 'high' as const,
      severity: 'block' as const,
      stage: 'A' as const,
      finding: opts.findings?.[idx] ?? `Gate ${id} failed: missing required content`,
      clarificationQuestion:
        opts.questions?.[idx] ?? `What ${id === 3 ? 'reference' : 'piece'} resolves Gate ${id}?`,
    })),
    signedAt: '2026-05-24T00:00:00.000Z',
    evaluatorVersion: 'test-stub',
    questions: opts.questions ?? [`What reference resolves Gate ${gateIds[0]}?`],
  };
}

function wrapVerdict(verdict: RefinementVerdict): RefineBacklogTaskResult {
  return {
    taskId: verdict.issueId,
    verdict,
    posts: [],
    shouldRefuseExecution: false,
    evaluationMode: 'enforce',
    upstreamOqCheck: {
      rejected: false,
      manualOverride: false,
      rfcChecks: [],
      events: [],
    },
  };
}

function makeStub(verdict: RefinementVerdict) {
  return async (): Promise<RefineBacklogTaskResult> => wrapVerdict(verdict);
}

function writeTasksMd(featDir: string, source: string): string {
  mkdirSync(featDir, { recursive: true });
  const path = join(featDir, 'tasks.md');
  writeFileSync(path, source, 'utf8');
  return path;
}

// ── Helper-level tests ───────────────────────────────────────────────────────

describe('normaliseClarificationQuestion', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normaliseClarificationQuestion('  What  IS this?\n')).toBe('what is this?');
  });
});

describe('hashClarificationQuestion', () => {
  it('is stable across whitespace + casing variations', () => {
    const a = hashClarificationQuestion('What is X?');
    const b = hashClarificationQuestion('  what  is  x?  ');
    expect(a).toBe(b);
  });
  it('differs across distinct questions', () => {
    const a = hashClarificationQuestion('What is X?');
    const b = hashClarificationQuestion('What is Y?');
    expect(a).not.toBe(b);
  });
});

describe('readAnalyzeMetadataFromDisk', () => {
  it('returns null when the file is absent', () => {
    expect(readAnalyzeMetadataFromDisk(join(workDir, 'missing.json'))).toBeNull();
  });

  it('parses coveredGates + coveredQuestionHashes + rationale', () => {
    const p = join(workDir, '.specify', 'analyze.json');
    mkdirSync(join(workDir, '.specify'), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        coveredGates: [1, 3, 5, 99 /* out of range */, 'not a number'],
        coveredQuestionHashes: ['abc123', 42 /* not a string */],
        rationale: 'spec-kit analyze v1.2',
      }),
      'utf8',
    );
    const out = readAnalyzeMetadataFromDisk(p);
    expect(out?.coveredGates).toEqual([1, 3, 5]);
    expect(out?.coveredQuestionHashes).toEqual(['abc123']);
    expect(out?.rationale).toBe('spec-kit analyze v1.2');
  });

  it('throws on malformed JSON', () => {
    const p = join(workDir, '.specify', 'analyze.json');
    mkdirSync(join(workDir, '.specify'), { recursive: true });
    writeFileSync(p, '{ not json', 'utf8');
    expect(() => readAnalyzeMetadataFromDisk(p)).toThrow(/failed to parse analyze metadata/);
  });
});

describe('classifyAnalyzeCoverage', () => {
  it('returns all failing findings as uncovered when analyze metadata is null', () => {
    const v = failVerdict({ gateIds: [3, 5] });
    const { coveredFindings, uncoveredFindings } = classifyAnalyzeCoverage(v, null);
    expect(coveredFindings).toEqual([]);
    expect(uncoveredFindings).toHaveLength(2);
  });

  it('auto-resolves findings whose gate id appears in coveredGates', () => {
    const v = failVerdict({ gateIds: [3, 5] });
    const { coveredFindings, uncoveredFindings } = classifyAnalyzeCoverage(v, {
      coveredGates: [3],
    });
    expect(coveredFindings).toHaveLength(1);
    expect(coveredFindings[0].gateId).toBe(3);
    expect(uncoveredFindings).toHaveLength(1);
    expect(uncoveredFindings[0].gateId).toBe(5);
  });

  it('auto-resolves findings whose clarification question hash matches', () => {
    const v = failVerdict({
      gateIds: [4, 6],
      questions: ['Tell me about FOO', 'Tell me about BAR'],
    });
    const fooHash = hashClarificationQuestion('Tell me about FOO');
    const { coveredFindings, uncoveredFindings } = classifyAnalyzeCoverage(v, {
      coveredQuestionHashes: [fooHash],
    });
    expect(coveredFindings).toHaveLength(1);
    expect(coveredFindings[0].clarificationQuestion).toBe('Tell me about FOO');
    expect(uncoveredFindings).toHaveLength(1);
  });
});

// ── runDorAtImport ───────────────────────────────────────────────────────────

describe('runDorAtImport — AC#1, AC#4 (strict default, full rubric fallback)', () => {
  const entry: SpecKitTaskEntry = {
    taskId: 'T-001',
    title: 'Implement bearer-token validator',
    body: 'Body',
    acceptanceCriteria: ['Returns 200', 'Returns 401'],
  };

  it('returns admitted when the DoR verdict is admit', async () => {
    const out = await runDorAtImport(
      {
        entry,
        renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody`,
      },
      {
        workDir,
        strictness: 'strict',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: makeStub(admitVerdict()),
      },
    );
    expect(out.outcome.kind).toBe('admitted');
  });

  it('cleans up the temp file under .ai-sdlc/import-spec-tmp/', async () => {
    let observedPath: string | undefined;
    await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: async (taskFilePath: string) => {
          observedPath = taskFilePath;
          return wrapVerdict(admitVerdict());
        },
      },
    );
    expect(observedPath).toBeDefined();
    expect(observedPath!.startsWith(resolveTmpImportDir(workDir))).toBe(true);
    expect(existsSync(observedPath!)).toBe(false);
  });
});

describe('runDorAtImport — AC#5, AC#6 (refuse-strict + clarification hints)', () => {
  const entry: SpecKitTaskEntry = {
    taskId: 'T-007',
    title: 'Add expiry check',
    body: '',
    acceptanceCriteria: [],
  };

  it('refuses and writes a clarification task with structured hints', async () => {
    const verdict = failVerdict({
      gateIds: [3, 5],
      findings: ['Reference RFC-9999 does not resolve', 'No surface named'],
      questions: ['Which RFC?', 'Which file path?'],
    });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: makeStub(verdict),
      },
    );
    expect(out.outcome.kind).toBe('refused-strict');
    if (out.outcome.kind !== 'refused-strict') return;
    expect(out.outcome.failedGates).toEqual([3, 5]);
    expect(out.outcome.clarificationTaskFile).toBeTruthy();

    const clarContent = readFileSync(out.outcome.clarificationTaskFile!, 'utf8');
    expect(clarContent).toContain('id: IMPCLARIFY-1');
    expect(clarContent).toContain('dor-blocked');
    expect(clarContent).toContain('upstream-clarification');
    // AC#6 — structured hints (which gates failed + why)
    expect(clarContent).toContain('Gate 3');
    expect(clarContent).toContain('Reference RFC-9999 does not resolve');
    expect(clarContent).toContain('Gate 5');
    expect(clarContent).toContain('Which file path?');
    expect(clarContent).toContain('.specify/specs/auth/tasks.md');
  });

  it('emits Decision: import-blocked-on-dor in the catalog when enabled (AC#7)', async () => {
    const verdict = failVerdict({ gateIds: [3] });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: makeStub(verdict),
      },
    );
    if (out.outcome.kind !== 'refused-strict') throw new Error('expected refused-strict');
    expect(out.outcome.decisionId).toMatch(/^DEC-\d{4,}$/);

    const log = readFileSync(resolveEventLogPath(workDir), 'utf8');
    expect(log).toContain('"type":"decision-opened"');
    expect(log).toContain('"scope":"import-spec:dor:T-007"');
    expect(log).toContain('import blocked on DoR');
  });

  it('skips the Decision event when the catalog is off but still emits the clarification task', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    const verdict = failVerdict({ gateIds: [3] });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: makeStub(verdict),
      },
    );
    if (out.outcome.kind !== 'refused-strict') throw new Error('expected refused-strict');
    expect(out.outcome.decisionId).toBeNull();
    expect(out.outcome.clarificationTaskFile).toBeTruthy();
    expect(existsSync(resolveEventLogPath(workDir))).toBe(false);
  });
});

describe('runDorAtImport — AC#2 (warn opt-out)', () => {
  const entry: SpecKitTaskEntry = {
    taskId: 'T-002',
    title: 'Add metrics',
    body: '',
    acceptanceCriteria: [],
  };

  it('admits the task with warnings under --rubric warn', async () => {
    const verdict = failVerdict({ gateIds: [3] });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'warn',
        featureId: 'auth',
        artifactPath: '.specify/specs/auth/tasks.md',
        evaluateDor: makeStub(verdict),
      },
    );
    expect(out.outcome.kind).toBe('admitted-with-warnings');
    if (out.outcome.kind !== 'admitted-with-warnings') return;
    expect(out.outcome.failedGates).toEqual([3]);
    // No clarification task should have been emitted under warn mode.
    expect(readdirSync(join(workDir, 'backlog', 'tasks'))).toEqual([]);
  });
});

describe('runDorAtImport — AC#3, AC#7 (analyze auto-resolve via catalog)', () => {
  const entry: SpecKitTaskEntry = {
    taskId: 'T-100',
    title: 'Add caching layer',
    body: '',
    acceptanceCriteria: [],
  };

  it('drops findings covered by coveredGates and emits matched Decisions', async () => {
    const verdict = failVerdict({
      gateIds: [3, 5],
      questions: ['Q-3', 'Q-5'],
      findings: ['F-3', 'F-5'],
    });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'cache',
        artifactPath: '.specify/specs/cache/tasks.md',
        evaluateDor: makeStub(verdict),
        readAnalyzeMetadata: () => ({ coveredGates: [3], rationale: 'covered by analyze' }),
      },
    );
    // One finding remains (Gate 5), so strict still refuses — but the Gate 3
    // analyze coverage is recorded as an auto-resolved Decision pair.
    expect(out.outcome.kind).toBe('refused-strict');
    if (out.outcome.kind !== 'refused-strict') return;
    expect(out.outcome.failedGates).toEqual([5]);
    expect(out.outcome.autoResolvedDecisionIds).toHaveLength(1);

    const log = readFileSync(resolveEventLogPath(workDir), 'utf8');
    // AC#7 — analyze-coverage event pair (decision-opened + operator-answered)
    expect(log).toContain('"type":"decision-opened"');
    expect(log).toContain('"type":"operator-answered"');
    expect(log).toContain('Auto-resolved by RFC-0036 OQ-7');
  });

  it('admits cleanly when analyze covers EVERY failing gate', async () => {
    const verdict = failVerdict({ gateIds: [3, 5] });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'cache',
        artifactPath: '.specify/specs/cache/tasks.md',
        evaluateDor: makeStub(verdict),
        readAnalyzeMetadata: () => ({ coveredGates: [3, 5] }),
      },
    );
    expect(out.outcome.kind).toBe('admitted');
    if (out.outcome.kind !== 'admitted') return;
    expect(out.outcome.autoResolvedDecisionIds).toHaveLength(2);
  });

  it('reads .specify/analyze.json from workDir when no override provided', async () => {
    // AC#4 baseline: when no analyze.json on disk, defaults to full DoR.
    // Here we write one and ensure it is honoured.
    const analyzePath = join(workDir, '.specify', 'analyze.json');
    mkdirSync(join(workDir, '.specify'), { recursive: true });
    writeFileSync(analyzePath, JSON.stringify({ coveredGates: [3] }), 'utf8');

    const verdict = failVerdict({ gateIds: [3] });
    const out = await runDorAtImport(
      { entry, renderTaskMarkdown: (id) => `---\nid: ${id}\n---\nbody` },
      {
        workDir,
        strictness: 'strict',
        featureId: 'cache',
        artifactPath: '.specify/specs/cache/tasks.md',
        evaluateDor: makeStub(verdict),
      },
    );
    expect(out.outcome.kind).toBe('admitted');
  });
});

// ── importSpec end-to-end Phase 5 wiring ─────────────────────────────────────

describe('importSpec — Phase 5 end-to-end (DoR + refuse-strict + analyze)', () => {
  it('refuses tasks that fail DoR in strict mode and writes clarification tasks', async () => {
    const featDir = join(specRoot, 'pay-feature');
    writeTasksMd(
      featDir,
      ['## Tasks', '', '### T-001 — Add payments', 'AC: charges card'].join('\n'),
    );

    const result = await importSpec({
      from: featDir,
      workDir,
      importedAt: '2026-05-24T00:00:00.000Z',
      strictness: 'strict',
      evaluateDor: makeStub(failVerdict({ gateIds: [3], findings: ['No spec ref'] })),
    });
    expect(result.outcome.kind).toBe('imported');
    if (result.outcome.kind !== 'imported') return;
    // AC#5: failed DoR → no placeholder task is written.
    expect(result.outcome.writtenTasks).toHaveLength(0);
    expect(result.outcome.refusedTasks).toHaveLength(1);
    // Only the clarification task should be present in backlog/tasks/.
    const filesInTasks = readdirSync(join(workDir, 'backlog', 'tasks'));
    expect(filesInTasks).toHaveLength(1);
    expect(filesInTasks[0]).toMatch(/^impclarify-1/);
  });

  it('admits failing tasks with warnings under --rubric warn (AC#2)', async () => {
    const featDir = join(specRoot, 'metrics-feature');
    writeTasksMd(featDir, ['### T-001 — Add metrics', 'AC: emits gauge'].join('\n'));

    const result = await importSpec({
      from: featDir,
      workDir,
      importedAt: '2026-05-24T00:00:00.000Z',
      strictness: 'warn',
      evaluateDor: makeStub(failVerdict({ gateIds: [3] })),
    });
    if (result.outcome.kind !== 'imported') throw new Error('expected imported');
    expect(result.outcome.writtenTasks).toHaveLength(1);
    expect(result.outcome.refusedTasks).toHaveLength(0);
    const warned = result.outcome.perTaskDor.find(
      (p) => p.outcome.kind === 'admitted-with-warnings',
    );
    expect(warned).toBeDefined();
  });

  it('admits when analyze metadata covers every failing gate (AC#3)', async () => {
    const featDir = join(specRoot, 'cache-feature');
    writeTasksMd(featDir, ['### T-001 — Add cache', 'AC: ttl'].join('\n'));

    const result = await importSpec({
      from: featDir,
      workDir,
      importedAt: '2026-05-24T00:00:00.000Z',
      strictness: 'strict',
      evaluateDor: makeStub(failVerdict({ gateIds: [3] })),
      readAnalyzeMetadata: () => ({ coveredGates: [3] }),
    });
    if (result.outcome.kind !== 'imported') throw new Error('expected imported');
    expect(result.outcome.writtenTasks).toHaveLength(1);
    expect(result.outcome.refusedTasks).toHaveLength(0);
  });

  it('uses the adopter-authoring.yaml dorStrictness when no override (AC#1)', async () => {
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'adopter-authoring.yaml'),
      'import:\n  dorStrictness: warn\n',
      'utf8',
    );
    const featDir = join(specRoot, 'cfg-feature');
    writeTasksMd(featDir, ['### T-001 — Add thing', 'AC: ok'].join('\n'));

    const result = await importSpec({
      from: featDir,
      workDir,
      importedAt: '2026-05-24T00:00:00.000Z',
      evaluateDor: makeStub(failVerdict({ gateIds: [3] })),
    });
    if (result.outcome.kind !== 'imported') throw new Error('expected imported');
    // Config said warn — failure should admit-with-warnings, not refuse.
    expect(result.outcome.strictness).toBe('warn');
    expect(result.outcome.writtenTasks).toHaveLength(1);
    expect(result.outcome.refusedTasks).toHaveLength(0);
  });
});
