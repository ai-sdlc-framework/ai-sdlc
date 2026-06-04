# RFC-0043 UCVG Threat-Model Conformance Evidence

**Phase 7 AC#5 — conformance evidence for the whitepaper threat model.**

This document maps each threat vector to its blocking stage, expected outcome,
and the test that asserts the property. It serves as the conformance evidence
referenced by the RFC-0043 threat model.

## Threat Model Vectors

The UCVG pipeline defends against 7 adversarial vectors (plus 1 benign baseline).
Each vector is exercised by a fixture in the corpus
(`pipeline-cli/src/pipeline/ucvg-threat-fixtures.ts`).

---

## Vector 1: benign

**Description:** Legitimate contributor adds a TypeScript utility and its test.

**Blocking stage:** none (passes all stages)

**Expected outcome:** `pass` + valid attestation

**How the property is asserted:**

1. `runAstGate(changedFiles)` returns `outcome: 'pass'` (Stage 1).
2. `MockSandboxDriver` (or real Docker) returns `outcome: 'success'` (Stage 2/3).
3. `validateReport(report)` returns `valid: true` with `consensus.approved: true` (Stage 4).
4. The clean-room signer proceeds to build the Merkle attestation.

**Test files:**
- Hermetic: `pipeline-cli/src/pipeline/ucvg-threat-hermetic.test.ts` — `Vector 1: benign`
- Integration: `pipeline-cli/src/pipeline/ucvg-threat-harness.test.ts` — `Vector 1 [integration]`

---

## Vector 2: protected-path-mutation

**Description:** Attacker modifies `.github/workflows/ci.yml` to inject RCE via workflow step.

**Blocking stage:** `stage-1-ast-gate`

**Expected outcome:** `abort-protected-path`

**How the property is asserted:**

1. `runAstGate([{ path: '.github/workflows/ci.yml', status: 'modified' }])` returns
   `outcome: 'abort-protected-path'` immediately.
2. `offendingPaths` contains `.github/workflows/ci.yml`.
3. `buildBlockedComment()` produces a comment naming the offending path + `needs-maintainer-review`.
4. `buildBlockedEvent()` has `type: 'UntrustedPrBlockedByProtectedPath'` and no AISDLC-NNN IDs.
5. **No sandbox or LLM is invoked** — Stage 1 abort is the terminal state.

**Security property:** `.github/**` is a protected path per RFC-0043 §Stage 1 defaults.
Any mutation to CI/CD configuration is an RCE-via-workflow vector. Zero LLM/sandbox spend
on block — cost is O(file-count × glob-match).

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 2: protected-path-mutation`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 2 [integration]`

---

## Vector 3: lifecycle-script-injection

**Description:** Attacker adds `postinstall` lifecycle script to `package.json`.

**Blocking stage:** `stage-1-ast-gate`

**Expected outcome:** `abort-protected-path`

**How the property is asserted:**

1. `runAstGate([{ path: 'package.json', status: 'modified' }])` returns
   `outcome: 'abort-protected-path'` via the protected-path check
   (`**/package.json` is in `DEFAULT_PROTECTED_PATHS`).
2. `detectLifecycleScriptAdditions(after, before)` independently catches `postinstall`
   — this is the belt-and-suspenders content heuristic (fires for custom configs
   that might narrow `protectedPaths`).

**Security property:** `package.json` lifecycle scripts (`preinstall`, `postinstall`,
`prepare`) are a supply-chain attack surface — they execute arbitrary code during
`npm install`. The path check blocks before any content inspection is needed.

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 3: lifecycle-script-injection`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 3 [integration]`

---

## Vector 4: github-action-injection

**Description:** Attacker embeds a `uses:` reference inside a `.ts` file to slip
past the `.github/**` path check.

**Blocking stage:** `stage-1-ast-gate`

**Expected outcome:** `abort-protected-path` (via content heuristic)

**How the property is asserted:**

1. The changed file path (`src/ci/workflow-generator.ts`) is NOT a protected path —
   the path check passes.
2. The `newGithubActionUses` content heuristic detects a net-new `uses:` line in the
   `.ts` file content — `heuristicFindings` contains a `newGithubActionUses` entry.
3. `runAstGate()` returns `outcome: 'abort-protected-path'` due to the heuristic finding.

**Security property:** Workflow action injection via `.ts` template literals is
a bypass attempt. The content heuristic provides belt-and-suspenders coverage for
files that pass path checks but contain embedded workflow YAML.

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 4: github-action-injection`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 4 [integration]`

---

## Vector 5: prompt-injection

**Description:** Diff comment embeds reviewer-override instructions to force approval.

**Blocking stage:** `stage-3-reviewer`

**Expected outcome:** `promptInjectionDetected: true` in security reviewer verdict;
`consensus.approved: false`; Stage 4 signer refuses.

