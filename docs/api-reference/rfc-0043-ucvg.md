# API Reference — RFC-0043 UCVG (Untrusted-Contributor Verification Gate)

**Document type:** API Reference
**Status:** Current
**Spec version:** v1alpha1
**RFC reference:** [RFC-0043](../../spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md)
**Source root:** `pipeline-cli/src/pipeline/`

---

## Overview

This document describes the type signatures, invocation contracts, and configuration interfaces for the RFC-0043 Untrusted-Contributor Verification Gate (UCVG). Phases 1-5 (AISDLC-497..501) implemented the code; this document (Phase 6, AISDLC-502) is the normative API reference.

All UCVG modules live in `pipeline-cli/src/pipeline/` and are exported from `pipeline-cli/src/pipeline/index.ts` (when applicable). Workflow-level invocations go through `pipeline-cli/bin/cli-ucvg.mjs`.

---

## `trust-classifier.ts`

**Stage 0 — Deterministic trust classification.**

### Types

```ts
/** RFC-0022 `reviewerAuthorityModel` values that affect UCVG engagement. */
type ReviewerAuthorityModel = 'open' | 'allowlist' | 'allowlist+role';

/** Classification outcome. */
type TrustClassification = 'trusted' | 'untrusted';

/**
 * Reason paired with the trust classification for audit/event logging.
 * Maps to: OQ-1 precedence rules.
 */
type TrustReason =
  | 'author-in-allowlist'          // found in .ai-sdlc/trusted-reviewers.yaml
  | 'reviewerAuthorityModel-open'  // open model → everyone trusted
  | 'fork-pr-always-untrusted'     // fork PR not overridden by allowlist
  | 'author-not-in-allowlist';     // allowlist/allowlist+role, not in file

interface TrustResult {
  classification: TrustClassification;
  reason: TrustReason;
  /** The PR author login that was evaluated. */
  author: string;
  /** The effective reviewer authority model consulted. */
  reviewerAuthorityModel: ReviewerAuthorityModel;
  /** Author logins found in the allowlist at evaluation time (for audit). */
  allowlistedAuthors: string[];
}

interface TrustClassifierInput {
  /** GitHub login of the PR author. */
  author: string;
  /** True when the PR was opened from a forked repo. */
  isFork: boolean;
  /**
   * RFC-0022 reviewer authority model from `.ai-sdlc/compliance.yaml`.
   * Defaults to `'open'` when not supplied.
   */
  reviewerAuthorityModel?: ReviewerAuthorityModel;
  /**
   * Absolute path to the repo root.
   * Used to resolve `.ai-sdlc/trusted-reviewers.yaml`.
   * Defaults to `process.cwd()`.
   */
  workDir?: string;
}
```

### Functions

#### `classifyTrust(input: TrustClassifierInput): TrustResult`

Classify a PR author as TRUSTED or UNTRUSTED.

**Precedence order (OQ-1 resolution):**

1. If `reviewerAuthorityModel === 'open'` → TRUSTED (UCVG opt-in only).
2. If author login is in `.ai-sdlc/trusted-reviewers.yaml` `allowlist.authors` → TRUSTED.
3. If `isFork === true` → UNTRUSTED (fork PRs always untrusted unless (2) overrides).
4. Author not in allowlist → UNTRUSTED.

**Security invariant:** No live GitHub API calls are made on the critical path. The static `.ai-sdlc/trusted-reviewers.yaml` file is the ONLY source of truth (OQ-1 resolution).

```ts
import { classifyTrust } from 'pipeline-cli/src/pipeline/trust-classifier.js';

const result = classifyTrust({
  author: 'alice-contrib',
  isFork: true,
  reviewerAuthorityModel: 'allowlist',
  workDir: '/path/to/repo',
});
// result.classification: 'trusted' | 'untrusted'
// result.reason: 'author-in-allowlist' | ...
```

#### `shouldEngageUcvg(result: TrustResult): boolean`

Determine whether UCVG should engage for this PR.

