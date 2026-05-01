/**
 * CI gate — RFC-0011 §12 Phase 2a acceptance criteria #4.
 *
 * Walks `spec/dor-corpus/` and asserts:
 *   1. EVERY fixture's Stage A overallVerdict matches its expectation.
 *   2. Every gate the fixture says MUST fail does fail (and no extras unless
 *      the fixture sets `allowExtraFailures: true`).
 *   3. Stage A perf budget (RFC §12 Phase 2a) — p95 < 100ms per fixture.
 *
 * Any drift fails the build. Adding/removing fixtures requires updating
 * the corresponding `.expected.json` sidecar.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runStageACorpus, loadCorpus } from './corpus.js';

// Project root — pipeline-cli sits two levels under it (`<root>/pipeline-cli/`).
const REPO_ROOT = resolve(__dirname, '../../..');
const CORPUS_ROOT = join(REPO_ROOT, 'spec', 'dor-corpus');

/**
 * The corpus runs hermetically — only the file-existence resolver is
 * active. We point that resolver at a synthetic project root that
 * contains every file path / RFC ID / AISDLC ID our `ready/` and
 * `edge-cases/` fixtures legitimately reference. That way the corpus
 * doesn't tie its admit/deny decisions to whatever happens to exist
 * in the actual repo at test time.
 */
let stubRoot: string;

beforeAll(() => {
  stubRoot = mkdtempSync(join(tmpdir(), 'dor-corpus-stub-'));
  // Files referenced by `ready/` + `edge-cases/` fixtures.
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
  // RFC files referenced by `ready/` + `edge-cases/` fixtures.
  mkdirSync(join(stubRoot, 'spec', 'rfcs'), { recursive: true });
  for (const rfc of ['RFC-0008-ppa-triad-integration.md', 'RFC-0011-definition-of-ready-gate.md']) {
    writeFileSync(join(stubRoot, 'spec', 'rfcs', rfc), '# stub');
  }
  // Backlog AISDLC-115.1 referenced by edge-case fixture.
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

describe('DoR corpus — Stage A regression gate', () => {
  it('loads at least 75 fixtures (RFC §5.6: 30 ready + 35 needs + 10 edge)', () => {
    const fixtures = loadCorpus(CORPUS_ROOT);
    // We allow ≥ 75 so future additions don't require touching this assertion.
    expect(fixtures.length).toBeGreaterThanOrEqual(75);
  });

  it('every bucket has the expected fixture count', () => {
    const fixtures = loadCorpus(CORPUS_ROOT);
    const counts: Record<string, number> = {};
    for (const f of fixtures) counts[f.bucket] = (counts[f.bucket] ?? 0) + 1;
    expect(counts['ready']).toBeGreaterThanOrEqual(30);
    expect(counts['edge-cases']).toBeGreaterThanOrEqual(10);
    for (const gate of [
      'gate-1-untestable-ac',
      'gate-2-markers',
      'gate-3-broken-references',
      'gate-4-unbounded-scope',
      'gate-5-no-surface',
      'gate-6-no-done-state',
      'gate-7-invisible-deps',
    ]) {
      expect(counts[`needs-clarification/${gate}`]).toBeGreaterThanOrEqual(5);
    }
  });

  it('Stage A produces the expected verdict for 100% of fixtures', async () => {
    const report = await runStageACorpus(CORPUS_ROOT, {
      evaluatorOpts: { hermetic: true },
      inputOverride: () => ({ workDir: stubRoot }),
    });
    if (report.failures.length > 0) {
      // Surface the first 10 failures with diagnostic detail so a CI fail
      // points reviewers at the offending fixtures.
      const sample = report.failures
        .slice(0, 10)
        .map(
          (f) =>
            `  - ${f.fixture}: ${f.reason} (verdict=${f.actualVerdict ?? 'n/a'}, fails=[${f.actualFailedGates?.join(',') ?? ''}])`,
        )
        .join('\n');
      throw new Error(
        `${report.failed}/${report.total} corpus fixtures failed Stage A regression. First failures:\n${sample}`,
      );
    }
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
  });

  it('Stage A perf p95 < 100ms per fixture (RFC §12 Phase 2a budget)', async () => {
    const report = await runStageACorpus(CORPUS_ROOT, {
      evaluatorOpts: { hermetic: true },
      inputOverride: () => ({ workDir: stubRoot }),
    });
    expect(report.perfMs.p95).toBeLessThan(100);
  });
});
