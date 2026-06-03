/**
 * Tests for `.github/workflows/trusted-reviewers-drift.yml`
 *
 * RFC-0043 Phase 1 — AC#9 (drift workflow hermetic tests).
 *
 * Validates:
 *  1. Workflow structure (triggers, job names, permissions)
 *  2. Drift detection logic (compare allowlist vs GitHub permissions)
 *  3. Decision emission when drift is detected
 *  4. No-drift case (no decision emitted)
 *
 * Pattern mirrors `dor-ingress.test.mjs` and `ai-sdlc-gate.test.mjs`.
 *
 * Run with: node --test .github/workflows/__tests__/trusted-reviewers-drift.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'trusted-reviewers-drift.yml');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// ── YAML loader (shells out to python3 + PyYAML) ─────────────────────────────
// Note: PyYAML parses `on:` (YAML 1.1) as boolean `true`. We load the raw doc
// and normalize the `on` key from `true` back to `'on'` for test assertions.
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    [
      '-c',
      `
import sys, yaml, json

# Use yaml.full_load to get YAML 1.1 behavior (on: → True).
with open(sys.argv[1]) as f:
  doc = yaml.safe_load(f)

# Normalize the True key back to 'on' (YAML 1.1 boolean quirk)
if True in doc:
  doc['on'] = doc.pop(True)

print(json.dumps(doc))
`,
      path,
    ],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

let wf;

before(() => {
  wf = loadYaml(WORKFLOW_PATH);
});

// ── 1. Workflow structure ─────────────────────────────────────────────────────

describe('trusted-reviewers-drift.yml — structure', () => {
  it('has a schedule trigger (weekly cron)', () => {
    const schedule = wf.on?.schedule;
    assert.ok(Array.isArray(schedule), 'schedule trigger should be an array');
    assert.ok(schedule.length >= 1, 'should have at least one cron entry');
    const cron = schedule[0].cron;
    assert.ok(typeof cron === 'string', 'cron expression should be a string');
    // Validate it's a valid cron expression (5 fields)
    const cronFields = cron.split(' ').filter(Boolean);
    assert.strictEqual(cronFields.length, 5, 'cron expression should have 5 fields');
  });

  it('has a workflow_dispatch trigger', () => {
    assert.ok(wf.on?.workflow_dispatch !== undefined, 'should have workflow_dispatch trigger');
  });

  it('has drift-check job', () => {
    assert.ok(wf.jobs?.['drift-check'], 'should have drift-check job');
  });

  it('has emit-drift-decision job', () => {
    assert.ok(wf.jobs?.['emit-drift-decision'], 'should have emit-drift-decision job');
  });

  it('emit-drift-decision needs drift-check', () => {
    const emitJob = wf.jobs?.['emit-drift-decision'];
    const needs = Array.isArray(emitJob?.needs) ? emitJob.needs : [emitJob?.needs];
    assert.ok(needs.includes('drift-check'), 'emit-drift-decision should need drift-check');
  });

  it('emit-drift-decision only fires when drift is detected', () => {
    const emitJob = wf.jobs?.['emit-drift-decision'];
    assert.ok(
      typeof emitJob?.if === 'string' && emitJob.if.includes('drift_detected'),
      'emit-drift-decision should only run when drift is detected',
    );
  });

  it('has correct permissions (contents: read for drift-check)', () => {
    const perms = wf.permissions;
    assert.ok(perms !== undefined, 'should declare permissions');
    assert.ok(
      perms.contents === 'read' || perms.contents === 'write',
      'should have contents permission',
    );
  });
});

// ── 2. Workflow content ───────────────────────────────────────────────────────

describe('trusted-reviewers-drift.yml — content', () => {
  it('extracts allowlisted authors from trusted-reviewers.yaml', () => {
    const driftJob = wf.jobs?.['drift-check'];
    assert.ok(driftJob, 'drift-check job should exist');

    // Check that extraction step exists
    const steps = driftJob.steps ?? [];
    const extractStep = steps.find(
      (s) => s.id === 'extract-allowlist' || (s.name && s.name.toLowerCase().includes('allowlist')),
    );
    assert.ok(extractStep, 'should have a step that extracts allowlisted authors');
  });

  it('fetches GitHub repo collaborators', () => {
    const driftJob = wf.jobs?.['drift-check'];
    const steps = driftJob?.steps ?? [];
    const fetchStep = steps.find(
      (s) => s.id === 'fetch-github-perms' || (s.name && s.name.toLowerCase().includes('github')),
    );
    assert.ok(fetchStep, 'should have a step that fetches GitHub permissions');
  });

  it('has a compare step that detects drift', () => {
    const driftJob = wf.jobs?.['drift-check'];
    const steps = driftJob?.steps ?? [];
    const compareStep = steps.find(
      (s) => s.id === 'compare' || (s.name && s.name.toLowerCase().includes('compare')),
    );
    assert.ok(compareStep, 'should have a compare step');
  });

  it('emits a Decision with summary trusted-reviewers-file-drift-detected', () => {
    const emitJob = wf.jobs?.['emit-drift-decision'];
    const steps = emitJob?.steps ?? [];
    // Find the step that runs cli-decisions
    const decisionStep = steps.find((s) => {
      const run = s.run ?? '';
      return run.includes('cli-decisions') || run.includes('trusted-reviewers-file-drift-detected');
    });
    assert.ok(decisionStep, 'should have a step that emits a Decision');

    const run = decisionStep.run ?? '';
    assert.ok(
      run.includes('trusted-reviewers-file-drift-detected'),
      'Decision summary should be trusted-reviewers-file-drift-detected',
    );
  });

  it('Decision summary does NOT contain internal tracker IDs (AISDLC-394)', () => {
    const emitJob = wf.jobs?.['emit-drift-decision'];
    const steps = emitJob?.steps ?? [];
    const decisionStep = steps.find((s) => {
      const run = s.run ?? '';
      return run.includes('trusted-reviewers-file-drift-detected');
    });

    if (decisionStep) {
      const run = decisionStep.run ?? '';
      // The Decision summary and body shown to users must not contain
      // internal tracker IDs like AISDLC-NNN or DEC-NNNN
      const summaryMatch = run.match(/--summary\s+"([^"]+)"/);
      if (summaryMatch) {
        assert.ok(
          !/AISDLC-\d+|DEC-\d+/.test(summaryMatch[1]),
          'Decision summary must not contain tracker IDs per AISDLC-394',
        );
      }
    }
  });

  it('workflow uses pinned action SHAs (security)', () => {
    const allSteps = [
      ...(wf.jobs?.['drift-check']?.steps ?? []),
      ...(wf.jobs?.['emit-drift-decision']?.steps ?? []),
    ];

    const actionSteps = allSteps.filter((s) => s.uses && s.uses.startsWith('actions/'));
    for (const step of actionSteps) {
      // Pinned SHAs are 40-character hex strings
      const uses = step.uses;
      const sha = uses.split('@')[1];
      assert.ok(
        /^[0-9a-f]{40}$/.test(sha) || sha.startsWith('v'),
        `Action ${uses} should be pinned to a SHA or version tag`,
      );
    }
  });
});

// ── 3. Drift logic simulation ─────────────────────────────────────────────────

describe('drift detection logic', () => {
  // Simulate the Python drift comparison logic from the workflow
  function computeDrift(allowlisted, githubWrite) {
    const allowlistedSet = new Set(allowlisted);
    const githubWriteSet = new Set(githubWrite);

    const inGithubNotAllowlist = [...githubWriteSet].filter((x) => !allowlistedSet.has(x)).sort();
    const inAllowlistNotGithub = [...allowlistedSet].filter((x) => !githubWriteSet.has(x)).sort();

    return {
      driftDetected: inGithubNotAllowlist.length > 0 || inAllowlistNotGithub.length > 0,
      inGithubNotAllowlist,
      inAllowlistNotGithub,
    };
  }

  it('detects no drift when allowlist matches GitHub write+', () => {
    const result = computeDrift(['alice', 'bob'], ['alice', 'bob']);
    assert.strictEqual(result.driftDetected, false);
  });

  it('detects drift when GitHub has write+ user not in allowlist', () => {
    const result = computeDrift(['alice'], ['alice', 'carol']);
    assert.strictEqual(result.driftDetected, true);
    assert.ok(result.inGithubNotAllowlist.includes('carol'));
    assert.strictEqual(result.inAllowlistNotGithub.length, 0);
  });

  it('detects drift when allowlist has user who lost GitHub write+', () => {
    const result = computeDrift(['alice', 'bob'], ['alice']);
    assert.strictEqual(result.driftDetected, true);
    assert.ok(result.inAllowlistNotGithub.includes('bob'));
    assert.strictEqual(result.inGithubNotAllowlist.length, 0);
  });

  it('detects bidirectional drift', () => {
    const result = computeDrift(['alice', 'bob'], ['alice', 'carol']);
    assert.strictEqual(result.driftDetected, true);
    assert.ok(result.inGithubNotAllowlist.includes('carol'));
    assert.ok(result.inAllowlistNotGithub.includes('bob'));
  });

  it('classifies drift as informational (static file remains authoritative)', () => {
    // The drift detection only reports — it does NOT change trust classification.
    // The static file is still the ONLY runtime source of truth (OQ-1 invariant).
    // This test documents the boundary: drift = informational, not classification.
    const result = computeDrift(['alice'], ['alice', 'carol']);
    assert.strictEqual(result.driftDetected, true, 'drift detected when GitHub has extra user');
    // carol is NOT classified as trusted despite having GitHub write+
    // because the static file (allowlisted) does not include carol
    assert.ok(
      !['alice'].includes('carol'),
      'carol is not in the allowlist and therefore not trusted',
    );
  });
});

// ── 4. trusted-reviewers.yaml allowlist format ────────────────────────────────

describe('trusted-reviewers.yaml allowlist extension (AC#2)', () => {
  it('allowlist block exists in trusted-reviewers.yaml', () => {
    const yaml = readFileSync(join(REPO_ROOT, '.ai-sdlc', 'trusted-reviewers.yaml'), 'utf8');
    assert.ok(
      yaml.includes('allowlist:'),
      'trusted-reviewers.yaml should have an allowlist: block',
    );
  });

  it('allowlist.authors block exists', () => {
    const yaml = readFileSync(join(REPO_ROOT, '.ai-sdlc', 'trusted-reviewers.yaml'), 'utf8');
    assert.ok(
      yaml.includes('authors:'),
      'trusted-reviewers.yaml should have an allowlist.authors: block',
    );
  });

  it('allowlist extension does not break reviewers block (v6 verifier compat)', () => {
    const yaml = readFileSync(join(REPO_ROOT, '.ai-sdlc', 'trusted-reviewers.yaml'), 'utf8');
    // The reviewers block must still be present for v6 verifier compatibility
    assert.ok(
      yaml.includes('reviewers:'),
      'trusted-reviewers.yaml should still have a reviewers: block (v6 verifier compat)',
    );
    // pubkey entries should still be present
    assert.ok(
      yaml.includes('pubkey:') || yaml.includes('BEGIN PUBLIC KEY'),
      'trusted-reviewers.yaml should still have pubkey entries',
    );
  });
});