- `open` model → returns `false` (UCVG never engages by default).
- `allowlist` / `allowlist+role` → returns `true` when `classification === 'untrusted'`.

#### `loadAllowlistedAuthors(workDir?: string): string[]`

Parse `allowlist.authors[].login` from `.ai-sdlc/trusted-reviewers.yaml`. Returns empty array when the file is absent, has no `allowlist:` block, or the array is empty. Throws only on parse errors (malformed YAML).

#### `extractAllowlistedAuthorsFromYaml(yamlText: string): string[]`

Exported for unit testing. Parses `allowlist.authors[].login` from raw YAML text.

---

## `ast-gate.ts`

**Stage 1 — Deterministic diff/AST gate (no LLM, no runner).**

### Types

```ts
/** Outcome of the AST gate evaluation. */
type AstGateOutcome = 'pass' | 'abort-protected-path';

interface AstGateResult {
  outcome: AstGateOutcome;
  /** Paths that triggered the abort (empty on pass). */
  offendingPaths: string[];
  /** Content heuristic findings (empty on pass). */
  heuristicFindings: HeuristicFinding[];
}

interface HeuristicFinding {
  type: 'packageJsonLifecycleScript' | 'newGithubActionUses';
  path: string;
  detail: string;
}

/** Content heuristic action: abort or warn. */
type HeuristicAction = 'abort' | 'warn';

/** Adopter-configurable AST gate configuration. */
interface AstGateConfig {
  /** Paths that trigger `abort-protected-path` on mutation (deny wins). */
  protectedPaths: string[];
  /** Only files matching these globs may change in an untrusted PR. */
  allowedMutationGlobs: string[];
  contentHeuristics: {
    /** Abort when `preinstall`/`postinstall`/`prepare` are added to package.json. */
    packageJsonLifecycleScripts: HeuristicAction;
    /** Abort when a new `uses:` reference appears in file content. */
    newGithubActionUses: HeuristicAction;
  };
}

/** A single changed file in the PR diff. */
interface ChangedFile {
  /** Repo-relative file path. */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** File content AFTER the change (for content heuristics). Optional. */
  afterContent?: string;
  /** File content BEFORE the change (for detecting additions). Optional. */
  beforeContent?: string;
}
```

### Constants

```ts
/** Default protected paths per RFC-0043 §Stage 1. Deny wins. */
const DEFAULT_PROTECTED_PATHS: readonly string[];

/** Default allowed mutation globs per RFC-0043 §Stage 1. */
const DEFAULT_ALLOWED_MUTATION_GLOBS: readonly string[];

/** Default content heuristics. */
const DEFAULT_CONTENT_HEURISTICS: AstGateConfig['contentHeuristics'];

/** Combined default config. */
const DEFAULT_AST_GATE_CONFIG: AstGateConfig;
```

### Functions

#### `runAstGate(changedFiles: ChangedFile[], config?: AstGateConfig): AstGateResult`

Run the Stage 1 gate on a list of changed files. The gate applies in this order:

1. Protected-path check (deny wins): any path matching `protectedPaths` → `abort-protected-path`.
2. Allowed-mutation check: any path NOT matching `allowedMutationGlobs` → `abort-protected-path`.
3. Content heuristics on files that passed (1) and (2).

All offending paths are collected before returning (does not short-circuit on first match).

#### `loadAstGateConfig(workDir?: string): AstGateConfig`

Load config from `.ai-sdlc/untrusted-pr-gate.yaml`. Falls back to `DEFAULT_AST_GATE_CONFIG` when absent.

#### `normalizePath(rawPath: string): string | null`

Normalize a file path before glob matching. Returns `null` when the path is ambiguous (directory traversal, backslash separators, empty after normalization). **Callers MUST treat null as "protected" (deny).**

#### `globToRegex(pattern: string): RegExp`

Convert a glob pattern (supporting `**`, `*`, `?`, character classes) to a RegExp. Used internally by `matchesAnyGlob`.

#### `matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean`

Returns true when `filePath` matches any glob in `patterns`.

