/**
 * End-to-end corpus harness — Phase 2b acceptance criteria #4 + #5.
 *
 * This file exercises the full Stage A + Stage B pipeline against
 * `spec/dor-corpus/` and asserts:
 *
 *   - Stage B match rate ≥ 90% (RFC §5.6 tier 2).
 *   - End-to-end verdict match rate ≥ 95% (RFC §5.6 tier 3).
 *
 * **Honest framing.** The agent does not actually call a real LLM in
 * tests. We use a `CalibratedMockSpawner` that returns hand-curated
 * per-fixture verdicts simulating what a calibrated LLM would emit.
 * The 90% / 95% thresholds therefore validate the orchestration +
 * merge logic, not real-LLM accuracy. Real-LLM calibration is the
 * Phase 7 soak per RFC §12.
 *
 * The Stage A 100% gate (`corpus.test.ts` → `runStageACorpus()`) is
 * unchanged and is still tier 1 per RFC §5.6 — this file is additive.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SubagentResult, SubagentSpawner, SpawnOpts } from '../types.js';
import { loadCorpus, type CorpusFixture } from './corpus.js';
import { effectiveE2E, runE2ECorpus, type FixtureExpectationWithE2E } from './corpus-e2e.js';
import { pickStageBGates, STAGE_B_OWNED_GATES } from './stage-b.js';
import { evaluateIssue } from './evaluate.js';
import type { GateId, IssueInput, StageAVerdict } from './types.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CORPUS_ROOT = join(REPO_ROOT, 'spec', 'dor-corpus');

// Same stub root logic as corpus.test.ts — file-existence resolver
// needs the project to look "real" for the ready/ + edge-cases/ refs.
let stubRoot: string;

beforeAll(() => {
  stubRoot = mkdtempSync(join(tmpdir(), 'dor-corpus-e2e-stub-'));
  for (const rel of [
    'pipeline-cli/src/index.ts',
    'pipeline-cli/src/index.test.ts',
    'pipeline-cli/src/cli/index.ts',
    'pipeline-cli/src/runtime/exec.ts',
    'pipeline-cli/src/dor/evaluate.ts',
    'pipeline-cli/src/dor/evaluate.test.ts',
    'pipeline-cli/src/dor/types.ts',
    'pipeline-cli/src/dor/corpus.ts',
    'pipeline-cli/src/dor/gates/gate-1-ac-testable.ts',
    'pipeline-cli/src/dor/gates/gate-2-no-markers.ts',
    'pipeline-cli/src/dor/resolvers/url-head.test.ts',
    'pipeline-cli/src/dor/resolvers/index.ts',
    'pipeline-cli/src/deps/dependency-graph.ts',
    'pipeline-cli/src/__test-helpers/fake-runner.ts',
    'pipeline-cli/bin/ai-sdlc-pipeline.mjs',
    'pipeline-cli/package.json',
    'pipeline-cli/src/steps/01-validate.ts',
    'pipeline-cli/src/steps/03-setup-worktree.test.ts',
    'orchestrator/src/admission.ts',
    'orchestrator/src/admission.test.ts',
    'orchestrator/src/admission-enrichment.ts',
    'orchestrator/src/admission-enrichment.test.ts',
    'orchestrator/src/admission-score.ts',
    'orchestrator/src/audit-archival.ts',
    'orchestrator/src/audit-extended.ts',
    'orchestrator/src/audit-sqlite-sink.ts',
    'orchestrator/package.json',
    'spec/schemas/refinement-verdict.v1.schema.json',
    'spec/schemas/dor-config.v1.schema.json',
    'spec/glossary.md',
    'spec/dor-corpus/README.md',
    'README.md',
    'CHANGELOG.md',
    'codecov.yml',
    'eslint.config.mjs',
    '.prettierrc.json',
    '.github/CODEOWNERS',
    'package.json',
    'pnpm-lock.yaml',
    'release-please-config.json',
    'ai-sdlc-plugin/mcp-server/package.json',
    'dashboard/index.html',
    'conformance/runner/index.ts',
    'scripts/check-publishable-package-configs.mjs',
    '.ai-sdlc/dor-config.yaml',
  ]) {
    const full = join(stubRoot, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '// stub for DoR corpus runner');
  }
  mkdirSync(join(stubRoot, 'spec', 'rfcs'), { recursive: true });
  for (const rfc of ['RFC-0008-ppa-triad-integration.md', 'RFC-0011-definition-of-ready-gate.md']) {
    writeFileSync(join(stubRoot, 'spec', 'rfcs', rfc), '# stub');
  }
  mkdirSync(join(stubRoot, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(stubRoot, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(stubRoot, 'backlog', 'completed', 'aisdlc-115.1 - stub.md'), 'stub');
});

afterAll(() => {
  if (stubRoot) {
    try {
      rmSync(stubRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/**
 * CalibratedMockSpawner — returns Stage B verdicts derived from the
 * fixture's `bucket` (i.e. the directory it lives in) so we simulate
 * a "calibrated LLM" perfectly scoring its own corpus. Real-LLM
 * accuracy is out of scope; this proves the orchestration + merge logic
 * is correct given a calibrated upstream.
 *
 * Per the bucket name convention:
 *   - `needs-clarification/gate-N-...` → fail gate N at Stage B
 *   - `ready/`                         → all Stage B gates pass
 *   - `edge-cases/`                    → all Stage B gates pass
 *                                         (multi-gate failure already caught
 *                                         by Stage A)
 */
