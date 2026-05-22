/**
 * RFC-0035 Phase 4 — Integration test (AC#5).
 *
 * AC#5: DoR clarification round produces a queryable Decision via
 * `cli-decisions list`.
 *
 * This test exercises the full path end-to-end:
 *   1. Run RFC-0011 Stage A on a vague issue (produces a needs-clarification
 *      verdict with clarification questions).
 *   2. Call `emitDorDecisions()` (the DoR bridge) to write Decision records.
 *   3. Query via `listDecisions()` and `buildDecisionsCli()` to verify the
 *      Decisions appear correctly in the catalog.
 *   4. Resolve one Decision via `resolveDorDecision()` and verify lifecycle
 *      → answered via the CLI `show` command.
 *
 * The evaluator runs Stage A only (no Stage B spawner) so the test stays
 * hermetic and fast without any LLM calls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateIssue } from '../dor/evaluate.js';
import { stripDurationMs } from '../dor/composite.js';
import type { IssueInput, RefinementVerdict } from '../dor/types.js';

import { emitDorDecisions, resolveDorDecision } from './dor-bridge.js';
import { listDecisions } from './projection.js';
import { buildDecisionsCli } from '../cli/decisions.js';
import { DECISION_CATALOG_FLAG } from './feature-flag.js';

// ── Test infrastructure ───────────────────────────────────────────────────────

const FLAG_ON = { [DECISION_CATALOG_FLAG]: 'experimental' } as NodeJS.ProcessEnv;

/**
 * A deliberately vague issue that will fail multiple DoR gates and produce questions.
 * `workDir` is an IssueInput field (not EvaluateOpts) used by the file-existence
 * resolver — pass it here so Gate 3 resolves refs against the per-test tmpdir.
 */
function makeVagueIssue(workDir: string): IssueInput {
  return {
    source: 'backlog',
    id: 'AISDLC-TEST-001',
    title: 'Make it faster',
    body: 'The system should be faster. Please fix this.',
    workDir,
    // No acceptance criteria → Gate 1 fails
    // No surface named → Gate 5 fails
  };
}

let workDir: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedEnvFlag: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dor-int-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  savedEnvFlag = process.env[DECISION_CATALOG_FLAG];

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

  process.env[DECISION_CATALOG_FLAG] = 'experimental';
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;

  if (savedEnvFlag === undefined) delete process.env[DECISION_CATALOG_FLAG];
  else process.env[DECISION_CATALOG_FLAG] = savedEnvFlag;

  rmSync(workDir, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-decisions', '--work-dir', workDir, ...args];
}