#### `detectLifecycleScriptAdditions(afterContent: string, beforeContent?: string | null): string[]`

Check whether a `package.json` content diff adds/modifies lifecycle scripts (`preinstall`, `postinstall`, `prepare`). Returns the list of added script key names.

#### `detectNewGithubActionUses(afterContent: string, beforeContent?: string | null): boolean`

Check whether a file content adds a NEW `uses:` line (line-level diff semantics). Returns true when any `uses:` line exists in `afterContent` that is not present (or is in excess) in `beforeContent`.

#### `buildBlockedEvent(prNumber, author, gateResult, now?): UntrustedPrBlockedByProtectedPathEvent`

Build the event object for emission to the event log.

#### `buildBlockedComment(gateResult: AstGateResult, author: string): string`

Build the GitHub comment body naming offending paths. Posted to the PR when the gate aborts.

---

## `sandbox-runner.ts`

**Stage 2/3 — OpenShell sandbox lifecycle + differential testing.**

### Types

```ts
/** The five supported sandbox drivers per RFC-0043 OQ-5 resolution. */
type SandboxDriverKind = 'docker' | 'podman' | 'kata' | 'gvisor' | 'microvm';

/** RFC-0022 compliance regimes that force a minimum isolation level. */
type ComplianceRegime = 'hipaa' | 'fedramp-high' | 'pci-dss-level-1' | 'none';

/** Sandbox configuration. Loaded from `.ai-sdlc/untrusted-pr-gate.yaml`. */
interface SandboxConfig {
  /** Which compute driver to use. Default: `docker`. */
  sandboxDriver: SandboxDriverKind;
  /** Differential test configuration including resource limits. */
  differentialTest: DifferentialTestConfig;
  /** RFC-0022 compliance regime (auto-overrides driver for HIPAA/FedRAMP/PCI). */
  complianceRegime?: ComplianceRegime;
  /** CI or local deployment mode per OQ-2. Default: `ci`. */
  deployment?: 'ci' | 'local';
}

interface ResourceLimits {
  /** Wall-clock timeout in seconds. Default: 600 (10 min). */
  wallClockSeconds: number;
  /** CPU cores. Default: 2. */
  cpuCores: number;
  /** Memory in megabytes. Default: 4096 (4 GB). */
  memoryMb: number;
  /** Per-test timeout in seconds. Optional adopter refinement. */
  perTestTimeoutSeconds?: number;
}

interface DifferentialTestConfig {
  resourceLimits: ResourceLimits;
}

/** Input for a sandbox spawn request. */
interface SandboxSpawnInput {
  /** Absolute path to the OpenShell policy file. */
  policyFilePath: string;
  /** The PR diff to apply (unified diff format). */
  prDiff: string;
  /** URL or local path of the clean upstream main to clone. */
  upstreamMainRef: string;
  /** Resource limits to enforce. */
  resourceLimits: ResourceLimits;
  /** The PR number being tested (for resource breach event attribution). */
  prNumber: number;
  /**
   * Environment variables to inject into the sandbox.
   * SECURITY CONSTRAINT: MUST NOT include signing-key.pem, write-scoped
   * GITHUB_TOKEN, NPM_TOKEN, or AI_SDLC_PAT.
   */
  sandboxEnv?: Record<string, string>;
}

type ResourceBreachType = 'wall-clock' | 'memory' | 'cpu';

/** Emitted when the sandbox breaches a resource limit. */
interface ResourceBreachEvent {
  type: 'ResourceBreach';
  breachType: ResourceBreachType;
  /** The configured limit that was exceeded. */
  limit: number;
  /** The unit of the limit (seconds, MB, cores). */
  limitUnit: string;
  /** The observed value at breach time (may be approximate). */
  observedValue?: number;
  prNumber: number;
  ts: string;
}
```

### Constants

```ts
/** Default resource limits per OQ-3 resolution. */
const DEFAULT_RESOURCE_LIMITS: ResourceLimits;  // 600s / 2 CPU / 4096 MB

/** Default sandbox config: docker driver, OQ-3 limits, no regime, CI deployment. */
const DEFAULT_SANDBOX_CONFIG: SandboxConfig;
```