function calibratedSpawnerFor(
  fixture: CorpusFixture & { expected: FixtureExpectationWithE2E },
): SubagentSpawner {
  const bucket = fixture.bucket;
  // Extract the gate ID for needs-clarification/gate-N-... buckets.
  const match = bucket.match(/^needs-clarification\/gate-(\d+)-/);
  const failGateFromBucket: GateId | null = match ? (Number(match[1]) as GateId) : null;
  const groundTruthMap = fixture.expected.e2e?.stageB ?? {};

  return {
    async spawn(opts: SpawnOpts): Promise<SubagentResult> {
      const requestedGates = extractRequestedGates(opts.prompt);
      const gates = requestedGates.map((id) => {
        // 1. Per-fixture stageB ground truth (when provided) is authoritative
        const truth = groundTruthMap[String(id) as `${GateId}`];
        if (truth) {
          return {
            gateId: id,
            verdict: truth,
            confidence: 'high' as const,
            finding: `Ground-truth Stage B verdict for gate ${id}: ${truth}`,
            ...(truth === 'fail'
              ? { clarificationQuestion: `Address gate ${id} (calibrated mock).` }
              : {}),
          };
        }
        // 2. Bucket-derived: gate-N bucket fails gate N, everything else passes
        if (failGateFromBucket === id) {
          return {
            gateId: id,
            verdict: 'fail' as const,
            confidence: 'high' as const,
            finding: `Bucket ${bucket} simulates a Stage B fail for gate ${id}`,
            clarificationQuestion: `Address gate ${id} (calibrated mock).`,
          };
        }
        // 3. Default: pass
        return {
          gateId: id,
          verdict: 'pass' as const,
          confidence: 'high' as const,
          finding: `Calibrated mock pass for gate ${id}`,
        };
      });
      return {
        type: 'refinement-reviewer',
        output: JSON.stringify({ gates, summary: `Calibrated mock for ${fixture.name}` }),
        status: 'success',
        durationMs: 1,
      };
    },
    async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
      return Promise.all(opts.map((o) => this.spawn(o)));
    },
  };
}

/**
 * Sniff the gate IDs the prompt asked about. The prompt template
 * embeds `### Gate <N>` headers per gate; this is the contract we
 * check the mock against.
 */
function extractRequestedGates(prompt: string): GateId[] {
  const out: GateId[] = [];
  const re = /^###\s+Gate\s+(\d)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const id = Number(m[1]);
    if (id >= 1 && id <= 7) out.push(id as GateId);
  }
  return out;
}