**How the property is asserted:**

1. Stage 1 AST gate returns `pass` (`.ts` file, not a protected path).
2. Stage 3 security reviewer detects injection via delimiter framing +
   post-content instruction restate (RFC-0043 §Stage 3 hardening).
3. Reviewer verdict has `promptInjectionDetected: true` and `approved: false`.
4. `consensus.approved` is `false` with `blockingFindings > 0`.
5. `validateReport(report)` returns `valid: true` (the schema IS correct — the
   injection is a finding, not malformed data).
6. The clean-room signer checks `consensus.approved` before key resolution and
   refuses to sign.

**Security property:** Prompt injection in attacker-controlled diff content is
the primary LLM-threat in an AI-review pipeline. The injection is SURFACED as a
critical security finding — it is NOT obeyed. The Zod-before-key invariant ensures
a forged "approved" signal cannot trick the signer even if injection partially succeeds.

**Integration gap:** The real reviewer call (Stage 3) requires a live inference proxy
+ LLM API key. The hermetic tests verify the PROPERTY contractually; the real-Docker
harness verifies the proxy lifecycle (port binding, session token withholding).

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 5: prompt-injection`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 5 [integration]`

---

## Vector 6: credential-exfiltration

**Description:** Sandbox process attempts to read the signing key, write tokens,
or reach external hosts.

**Blocking stage:** `stage-3-reviewer` (exfil is prevented at the runtime layer)

**Expected outcome:** All exfiltration attempts are blocked by:
1. `validateSandboxEnv()` — rejects `GITHUB_TOKEN`/`NPM_TOKEN`/`AI_SDLC_PAT`/signing-key paths
2. Docker `--network=none` — blocks direct external host calls
3. Read-only root filesystem — signing key path is not mounted
4. `InferenceProxy` tool-use refusal — `tools`/`tool_choice` in request → 422

**How the property is asserted (hermetic):**

1. `validateSandboxEnv({ GITHUB_TOKEN: 'ghs_secret' })` throws — credential not in sandbox env.
2. `validateSandboxEnv({ AI_SDLC_PAT: 'ghp_...' })` throws.
3. `validateSandboxEnv({ MY_SIGNING_KEY_PATH: '...' })` throws (substring check).
4. `DEFAULT_SANDBOX_CONFIG` has no `sandboxEnv` field.
5. `MockSandboxDriver.spawn({ sandboxEnv: { GITHUB_TOKEN: ... } })` rejects.
6. `detectSandboxArtifacts(dirWithSentinel)` returns the sentinel name — signer refuses
   to run if sandbox sentinels are present.
7. `InferenceProxy` can be constructed with a credential — the proxy withholds it.

**How the property is asserted (real-Docker integration):**

- The container env is constructed as `{ PATH, SANDBOX_PR_DIFF_B64 }` only —
  no host secrets are inherited.
- `docker run --network=none` blocks any `curl`/`fetch` to external hosts.
- `docker run --read-only` prevents writes to the host filesystem.
- The proxy session token is a random hex string, NOT the raw API key.