### Functions

#### `resolveEffectiveDriver(requestedDriver, regime?): { driver, overrideApplied, overrideReason? }`

Apply the RFC-0022 regime override to the requested driver. Returns the effective driver. Pure function — does not start any sandbox.

**HIPAA / FedRAMP High / PCI-DSS Level 1 → MicroVM required.** If `requestedDriver !== 'microvm'` and a mandating regime is active, `overrideApplied: true` and `driver: 'microvm'` is returned.

#### `loadSandboxConfig(workDir?: string): SandboxConfig`

Load config from `.ai-sdlc/untrusted-pr-gate.yaml`. Falls back to `DEFAULT_SANDBOX_CONFIG`.

#### `runSandbox(input: RunSandboxInput): Promise<SandboxResult>`

High-level sandbox runner orchestrator. Orchestrates the full Stage 2/3 lifecycle:

1. Apply regime override to select the effective driver.
2. Validate the credential withholding invariant.
3. Spawn the sandbox (differential test sequence) via `driver.spawn(input)`.
4. On resource breach: emit breach event; return `{ outcome: 'resource-breach', breach }`.
5. Teardown (idempotent; always called).

Returns a `SandboxResult` discriminated union:

```ts
type SandboxResult =
  | { outcome: 'success'; differentialTest: DifferentialTestResult; durationMs: number }
  | { outcome: 'resource-breach'; breach: ResourceBreachEvent }
  | { outcome: 'error'; error: string };

interface RunSandboxInput {
  prNumber: number;
  prDiff: string;
  upstreamMainRef: string;
  config: SandboxConfig;
  workDir?: string;
  driverOverride?: SandboxDriver;
  policyFilePath?: string;
}
```

The `SandboxDriver` interface has exactly two methods — `spawn()` and `teardown()`:

```ts
interface SandboxDriver {
  readonly kind: SandboxDriverKind;
  spawn(input: SandboxSpawnInput): Promise<SandboxResult>;
  teardown(): Promise<void>;
}
```

There are no `beforeSpawn`, `afterSpawn`, or `onResourceBreach` hooks on `SandboxDriver`. Resource breach detection is handled via `Promise.race` inside `runSandbox`.

#### `createSandboxDriver(config: SandboxConfig, overrideDriver?: SandboxDriver): { driver, regimeOverrideApplied, regimeOverrideReason? }`

Factory that applies the RFC-0022 regime override and returns the appropriate driver. `DockerSandboxDriver` is fully implemented. `PodmanSandboxDriver`, `KataSandboxDriver`, `GVisorSandboxDriver`, and `MicroVmSandboxDriver` are pluggable stubs that return `{ outcome: 'error' }` until a concrete implementation is provided.

---

## `reviewer-matrix.ts`

**Stage 3 — Hardened 3-reviewer matrix + prompt-injection delimiter framing.**

Module: `pipeline-cli/src/pipeline/reviewer-matrix.ts`

### Types

```ts
/** The three reviewer roles in the RFC-0010 §13 matrix. */
type ReviewerRole = 'code' | 'test' | 'security';

/** Injection attempt category — maps to the five corpus categories (AC-5). */
type InjectionCategory =
  | 'direct-instruction'
  | 'hidden-content'
  | 'code-comment'
  | 'markdown-formatted'
  | 'multi-language';

interface InjectionMatch {
  category: InjectionCategory;
  matchedText: string;   // truncated to 200 chars
  lineIndex?: number;    // 0-indexed line within the diff
}

interface InjectionDetectionResult {
  detected: boolean;
  matches: InjectionMatch[];
}
```

### Constants

