/**
 * Corpus loader + runner. Walks the on-disk corpus at
 * `spec/dor-corpus/` (or any directory passed in) and evaluates every
 * fixture against the Stage A pipeline.
 *
 * RFC-0011 §5.6 + §12 Phase 2a: the corpus is the rubric's regression
 * suite. CI runs `runStageACorpus()` and asserts 100% match — any drift
 * fails the build.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { evaluateIssue, type EvaluateOpts } from './evaluate.js';
import type { GateId, IssueInput, OverallVerdict, StageAVerdict } from './types.js';

export interface FixtureExpectation {
  /** Expected overall verdict from Stage A only. */
  overallVerdict: OverallVerdict;
  /**
   * Optional list of gate IDs whose Stage A verdict MUST be 'fail'.
   * The corpus runner will assert each named gate failed AND that any
   * other gate that failed isn't a surprise (i.e. either listed here
   * OR the fixture explicitly marks `allowExtraFailures: true`).
   */
  failsGates?: GateId[];
  /**
   * Allow Stage A to fail additional gates beyond `failsGates`. Used
   * sparingly for edge-case fixtures that legitimately trip multiple
   * gates.
   */
  allowExtraFailures?: boolean;
  /** Optional fixture description (informational only). */
  description?: string;
}

export interface CorpusFixture {
  name: string;
  /** Path to the markdown body file relative to corpus root. */
  bodyPath: string;
  /** Path to the `.expected.json` sidecar relative to corpus root. */
  expectedPath: string;
  /** The category bucket (`ready`, `needs-clarification/gate-N-...`, `edge-cases`). */
  bucket: string;
  /** Loaded expectation. */
  expected: FixtureExpectation;
  /** Loaded body markdown. */
  body: string;
}

export interface CorpusReport {
  total: number;
  passed: number;
  failed: number;
  failures: Array<{
    fixture: string;
    reason: string;
    actualVerdict?: OverallVerdict;
    actualFailedGates?: GateId[];
  }>;
  /** Stage A latency summary across the corpus. */
  perfMs: { p50: number; p95: number; max: number };
}

/**
 * Walk `<corpusRoot>` and return every fixture (body + sidecar pair).
 * A fixture is identified by a `.md` file with a sibling
 * `.expected.json` (same basename minus extension).
 */
export function loadCorpus(corpusRoot: string): CorpusFixture[] {
  if (!existsSync(corpusRoot)) {
    throw new Error(`corpus root not found: ${corpusRoot}`);
  }
  const out: CorpusFixture[] = [];
  walk(corpusRoot, (path) => {
    if (!path.endsWith('.md')) return;
    const expectedPath = path.replace(/\.md$/, '.expected.json');
    if (!existsSync(expectedPath)) return;
    const body = readFileSync(path, 'utf8');
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as FixtureExpectation;
    const rel = relative(corpusRoot, path);
    const bucket = rel.split('/').slice(0, -1).join('/') || 'root';
    const name = basename(path, '.md');
    out.push({
      name,
      bodyPath: rel,
      expectedPath: relative(corpusRoot, expectedPath),
      bucket,
      expected,
      body,
    });
  });
  out.sort((a, b) => a.bodyPath.localeCompare(b.bodyPath));
  return out;
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

export interface RunCorpusOpts {
  /**
   * Per-fixture evaluator opts. Defaults to `{ hermetic: true }` because
   * the corpus is meant to be reproducible offline.
   */
  evaluatorOpts?: EvaluateOpts;
  /** Per-fixture optional input override (e.g. workDir). */
  inputOverride?: (fixture: CorpusFixture) => Partial<IssueInput>;
}

/**
 * Evaluate every fixture and compare against its expectation. Returns
 * a structured report. Used by the CI gate test.
 */
export async function runStageACorpus(
  corpusRoot: string,
  opts: RunCorpusOpts = {},
): Promise<CorpusReport> {
  const fixtures = loadCorpus(corpusRoot);
  const failures: CorpusReport['failures'] = [];
  const latencies: number[] = [];

  for (const fx of fixtures) {
    const input: IssueInput = {
      source: 'backlog',
      id: fx.name,
      title: fx.name.replace(/-/g, ' '),
      body: fx.body,
      ...(opts.inputOverride ? opts.inputOverride(fx) : {}),
    };
    let verdict: StageAVerdict;
    try {
      verdict = await evaluateIssue(input, opts.evaluatorOpts ?? { hermetic: true });
    } catch (err) {
      failures.push({
        fixture: fx.bodyPath,
        reason: `evaluator threw: ${(err as Error).message}`,
      });
      continue;
    }

    latencies.push(verdict.durationMs);
    const failureReasons = compareToExpectation(fx.expected, verdict);
    if (failureReasons.length > 0) {
      failures.push({
        fixture: fx.bodyPath,
        reason: failureReasons.join('; '),
        actualVerdict: verdict.overallVerdict,
        actualFailedGates: verdict.gates.filter((g) => g.verdict === 'fail').map((g) => g.gateId),
      });
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const perfMs = {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  };

  return {
    total: fixtures.length,
    passed: fixtures.length - failures.length,
    failed: failures.length,
    failures,
    perfMs,
  };
}

function compareToExpectation(expected: FixtureExpectation, actual: StageAVerdict): string[] {
  const reasons: string[] = [];
  if (actual.overallVerdict !== expected.overallVerdict) {
    reasons.push(
      `overallVerdict mismatch: expected '${expected.overallVerdict}', got '${actual.overallVerdict}'`,
    );
  }
  const failedGates = actual.gates.filter((g) => g.verdict === 'fail').map((g) => g.gateId);
  const expectedFails = expected.failsGates ?? [];
  for (const id of expectedFails) {
    if (!failedGates.includes(id)) {
      reasons.push(`expected gate ${id} to fail, but it did not`);
    }
  }
  if (!expected.allowExtraFailures) {
    for (const id of failedGates) {
      if (!expectedFails.includes(id)) {
        reasons.push(`unexpected extra gate failure: gate ${id}`);
      }
    }
  }
  return reasons;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