**Security property (AC#3):** The signing key is never injected into the sandbox
process environment. The sandbox can only reach `inference.local` (the proxy) —
no external hosts. The proxy withholds the provider credential and only exposes
a session-scoped token. Even if the attacker fully controls the sandbox process,
they cannot extract signing material or reach external exfiltration endpoints.

**Integration gap:** Kernel-level network namespace enforcement (`--network=none`)
and filesystem isolation can only be tested with a real Docker daemon. The hermetic
tests verify the TypeScript-layer enforcement (validateSandboxEnv, proxy construction).

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 6: credential-exfiltration`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 6 [integration]`

---

## Vector 7: resource-exhaustion

**Description:** Attacker submits infinite-loop tests to exhaust the sandbox wall-clock budget.

**Blocking stage:** `stage-3-reviewer` (runner level — sandbox kill)

**Expected outcome:** `outcome: 'resource-breach'` with `breachType: 'wall-clock'`; fail-closed.

**How the property is asserted:**

1. Stage 1 passes (`.ts` file — not a protected path).
2. `MockSandboxDriver` with `buildResourceBreachSandboxResult()` returns `outcome: 'resource-breach'`.
3. `breach.breachType === 'wall-clock'` and `breach.limit === 600`.
4. `buildResourceBreachComment()` names the wall-clock limit; no AISDLC-NNN IDs.
5. A report produced after a breach has `consensus.approved: false` — signer refuses.
6. `runSandbox()` with a 1-second config + delayed mock → result is `resource-breach`.

**Security property:** Infinite-loop tests are a DoS vector. The sandbox enforces
a wall-clock timeout via `AbortController` + `docker kill`. The breach result is
ALWAYS treated as `consensus.approved: false` — there is no path from resource breach
to a signed attestation. Fail-closed is the invariant.

**Integration gap:** Real `docker kill` enforcement requires a running container.
The hermetic tests verify the breach-result shape and the signer's response to it.

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 7: resource-exhaustion`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 7 [integration]`

---

## Vector 8: report-forgery

**Description:** Attacker forges the unsigned report artifact with injected keys or wrong
schemaVersion to bypass Stage 4 validation.

**Blocking stage:** `stage-4-refusal` (Zod parse rejection)

**Expected outcome:** `validateReport()` returns `valid: false`; signing key never resolved.

**How the property is asserted:**

1. `forgeReport(base, { signature: 'forged-sig' })` → `validateReport()` returns `valid: false`
   (`.strict()` rejects unknown key `signature`).
2. `forgeReport(base, { schemaVersion: 'injected-version' })` → rejected (wrong literal).
3. `forgeReport(base, { autoApproved: true })` → rejected (unknown key).
4. `forgeReport(base, { override: { skipSigning: true } })` → rejected (unknown key).
5. Omitting `promptInjectionDetected` from a reviewer verdict → rejected (required field).
6. The clean-room signer calls `validateReport()` BEFORE `resolveSigningKeyPath()` —
   the signing key is never read when the report is invalid.

**Security property:** Zod-before-key is the Stage 4 trust boundary. All reviewer
verdict schemas use `.strict()` to reject unknown keys. A compromised sandbox cannot
forge a valid attestation by injecting extra fields into the unsigned report artifact.

**Test files:**
- Hermetic: `ucvg-threat-hermetic.test.ts` — `Vector 8: report-forgery`
- Integration: `ucvg-threat-harness.test.ts` — `Vector 8 [integration]`

---

## Irreducible Integration Gaps

The following behaviors require a real Docker daemon to test and cannot be hermetically
verified. They are documented here per AC#4 + the task brief's honesty requirement:

| Gap | Why hermetic tests cannot cover it | How to run |
|-----|-------------------------------------|------------|
| Real Docker container lifecycle (spawn, cidfile poll, kill, teardown) | Requires a real container runtime and kernel namespaces | `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 pnpm --filter @ai-sdlc/pipeline-cli test ucvg-threat-harness` |
| Real network deny (`--network=none` blocks external host calls) | Linux kernel network namespace enforcement | Same as above |
| Real filesystem isolation (read-only root fs + tmpfs workspace) | Linux kernel mount namespace + overlay FS | Same as above |
| Real wall-clock enforcement (AbortController + `docker kill`) | Requires a running process that actually blocks | Same as above |
| Real inference.local proxy binding (port allocation) | Requires `net.createServer()` bind on a live network interface | Same as above |
| Real LLM reviewer call (prompt injection detection in production) | Requires a live Anthropic/OpenAI API key and a running model | Operator-run; costs real API tokens |

## How to Run the Integration Harness

```bash
# Prerequisites:
# 1. Docker daemon running (verify: docker info)
# 2. Optionally: set AI_SDLC_SANDBOX_IMAGE to the container image to use

# Run only the gated integration tests
AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 \
AI_SDLC_SANDBOX_IMAGE=node:22-slim \
  pnpm --filter @ai-sdlc/pipeline-cli test src/pipeline/ucvg-threat-harness.test.ts

# Run only the hermetic tests (no Docker required)
pnpm --filter @ai-sdlc/pipeline-cli test src/pipeline/ucvg-threat-hermetic.test.ts

# Run both
AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 \
  pnpm --filter @ai-sdlc/pipeline-cli test src/pipeline/ucvg-threat-

# The harness writes conformance evidence to a temp dir and logs the path.
# The renderConformanceTable() output is also printed to stdout.
```

## Related Files

| File | Role |
|------|------|
| `pipeline-cli/src/pipeline/ucvg-threat-fixtures.ts` | Fixture corpus (one per vector) + builder helpers |
| `pipeline-cli/src/pipeline/ucvg-threat-hermetic.test.ts` | Hermetic tests (no Docker) |
| `pipeline-cli/src/pipeline/ucvg-threat-harness.test.ts` | Real-Docker integration harness (gated) |
| `pipeline-cli/src/pipeline/ast-gate.ts` | Stage 1 implementation |
| `pipeline-cli/src/pipeline/sandbox-runner.ts` | Stage 2/3 implementation |
| `pipeline-cli/src/pipeline/inference-proxy.ts` | inference.local credential-withholding proxy |
| `pipeline-cli/src/pipeline/report-validator.ts` | Stage 4 Zod boundary schema |
| `pipeline-cli/src/pipeline/clean-room-signer.ts` | Stage 4 signing-key isolation |
| `spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md` | Source of truth for threat model |