```ts
/** Opening delimiter marker for untrusted PR diff content. */
const DIFF_OPEN_MARKER: string;   // '<<<UNTRUSTED_PR_DIFF>>>'

/** Closing delimiter marker for untrusted PR diff content. */
const DIFF_CLOSE_MARKER: string;  // '<<<END_UNTRUSTED_PR_DIFF>>>'

/** Decision Catalog summary for corpus extension requests. */
const INJECTION_CORPUS_EXTENSION_REQUEST_SUMMARY: string;
// = 'prompt-injection-corpus-extension-request'
```

### Functions

#### `buildHardenedDiffSection(prDiff: string): string`

Build the sandwich-framed diff section for embedding in a reviewer prompt. Wraps the untrusted diff between `<<<UNTRUSTED_PR_DIFF>>>` and `<<<END_UNTRUSTED_PR_DIFF>>>` markers. Any embedded framing tokens in the diff are neutralized (`<<<` → `&lt;<<`) to prevent marker breakout.

```ts
const framedDiff = buildHardenedDiffSection(rawPrDiff);
const prompt = reviewerTemplateBody.replace('{{PR_DIFF}}', framedDiff);
```

#### `detectInjectionAttempts(diff: string): InjectionDetectionResult`

Detect prompt-injection attempts in a PR diff string. Runs the diff through all five corpus-category pattern sets and returns a structured result. Reviewers call this to decide whether to set `promptInjectionDetected: true`.

**Note:** This is a heuristic for the hermetic test corpus. In production, the primary defense is the delimiter framing combined with the reviewer's instruction-following behavior.

#### `buildInjectionFinding(role: ReviewerRole, match: InjectionMatch): Finding`

Build a correctly typed `Finding` for a detected injection attempt. Severity per AC-3 contract: `security` → `critical`; `code` → `major`; `test` → `major`.

#### `incrementInjectionCorpusCounter(existing, request): InjectionCorpusExtensionCounter`

RFC-0035 Stage A counter for injection-corpus extension requests. Idempotent per requester identity. Auto-promote threshold: ≥2 distinct adopter organizations.

---

## `report-validator.ts`

**Stage 4 boundary schema — Zod validation before key resolution.**

### Types

```ts
/**
 * Result of validating an untrusted-PR report artifact.
 * Discriminated union: { valid: true, report } | { valid: false, error }.
 */
type ReportValidationResult =
  | { valid: true; report: UntrustedPrReport }
  | { valid: false; error: string };

/** Inferred TypeScript type from UntrustedPrReportSchema. */
type UntrustedPrReport = {
  schemaVersion: 'untrusted-pr-report.v1';
  prNumber: number;        // positive integer
  headSha: string;         // /^[0-9a-f]{40}$/i
  baseSha: string;         // /^[0-9a-f]{40}$/i
  generatedAt: string;     // ISO 8601 datetime
  trust: {
    classification: 'untrusted' | 'trusted';
    reason: string;
  };
  astGate: {
    outcome: 'pass' | 'abort-protected-path';
    offendingPaths: string[];
  };
  differentialTest: {
    upstreamSuitePassed: boolean;
    newTestsPassed: boolean;
    newCodeCoveragePct: number;   // [0, 100]
  };
  reviewers: {
    code: ReviewerVerdict;
    test: ReviewerVerdict;
    security: ReviewerVerdict;
  };
  consensus: {
    approved: boolean;
    blockingFindings: number;     // non-negative integer
  };
};

/** Single reviewer verdict. */
type ReviewerVerdict = {
  approved: boolean;
  findings: Finding[];
  promptInjectionDetected: boolean;  // REQUIRED field — sandbox MUST always emit
};

/** Single reviewer finding. */
type Finding = {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  message: string;        // min length 1
  path?: string;          // optional file path
};
```

### Schema

#### `UntrustedPrReportSchema`

The Zod schema enforced at the Stage-4 trust boundary. All sub-objects use `.strict()` — unknown keys are rejected, not silently stripped. This is the tamper-detection property.

**Alignment with JSON Schema:** `spec/schemas/untrusted-pr-report.v1.schema.json` is the mirror JSON Schema definition. Any change to either must be reflected in both.

### Functions

#### `validateReport(data: unknown): ReportValidationResult`

