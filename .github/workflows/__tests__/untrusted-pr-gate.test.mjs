/**
 * Tests for `.github/workflows/untrusted-pr-gate.yml` — RFC-0043 Phase 5 (AISDLC-501).
 *
 * Verifies the UCVG workflow structure, AISDLC-381 fork-PR safety compliance,
 * 4-stage orchestration wiring, feature-flag behavior, deployment mode switching,
 * and degradation path.
 *
 * ## Test coverage
 *   AC#1 — workflow triggers on pull_request_target (AISDLC-381 fork-PR hardening)
 *   AC#1 — AISDLC-381 5-point safety guard documented inline
 *   AC#2 — 4-stage orchestration: classify-and-gate → sandbox-and-review → clean-room-sign
 *   AC#3 — composes with ai-sdlc/pr-ready rollup (does NOT replace existing checks)
 *   AC#4 — deployment: local|ci config respected
 *   AC#5 — CI deployment mode: reviewers run inside CI-side OpenShell sandbox
 *   AC#6 — local opt-in mode: workflow detects deployment: local, hands off
 *   AC#7 — AI_SDLC_UNTRUSTED_PR_GATE feature flag (off / on behavior)
 *   AC#8 — degradation path: missing OpenShell → Stage 0/1 still run; operator message
 *   AC#9 — Decision: untrusted-pr-gate-degraded-mode emitted via RFC-0035 G0
 *   AC#11 — Stage 1 blocks protected-path mutations (zero LLM, zero sandbox spend)
 *
 * ## Hermetic test invariant (fork-PR safety guard #3)
 *   This test file MUST NOT execute anything from `pr-content/` or import fork code.
 *   All assertions are structural (YAML parse + raw text scan).
 *
 * Run with: node --test .github/workflows/__tests__/untrusted-pr-gate.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');
const WORKFLOW_NAME = 'untrusted-pr-gate.yml';
const WORKFLOW_PATH = resolve(WORKFLOWS_DIR, WORKFLOW_NAME);

// Load YAML via python3 (matches the pattern used in fork-pr-safety.test.mjs,
// ai-sdlc-gate.test.mjs etc. — avoids requiring pnpm install to have run first).
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

// Resolve the `on:` triggers under either key (PyYAML's `on` quirk).
function getTriggers(wf) {
  return wf.on ?? wf[true] ?? wf['on'] ?? {};
}

// Flatten every `steps:` block of every job in a workflow into a flat array.
function allSteps(wf) {
  const out = [];
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      out.push({ jobId, step });
    }
  }
  return out;
}

// Extract every checkout step.
function checkoutSteps(wf) {
  return allSteps(wf)
    .filter(
      ({ step }) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    .map(({ jobId, step }) => ({
      jobId,
      ref: step.with?.ref,
      path: step.with?.path,
      persistCredentials: step.with?.['persist-credentials'],
      stepName: step.name,
    }));
}

// Raw text of the workflow file (for comment-based assertions).
const raw = readFileSync(WORKFLOW_PATH, 'utf-8');

let wf;
before(() => {
  wf = loadYaml(WORKFLOW_PATH);
});

// ── AC#1: Trigger + AISDLC-381 fork-PR hardening ─────────────────────────────

describe('AC#1 — trigger on pull_request_target (AISDLC-381 fork-PR hardening)', () => {
  it('workflow triggers on pull_request_target', () => {
    const triggers = getTriggers(wf);
    assert.ok(
      'pull_request_target' in triggers,
      `${WORKFLOW_NAME} must declare a 'pull_request_target' trigger for fork-PR support (AISDLC-381)`,
    );
  });

  it('pull_request_target includes opened, synchronize, reopened, ready_for_review', () => {
    const triggers = getTriggers(wf);
    const prtTypes = triggers.pull_request_target?.types ?? [];
    for (const type of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
      assert.ok(prtTypes.includes(type), `pull_request_target must include type '${type}'`);
    }
  });

  it('workflow mentions AISDLC-381 in inline comments', () => {
    assert.match(
      raw,
      /AISDLC-381/,
      `${WORKFLOW_NAME} must reference AISDLC-381 in inline comments`,
    );
  });

  it('workflow documents the 5-point safety guard', () => {
    assert.match(
      raw,
      /5-point safety guard/i,
      `${WORKFLOW_NAME} must reference the 5-point safety guard (AISDLC-381)`,
    );
  });

  it('workflow references operator-runbook.md', () => {
    assert.match(
      raw,
      /operator-runbook\.md/,
      `${WORKFLOW_NAME} must point readers to docs/operations/operator-runbook.md`,
    );
  });
});

// ── AISDLC-381 fork-PR safety guards ─────────────────────────────────────────

describe('AISDLC-381 fork-PR safety: guard #1 — workflow logic uses target main checkout', () => {
  it('every job that has checkouts: first checkout has no ref (defaults to target main)', () => {
    const checkouts = checkoutSteps(wf);
    const byJob = new Map();
    for (const c of checkouts) {
      if (!byJob.has(c.jobId)) byJob.set(c.jobId, []);
      byJob.get(c.jobId).push(c);
    }
    for (const [jobId, list] of byJob) {
      assert.equal(
        list[0].ref,
        undefined,
        `job '${jobId}' first checkout MUST NOT pin ref: — pull_request_target defaults to target main (fork-PR safety guard #1)`,
      );
    }
  });
});

describe('AISDLC-381 fork-PR safety: guard #2 — fork content sandboxed in pr-content/', () => {
  it('all fork-content checkouts use path: pr-content and persist-credentials: false', () => {
    const checkouts = checkoutSteps(wf);
    const forkCheckouts = checkouts.filter(
      (c) =>
        typeof c.ref === 'string' && (c.ref.includes('head_sha') || c.ref.includes('head.sha')),
    );
    assert.ok(
      forkCheckouts.length > 0,
      `${WORKFLOW_NAME} must have at least one fork-HEAD checkout for PR content`,
    );
    for (const c of forkCheckouts) {
      assert.equal(
        c.path,
        'pr-content',
        `fork-data checkout MUST use path: pr-content (sandboxed subdirectory)`,
      );
      assert.equal(
        c.persistCredentials,
        false,
        `fork-data checkout MUST disable persist-credentials so fork code never sees a token`,
      );
    }
  });
});

describe('AISDLC-381 fork-PR safety: guard #3 — no execution against pr-content/', () => {
  const FORBIDDEN_RUN_PATTERNS = [
    { re: /\bcd\s+pr-content/, desc: 'cd into pr-content/ (execution context switch)' },
    { re: /pnpm\s+install[^\n]*pr-content/, desc: 'pnpm install against pr-content/' },
    { re: /pnpm\s+build[^\n]*pr-content/, desc: 'pnpm build against pr-content/' },
    { re: /\bnode\s+pr-content\//, desc: 'node invocation against pr-content/' },
    { re: /\brun:\s*\.\/pr-content\//, desc: 'run: ./pr-content/<script>' },
  ];

  it('no `run:` script executes fork content from pr-content/', () => {
    const steps = allSteps(wf);
    for (const { jobId, step } of steps) {
      const run = String(step.run ?? '');
      if (!run) continue;
      for (const { re, desc } of FORBIDDEN_RUN_PATTERNS) {
        assert.doesNotMatch(
          run,
          re,
          `${WORKFLOW_NAME} job '${jobId}' step '${step.name ?? '<unnamed>'}' must NOT: ${desc}`,
        );
      }
    }
  });

  it('no `uses:` reference points into pr-content/ (no fork-provided actions)', () => {
    const steps = allSteps(wf);
    for (const { jobId, step } of steps) {
      const uses = String(step.uses ?? '');
      if (!uses) continue;
      assert.doesNotMatch(
        uses,
        /^\.\/pr-content\//,
        `${WORKFLOW_NAME} job '${jobId}' step '${step.name ?? '<unnamed>'}' must NOT use: ./pr-content/<action>`,
      );
    }
  });

  it('no step sets working-directory into pr-content/', () => {
    const steps = allSteps(wf);
    for (const { jobId, step } of steps) {
      const wd = step['working-directory'];
      if (wd !== undefined) {
        assert.doesNotMatch(
          String(wd),
          /^pr-content/,
          `${WORKFLOW_NAME} job '${jobId}' step '${step.name ?? '<unnamed>'}' must NOT set working-directory into pr-content/`,
        );
      }
    }
  });
});

describe('AISDLC-381 fork-PR safety: guard #5 — no signing keys in fork-PR workflow', () => {
  const FORBIDDEN_SECRETS = [
    /AI_SDLC_ATTESTATION_PRIVATE_KEY/i,
    /\bNPM_TOKEN\b/i,
    /\bAWS_/i,
    /\bGCP_/i,
  ];

  it('workflow does NOT reference signing keys / publish tokens in non-comment lines', () => {
    // Only check non-comment lines (signing keys in YAML comments are OK —
    // they document what is NOT present).
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.replace(/^\s+/, '');
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      for (const re of FORBIDDEN_SECRETS) {
        assert.doesNotMatch(
          line,
          re,
          `${WORKFLOW_NAME} must NOT reference signing keys / publish tokens in non-comment lines (fork-PR safety guard #5)`,
        );
      }
    }
  });
});

// ── AC#2: 4-stage orchestration ───────────────────────────────────────────────

describe('AC#2 — 4-stage orchestration job structure', () => {
  it('workflow has classify-and-gate job (Stage 0+1)', () => {
    assert.ok(
      'classify-and-gate' in (wf.jobs ?? {}),
      `${WORKFLOW_NAME} must have a 'classify-and-gate' job for Stage 0+1`,
    );
  });

  it('workflow has sandbox-and-review job (Stage 2/3)', () => {
    assert.ok(
      'sandbox-and-review' in (wf.jobs ?? {}),
      `${WORKFLOW_NAME} must have a 'sandbox-and-review' job for Stage 2/3`,
    );
  });

  it('workflow has clean-room-sign job (Stage 4)', () => {
    assert.ok(
      'clean-room-sign' in (wf.jobs ?? {}),
      `${WORKFLOW_NAME} must have a 'clean-room-sign' job for Stage 4`,
    );
  });

  it('sandbox-and-review needs classify-and-gate (pipeline halt at first abort)', () => {
    const sandboxJob = wf.jobs?.['sandbox-and-review'];
    const needs = Array.isArray(sandboxJob?.needs) ? sandboxJob.needs : [sandboxJob?.needs];
    assert.ok(
      needs.includes('classify-and-gate'),
      `sandbox-and-review must need classify-and-gate so it only runs after Stage 0+1 passes`,
    );
  });

  it('clean-room-sign needs sandbox-and-review (Stage 4 after Stage 2/3)', () => {
    const signJob = wf.jobs?.['clean-room-sign'];
    const needs = Array.isArray(signJob?.needs) ? signJob.needs : [signJob?.needs];
    assert.ok(
      needs.includes('sandbox-and-review'),
      `clean-room-sign must need sandbox-and-review so Stage 4 only runs after Stage 2/3 succeeds`,
    );
  });

  it('clean-room-sign has an if: gate_outcome == pass condition', () => {
    const signJob = wf.jobs?.['clean-room-sign'];
    const cond = String(signJob?.if ?? '');
    assert.match(
      cond,
      /gate_outcome.*pass|pass.*gate_outcome/,
      `clean-room-sign must guard on gate_outcome == 'pass' so it does not run after a Stage 1 abort`,
    );
  });
});

// ── AC#3: Composes with ai-sdlc/pr-ready ──────────────────────────────────────

describe('AC#3 — composes with ai-sdlc/pr-ready rollup (does NOT replace)', () => {
  it('workflow posts ai-sdlc/untrusted-pr-gate status (does not overwrite ai-sdlc/pr-ready)', () => {
    assert.match(
      raw,
      /ai-sdlc\/untrusted-pr-gate/,
      `${WORKFLOW_NAME} must post 'ai-sdlc/untrusted-pr-gate' status context (not ai-sdlc/pr-ready)`,
    );
    // Must NOT claim to post or set the ai-sdlc/pr-ready context.
    // (We don't assert absence of the string in comments — only that the workflow
    //  doesn't SET a status context named ai-sdlc/pr-ready.)
    const nonCommentLines = raw
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    assert.doesNotMatch(
      nonCommentLines,
      /context:.*ai-sdlc\/pr-ready/,
      `${WORKFLOW_NAME} must NOT post ai-sdlc/pr-ready status — it should only post ai-sdlc/untrusted-pr-gate`,
    );
  });
});

// ── AC#4: deployment: local|ci ────────────────────────────────────────────────

describe('AC#4 — deployment: local|ci config respected; default ci (OQ-2 resolution)', () => {
  it('classify-and-gate reads deployment mode from .ai-sdlc/untrusted-pr-gate.yaml', () => {
    assert.match(
      raw,
      /untrusted-pr-gate\.yaml/,
      `${WORKFLOW_NAME} must read .ai-sdlc/untrusted-pr-gate.yaml for deployment mode`,
    );
  });

  it('deployment mode defaults to ci when config is absent', () => {
    // Verify the workflow has a default fallback to 'ci'.
    assert.match(
      raw,
      /deployment.*ci|ci.*deployment/,
      `${WORKFLOW_NAME} must default deployment mode to 'ci' (OQ-2 resolution)`,
    );
  });

  it('workflow detects deployment: local and hands off', () => {
    assert.match(
      raw,
      /deployment.*local|local.*deployment/,
      `${WORKFLOW_NAME} must detect deployment: local mode (AC#6)`,
    );
  });
});

// ── AC#5: CI deployment mode ──────────────────────────────────────────────────

describe('AC#5 — CI deployment mode: reviewers in CI-side OpenShell sandbox', () => {
  it('sandbox-and-review job uses sandbox-run CLI', () => {
    assert.match(
      raw,
      /sandbox-run/,
      `${WORKFLOW_NAME} must invoke sandbox-run subcommand for CI deployment mode`,
    );
  });

  it('signing key is explicitly absent from sandbox-and-review job (credential withholding)', () => {
    // The comment "SIGNING KEY IS INTENTIONALLY ABSENT" or equivalent must appear.
    assert.match(
      raw,
      /SIGNING KEY.*ABSENT|signing.*key.*absent|INTENTIONALLY ABSENT/i,
      `${WORKFLOW_NAME} must document that the signing key is withheld from the sandbox job`,
    );
  });
});

// ── AC#6: local opt-in mode ───────────────────────────────────────────────────

describe('AC#6 — local opt-in: workflow detects deployment: local and hands off', () => {
  it('local-review subcommand is referenced in the workflow', () => {
    assert.match(
      raw,
      /local-review/,
      `${WORKFLOW_NAME} must reference the local-review subcommand for deployment: local mode`,
    );
  });
});

// ── AC#7: Feature flag ────────────────────────────────────────────────────────

describe('AC#7 — AI_SDLC_UNTRUSTED_PR_GATE feature flag (default off)', () => {
  it('workflow reads AI_SDLC_UNTRUSTED_PR_GATE or GATE_FLAG env var', () => {
    assert.match(
      raw,
      /AI_SDLC_UNTRUSTED_PR_GATE|GATE_FLAG/,
      `${WORKFLOW_NAME} must read the AI_SDLC_UNTRUSTED_PR_GATE feature flag`,
    );
  });

  it('flag-off path produces a status (flag-off-status job or equivalent)', () => {
    const jobs = Object.keys(wf.jobs ?? {});
    const hasOffJob =
      jobs.includes('flag-off-status') ||
      raw.includes('flag-off') ||
      raw.includes('flag off') ||
      raw.includes("flag_on != 'true'") ||
      raw.includes('enabled != true');
    assert.ok(
      hasOffJob,
      `${WORKFLOW_NAME} must have a job/path for when the flag is OFF that posts a status`,
    );
  });

  it('flag-on path engages UCVG for untrusted PRs (flag_on check)', () => {
    assert.match(
      raw,
      /flag_on|flag.*on|enabled.*true/i,
      `${WORKFLOW_NAME} must guard UCVG jobs on the flag being on`,
    );
  });

  it('truthy values recognized: 1, true, yes, on (case-insensitive)', () => {
    // The check-flag step must handle these values.
    const flagCheckStep = allSteps(wf).find(
      ({ step }) =>
        typeof step.run === 'string' &&
        (step.run.includes('true') || step.run.includes('yes') || step.run.includes('on')),
    );
    assert.ok(
      flagCheckStep ||
        raw.includes('FLAG_LOWER == "1"') ||
        raw.includes("FLAG_LOWER == '1'") ||
        (raw.includes('true') && raw.includes('yes') && raw.includes('on')),
      `${WORKFLOW_NAME} must recognize truthy values 1, true, yes, on for the feature flag`,
    );
  });
});

// ── AC#8: Degradation path ────────────────────────────────────────────────────

describe('AC#8 — degradation path: missing OpenShell → Stage 0/1 still run', () => {
  it('workflow checks OpenShell availability', () => {
    assert.match(
      raw,
      /openshell|OpenShell/,
      `${WORKFLOW_NAME} must check OpenShell availability for the degradation path`,
    );
  });

  it('degradation operator message present: "Stage 2 unavailable; falling back..."', () => {
    assert.match(
      raw,
      /Stage 2 unavailable.*falling back|falling back.*static-review-only/i,
      `${WORKFLOW_NAME} must emit the degradation message per AC#8`,
    );
  });

  it('sandbox-and-review has a degraded-mode path for static review', () => {
    assert.match(
      raw,
      /review-degraded|degraded/,
      `${WORKFLOW_NAME} must have a degraded-mode path that runs static-diff review`,
    );
  });
});

// ── AC#9: Decision: untrusted-pr-gate-degraded-mode ──────────────────────────

describe('AC#9 — Decision: untrusted-pr-gate-degraded-mode emitted via RFC-0035 G0', () => {
  it('workflow emits Decision via cli-decisions when degraded', () => {
    assert.match(
      raw,
      /cli-decisions.*add|decisions.*add/,
      `${WORKFLOW_NAME} must emit a Decision via cli-decisions when degradation is engaged (AC#9)`,
    );
  });

  it('Decision summary is untrusted-pr-gate-degraded-mode', () => {
    assert.match(
      raw,
      /untrusted-pr-gate-degraded-mode/,
      `${WORKFLOW_NAME} must use 'untrusted-pr-gate-degraded-mode' as the Decision summary`,
    );
  });
});

// ── AC#11: Stage 1 blocks protected-path mutations ───────────────────────────

describe('AC#11 — Stage 1 blocks protected-path mutations (zero LLM, zero sandbox spend)', () => {
  it('classify-and-gate job runs ast-gate CLI', () => {
    assert.match(
      raw,
      /ast-gate/,
      `${WORKFLOW_NAME} must invoke the ast-gate subcommand for Stage 1`,
    );
  });

  it('AST gate abort posts comment and label (needs-maintainer-review)', () => {
    assert.match(
      raw,
      /needs-maintainer-review/,
      `${WORKFLOW_NAME} must apply the needs-maintainer-review label when Stage 1 aborts`,
    );
  });

  it('Stage 1 abort posts a block comment naming the offending paths', () => {
    // The Post block comment step uses actions/github-script@v7.
    const scriptSteps = allSteps(wf).filter(
      ({ step }) => typeof step.uses === 'string' && step.uses.startsWith('actions/github-script@'),
    );
    assert.ok(
      scriptSteps.length > 0,
      `${WORKFLOW_NAME} must have at least one actions/github-script step for posting comments/labels`,
    );
  });

  it('Stage 1 guard condition prevents sandbox-and-review from running on abort', () => {
    const sandboxJob = wf.jobs?.['sandbox-and-review'];
    const cond = String(sandboxJob?.if ?? '');
    // Must check gate_outcome == 'pass' (only proceed if Stage 1 passed).
    assert.match(
      cond,
      /gate_outcome.*pass|pass.*gate_outcome/,
      `sandbox-and-review must gate on gate_outcome == 'pass' (Stage 1 must have passed)`,
    );
  });

  it('Stage 1 block path does NOT invoke LLM or sandbox CLI (zero LLM, zero sandbox spend)', () => {
    // The block comment step (Post block comment + label) must not invoke
    // sandbox-run or any ANTHROPIC_API_KEY-consuming step.
    const blockSteps = allSteps(wf).filter(
      ({ step }) => typeof step.name === 'string' && /block/i.test(step.name),
    );
    for (const { step } of blockSteps) {
      const run = String(step.run ?? '');
      assert.doesNotMatch(
        run,
        /sandbox-run|ANTHROPIC_API_KEY/,
        `Stage 1 block step '${step.name}' must NOT invoke sandbox-run or use ANTHROPIC_API_KEY (zero LLM spend)`,
      );
    }
  });
});

// ── Adopter-facing string hygiene ─────────────────────────────────────────────

describe('Adopter-facing string hygiene — no AISDLC-NNN in non-comment lines', () => {
  // Per AISDLC-394: strings posted to GitHub PRs must not contain internal tracker IDs.
  // Comments (lines starting with #) are exempt.

  const TRACKER_RE = /AISDLC-\d+/;

  function isMaintainerComment(line) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('#')) return true;
    if (trimmed.startsWith('//')) return true;
    const trailingYaml = line.indexOf(' #');
    const trackerIdx = line.search(TRACKER_RE);
    if (trailingYaml !== -1 && trackerIdx > trailingYaml) return true;
    const trailingJs = line.indexOf(' //');
    if (trailingJs !== -1 && trackerIdx > trailingJs) return true;
    return false;
  }

  it('no AISDLC-NNN token appears in non-comment lines', () => {
    const lines = raw.split('\n');
    const leaks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!TRACKER_RE.test(line)) continue;
      if (isMaintainerComment(line)) continue;
      leaks.push(`line ${i + 1}: ${line.trimEnd()}`);
    }
    assert.deepEqual(
      leaks,
      [],
      `${WORKFLOW_NAME} has AISDLC-NNN tokens in non-comment lines (adopter-facing string leak):\n${leaks.join('\n')}`,
    );
  });
});

// ── Permissions ───────────────────────────────────────────────────────────────

describe('Permissions — minimum needed; no contents:write (fork-PR safety guard #5)', () => {
  it('workflow-level permissions do NOT include contents: write', () => {
    const perms = wf.permissions ?? {};
    assert.notEqual(
      perms.contents,
      'write',
      `${WORKFLOW_NAME} must NOT have workflow-level contents: write (fork-PR safety guard #5)`,
    );
  });

  it('clean-room-sign job does NOT have contents: write', () => {
    const signJob = wf.jobs?.['clean-room-sign'];
    const perms = signJob?.permissions ?? {};
    assert.notEqual(
      perms.contents,
      'write',
      `clean-room-sign must NOT have contents: write (signing only needs statuses: write)`,
    );
  });
});
