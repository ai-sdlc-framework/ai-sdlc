---
id: AISDLC-502
title: 'docs: RFC-0043 Phase 6 — operator runbook + API reference + conformance test suite + glossary + adopter explainer'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - phase-6
  - docs
  - conformance
dependencies:
  - AISDLC-497
  - AISDLC-498
  - AISDLC-499
  - AISDLC-500
  - AISDLC-501
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0043. Adopter-facing surfaces + conformance gates + cross-OQ Decision-Catalog hooks documented in operator runbook. Closes the `requiresDocs: [operator-runbook, api-reference]` deferred-docs deadline (2026-08-31 per frontmatter).

## Scope (RFC-0043 §Acceptance Criteria + §requiresDocs)

### Operator runbook (`docs/operations/untrusted-contributor-pr-verification.md`)

Sections:
- **When to enable UCVG**: criteria (org has external contributors; RFC-0022 regime declared; etc.); composition with existing RFC-0042 attestation
- **Authoring trusted-reviewers.yaml**: schema reference; author allowlist extension; drift-detection workflow setup
- **Stage 0/1 troubleshooting**: how to interpret `needs-maintainer-review` labels; AST gate finding format; protected-path violations and remediation
- **Sandbox driver selection**: Docker default trade-offs; when to opt into Kata/gVisor; RFC-0022 regime override semantics (HIPAA/FedRAMP/PCI-DSS Level 1 → MicroVM required)
- **Resource limit tuning**: defaults (10min/2 cores/4GB/deny network) + when to override + reading `Decision: untrusted-pr-resource-exhausted` patterns
- **Reading the unsigned report**: report schema explanation; how to interpret each section
- **Clean-room signer operation**: trust boundary; what happens if signer rejects (Zod validation failure)
- **Reviewer hardening**: injection-attempt finding shape; what to do when it fires
- **Degradation mode**: when it engages; operator response; how to restore full path
- **Decision-Catalog hooks**: what each Decision means and how to respond
  - `trusted-reviewers-file-drift-detected` (Phase 1 drift workflow)
  - `untrusted-pr-resource-exhausted` (Phase 3 sandbox)
  - `untrusted-pr-sigstore-anchor-request` (Phase 2 OQ-4 hook)
  - `stage-1-content-heuristic-addition-request` (Phase 1 OQ-6 hook)
  - `prompt-injection-corpus-extension-request` (Phase 4 OQ adjacent hook)
  - `untrusted-pr-gate-degraded-mode` (Phase 5 degradation)

### API reference (`docs/api-reference/rfc-0043-ucvg.md`)

Type signatures + invocation contracts for:
- `trust-classifier.ts` exports (`classifyTrust`, types)
- `ast-gate.ts` exports (`runAstGate`, `AstGateOutcome`)
- `sandbox-runner.ts` exports (`spawnSandbox`, `SandboxConfig`, lifecycle hooks)
- `report-validator.ts` exports (`UntrustedPrReportSchema`, `validateReport`)
- Clean-room signer interface
- Workflow input/output contracts for `untrusted-pr-gate.yml`

### Conformance test suite

Comprehensive test suite covering:
- **AC-1**: untrusted PR modifying protected paths blocked by Stage 1 with ZERO LLM/sandbox spend
- **AC-2**: sandbox cannot read host's high-privilege tokens (sandbox-escape exfiltration-attempt test)
- **AC-3**: prompt-injection snippet surfaces as finding, not obeyed; clean-room signer mints valid RFC-0042 v6 attestation only after Zod boundary validates
- All 6 OQ resolutions verified by hermetic tests (drift detection, CI default deployment, resource limits, operator-key-only signing, regime override, content-heuristic boundary)
- End-to-end test: synthetic untrusted PR with: (a) clean source change → full path succeeds; (b) protected-path mutation → Stage 1 abort; (c) DoS test → Stage 3 resource exhaustion abort; (d) injection-attempt → Stage 4 reviewer finding

### Glossary additions

- `UCVG` — Untrusted-Contributor Verification Gate
- `Trust classification` — Stage 0 deterministic trusted/untrusted determination
- `Protected paths` — Stage 1 hard-block path list
- `OpenShell sandbox` — NVIDIA OpenShell policy-enforced sandbox runtime
- `Differential testing` — running upstream suite + contributor's new tests inside sandbox
- `Clean-room attestation` — Stage 4 signing in environment that never touched untrusted code
- `Unsigned report artifact` — sandbox-emitted Zod-validated report consumed by clean-room signer
- `Credential withholding` — proxy-layer credential injection that withholds tokens from sandbox process
- `Prompt-injection-attempt finding` — Stage 3 reviewer finding category for embedded injection attempts

### Adopter explainer (`docs/concepts/untrusted-contributor-verification.md`)

Plain-language explainer:
- Why the framework needs UCVG (zero-trust verification for external/fork PRs)
- How it composes with RFC-0042 (Merkle attestation substrate)
- What changes for the maintainer (per OQ-2 CI default — minimal operational change)
- What changes for the contributor (Stage 1 may auto-abort PRs touching protected paths; clear feedback comment; no LLM/sandbox cost burned)
- Migration pattern from open / allowlist / allowlist+role (composes with RFC-0022)

### Promotion runbook

`docs/operations/untrusted-pr-gate-promotion.md`:
- Operator-driven default-on flip per RFC-0014 / RFC-0015 convention
- Corpus-driven: InternalAdopter validation must complete without regressions before promotion
- Decision routing: `AI_SDLC_UNTRUSTED_PR_GATE` flag flip via operator authorization

## Composes with

- AISDLC-497..501 (Phases 1-5): every doc surface cross-references the implementation tasks
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/operations/untrusted-contributor-pr-verification.md` published with all 10 runbook sections
- [ ] #2 `docs/api-reference/rfc-0043-ucvg.md` published with type signatures + invocation contracts
- [ ] #3 Conformance test suite covers AC-1, AC-2, AC-3 from RFC + all 6 OQ resolutions
- [ ] #4 End-to-end test: synthetic untrusted PR with 4 scenarios (clean / protected-path / DoS / injection)
- [ ] #5 Glossary additions ship (9 terms)
- [ ] #6 `docs/concepts/untrusted-contributor-verification.md` adopter explainer published
- [ ] #7 `docs/operations/untrusted-pr-gate-promotion.md` runbook published; ties promotion to corpus-driven evidence per RFC-0014/RFC-0015 pattern
- [ ] #8 Each runbook section cross-links to the relevant RFC-0043 §OQ resolution + implementer task
- [ ] #9 `requiresDocs: [operator-runbook, api-reference]` deferred-docs deadline (2026-08-31) met
<!-- AC:END -->