Validate an untrusted-PR report artifact against `UntrustedPrReportSchema`. Called by the clean-room signer BEFORE resolving the signing key.

```ts
import { validateReport } from 'pipeline-cli/src/pipeline/report-validator.js';

const result = validateReport(JSON.parse(artifactJson));
if (!result.valid) {
  // Reject — do NOT proceed to key resolution
  throw new Error(`[clean-room-signer] Report rejected: ${result.error}`);
}
const report = result.report;
// ... proceed to build Merkle tree + sign
```

**Error format:** On failure, `result.error` is a single-line string of Zod errors formatted as `<path>: <message>; <path>: <message>`.

---

## Clean-Room Signer Interface

**Stage 4 — Decoupled signing step.**

Module: `pipeline-cli/src/pipeline/clean-room-signer.ts`

### Exported constant

```ts
/** Sentinel file/directory names that indicate an active sandbox environment. */
const SANDBOX_ARTIFACT_SENTINELS: readonly string[];
// Values: 'untrusted-pr-eval-active', 'stages-1-3-output', 'sandbox-output',
//         '.sandbox-pid', 'untrusted-pr-eval.lock'
```

### Functions

#### `detectSandboxArtifacts(workDir: string): string | null`

Check whether the working directory contains any sandbox artifact sentinels. Returns the first sentinel name found (for error messaging), or `null` when clean.

This implements AC#8 — the signer refuses to run if any untrusted-PR-eval artifact is present in its environment. Called at the very start of `runCleanRoomSigner`, before any key interaction.

**Sentinel files that trigger rejection:**
- `untrusted-pr-eval-active`
- `stages-1-3-output`
- `sandbox-output`
- `.sandbox-pid`
- `untrusted-pr-eval.lock`

#### `runCleanRoomSigner(opts: CleanRoomSignerOptions): CleanRoomSignerResult`

**Synchronous.** Main entry point for Stage 4. Applies the full trust boundary in strict order:

1. Isolation check (AC#8) — refuses if sentinel detected; key is NEVER touched.
2. Read + parse the unsigned report JSON from `opts.reportArtifactPath`.
3. Zod-validate against `UntrustedPrReportSchema` (BEFORE key resolution — AC#5).
4. Cross-validate `report.headSha` against `opts.headSha` (TOCTOU guard).
5. Check `consensus.approved === true` and no reviewer rejected/detected injection (AC#4).
6. Resolve signing key via `resolveSigningKeyPath()`.
7. Build RFC-0042 v6 Merkle tree from transcript leaves.
8. Sign Merkle root with operator ed25519 key.
9. Write `.ai-sdlc/attestations/<patchId>.v6.dsse.json`.

Returns a typed discriminated union — callers MUST check `result.success` before accessing `result.report` / `result.envelopePath`.

```ts
interface CleanRoomSignerOptions {
  /** Absolute path to the unsigned report artifact file. */
  reportArtifactPath: string;
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Task ID used to select which transcript leaves belong to this PR. */
  taskId: string;
  /** Git commit SHA of the PR head. Bound to the envelope subject. */
  headSha: string;
  /** Optional content-addressed patch-id (AISDLC-398). */
  patchId?: string;
  /** Optional identity string embedded in the attestation envelope. */
  signerIdentity?: string;
  /**
   * Working directory for the isolation-invariant check (AC#8).
   * Defaults to `process.cwd()`. MUST be the operator's directory, not the sandbox.
   */
  workDir?: string;
}

type CleanRoomSignerResult = CleanRoomSignerSuccess | CleanRoomSignerFailure;

interface CleanRoomSignerSuccess {
  success: true;
  report: UntrustedPrReport;
  envelopePath: string;
}

interface CleanRoomSignerFailure {
  success: false;
  phase: 'isolation-check' | 'artifact-read' | 'zod-validation'
       | 'consensus-rejected' | 'key-resolution' | 'signing';
  error: string;
}
```

#### `unsignedReportPath(repoRoot: string, prNumber: number): string`

Derive the standard unsigned-report artifact path for a given PR number.

Layout: `<repoRoot>/.ai-sdlc/ucvg/reports/<prNumber>.unsigned.json`. Both the sandbox runner (Stage 2/3) and the clean-room signer (Stage 4) use this function to guarantee path agreement.

---

## `untrusted-pr-gate.yml` — Workflow Input/Output Contracts

**Trigger:** `pull_request_target` on `opened`, `synchronize`, `reopened`, `ready_for_review` against `main`.

### Inputs (via repository variable + PR event context)

| Source | Name | Type | Description |
|--------|------|------|-------------|
| Repository variable | `AI_SDLC_UNTRUSTED_PR_GATE` | string | Feature flag. Truthy: `1`, `true`, `yes`, `on` (case-insensitive). Default: `off`. |
| PR event | `github.event.pull_request.user.login` | string | PR author GitHub login. |
| PR event | `github.event.pull_request.head.repo.fork` | boolean | Whether the PR head is from a fork. |
| PR event | `github.event.pull_request.head.sha` | string | PR head commit SHA. |
| PR event | `github.event.pull_request.base.sha` | string | PR base commit SHA. |
| Repository secret | `AISDLC_SIGNING_KEY_PATH` | string | Path to the signing key (only in `clean-room-sign` job). |

### Job outputs

| Job | Output key | Type | Description |
|-----|------------|------|-------------|
| `classify-and-gate` | `trust` | `trusted` \| `untrusted` | Stage 0 classification. |
| `classify-and-gate` | `gate_outcome` | `pass` \| `abort-protected-path` | Stage 1 result. |
| `classify-and-gate` | `flag_on` | `true` \| `false` | Whether the feature flag is ON. |
| `classify-and-gate` | `deployment_mode` | `ci` \| `local` | Deployment mode from config. |
| `classify-and-gate` | `offending_paths` | string | Space-separated offending path list. |
| `sandbox-and-review` | `report_artifact` | string | Path to unsigned report (empty if degraded). |
| `sandbox-and-review` | `sandbox_available` | `true` \| `false` | Whether OpenShell was detected. |
| `sandbox-and-review` | `degraded` | `true` \| `false` | Whether degradation mode engaged. |

### Commit status contexts posted

| Context | When | State |
|---------|------|-------|
| `ai-sdlc/untrusted-pr-gate` | Stage 1 abort (protected-path) | `failure` |
| `ai-sdlc/untrusted-pr-gate` | Stage 2 degraded (sandbox unavailable) | `failure` |
| `ai-sdlc/untrusted-pr-gate` | Stage 4 success + `consensus.approved: true` | `success` |
| `ai-sdlc/untrusted-pr-gate` | Stage 4 failure | `failure` |
| `ai-sdlc/untrusted-pr-gate` | Pipeline error (watchdog job) | `failure` |
| `ai-sdlc/untrusted-pr-gate` | Flag off | `success` (skipped, neutral) |
| `ai-sdlc/untrusted-pr-gate` | Trusted author | `success` (skipped, neutral) |

### Security properties

- **Fork-PR safety guard #1:** Workflow logic executes from `main` checkout (no `ref:` on first `actions/checkout`). Fork-controlled code never runs in the workflow runner.
- **Fork-PR safety guard #2:** PR content is checked out into `pr-content/` (read-only data) for diff computation only.
- **Fork-PR safety guard #3:** `pnpm install`/`build` only run from the `main` checkout.
- **Fork-PR safety guard #4:** No fork-provided actions (`uses:`). All pinned to vetted publishers by commit SHA.
- **Fork-PR safety guard #5:** Signing key secret only present in `clean-room-sign` job — never in `sandbox-and-review` or `classify-and-gate` jobs.

---

## CLI — `cli-ucvg.mjs`

The UCVG CLI (`pipeline-cli/bin/cli-ucvg.mjs`) exposes subcommands for workflow-level invocation.

```
node pipeline-cli/bin/cli-ucvg.mjs <subcommand> [flags]
```

### Subcommands

#### `classify`

Run Stage 0 trust classification. Outputs trust value to stdout.

```bash
node pipeline-cli/bin/cli-ucvg.mjs classify \
  --author <github-login> \
  --is-fork <true|false> \
  --work-dir <repo-root>
```

Output: `trusted` or `untrusted` (single line, stdout).

#### `ast-gate`

Run Stage 1 AST gate. Reads changed file paths from stdin (newline-separated).

```bash
printf '%s\n' "$CHANGED_FILES" | node pipeline-cli/bin/cli-ucvg.mjs ast-gate \
  --pr-number <number> \
  --author <github-login> \
  --work-dir <repo-root>
```

Output (last line of stdout): JSON object `{ outcome, offendingPaths, heuristicFindings }`.

#### `sandbox-run`

Run Stages 2/3 (sandbox + reviewer matrix). Emits unsigned report artifact.

```bash
node pipeline-cli/bin/cli-ucvg.mjs sandbox-run \
  --pr-number <number> \
  --head-sha <sha> \
  --base-sha <sha> \
  --pr-content-dir <path> \
  --work-dir <repo-root> \
  --output-dir <path>
```

Output: unsigned report at `<output-dir>/<pr-number>.unsigned.json`.

#### `clean-room-sign`

Run Stage 4 (clean-room attestation). Reads unsigned report; emits signed DSSE envelope.

```bash
node pipeline-cli/bin/cli-ucvg.mjs clean-room-sign \
  --report-path <path> \
  --pr-number <number> \
  --head-sha <sha> \
  --work-dir <repo-root>
```

Output: DSSE envelope at `.ai-sdlc/attestations/<patchId>.v6.dsse.json`.

---

## Configuration Files

### `.ai-sdlc/untrusted-pr-gate.yaml`

Adopter-configurable Stage 1 + sandbox configuration. All fields optional; absent fields fall back to RFC-0043 defaults.

```yaml
# Stage 1 config
protectedPaths:         # Full-replacement list (not merge); must include defaults you want
  - '.github/**'
  - '**/package.json'
  - '**/pnpm-lock.yaml'
  - '**/package-lock.json'
  - '**/yarn.lock'
  - '.ai-sdlc/**'
  - 'ai-sdlc-plugin/agents/**'

allowedMutationGlobs:   # Full-replacement list
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.jsx'
  - '**/*.md'

contentHeuristics:
  packageJsonLifecycleScripts: abort  # or: warn
  newGithubActionUses: abort          # or: warn

# Stage 2/3 config
sandboxDriver: docker         # or: podman | kata | gvisor | microvm
complianceRegime: none        # or: hipaa | fedramp-high | pci-dss-level-1
deployment: ci                # or: local

differentialTest:
  resourceLimits:
    wallClockSeconds: 600     # 10 min default
    cpuCores: 2
    memoryMb: 4096            # 4 GB default
    perTestTimeoutSeconds: 60 # optional per-test cap
```

### `.ai-sdlc/untrusted-pr.openshell.yaml`

OpenShell sandbox policy (Stage 2/3). This file is read by the OpenShell runtime and enforces:

- Filesystem isolation (Landlock LSM): read-only `/usr`, `/lib`, `/etc`; read-write `/sandbox`, `/tmp`.
- Process isolation (seccomp-BPF): blocks `mount`, `pivot_root`, `ptrace`, `bpf`.
- Network isolation (OPA/Rego deny-by-default): only `github.com` via `git` binary allowed.
- Inference routing: provider API key injected at `inference.local` proxy — never in sandbox env.

---

## See Also

- [Operator Runbook](../operations/untrusted-contributor-pr-verification.md)
- [Adopter Explainer](../concepts/untrusted-contributor-verification.md)
- [Promotion Runbook](../operations/untrusted-pr-gate-promotion.md)
- [RFC-0043](../../spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md)
- [RFC-0042 API Reference](rfc-0042-attestation.md) (signing key resolution, Merkle tree construction)