function stdoutJson<T = unknown>(): T {
  const text = stdoutChunks.join('');
  const trimmed = text.trim();
  const idx = trimmed.search(/[{[]/);
  if (idx < 0) throw new Error(`no JSON found in stdout: ${text}`);
  return JSON.parse(trimmed.slice(idx)) as T;
}

// ── AC#5 — Integration test ───────────────────────────────────────────────────

describe('AC#5 — DoR clarification round → queryable Decisions via cli-decisions list', () => {
  it('Stage A eval on a vague issue produces a needs-clarification verdict with questions', async () => {
    const stageA = await evaluateIssue(makeVagueIssue(workDir), {
      hermetic: true, // skip network calls
    });
    const verdict = stripDurationMs(stageA);

    expect(verdict.overallVerdict).toBe('needs-clarification');
    // Stage A (deterministic) produces questions from blocking gates.
    // The vague issue reliably fails Gate 1 (no AC) and Gate 5 (no surface).
    expect(verdict.questions?.length ?? 0).toBeGreaterThan(0);
  });

  it('emitting DoR decisions writes queryable records to the catalog', async () => {
    // Step 1: Evaluate the vague issue with DoR Stage A.
    const stageA = await evaluateIssue(makeVagueIssue(workDir), { hermetic: true });
    const verdict = stripDurationMs(stageA);
    expect(verdict.questions?.length ?? 0).toBeGreaterThan(0);

    // Step 2: Emit Decision records from the verdict.
    const bridgeResult = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    expect(bridgeResult.enabled).toBe(true);
    expect(bridgeResult.emitted).toBe(verdict.questions!.length);
    expect(bridgeResult.decisionIds).toHaveLength(verdict.questions!.length);

    // Step 3: Query via listDecisions — should find one record per question.
    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(verdict.questions!.length);
    for (const d of decisions) {
      expect(d.metadata.source).toBe('dor-clarification');
      expect(d.status.lifecycle).toBe('open');
      // Every decision summary should be one of the clarification questions.
      expect(verdict.questions!).toContain(d.spec.summary);
    }
  });

  it('decisions appear in cli-decisions list --format json output', async () => {
    const stageA = await evaluateIssue(makeVagueIssue(workDir), { hermetic: true });
    const verdict = stripDurationMs(stageA);
    emitDorDecisions(verdict, { workDir, env: FLAG_ON });

    // Query via the CLI.
    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();

    const result = stdoutJson<{
      ok: boolean;
      decisions: Array<{ metadata: { id: string; source: string } }>;
    }>();
    expect(result.ok).toBe(true);
    expect(result.decisions.length).toBe(verdict.questions!.length);
    for (const d of result.decisions) {
      expect(d.metadata.source).toBe('dor-clarification');
    }
  });

  it('resolving a DoR decision appears as answered via cli-decisions show', async () => {
    const stageA = await evaluateIssue(makeVagueIssue(workDir), { hermetic: true });
    const verdict = stripDurationMs(stageA);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });

    const decisionId = decisionIds[0]!;

    // Resolve the first decision.
    resolveDorDecision(decisionId, 'provide-answer', {
      workDir,
      env: FLAG_ON,
      by: 'operator@example.com',
    });

    // Query via the CLI show command.
    setArgv('show', decisionId, '--format', 'json');
    await buildDecisionsCli().parseAsync();

    const result = stdoutJson<{
      ok: boolean;
      decision: {
        status: { lifecycle: string; answeredOptionId: string; answeredBy: string };
      };
    }>();
    expect(result.ok).toBe(true);
    expect(result.decision.status.lifecycle).toBe('answered');
    expect(result.decision.status.answeredOptionId).toBe('provide-answer');
    expect(result.decision.status.answeredBy).toBe('operator@example.com');
  });

  it('decisions from multiple verdict calls accumulate in the catalog', async () => {
    // First verdict — issue #1.
    const verdict1: RefinementVerdict = {
      issueId: 'AISDLC-AAA',
      rubricVersion: 'v1',
      overallVerdict: 'needs-clarification',
      gates: [],
      signedAt: new Date().toISOString(),
      evaluatorVersion: 'test',
      questions: ['What is the scope of AISDLC-AAA?', 'Which shard does AISDLC-AAA target?'],
    };
    // Second verdict — issue #2.
    const verdict2: RefinementVerdict = {
      issueId: 'AISDLC-BBB',
      rubricVersion: 'v1',
      overallVerdict: 'needs-clarification',
      gates: [],
      signedAt: new Date().toISOString(),
      evaluatorVersion: 'test',
      questions: ['What is the done-state for AISDLC-BBB?'],
    };

    emitDorDecisions(verdict1, { workDir, env: FLAG_ON });
    emitDorDecisions(verdict2, { workDir, env: FLAG_ON });

    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();

    const result = stdoutJson<{ decisions: unknown[] }>();
    expect(result.decisions).toHaveLength(3); // 2 + 1
  });

  it('when feature flag is off, no decisions are emitted (degrade-open)', async () => {
    const stageA = await evaluateIssue(makeVagueIssue(workDir), { hermetic: true });
    const verdict = stripDurationMs(stageA);
    expect(verdict.questions?.length ?? 0).toBeGreaterThan(0);

    // Bridge with flag explicitly OFF (AISDLC-392: default is now ON; opt-out required).
    const bridgeResult = emitDorDecisions(verdict, {
      workDir,
      env: { AI_SDLC_DECISION_CATALOG: 'off' } as NodeJS.ProcessEnv,
    });
    expect(bridgeResult.enabled).toBe(false);
    expect(bridgeResult.emitted).toBe(0);

    // catalog is empty.
    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(0);
  });
});
