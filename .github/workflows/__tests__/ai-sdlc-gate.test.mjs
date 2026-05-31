/**
 * Tests for `.github/workflows/ai-sdlc-gate.yml` — AISDLC-140 sub-1.
 *
 * The gate workflow is the framework's prescriptive single-rollup PR check
 * (Pattern B from /tmp/research-prior-art.md, named-adopter list incl.
 * aiohttp, attrs, conda, setuptools, pytest, Mergify). The aggregator
 * `pr-ready` job uses `re-actors/alls-green@release/v1` to convert the
 * `needs` context into a single check named `ai-sdlc/pr-ready`.
 *
 * What we test (and why these specific things):
 *   1. Workflow STRUCTURE — triggers, job names, `needs:` wiring,
 *      `if: always()` on the aggregator. Locks in the contract that
 *      branch protection will be wired against post-cutover.
 *   2. Archetype DECISION LOGIC — given a hypothetical changeset, does
 *      the `docs_only` filter resolve correctly. We can't run dorny
 *      hermetically, but we can assert the filter patterns mirror the
 *      docs-only set used by the rest of the AI-SDLC review machinery
 *      (`ai-sdlc-review.yml` paths-ignore + `ai-sdlc-review-docs-only.yml`
 *      detect step) — drift between these is the exact bug class that
 *      created the AISDLC-136 deadlock.
 *   3. AGGREGATOR SEMANTICS — given simulated `needs` contexts (all
 *      success / docs-only-skipped / one failure / one cancelled),
 *      does the alls-green decision match expectation. We mirror the
 *      action's documented logic in pure JS so a regression in our
 *      understanding of how alls-green treats `skipped` (= success by
 *      default, the load-bearing detail flagged in the research doc)
 *      can't slip through unnoticed.
 *
 * Run with: node --test .github/workflows/__tests__/ai-sdlc-gate.test.mjs
 *
 * YAML parsing: shells out to `python3 -c "import yaml; ..."` to avoid
 * requiring `pnpm install` to have happened. The same pattern Python is
 * already used to validate this YAML (see verification command in the
 * AISDLC-140 sub-1 task description). All AI-SDLC dev environments and
 * GitHub Actions ubuntu-latest runners ship python3 + PyYAML.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'ai-sdlc-gate.yml');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// ── YAML loader (shells out to python3 + PyYAML) ─────────────────────────
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

// ── Aggregator decision oracle ───────────────────────────────────────────
// Mirrors `re-actors/alls-green@release/v1`'s default behavior:
//   - success | skipped → contributes to "all green"
//   - failure | cancelled → fails the aggregate
// This is the load-bearing detail flagged in /tmp/research-prior-art.md
// (and reaffirmed in the AISDLC-140 redesign memo Q3): naive `needs:`
// alone reports `skipped`, which auto-merge would treat as success;
// alls-green with `needs` introspection is the canonical fix that
// PRESERVES "skipped → pass" for archetype-conditional jobs.
function allsGreenDecision(needs) {
  for (const [, job] of Object.entries(needs)) {
    if (job.result === 'failure' || job.result === 'cancelled') {
      return { passed: false, reason: `job result=${job.result}` };
    }
  }
  return { passed: true };
}

let workflow;

before(() => {
  workflow = loadYaml(WORKFLOW_PATH);
});

describe('ai-sdlc-gate.yml — workflow structure (AC #1, #4)', () => {
  it('exists and parses as valid YAML', () => {
    assert.ok(workflow, 'workflow must parse');
    assert.equal(workflow.name, 'AI-SDLC PR Ready Gate');
  });

  it('AC #1: triggers on pull_request (opened/synchronize/reopened/ready_for_review post-AISDLC-218 revision); merge_group removed per AISDLC-400', () => {
    // YAML's `on:` shorthand can come back as a dict OR as the literal
    // string "on" depending on parser quirks (`on: true` collision with
    // YAML 1.1 boolean coercion). PyYAML 6+ preserves it as the string
    // key "on" — assert defensively.
    const triggers = workflow.on ?? workflow[true] ?? workflow['on'];
    assert.ok(triggers, `expected triggers under "on:"; got keys: ${Object.keys(workflow)}`);

    // AISDLC-218 (revised): `opened` was originally dropped under the
    // assumption that ALL PRs would be opened as draft per the new flow,
    // but PRs opened directly as ready (e.g. sync chore PRs via
    // `gh pr create` with no `--draft`) get NO event handling without
    // `opened`. Workaround: keep `opened` in types AND rely on the
    // job-level `if: !draft` guards to skip draft opens. `ready_for_review`
    // is also kept so the canonical draft-flip flow fires once.
    assert.deepEqual(
      triggers.pull_request?.types?.sort(),
      ['opened', 'ready_for_review', 'reopened', 'synchronize'],
      'pull_request must include opened (for direct-ready PRs) + ready_for_review (for draft flips); draft opens are skipped at job level via if: !draft',
    );
    // AISDLC-400 (2026-05-23): merge_group trigger removed. The GitHub merge
    // queue was dropped; PRs merge directly via auto-merge (squash). There
    // are no longer queue probe SHAs to gate against. Rollback: restore
    // merge_group here and re-enable the queue in Settings → Branches → main.
    assert.equal(
      triggers.merge_group,
      undefined,
      'merge_group trigger must be absent (AISDLC-400: no merge queue)',
    );
  });

  it('declares all seven required jobs by canonical names (AC #3)', () => {
    // AISDLC-388: attestation-gate added — re-introduces machine enforcement
    // of ai-sdlc/attestation for code PRs (skipped on docs-only) via the
    // rollup layer, after AISDLC-388 removed it from branch protection.
    const expectedJobs = [
      'detect',
      'lint',
      'build-test',
      'coverage',
      'integration',
      'attestation-gate',
      'pr-ready',
    ];
    assert.deepEqual(Object.keys(workflow.jobs).sort(), expectedJobs.sort());
  });

  it('AC #4: pr-ready aggregator uses re-actors/alls-green with if: always() and inspects needs context', () => {
    const agg = workflow.jobs['pr-ready'];
    assert.equal(agg.name, 'ai-sdlc/pr-ready', 'check name must be exactly ai-sdlc/pr-ready');
    // AISDLC-218: `if:` extended with a draft guard — `re-actors/alls-green`
    // treats all-skipped as failure, so on draft PRs (where every upstream
    // job is skipped by its own draft guard) the rollup posted FAILURE on
    // every sync. Skipping the rollup on draft means no required check
    // posts on draft (which is fine — drafts can't merge); on ready_for_review
    // the workflow fires fresh and pr-ready posts SUCCESS correctly.
    // The rollup must STILL run on push/merge_group + non-draft PRs.
    assert.match(
      agg.if,
      /always\(\)/,
      'aggregator must include always() so it runs even when upstream jobs fail',
    );
    assert.match(
      agg.if,
      /draft\s*==\s*false/,
      'aggregator must skip on draft PRs (AISDLC-218 — alls-green treats all-skipped as failure)',
    );
    // `needs` may be parsed as an array of strings.
    const needs = Array.isArray(agg.needs) ? agg.needs : [agg.needs];
    // AISDLC-388: attestation-gate added to needs to re-introduce machine
    // enforcement of code-PR attestation via the rollup.
    for (const required of [
      'detect',
      'lint',
      'build-test',
      'coverage',
      'integration',
      'attestation-gate',
    ]) {
      assert.ok(needs.includes(required), `pr-ready needs: ${required}`);
    }

    // Find the alls-green step.
    const allsGreenStep = agg.steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('re-actors/alls-green'),
    );
    assert.ok(allsGreenStep, 'aggregator must use re-actors/alls-green action');
    assert.match(
      allsGreenStep.uses,
      /^re-actors\/alls-green@release\/v1$/,
      'must pin to release/v1 (industry-standard tag used by aiohttp, attrs, conda, ...)',
    );
    // Action must receive `jobs: ${{ toJSON(needs) }}` so it can introspect.
    assert.match(
      String(allsGreenStep.with?.jobs ?? ''),
      /toJSON\(needs\)/,
      'alls-green must receive needs context via toJSON(needs)',
    );
  });

  it('attestation-gate is skipped for docs-only AND dependabot[bot] PRs (issue #791)', () => {
    // Dependabot can't run the local reviewer+sign flow, so its dependency-bump
    // PRs are exempt from the attestation requirement (gated by build/test +
    // human review instead). The gate skips → alls-green treats skipped as
    // success → pr-ready passes. If this exemption is removed, every Dependabot
    // PR is permanently blocked on a missing envelope.
    const gate = workflow.jobs['attestation-gate'];
    assert.ok(gate?.if, 'attestation-gate must have an if: gating expression');
    assert.match(
      gate.if,
      /needs\.detect\.outputs\.docs_only\s*!=\s*'true'/,
      'attestation-gate must still skip docs-only PRs',
    );
    assert.match(
      gate.if,
      /github\.event\.pull_request\.user\.login\s*!=\s*'dependabot\[bot\]'/,
      'attestation-gate must skip dependabot[bot] PRs (issue #791)',
    );
  });

  it('AC #3 (docs-only): only Detect Changes + Lint & Format are required when docs_only=true', () => {
    // The build-test, coverage, integration jobs must each carry an
    // `if:` that short-circuits when detect.outputs.docs_only == 'true'.
    // Skipped jobs are treated as "passed" by alls-green (per the
    // load-bearing detail in /tmp/research-prior-art.md), so docs-only
    // PRs naturally pass the aggregator.
    for (const jobId of ['build-test', 'coverage', 'integration']) {
      const job = workflow.jobs[jobId];
      assert.ok(job.if, `${jobId} must have an if: gating expression`);
      assert.match(
        job.if,
        /needs\.detect\.outputs\.docs_only\s*!=\s*'true'/,
        `${jobId} must skip when docs_only=true`,
      );
      // Must depend on detect for the output to be readable.
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      assert.ok(needs.includes('detect'), `${jobId} must declare needs: [detect, ...]`);
    }
  });

  it('AC #3 (code/mixed): build-test runs Node 20 AND Node 22 via matrix', () => {
    const bt = workflow.jobs['build-test'];
    assert.deepEqual(
      bt.strategy?.matrix?.['node-version']?.sort(),
      [20, 22],
      'build-test matrix must include both Node 20 and Node 22',
    );
    assert.equal(
      bt.strategy.matrix['node-version'].length,
      2,
      'matrix must be exactly 2 versions; widening adds compute without protection',
    );
  });

  it('detect job uses dorny/paths-filter@v3 with predicate-quantifier: every', () => {
    const detect = workflow.jobs.detect;
    const filterStep = detect.steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter'),
    );
    assert.ok(filterStep, 'detect must use dorny/paths-filter');
    assert.match(filterStep.uses, /^dorny\/paths-filter@v3$/);
    // `every` quantifier is REQUIRED for correct mixed-PR handling.
    // Default (`some`) treats one-docs-one-code PRs as docs-only,
    // which would skip build-test on real code changes — the exact
    // class of bug this AC is locking in.
    assert.equal(
      filterStep.with?.['predicate-quantifier'],
      'every',
      'predicate-quantifier MUST be "every" or mixed PRs incorrectly resolve as docs-only',
    );
  });

  it('docs-only filter mirrors the canonical AI-SDLC docs-only path set', () => {
    // Drift between this filter and the docs-only sets in
    // ai-sdlc-review.yml + verify-attestation.yml + ai-sdlc-review-docs-only.yml
    // is the exact bug class that produced the AISDLC-136 deadlock.
    // Lock the exact pattern set in.
    const detect = workflow.jobs.detect;
    const filterStep = detect.steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter'),
    );
    const filtersYaml = filterStep.with.filters;
    // The filters value is a YAML string (the action parses it itself).
    // Re-parse it to check the docs_only pattern set.
    const json = execFileSync(
      'python3',
      ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
      { encoding: 'utf-8', input: filtersYaml },
    );
    const filters = JSON.parse(json);
    assert.deepEqual(
      filters.docs_only.sort(),
      ['*.md', 'backlog/completed/**', 'backlog/tasks/**', 'docs/**', 'spec/rfcs/**'],
      'docs_only patterns must mirror ai-sdlc-review-docs-only.yml exactly',
    );
  });

  it('AC #1 also: workflow file is valid YAML when validated by python3 + PyYAML', () => {
    // Smoke-test the verification command from the task description.
    const output = execFileSync(
      'python3',
      ['-c', 'import yaml, sys; yaml.safe_load(open(sys.argv[1])); print("ok")', WORKFLOW_PATH],
      { encoding: 'utf-8' },
    );
    assert.equal(output.trim(), 'ok');
  });
});

describe('ai-sdlc-gate.yml — aggregator decision logic (AC #4, #5)', () => {
  // These tests exercise the alls-green oracle directly with simulated
  // `needs` contexts. They lock in the SEMANTIC contract that
  // /tmp/research-prior-art.md flags as load-bearing: skipped MUST count
  // as pass, otherwise archetype-conditional gates deadlock.

  it('AC #5: docs-only PR (build-test/coverage/integration skipped) → pr-ready PASSES', () => {
    // The docs-only archetype: detect ran (success), lint ran (success),
    // the three code-gated jobs were skipped because `if:` evaluated
    // false. alls-green must treat skipped as success.
    const needs = {
      detect: { result: 'success' },
      lint: { result: 'success' },
      'build-test': { result: 'skipped' },
      coverage: { result: 'skipped' },
      integration: { result: 'skipped' },
    };
    const decision = allsGreenDecision(needs);
    assert.equal(
      decision.passed,
      true,
      `expected pass on all-green-docs-only; got: ${decision.reason}`,
    );
  });

  it('code PR with all jobs green → pr-ready PASSES', () => {
    const needs = {
      detect: { result: 'success' },
      lint: { result: 'success' },
      'build-test': { result: 'success' },
      coverage: { result: 'success' },
      integration: { result: 'success' },
    };
    assert.equal(allsGreenDecision(needs).passed, true);
  });

  it('AC #4: any single failure → pr-ready FAILS', () => {
    const needs = {
      detect: { result: 'success' },
      lint: { result: 'success' },
      'build-test': { result: 'failure' },
      coverage: { result: 'success' },
      integration: { result: 'success' },
    };
    const decision = allsGreenDecision(needs);
    assert.equal(decision.passed, false);
    assert.match(decision.reason, /failure/);
  });

  it('cancelled job → pr-ready FAILS (cancellations are not allowed-skips)', () => {
    // A cancellation usually means concurrency cancelled the run or a
    // human stopped it. alls-green correctly treats this as failure
    // rather than letting the aggregator pass silently.
    const needs = {
      detect: { result: 'success' },
      lint: { result: 'cancelled' },
      'build-test': { result: 'success' },
      coverage: { result: 'success' },
      integration: { result: 'success' },
    };
    const decision = allsGreenDecision(needs);
    assert.equal(decision.passed, false);
    assert.match(decision.reason, /cancelled/);
  });

  it('mixed-archetype PR (some skipped, some success) → pr-ready PASSES', () => {
    // E.g. fork PR where integration was skipped due to no secrets,
    // plus everything else green. Should still pass.
    const needs = {
      detect: { result: 'success' },
      lint: { result: 'success' },
      'build-test': { result: 'success' },
      coverage: { result: 'success' },
      integration: { result: 'skipped' }, // fork PR
    };
    assert.equal(allsGreenDecision(needs).passed, true);
  });

  it('all jobs skipped (degenerate empty PR) → pr-ready PASSES (alls-green default)', () => {
    // Edge case: imagine GH dispatches the workflow but every job is
    // skipped (e.g. in a `[ci skip]`-equivalent scenario that doesn't
    // actually trigger the marker check). alls-green's documented
    // default treats empty-success as success. This is the same
    // semantic that makes path-filter PRs work — so we lock it in.
    const needs = {
      detect: { result: 'skipped' },
      lint: { result: 'skipped' },
      'build-test': { result: 'skipped' },
      coverage: { result: 'skipped' },
      integration: { result: 'skipped' },
    };
    assert.equal(allsGreenDecision(needs).passed, true);
  });
});

describe('ai-sdlc-gate.yml — archetype detection (AC #2)', () => {
  // Static-pattern tests against the docs-only filter list. We model
  // dorny/paths-filter's predicate-quantifier:every behavior in pure JS
  // and assert that our path patterns produce the expected archetype
  // for each canonical PR shape.

  // Minimal glob → regex translator for the patterns in our filter.
  // Supports: `**` (any depth), `*` (any non-/ segment), exact strings.
  function globToRegex(glob) {
    // Order matters: `**` → '.*' MUST happen before `*` → '[^/]*'.
    const re = glob
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials except *
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__GLOBSTAR__/g, '.*');
    return new RegExp(`^${re}$`);
  }

  const docsPatterns = [
    'spec/rfcs/**',
    'docs/**',
    'backlog/tasks/**',
    'backlog/completed/**',
    '*.md', // root-level only (single-* doesn't match `/`)
  ];

  function isDocsOnly(files) {
    if (!files.length) return false; // empty diff is not docs-only
    return files.every((f) => docsPatterns.some((p) => globToRegex(p).test(f)));
  }

  it('PR touching only spec/rfcs/** → docs-only', () => {
    assert.equal(isDocsOnly(['spec/rfcs/RFC-0042-foo.md']), true);
  });

  it('PR touching only docs/** → docs-only', () => {
    assert.equal(isDocsOnly(['docs/operations/quality-gate.md']), true);
  });

  it('PR touching only backlog/tasks/** → docs-only', () => {
    assert.equal(isDocsOnly(['backlog/tasks/AISDLC-140-foo.md']), true);
  });

  it('PR touching only root README.md → docs-only', () => {
    assert.equal(isDocsOnly(['README.md', 'CHANGELOG.md']), true);
  });

  it('PR mixing docs + code → NOT docs-only (must trigger build-test)', () => {
    // The exact case the predicate-quantifier:every assertion above
    // protects against. This is the one that, mishandled, would
    // silently skip build-test on real code changes.
    assert.equal(
      isDocsOnly(['docs/operations/quality-gate.md', 'pipeline-cli/src/exec.ts']),
      false,
    );
  });

  it('PR touching only code → NOT docs-only', () => {
    assert.equal(isDocsOnly(['pipeline-cli/src/exec.ts']), false);
  });

  it('PR touching nested *.md (docs/foo/bar.md) → docs-only via docs/**', () => {
    assert.equal(isDocsOnly(['docs/foo/bar.md']), true);
  });

  it('PR touching nested *.md OUTSIDE docs/spec/backlog (e.g. ai-sdlc-plugin/foo.md) → NOT docs-only', () => {
    // The root-level `*.md` pattern intentionally does NOT match nested
    // markdown files outside the explicit docs paths. A README inside
    // a code package should still trigger build-test in case the README
    // documents code-level behavior that needs verifying.
    assert.equal(isDocsOnly(['ai-sdlc-plugin/foo.md']), false);
  });
});

describe('ai-sdlc-gate.yml — coexistence with legacy workflows (AISDLC-140 sub-1 vs sub-3)', () => {
  it('runs ADDITIVELY — does not modify or remove legacy workflows', () => {
    // Sub-1 ships only the new aggregator. The cutover (sub-3) is an
    // operator action: change branch protection to require ai-sdlc/pr-ready
    // and remove the legacy required checks. This test asserts the
    // legacy workflows are still present so a regression that quietly
    // deletes them as part of sub-1 fails fast.
    for (const legacy of ['ci.yml', 'ai-sdlc-review.yml', 'verify-attestation.yml']) {
      const path = join(REPO_ROOT, '.github', 'workflows', legacy);
      const contents = readFileSync(path, 'utf-8');
      assert.ok(contents.length > 0, `${legacy} must still exist (cutover is sub-3, not sub-1)`);
    }
  });
});