describe('DoR corpus — Stage A + Stage B end-to-end harness', () => {
  it('runs without throwing against the full corpus', async () => {
    const report = await runE2ECorpus(CORPUS_ROOT, {
      stageBOptsFor: (fx) => ({
        spawner: calibratedSpawnerFor(
          fx as CorpusFixture & { expected: FixtureExpectationWithE2E },
        ),
      }),
      inputOverride: () => ({ workDir: stubRoot }),
    });
    expect(report.total).toBeGreaterThan(0);
  });

  it('Stage B match rate ≥ 90% (RFC §5.6 tier 2)', async () => {
    const report = await runE2ECorpus(CORPUS_ROOT, {
      stageBOptsFor: (fx) => ({
        spawner: calibratedSpawnerFor(
          fx as CorpusFixture & { expected: FixtureExpectationWithE2E },
        ),
      }),
      inputOverride: () => ({ workDir: stubRoot }),
    });
    // Only fixtures with a `stageB` ground-truth block contribute checks.
    // Currently those are gate-4-* + gate-6-* (10 fixtures × 1 check each).
    expect(report.stageBChecks).toBeGreaterThanOrEqual(10);
    expect(report.stageBMatchRate).toBeGreaterThanOrEqual(0.9);
  });

  it('end-to-end verdict match rate ≥ 95% (RFC §5.6 tier 3)', async () => {
    const report = await runE2ECorpus(CORPUS_ROOT, {
      stageBOptsFor: (fx) => ({
        spawner: calibratedSpawnerFor(
          fx as CorpusFixture & { expected: FixtureExpectationWithE2E },
        ),
      }),
      inputOverride: () => ({ workDir: stubRoot }),
    });
    if (report.e2eMatchRate < 0.95) {
      const sample = report.results
        .filter((r) => !r.e2eMatch)
        .slice(0, 10)
        .map((r) => `  - ${r.fixture}: ${r.reason ?? '(no reason)'}`)
        .join('\n');
      throw new Error(
        `E2E match rate ${(report.e2eMatchRate * 100).toFixed(1)}% < 95%. First mismatches:\n${sample}`,
      );
    }
    expect(report.e2eMatchRate).toBeGreaterThanOrEqual(0.95);
  });
});

describe('effectiveE2E', () => {
  it('returns the explicit e2e block when present', () => {
    const expectation: FixtureExpectationWithE2E = {
      overallVerdict: 'admit',
      e2e: {
        overallVerdict: 'needs-clarification',
        failsGates: [4],
        stageB: { '4': 'fail' },
      },
    };
    const e = effectiveE2E(expectation);
    expect(e.overallVerdict).toBe('needs-clarification');
    expect(e.failsGates).toEqual([4]);
    expect(e.stageB?.['4']).toBe('fail');
  });

  it('inherits Stage A expectation when no e2e block', () => {
    const expectation: FixtureExpectationWithE2E = {
      overallVerdict: 'needs-clarification',
      failsGates: [1, 2],
      allowExtraFailures: true,
    };
    const e = effectiveE2E(expectation);
    expect(e.overallVerdict).toBe('needs-clarification');
    expect(e.failsGates).toEqual([1, 2]);
    expect(e.allowExtraFailures).toBe(true);
  });
});

describe('Stage B gate selection (sanity)', () => {
  it('the Stage A pipeline produces skip verdicts for gates 4 + 6 on every fixture', async () => {
    const fixtures = loadCorpus(CORPUS_ROOT);
    for (const fx of fixtures) {
      const input: IssueInput = {
        source: 'backlog',
        id: fx.name,
        title: fx.name,
        body: fx.body,
        workDir: stubRoot,
      };
      const sa: StageAVerdict = await evaluateIssue(input, { hermetic: true });
      // Gate 4 and 6 always 'skip' from Stage A — Stage B owns them.
      for (const owned of STAGE_B_OWNED_GATES) {
        const gate = sa.gates.find((g) => g.gateId === owned);
        expect(gate?.verdict).toBe('skip');
      }
      // pickStageBGates always includes 4 + 6
      const ids = pickStageBGates(sa);
      for (const owned of STAGE_B_OWNED_GATES) {
        expect(ids).toContain(owned);
      }
    }
  });
});
