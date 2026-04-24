# RFC-0007: Figma Make Pipeline Integration

**Document type:** Normative (final)
**Status:** Final v1 — Figma Make Canonicalization, Validation Pipeline, DesignPrototypeProvider Adapter
**Created:** 2026-04-05
**Revised:** 2026-04-13
**Authors:** [Author Name]
**Reviewers:** [Design Leadership], [Engineering / Agent Systems], [Product Leadership]
**Spec version:** v1alpha1
**Requires:** RFC-0002 (Pipeline Orchestration), RFC-0004 (CostPolicy), RFC-0006 (Design System Governance v5)

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Dominique Legault | CTO / Engineering Authority | ✅ Approved | 2026-04-13 |
| Morgan Hirtle | Chief of Design / Design Authority | ✅ Approved | 2026-04-13 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Approved | 2026-04-04 |

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-04-05 | Initial draft. Escalated from RFC-0006 OQ-3. Defines: `DesignPrototype` resource type, `DesignPrototypeProvider` adapter interface, Figma Make reference adapter, five-stage validation pipeline, `design-prototype.submitted` trigger, prototype autonomy policy extensions, audit requirements, RFC-0006 and RFC-0008 integration constraints. |
| v1 (final) | 2026-04-13 | All-pillar sign-off received. Two amendments applied per Alexander Kline Product sign-off (2026-04-04): (1) §5.4 and §8.5 (Stage 4 behavior) rewritten to remove unspecified "reduced Sα₂ score" language — replaced with `IntentTraceabilityWarning` forwarding to PPA; PPA v1.2 to quantify the penalty. (2) §14.3 added defining `AdmissionInput.sourceType` contract for prototype-derived work items entering PPA admission. Engineering sign-off (Dom Legault, 2026-04-13) and Design sign-off (Morgan Hirtle, 2026-04-13) received with no further amendments. |

---

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Problem Statement](#3-problem-statement)
4. [Proposal](#4-proposal)
5. [New Resource Type: DesignPrototype](#5-new-resource-type-designprototype)
   - [5.1 Schema Requirements](#51-schema-requirements)
   - [5.2 Canonicalization Model](#52-canonicalization-model)
   - [5.3 Binding to DesignSystemBinding](#53-binding-to-designsystembinding)
   - [5.4 Binding to DesignIntentDocument](#54-binding-to-designintentdocument)
   - [5.5 Stewardship Model](#55-stewardship-model)
6. [DesignPrototypeProvider Adapter Interface](#6-designprototypeprovider-adapter-interface)
7. [Figma Make Reference Adapter](#7-figma-make-reference-adapter)
8. [Validation Pipeline](#8-validation-pipeline)
   - [8.1 Stage Architecture and the Deterministic-First Principle](#81-stage-architecture-and-the-deterministic-first-principle)
   - [8.2 Stage 1: Structural Integrity](#82-stage-1-structural-integrity)
   - [8.3 Stage 2: Token Compliance](#83-stage-2-token-compliance)
   - [8.4 Stage 3: Catalog Coverage](#84-stage-3-catalog-coverage)
   - [8.5 Stage 4: Design Intent Traceability](#85-stage-4-design-intent-traceability)
   - [8.6 Stage 5: Design Authority Checkpoint](#86-stage-5-design-authority-checkpoint)
   - [8.7 Failure Handling and Feedback Payload](#87-failure-handling-and-feedback-payload)
   - [8.8 Admission Result and Status](#88-admission-result-and-status)
9. [Pipeline Integration](#9-pipeline-integration)
   - [9.1 New Trigger: design-prototype.submitted](#91-new-trigger-design-prototypesubmitted)
   - [9.2 New Stage Type: design-prototype-admission](#92-new-stage-type-design-prototype-admission)
   - [9.3 Transition to Governed Pipeline](#93-transition-to-governed-pipeline)
10. [AgentRole Extensions for Prototype-Driven Pipelines](#10-agentrole-extensions-for-prototype-driven-pipelines)
11. [Autonomy Policy Extensions](#11-autonomy-policy-extensions)
    - [11.1 Prototype Autonomy Levels](#111-prototype-autonomy-levels)
    - [11.2 Auto-Trigger Requirements and Earned Admission](#112-auto-trigger-requirements-and-earned-admission)
12. [Audit Requirements](#12-audit-requirements)
13. [Integration with RFC-0006](#13-integration-with-rfc-0006)
    - [13.1 API Surface Boundaries](#131-api-surface-boundaries)
    - [13.2 Token Version Compatibility](#132-token-version-compatibility)
    - [13.3 Coverage Threshold Enforcement](#133-coverage-threshold-enforcement)
14. [Integration with RFC-0008](#14-integration-with-rfc-0008)
    - [14.1 DID Association Requirements](#141-did-association-requirements)
    - [14.2 C2 Impact Constraint](#142-c2-impact-constraint)
15. [Worked Example](#15-worked-example)
16. [Security Considerations](#16-security-considerations)
17. [Alternatives Considered](#17-alternatives-considered)
18. [Open Questions](#18-open-questions)
19. [References](#19-references)

---

## 1. Summary

This RFC introduces governed Figma Make output into the AI-SDLC pipeline. It defines how non-deterministic generative design artifacts produced by Figma Make are canonicalized, validated, and admitted as deterministic pipeline triggers — without compromising the governance guarantees that RFC-0006 establishes downstream.

The proposal adds one new resource type (`DesignPrototype`), one new adapter interface (`DesignPrototypeProvider`), one reference adapter implementation (`figma-make`), a five-stage validation pipeline that gates admission before any governed pipeline stage executes, a new trigger type (`design-prototype.submitted`), and autonomy policy extensions governing when Figma Make output may auto-trigger a pipeline run versus requiring explicit design-lead approval.

RFC-0007 does not modify RFC-0006 or RFC-0008. It extends the governance chain upstream — adding a pre-pipeline admission layer that did not previously exist. RFC-0006 governs what happens inside the pipeline; RFC-0007 governs what enters it from a generative design source.

---

## 2. Motivation

### 2.1 The Generative Design Gap

RFC-0006 introduced a governed design-to-code pipeline with design tokens as the shared contract. It defines how the pipeline operates once a design artifact is admitted. What it does not define is how a designer's use of Figma Make — a generative AI tool that produces components, layouts, and interactive prototypes from natural language prompts — enters that governed pipeline in a controlled way.

Figma Make is fundamentally non-deterministic. Two runs from the same prompt produce structurally different output. The same designer, using the same library, asking for the same component, may receive different token usage patterns, different layer hierarchies, and different interaction models on successive runs. This is expected and by design — generative tools explore a solution space rather than compute a single answer.

This non-determinism is valuable at the exploration stage. It becomes a governance problem at the specification stage, when design artifacts need to be stable, traceable inputs to an AI coding pipeline. The AI-SDLC pipeline requires that two runs against the same input produce the same result. A pipeline that cannot be reproduced is a pipeline that cannot be trusted, audited, or improved.

### 2.2 The Missing Validation Layer

RFC-0006 §9.5 explicitly deferred all Figma Make concerns to this RFC:

> The Figma `DesignTokenProvider` adapter is scoped exclusively to **token extraction**. It does not cover generating components from Figma designs, reading Figma design files for layout or interaction spec, or any Figma Make workflow. Those concerns belong to RFC-0007.

No validation layer currently exists between Figma Make output and the governed pipeline entry point. A designer could, in principle, submit a Figma Make artifact that:

- References tokens not present in the active token schema
- Introduces component patterns with no catalog equivalent
- Contains no association to a `DesignIntentDocument`, making it unscoreable by PPA's Sα₂
- Has no stable structural representation (the artifact shifts on re-export)
- Was produced from a prompt written by a product manager rather than a designer, bypassing design authority

None of these failure modes are caught by RFC-0006's quality gates, which operate on agent-generated code, not on design source artifacts. RFC-0007 fills this gap.

### 2.3 The Design Authority Entrypoint

RFC-0006 §4.2 P6 establishes that design authority is a first-class governance concern. The design review gate (§8.5) enforces this inside the pipeline. But design authority must also apply at the pipeline entry point. If generative design output enters the pipeline without a checkpoint that confirms a human designer has reviewed and committed to it as the authoritative artifact, the design authority guarantee is hollow.

A Figma Make prototype that has not been reviewed and committed by a designer is not a design artifact — it is a generative suggestion. The governance chain must not treat these as equivalent.

### 2.4 Strategic Fit

Figma Make reached general availability in late 2025 as part of Figma AI. It is now the primary mechanism by which design teams at many organizations begin the component specification process. Treating it as outside the governance model is increasingly untenable as the volume of Figma Make output entering the design-to-code pipeline grows.

This RFC formalizes the relationship between generative design tooling and the AI-SDLC governance layer, consistent with the framework's core principle that every artifact that enters the pipeline — whether generated by a human, an AI coding agent, or a generative design tool — must be traceable, validated, and auditable.

---

## 3. Problem Statement

RFC-0006 defines a governed design-to-code pipeline. RFC-0007 addresses three gaps that RFC-0006 explicitly deferred:

**Problem 1 — Non-determinism.** Figma Make produces structurally different components from the same prompt on successive runs. The governed pipeline requires deterministic inputs. Accepting a non-deterministic artifact as a pipeline trigger introduces unpredictability at the source of the governance chain: a token compliance check, visual regression diff, or design review run against the original artifact cannot be reproduced against a re-export.

**Problem 2 — Absence of a validation layer.** No mechanism exists to validate Figma Make output before it enters the governed pipeline. The five concerns that require validation before admission — structural integrity, token compliance, catalog coverage, design intent traceability, and design authority confirmation — are currently unaddressed.

**Problem 3 — Missing adapter interface.** RFC-0006 defines `DesignTokenProvider`, `ComponentCatalog`, and `VisualRegressionRunner`. No adapter interface exists for reading, validating, and normalizing generative design artifacts from Figma. The `DesignPrototypeProvider` interface defined in this RFC fills that gap.

---

## 4. Proposal

### 4.1 Architectural Overview

RFC-0007 introduces a pre-pipeline admission layer that sits upstream of the RFC-0006 governed pipeline:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     FIGMA MAKE OUTPUT (raw)                          │
│  Non-deterministic generative artifacts; not yet governed resources  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  Designer selects and commits canonical run
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│              CANONICALIZATION (RFC-0007 §5.2)                        │
│  Designer selects one Figma Make run as the authoritative artifact.  │
│  The artifact is content-addressed and recorded in the audit log.    │
│  A DesignPrototype resource is created.                              │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  design-prototype.submitted trigger
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│         VALIDATION PIPELINE — Five Stages (RFC-0007 §8)              │
│                                                                      │
│  Stage 1: Structural Integrity   (deterministic)                     │
│  Stage 2: Token Compliance       (deterministic)                     │
│  Stage 3: Catalog Coverage       (deterministic)                     │
│  Stage 4: Design Intent Traceability  (deterministic)                │
│  Stage 5: Design Authority Checkpoint (human gate)                   │
│                                                                      │
│  Stages 1–4 run fully automatically, in order, without LLM.         │
│  Stage 5 is a human checkpoint; auto-skipped at qualifying           │
│  autonomy levels (see §11.2).                                        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  DesignPrototype.status.phase = Admitted
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│         RFC-0006 GOVERNED PIPELINE (unchanged)                       │
│  design-system stages, quality gates, agent context, visual          │
│  regression, design review — all per RFC-0006 specification.         │
└──────────────────────────────────────────────────────────────────────┘
```

RFC-0007 owns everything above the dashed line. RFC-0006 owns everything below it. The admission result of the RFC-0007 validation pipeline is the only input RFC-0006 needs to know about; the details of how a `DesignPrototype` was canonicalized and validated are opaque to the downstream pipeline stages.

### 4.2 Design Principles Specific to This RFC

**P1 — Canonicalization is a human act, not an automated selection.** No algorithm in this RFC selects among Figma Make runs on behalf of the designer. The designer reviews the runs, selects one, and commits it as the authoritative artifact. Automated selection strategies (e.g., "highest token compliance") are explicitly rejected — they would shift design authority from the designer to the governance system.

**P2 — Determinism is achieved by commitment, not by control.** RFC-0007 does not attempt to make Figma Make itself deterministic. That is not possible and not the goal. Determinism is achieved by the designer committing one run as canonical before it enters governance. From the governance system's perspective, the committed artifact is the artifact — the fact that it was produced non-deterministically is irrelevant once committed.

**P3 — Validation is five stages, not one gate.** Each validation stage catches a distinct failure mode. Collapsing them into a single pass/fail gate would make feedback opaque. Designers need to know whether their artifact failed on token compliance or catalog coverage — these require different remediation actions.

**P4 — Deterministic checks run before any LLM evaluation.** Stages 1–4 are fully deterministic. No LLM is invoked during these stages. This is consistent with RFC-0006's deterministic-first principle (Addendum A) and ensures that validation results are reproducible and auditable without token cost.

**P5 — The design authority checkpoint is not optional below the qualifying autonomy level.** Stage 5 requires a human designer to confirm that the committed artifact represents their intent before it enters the governed pipeline. This is not a formality — it is the enforcement point for design authority at the pipeline entry. Teams that want to skip Stage 5 entirely must earn that capability through the autonomy policy (§11.2).

**P6 — A DesignPrototype without a DesignIntentDocument association has reduced pipeline admission scoring.** An artifact that cannot be traced to a `DesignIntentDocument` will receive a degraded Sα₂ score in PPA admission (per RFC-0008 §5). RFC-0007 does not block DID-less prototypes from admission, but it records the absence as a `IntentTraceabilityWarning` in the audit log and notifies the design authority.

---

## 5. New Resource Type: DesignPrototype

A `DesignPrototype` declares a canonicalized Figma Make output as a governed resource with validation requirements. It is created by the orchestrator when a designer commits a Figma Make run via the canonicalization flow (§5.2).

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignPrototype
metadata:
  name: checkout-redesign-prototype-001
  namespace: team-frontend
  labels:
    feature: checkout-redesign
    designer: morgan-hirtle
    source: figma-make
  annotations:
    ai-sdlc.io/figma-file-id: "aBcDeFgHiJkLmNoP"
    ai-sdlc.io/figma-frame-id: "1234:5678"
    ai-sdlc.io/figma-make-run-id: "run_2026040512345"
    ai-sdlc.io/canonical-hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
spec:
  # --- SOURCE ---
  source:
    provider: figma-make                  # Must reference a DesignPrototypeProvider
    fileId: "aBcDeFgHiJkLmNoP"           # Figma file ID
    frameIds:                             # One or more top-level frames
      - "1234:5678"
      - "1234:5679"
    makeRunId: "run_2026040512345"        # Figma Make run ID; immutable after canonicalization
    exportFormat: figma-json              # figma-json | svg | png (figma-json required for validation)
    exportedAt: "2026-04-05T14:32:00Z"   # Timestamp of the export used for canonicalization

  # --- CANONICALIZATION ---
  canonicalization:
    committedBy: "morgan-hirtle"          # Principal who committed this run as canonical
    committedAt: "2026-04-05T14:35:00Z"
    contentHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    # Content hash is computed over the exported figma-json artifact.
    # Any re-export produces a new hash; if the new hash differs, a new
    # DesignPrototype must be created. The orchestrator MUST reject pipeline
    # triggers referencing a DesignPrototype whose stored hash does not
    # match a fresh hash of the current Figma export.

  # --- BINDING TO DESIGN SYSTEM ---
  designSystemRef:
    name: acme-design-system             # Must reference an existing DesignSystemBinding
    namespace: team-frontend
    tokenSchemaVersion: "3.2.1"          # Token schema version active at canonicalization time
    # The validation pipeline will reject admission if the active token schema
    # version has advanced beyond what is permitted by the DesignSystemBinding's
    # versionPolicy relative to this pinned version.

  # --- BINDING TO DESIGN INTENT ---
  intentRef:
    name: acme-product-intent            # Reference to a DesignIntentDocument (RFC-0008)
    namespace: product-acme
    required: true                       # true | false
    # If required: true and no intentRef is resolvable, Stage 4 fails hard.
    # If required: false, Stage 4 emits an IntentTraceabilityWarning instead of failing.

  # --- VALIDATION POLICY ---
  validationPolicy:
    stage1:                              # Structural Integrity
      minimumLayerCount: 1
      requiresInteractionSpec: false     # true requires at least one defined interaction
      allowEmptyFrames: false
    stage2:                              # Token Compliance
      minimumTokenCoverageRate: 0.80     # At least 80% of resolvable values must use tokens
      hardcodeCategories: [color, spacing, typography]
      # Any hardcoded value in the above categories fails Stage 2 regardless of
      # the overall coverage rate.
    stage3:                              # Catalog Coverage
      minimumCatalogCoverageRate: 0.60   # At least 60% of component patterns must resolve
                                         # to existing catalog entries
      allowNewComponentPatterns: true    # false blocks admission if any uncatalogued pattern is found
    stage4:                              # Design Intent Traceability
      requireDIDAssociation: true        # Mirrors intentRef.required above
    stage5:                              # Design Authority Checkpoint
      requireDesignLeadApproval: true    # Can be overridden by autonomy policy (§11.2)
      approvalTimeout: "PT72H"           # ISO 8601 duration
      onTimeout: fail                    # fail | escalate | auto-approve

  # --- PIPELINE TRIGGER CONFIGURATION ---
  pipelineTrigger:
    targetPipeline: "frontend-checkout-pipeline"
    targetNamespace: team-frontend
    triggerOnAdmission: true             # Emit design-prototype.submitted on admission
    agentContextIncludes:
      - figma-json                       # Full structural export for agent context
      - token-bindings                   # Resolved token references
      - catalog-matches                  # Matched catalog components with confidence scores

status:
  phase: Validating                      # Created | Canonicalized | Validating | Admitted | Rejected | Expired
  validationRun:
    startedAt: "2026-04-05T14:35:05Z"
    stages:
      stage1: { status: Passed, completedAt: "2026-04-05T14:35:06Z" }
      stage2: { status: Passed, completedAt: "2026-04-05T14:35:07Z", tokenCoverageRate: 0.87 }
      stage3: { status: Running }
      stage4: { status: Pending }
      stage5: { status: Pending }
  admissionRecord: null                  # Populated on Admitted
  rejectionRecord: null                  # Populated on Rejected
  auditRef: "audit-entry-7f3a9b2c"
```

### 5.1 Schema Requirements

The `DesignPrototype` resource MUST be validated against JSON Schema (draft 2020-12). Required fields:

- `spec.source.provider` — MUST reference a registered `DesignPrototypeProvider` adapter binding
- `spec.source.fileId` — MUST be a non-empty string
- `spec.source.makeRunId` — MUST be present and immutable after creation
- `spec.canonicalization.committedBy` — MUST be a principal with `designAuthority` in the referenced `DesignSystemBinding`
- `spec.canonicalization.contentHash` — MUST be a `sha256:` prefixed hex string of the exported artifact
- `spec.designSystemRef.name` — MUST reference an existing `DesignSystemBinding`
- `spec.validationPolicy` — MUST be fully specified; no implicit defaults

The orchestrator MUST reject `DesignPrototype` creation requests where `spec.canonicalization.committedBy` is not a principal with design authority. Designers can create `DesignPrototype` resources for their own work; pipeline automation may not create them on behalf of a designer.

### 5.2 Canonicalization Model

Non-determinism is resolved at the canonicalization step, before any validation occurs. Canonicalization is a human act — the designer selects one Figma Make run and commits it as the authoritative artifact for the governance chain.

**What canonicalization does:**

1. The designer selects one Figma Make run from the available outputs (run selection is done in the Figma UI; the governance system does not see unchosen runs)
2. The orchestrator exports the selected run in `figma-json` format via the `DesignPrototypeProvider` adapter's `exportArtifact` method
3. The exported artifact is content-addressed: `sha256(artifact_bytes)` is computed and stored in `spec.canonicalization.contentHash`
4. A `DesignPrototype` resource is created with `status.phase = Canonicalized`
5. The artifact bytes are stored in the team's configured artifact store (see §16.2)
6. The audit log records: designer identity, Figma file ID, Make run ID, content hash, and export timestamp

**What canonicalization does not do:**

- It does not evaluate the artifact for quality
- It does not run any validation
- It does not select among multiple runs on the designer's behalf
- It does not modify the artifact in any way

**Hash stability requirement:** The `figma-json` export of a committed Figma Make run MUST be byte-stable for the duration of the `DesignPrototype` resource's lifecycle. If Figma's export format changes such that a re-export of the same run produces different bytes, the `DesignPrototype` is considered expired and a new canonicalization is required. The orchestrator MUST check hash stability before emitting a `design-prototype.submitted` trigger if more than `spec.source.exportedAt` + 24 hours have elapsed.

**Multiple runs and revision:** If a designer produces a revised Figma Make artifact (new prompt, new run), they create a new `DesignPrototype` resource. The previous resource is not mutated. Both resources are retained in the audit log. The pipeline receives the trigger for whichever resource is most recently admitted.

### 5.3 Binding to DesignSystemBinding

Every `DesignPrototype` MUST reference a `DesignSystemBinding` via `spec.designSystemRef`. This binding establishes the token schema version, catalog, and compliance thresholds that the validation pipeline uses.

**Token schema version pinning:** The `spec.designSystemRef.tokenSchemaVersion` field records the active token schema version at the time of canonicalization. The validation pipeline's Stage 2 validates the prototype's token references against this version. If the active schema has since advanced to a version that is incompatible with the pinned version under the `DesignSystemBinding`'s `versionPolicy`, Stage 2 fails with a `TokenSchemaVersionMismatch` result.

This prevents the following failure mode: a designer canonicalizes a Figma Make artifact against token schema v3.2.1, then the token schema advances to v4.0.0 (a breaking change), and the prototype enters the pipeline referencing tokens that no longer exist. Version pinning makes this failure explicit at admission rather than silent inside the pipeline.

**Coverage threshold inheritance:** The `DesignSystemBinding.spec.compliance.coverage.minimum` is the floor for Figma Make output. The `spec.validationPolicy.stage3.minimumCatalogCoverageRate` in the `DesignPrototype` may be stricter (higher threshold) but never looser. If a `DesignPrototype` sets a `minimumCatalogCoverageRate` below the `DesignSystemBinding`'s `coverage.minimum`, the orchestrator MUST reject the resource at creation time with a `PolicyThresholdViolation` error.

### 5.4 Binding to DesignIntentDocument

The `spec.intentRef` field associates a `DesignPrototype` with a `DesignIntentDocument` (RFC-0008 §4). This association serves two purposes:

**Purpose 1 — Admission scoring.** PPA's Sα₂ (Vibe Coherence) component requires a `DesignIntentDocument` reference to evaluate whether a work item aligns with the team's design principles. A `DesignPrototype` that enters the governed pipeline without a DID association generates an `IntentTraceabilityWarning` recorded in the admission result. Work items produced from such a prototype carry the warning forward into PPA admission, where PPA applies its standard mechanism for unanchored items (defined in PPA v1.2). RFC-0007 governs the warning; PPA governs the scoring consequence.

**Purpose 2 — Design authority validation.** The Stage 4 validation check (§8.5) confirms that the DID association is resolvable and that the referenced DID is in a valid state (not expired, not in `Rejected` phase). A prototype associated with an expired DID is a signal that the design intent it was grounded in is no longer current.

**Retroactive DID association:** A `DesignPrototype` created without an `intentRef` (where `required: false`) MAY have an `intentRef` added before Stage 4 completes. The designer or design lead may add the reference as part of the Stage 5 design authority checkpoint. If added before Stage 4 runs, Stage 4 evaluates the reference normally. If added after Stage 4 has passed (as a warning), the resource status is updated to `IntentAssociated` and the audit log records the association.

### 5.5 Stewardship Model

`DesignPrototype` resources are governed under design authority. The following stewardship rules apply:

| Action | Authority | Rationale |
|--------|-----------|-----------|
| Create a `DesignPrototype` | Designer or Design Lead | Canonicalization is a design act (§4.2 P1) |
| Set `validationPolicy` thresholds | Design Lead + Engineering Lead | Thresholds affect both disciplines |
| Override Stage 5 timeout behavior | Design Lead | Governs design authority checkpoint |
| Expire a `DesignPrototype` | Design Lead or Orchestrator (auto) | Manages lifecycle of admitted artifacts |
| Retrieve audit records | Any principal | Audit records are readable by all |
| Modify `canonicalization.*` fields | Nobody (immutable) | Canonicalization fields are write-once |
| Modify `source.*` fields | Nobody (immutable) | Source fields are write-once |

All mutations to a `DesignPrototype` resource after creation MUST be recorded in the hash-chained audit log with the submitter's identity and a reason field.

---

## 6. DesignPrototypeProvider Adapter Interface

The `DesignPrototypeProvider` is the fifth adapter interface in the AI-SDLC framework (following `DesignTokenProvider`, `ComponentCatalog`, `VisualRegressionRunner`, and `UsabilitySimulationRunner`). It bridges generative design tool output into the governance layer.

```typescript
interface DesignPrototypeProvider {
  /**
   * Export a specific Figma Make run as a structured artifact.
   * This is the canonicalization export — called once per committed run.
   * The returned bytes MUST be byte-stable for a given runId and format.
   */
  exportArtifact(options: {
    fileId: string;
    frameIds: string[];
    makeRunId: string;
    format: 'figma-json' | 'svg' | 'png';
  }): Promise<{
    bytes: Uint8Array;
    contentHash: string;         // sha256: prefixed
    exportedAt: string;          // ISO 8601
    metadata: ArtifactMetadata;
  }>;

  /**
   * Parse a canonicalized figma-json artifact into a structured
   * PrototypeStructure for validation and agent context injection.
   */
  parseStructure(artifact: Uint8Array): Promise<PrototypeStructure>;

  /**
   * Extract all value references from the artifact and classify them
   * as token-bound or hardcoded. Used by Stage 2 validation.
   */
  extractValueReferences(
    structure: PrototypeStructure
  ): Promise<ValueReferenceReport>;

  /**
   * Identify component patterns in the artifact and attempt to match
   * them against entries in a ComponentCatalog. Used by Stage 3 validation.
   */
  matchCatalogComponents(
    structure: PrototypeStructure,
    catalog: ComponentCatalog
  ): Promise<CatalogMatchReport>;

  /**
   * Verify structural integrity requirements against the artifact.
   * Used by Stage 1 validation. Returns a detailed result per requirement.
   */
  verifyStructuralIntegrity(
    structure: PrototypeStructure,
    policy: Stage1Policy
  ): Promise<StructuralIntegrityResult>;

  /**
   * Build the agent context payload from an admitted DesignPrototype.
   * This method is called by the orchestrator when preparing context
   * for a pipeline stage that references a DesignPrototype.
   * It MUST only be callable on resources with status.phase = Admitted.
   */
  buildAgentContext(
    prototype: DesignPrototype,
    options: {
      includes: AgentContextInclusion[];
      tokenSchema: DesignTokenSet;
      catalogManifest: ComponentManifest;
    }
  ): Promise<PrototypeAgentContext>;

  /**
   * Check hash stability: re-export the artifact and compare the new
   * hash against the stored hash in the DesignPrototype resource.
   * Returns true if stable, false if the export has drifted.
   */
  verifyHashStability(prototype: DesignPrototype): Promise<{
    stable: boolean;
    storedHash: string;
    currentHash: string;
    driftedAt?: string;
  }>;

  /**
   * Subscribe to events from the design tool that should trigger a new
   * canonicalization flow (e.g., a designer explicitly marks a frame as
   * "ready for handoff" in Figma).
   * Returns an unsubscribe function.
   */
  onPrototypeReadySignal(
    callback: (signal: PrototypeReadySignal) => void
  ): Unsubscribe;
}
```

**Supporting types:**

```typescript
interface PrototypeStructure {
  frames: FrameNode[];
  componentInstances: ComponentInstance[];
  valueReferences: ValueReference[];
  interactionSpec?: InteractionSpec;
  layerCount: number;
  depth: number;
  exportFormat: 'figma-json';
}

interface ValueReferenceReport {
  totalReferences: number;
  tokenBoundReferences: TokenBoundReference[];   // References resolved to a token
  hardcodedReferences: HardcodedReference[];     // References with literal values, no token
  unresolvedReferences: UnresolvedReference[];   // References that could not be classified
  coverageRate: number;                          // tokenBound / (tokenBound + hardcoded)
  hardcodedByCategory: {
    color: HardcodedReference[];
    spacing: HardcodedReference[];
    typography: HardcodedReference[];
    other: HardcodedReference[];
  };
}

interface CatalogMatchReport {
  componentPatterns: ComponentPatternMatch[];
  totalPatterns: number;
  matchedPatterns: number;
  unmatchedPatterns: ComponentPatternMatch[];    // Patterns with no catalog equivalent
  coverageRate: number;                          // matched / total
}

interface ComponentPatternMatch {
  patternId: string;
  frameRef: string;
  confidence: number;                            // 0.0–1.0
  catalogEntry?: string;                         // Component name if matched
  isNewPattern: boolean;
  reasoning: string;                             // Short description of match result
}

interface PrototypeReadySignal {
  fileId: string;
  frameIds: string[];
  makeRunId: string;
  signalledBy: string;                           // Designer identity from Figma
  signalledAt: string;
  signal: 'handoff-ready' | 'review-complete' | 'explicit-submit';
}
```

### 6.1 Scope Boundary with DesignTokenProvider

The `DesignPrototypeProvider` and the `figma-variables` `DesignTokenProvider` (RFC-0006 §9.5) MUST NOT overlap in their Figma API surface. The boundary is strict:

| Figma API Surface | Owner |
|-------------------|-------|
| `GET /v1/files/:file_key/variables` | `figma-variables` DesignTokenProvider (RFC-0006) |
| `GET /v1/files/:file_key/variables/local` | `figma-variables` DesignTokenProvider (RFC-0006) |
| `GET /v1/files/:file_key` (full file tree) | `figma-make` DesignPrototypeProvider (RFC-0007) |
| `GET /v1/files/:file_key/nodes` | `figma-make` DesignPrototypeProvider (RFC-0007) |
| Figma Make run enumeration and export | `figma-make` DesignPrototypeProvider (RFC-0007) |
| Figma prototype interaction graph | `figma-make` DesignPrototypeProvider (RFC-0007) |
| Figma Variables API for token resolution (read-only, during value classification) | `figma-make` DesignPrototypeProvider (RFC-0007) reads tokens by reference; does not write |

**Important clarification on token resolution:** The `DesignPrototypeProvider` MAY read token values from the Figma Variables API during `extractValueReferences` to classify whether a value reference in the prototype is token-bound. This is a read-only operation for the purpose of classification, not a competing implementation of `DesignTokenProvider`. The canonical token schema for compliance evaluation always comes from the `DesignSystemBinding.spec.tokens.provider`, not from Figma directly.

---

## 7. Figma Make Reference Adapter

The `figma-make` adapter is the **project-owned reference implementation** of `DesignPrototypeProvider`. It operates against the Figma REST API and Figma Make's run output format.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: figma-make-adapter
  namespace: team-frontend
spec:
  interface: DesignPrototypeProvider
  implementation: figma-make
  version: v1alpha1
  owner: project                          # project | community
  config:
    figmaApiToken: "${FIGMA_API_TOKEN}"   # Must have files:read and file_variables:read scope
    figmaMakeApiToken: "${FIGMA_MAKE_API_TOKEN}"
    exportFormat: figma-json
    artifactStore:
      type: s3-compatible                 # s3-compatible | gcs | azure-blob | local (dev only)
      bucket: "${ARTIFACT_STORE_BUCKET}"
      prefix: "design-prototypes/"
      encryptionKey: "${ARTIFACT_ENCRYPTION_KEY}"
    hashStabilityCheck:
      enabled: true
      maxAgeBeforeRecheck: "PT24H"        # Re-verify hash if > 24h since export
    readySignal:
      enabled: true
      watchEvents: ["handoff-ready", "explicit-submit"]
      pollingInterval: "PT5M"             # Polling interval for Figma webhook fallback
```

**Authentication requirements:** The Figma API token configured in this adapter MUST have:
- `files:read` — to read design file structure and node data
- `file_variables:read` — to classify token-bound value references
- Figma Make API access — for run enumeration and export (scope name subject to Figma API finalization)

The token MUST NOT have write scope. The `figma-make` adapter is a read-only adapter. Any write operation (including updating Figma file content from the governance side) is out of scope for this RFC and MUST NOT be implemented.

**Implementation status:**

| Adapter | Interface | Priority | Status |
|---------|-----------|----------|--------|
| `figma-make` | `DesignPrototypeProvider` | 1st (sole reference) | v1alpha1 |

No community adapters are scoped for v1alpha1. Teams using tools other than Figma Make (e.g., Penpot's generative features) MAY implement the `DesignPrototypeProvider` interface against the community adapter contract. The interface is tool-agnostic; the `figma-make` adapter is Figma-specific.

---

## 8. Validation Pipeline

The validation pipeline is the core contribution of this RFC. It is a five-stage pre-admission sequence that a `DesignPrototype` must pass before it is admitted as a governed pipeline trigger.

### 8.1 Stage Architecture and the Deterministic-First Principle

Stages 1–4 are fully deterministic. They run in sequence, in order, and produce the same result on every run given the same artifact and the same policy configuration. No LLM is invoked during Stages 1–4.

Stage 5 is a human gate. It does not run deterministic checks — it requires explicit approval from a principal with design authority. Stage 5 runs only after Stages 1–4 have all passed. An artifact that fails any of Stages 1–4 does not proceed to Stage 5.

**Stage execution order:**

```
Stage 1 → Stage 2 → Stage 3 → Stage 4 → Stage 5
  ↓ fail    ↓ fail    ↓ fail    ↓ fail    ↓ reject
Rejected  Rejected  Rejected  Warning*  Rejected
                               or Fail
```

*Stage 4 with `required: false` produces a `IntentTraceabilityWarning` rather than `Rejected` when no DID association is found. Stages 1–3 always produce `Rejected` on failure.

**Validation pipeline resource:**

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: checkout-prototype-admission
  namespace: team-frontend
spec:
  trigger:
    type: design-prototype.created        # Internal trigger: fires when a DesignPrototype
                                          # resource is created with phase = Canonicalized
    prototypeRef:
      selector:
        matchLabels:
          feature: checkout-redesign
  stages:
    - name: structural-integrity
      type: design-prototype-admission
      admissionStage: 1
      prototypeRef: "${trigger.prototypeRef}"

    - name: token-compliance
      type: design-prototype-admission
      admissionStage: 2
      dependsOn: [structural-integrity]
      prototypeRef: "${trigger.prototypeRef}"

    - name: catalog-coverage
      type: design-prototype-admission
      admissionStage: 3
      dependsOn: [token-compliance]
      prototypeRef: "${trigger.prototypeRef}"

    - name: design-intent-traceability
      type: design-prototype-admission
      admissionStage: 4
      dependsOn: [catalog-coverage]
      prototypeRef: "${trigger.prototypeRef}"

    - name: design-authority-checkpoint
      type: design-prototype-admission
      admissionStage: 5
      dependsOn: [design-intent-traceability]
      prototypeRef: "${trigger.prototypeRef}"
      # Stage 5 may be auto-approved based on autonomy policy (§11.2)
```

### 8.2 Stage 1: Structural Integrity

Stage 1 verifies that the canonicalized artifact is a well-formed, processable design artifact. It catches artifacts that are technically valid Figma exports but structurally insufficient to be useful as pipeline inputs.

**Checks performed:**

| Check | Failure condition | Configurable via |
|-------|------------------|-----------------|
| Parse-ability | Artifact cannot be parsed as valid `figma-json` | Not configurable; always fails |
| Minimum frame count | Fewer frames than `minimumLayerCount` (default: 1) | `validationPolicy.stage1.minimumLayerCount` |
| Empty frames | Top-level frames with no child nodes, if `allowEmptyFrames: false` | `validationPolicy.stage1.allowEmptyFrames` |
| Interaction spec presence | No interaction data, if `requiresInteractionSpec: true` | `validationPolicy.stage1.requiresInteractionSpec` |
| Artifact freshness | Content hash mismatch on re-verification | Not configurable; always fails |
| Non-expired status | `DesignPrototype.status.phase` is `Expired` | Not configurable; always fails |

**Stage 1 result payload:**

```typescript
interface Stage1Result {
  stage: 1;
  status: 'Passed' | 'Failed';
  checks: StructuralCheck[];
  layerCount: number;
  frameCount: number;
  hasInteractionSpec: boolean;
  artifactHashVerified: boolean;
  completedAt: string;
}

interface StructuralCheck {
  checkId: string;
  description: string;
  passed: boolean;
  details?: string;
}
```

### 8.3 Stage 2: Token Compliance

Stage 2 evaluates whether the prototype's value references use design tokens from the active schema, or whether they contain hardcoded values that bypass the token system.

This stage mirrors the token compliance gate in RFC-0006 §8.1, but operates on design source artifacts rather than generated code. The underlying principle is the same: hardcoded values in design artifacts propagate directly to hardcoded values in agent-generated code.

**Checks performed:**

1. **Overall coverage rate:** The `ValueReferenceReport.coverageRate` MUST be ≥ `validationPolicy.stage2.minimumTokenCoverageRate`. Coverage rate is computed as `tokenBound / (tokenBound + hardcoded)`. Unresolved references are excluded from the denominator — they indicate an adapter classification gap, not a token violation.

2. **Hardcoded value by category:** For any category listed in `validationPolicy.stage2.hardcodeCategories`, the presence of *any* hardcoded reference in that category fails Stage 2, regardless of the overall coverage rate. This zero-tolerance rule for specific categories (typically `color`, `spacing`, `typography`) ensures that the most design-system-critical values are never accepted in hardcoded form.

3. **Token schema version compatibility:** All token-bound references MUST resolve against the token schema version pinned in `spec.designSystemRef.tokenSchemaVersion`. Token references that resolve in the current token schema but not in the pinned version indicate that the artifact was produced against a newer schema version than declared. This is treated as a Stage 2 failure with a `TokenSchemaMismatch` sub-result.

4. **Alias chain integrity:** Token references that traverse alias chains MUST terminate at a primitive token. Circular alias references fail Stage 2.

**Stage 2 result payload:**

```typescript
interface Stage2Result {
  stage: 2;
  status: 'Passed' | 'Failed';
  tokenCoverageRate: number;
  minimumRequired: number;
  hardcodedByCategory: { [category: string]: HardcodedReference[] };
  categoryViolations: string[];       // Categories that failed the zero-tolerance rule
  tokenSchemaMismatch: boolean;
  brokenAliasChains: string[];
  completedAt: string;
}
```

### 8.4 Stage 3: Catalog Coverage

Stage 3 evaluates whether the component patterns used in the prototype correspond to entries in the team's `ComponentCatalog`. This is the design-side enforcement of RFC-0006 §4.2 P4 (agents must compose before they create). If a prototype introduces component patterns with no catalog equivalent, the agent will have to create new components rather than compose existing ones — which requires higher autonomy, additional quality gates, and human approval.

Stage 3 does not block admission based on the presence of new patterns by default. It classifies them and produces a report that becomes part of the agent context. Teams that want to block admission on new patterns entirely can set `validationPolicy.stage3.allowNewComponentPatterns: false`.

**Checks performed:**

1. **Coverage rate:** The `CatalogMatchReport.coverageRate` MUST be ≥ `validationPolicy.stage3.minimumCatalogCoverageRate`.

2. **New pattern enumeration:** All unmatched patterns are recorded in the admission result as `newPatternCandidates`. This list is forwarded to the design team via C7 (RFC-0008 §11.2) if the resulting task enters the PPA priority queue, enabling proactive catalog preparation.

3. **Component duplication risk:** Matched patterns with confidence < 0.70 are flagged as `lowConfidenceMatches`. These indicate patterns that may be near-duplicates of existing components or may require design judgment to resolve. They are advisory, not blocking.

**Interaction with RFC-0008 C7:** New component pattern candidates identified in Stage 3 are the design-side signal for RFC-0008's C7 (PPA Design Lookahead). When a `DesignPrototype` is admitted with `newPatternCandidates`, the orchestrator SHOULD surface these in the C7 notification if the feature enters the PPA top-10. The design team can then prepare catalog entries before the feature enters the pipeline, avoiding the catalog gap stall that C7 is designed to prevent.

**Stage 3 result payload:**

```typescript
interface Stage3Result {
  stage: 3;
  status: 'Passed' | 'Failed';
  catalogCoverageRate: number;
  minimumRequired: number;
  matchedPatterns: ComponentPatternMatch[];
  unmatchedPatterns: ComponentPatternMatch[];
  newPatternCandidates: NewPatternCandidate[];
  lowConfidenceMatches: ComponentPatternMatch[];
  completedAt: string;
}

interface NewPatternCandidate {
  patternId: string;
  frameRef: string;
  suggestedComponentName: string;    // Best-effort naming for design team review
  estimatedComplexity: 'simple' | 'compound' | 'complex';
  needsDesignSystemEntry: boolean;
}
```

### 8.5 Stage 4: Design Intent Traceability

Stage 4 verifies that the prototype is associated with a valid `DesignIntentDocument` (RFC-0008 §4) and that the association is current and resolvable.

**Checks performed:**

1. **DID resolution:** The `spec.intentRef.name` and `spec.intentRef.namespace` MUST resolve to an existing, non-expired `DesignIntentDocument` resource.

2. **DID validity:** The resolved DID MUST have `status.lastReviewed` within the DID's `reviewCadence` period. An overdue DID is not necessarily invalid (the prototype may still be admitted), but it produces a `StaleDesignIntentWarning` in the admission result.

3. **Design system alignment:** The resolved DID's `spec.designSystemRef.name` MUST match the `DesignPrototype`'s `spec.designSystemRef.name`. A prototype associated with a DID that references a different design system than the prototype is governed against produces an `AlignmentMismatch` failure.

**Behavior when `required: false`:**

If `spec.intentRef` is absent or `spec.validationPolicy.stage4.requireDIDAssociation: false`, Stage 4 records an `IntentTraceabilityWarning` and proceeds to Stage 5. The warning is:

- Recorded in the audit log
- Included in the Stage 5 context provided to the design authority reviewer
- Forwarded to the design lead via notification
- Reflected in the `DesignPrototype.status.admissionRecord.warnings` field after admission

An admitted prototype without a DID association generates an `IntentTraceabilityWarning` recorded in the admission result. Work items produced from such a prototype carry the warning forward into PPA admission, where PPA applies its standard mechanism for unanchored items (defined in PPA v1.2). RFC-0007 governs the warning; PPA governs the scoring consequence.

**Stage 4 result payload:**

```typescript
interface Stage4Result {
  stage: 4;
  status: 'Passed' | 'Failed' | 'PassedWithWarning';
  didResolved: boolean;
  didRef?: string;
  didIsValid?: boolean;
  didIsStale?: boolean;             // lastReviewed > reviewCadence
  designSystemAligned?: boolean;
  warnings: Stage4Warning[];
  completedAt: string;
}

type Stage4Warning =
  | { type: 'IntentTraceabilityWarning'; message: string }
  | { type: 'StaleDesignIntentWarning'; lastReviewed: string; overdueDays: number }
  | { type: 'AlignmentMismatch'; didDesignSystem: string; prototypeDesignSystem: string };
```

### 8.6 Stage 5: Design Authority Checkpoint

Stage 5 is a human gate. It requires a principal with design authority to review the prototype and its Stage 1–4 results and explicitly confirm that the prototype represents their intent and is ready to trigger a governed pipeline run.

Stage 5 exists because Stages 1–4, however thorough, evaluate the artifact against machine-readable criteria. They cannot evaluate whether the prototype captures the right design direction, whether the interaction model is appropriate for the feature, or whether the prototype reflects the designer's current thinking or an abandoned exploration. Only the designer can make that determination.

**What the Stage 5 reviewer sees:**

- The canonicalized prototype artifact (rendered preview)
- The Stage 1–4 validation results in summary form
- Any warnings from Stage 4 (missing DID, stale DID, alignment mismatch)
- New pattern candidates identified in Stage 3
- The target pipeline and the agent context payload that will be injected

**Approval actions:**

| Action | Effect |
|--------|--------|
| `approve` | Stage 5 passes; `DesignPrototype.status.phase = Admitted`; `design-prototype.submitted` trigger is emitted |
| `reject` | Stage 5 fails; `DesignPrototype.status.phase = Rejected`; designer is notified with reviewer's rejection notes |
| `request-revision` | Stage 5 deferred; designer must create a new `DesignPrototype` with revisions and re-enter the validation pipeline |

**Timeout behavior:**

The `spec.validationPolicy.stage5.approvalTimeout` field (ISO 8601 duration) controls what happens if no action is taken within the window. Options:

- `fail` — `DesignPrototype.status.phase = Rejected`; pipeline is not triggered; designer is notified
- `escalate` — the timeout event is sent to `DesignSystemBinding.spec.stewardship.designAuthority.principals`; an additional `PT24H` grace period begins; if still unresolved, `fail` applies
- `auto-approve` — Stage 5 is auto-approved; this option is ONLY available at Autonomy Level 3 (see §11.2) and MUST be explicitly opted into in the `validationPolicy`

**Stage 5 result payload:**

```typescript
interface Stage5Result {
  stage: 5;
  status: 'Passed' | 'Failed' | 'AutoApproved' | 'TimedOut';
  reviewer?: string;                  // Principal who approved or rejected
  reviewedAt?: string;
  action: 'approve' | 'reject' | 'request-revision' | 'auto-approved' | 'timed-out';
  reviewerNotes?: string;
  autoApprovalPolicy?: string;        // Autonomy policy that authorized auto-approval
  completedAt: string;
}
```

### 8.7 Failure Handling and Feedback Payload

When a `DesignPrototype` fails any validation stage, the orchestrator creates a `PrototypeValidationFailure` payload and delivers it to the designer.

```typescript
interface PrototypeValidationFailure {
  prototypeId: string;
  failedAt: 1 | 2 | 3 | 4 | 5;
  failureCategory: PrototypeFailureCategory;
  stageResults: (Stage1Result | Stage2Result | Stage3Result | Stage4Result | Stage5Result)[];
  remediationGuide: RemediationGuide;
  auditRef: string;
}

type PrototypeFailureCategory =
  | 'structural-integrity-failure'
  | 'token-compliance-failure'
  | 'catalog-coverage-failure'
  | 'design-intent-traceability-failure'
  | 'design-authority-rejected'
  | 'design-authority-timeout';

interface RemediationGuide {
  summary: string;
  actionItems: RemediationAction[];
}

interface RemediationAction {
  priority: 'required' | 'recommended';
  action: string;
  detail: string;
  resourceRef?: string;              // Link to the token, catalog entry, or DID that needs attention
}
```

**Remediation routing:**

| Failure category | Primary action | Routed to |
|-----------------|----------------|-----------|
| `structural-integrity-failure` | Revise the Figma Make output or choose a different run | Designer |
| `token-compliance-failure` | Replace hardcoded values with token references in Figma | Designer + Design System team notification |
| `catalog-coverage-failure` (rate below threshold) | Revise the prototype to use more catalog components | Designer |
| `catalog-coverage-failure` (new patterns blocked) | Add component patterns to catalog before re-submission | Designer + Design System team |
| `design-intent-traceability-failure` | Associate the prototype with a valid DID | Designer + Product Lead notification |
| `design-authority-rejected` | Revise per reviewer notes and create a new DesignPrototype | Designer |
| `design-authority-timeout` | Resubmit for approval or configure a longer timeout | Design Lead |

**Failure loop prevention:** A `DesignPrototype` that has been rejected MAY NOT be resubmitted by updating its status. A new `DesignPrototype` resource MUST be created. This ensures that the audit log retains the full history of failed attempts, not just the final successful submission. The new resource MAY reference the rejected resource via an `annotation: ai-sdlc.io/revised-from: "<rejected-resource-name>"` to make the revision lineage explicit.

### 8.8 Admission Result and Status

When all five stages pass, the `DesignPrototype` transitions to `Admitted` and an `AdmissionRecord` is populated:

```typescript
interface AdmissionRecord {
  admittedAt: string;
  admittedBy: string;               // designer (Stage 5 reviewer) or 'auto-policy'
  stageResults: AllStageResults;
  warnings: AdmissionWarning[];
  tokenSchemaVersionAtAdmission: string;
  catalogManifestVersionAtAdmission: string;
  agentContextHash: string;         // Hash of the agent context payload — for reproducibility
  pipelineTriggerEmitted: boolean;
  triggerRef: string;               // Reference to the emitted design-prototype.submitted event
}
```

The `admittedAt` timestamp and the content hash together form the reproducible identity of the admitted artifact. Any downstream pipeline stage that needs to verify it is working against the correct artifact can check both.

---

## 9. Pipeline Integration

### 9.1 New Trigger: design-prototype.submitted

RFC-0007 introduces a new pipeline trigger type: `design-prototype.submitted`. This trigger is emitted by the orchestrator when a `DesignPrototype` resource transitions to `status.phase = Admitted`.

```yaml
# Trigger definition (extends RFC-0002 trigger vocabulary)
triggers:
  - type: design-prototype.submitted
    prototypeRef:
      name: "${prototype.metadata.name}"
      namespace: "${prototype.metadata.namespace}"
    # Payload available to pipeline stages:
    # trigger.prototype         — the full DesignPrototype resource
    # trigger.admissionRecord   — the admission record
    # trigger.agentContext      — the resolved agent context payload
    # trigger.newPatternCandidates — new component patterns from Stage 3
```

This trigger is analogous to the `design-token.changed` trigger defined in RFC-0006 §6.2, but fires on design artifact admission rather than token change. Pipelines that begin with a design prototype entrypoint (versus a token change entrypoint) use this trigger as their starting point.

**Trigger vs. token change triggers:** A pipeline MAY be configured with both `design-prototype.submitted` and `design-token.changed` triggers. They represent two different entry points into the same governed pipeline. `design-prototype.submitted` is appropriate when a feature begins with a design prototype (the common Figma Make use case). `design-token.changed` is appropriate when a feature begins with a token schema update (the design system maintenance use case).

### 9.2 New Stage Type: design-prototype-admission

The `design-prototype-admission` stage type represents one stage of the validation pipeline. It is a first-class stage type, not a wrapper around an existing type.

```yaml
# Stage type registration (extends RFC-0002 stage vocabulary)
stageTypes:
  - type: design-prototype-admission
    description: >
      Executes one stage of the DesignPrototype validation pipeline.
      Stages 1–4 are deterministic and run automatically.
      Stage 5 is a human checkpoint that may be auto-approved per autonomy policy.
    fields:
      admissionStage:
        type: integer
        enum: [1, 2, 3, 4, 5]
        required: true
      prototypeRef:
        type: resourceRef
        kind: DesignPrototype
        required: true
    costPolicy:
      # Stages 1–4 are deterministic — no LLM token cost.
      # Stage 5 is human time, not LLM cost.
      # No CostPolicy budget is consumed by admission stages.
      agentTokenBudget: 0
```

### 9.3 Transition to Governed Pipeline

After admission, the `design-prototype.submitted` trigger initiates the governed pipeline defined by RFC-0006. The admission record and the agent context payload are available to all downstream stages.

**Context injection:** Pipeline stages that reference a `DesignPrototype` receive the agent context payload built by `DesignPrototypeProvider.buildAgentContext()`. This payload contains:

- The structured `figma-json` representation of the admitted prototype (for agent layout comprehension)
- The resolved token binding map (token name → current value, for agent token usage)
- The catalog match report (for agent composition guidance — which components to compose and which will need to be created new)

The agent context payload is constructed at admission time and its hash recorded in the `AdmissionRecord.agentContextHash`. If the pipeline stage needs to verify it is using the original admitted context (not a re-generated context with a different schema version), it can compare the hash.

**Post-admission prototype lifecycle:**

A `DesignPrototype` with `status.phase = Admitted` MUST remain `Admitted` for the duration of any pipeline run that references it. It may only transition to `Expired` when:

1. The designer or design lead explicitly expires it
2. The hash stability check (§5.2) detects that the Figma export has drifted from the stored hash
3. The `DesignSystemBinding.spec.tokens.versionPolicy` advances the active token schema to a version that is incompatible with `spec.designSystemRef.tokenSchemaVersion` under the pinned version policy

When a `DesignPrototype` expires during an active pipeline run, the orchestrator MUST pause the pipeline, notify the design authority, and await instruction. The pipeline MUST NOT continue with an expired prototype. This is the same escalation pattern used by RFC-0006 §10.2 for token conflicts during active pipeline runs.

---

## 10. AgentRole Extensions for Prototype-Driven Pipelines

When a pipeline is triggered by `design-prototype.submitted`, the agent roles involved receive additional context that is specific to prototype-driven generation.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: prototype-driven-frontend
  namespace: team-frontend
spec:
  model: claude-sonnet-4-20250514
  contextStrategy: prototype-aware      # New strategy; see §10.1
  contextStrategyOverride: auto

  designSystem:
    bindingRef:
      name: acme-design-system
      namespace: team-frontend
    prototypeRef:
      # Dynamic: resolved from the triggering design-prototype.submitted event
      fromTrigger: true

  permissions:
    compose:
      existingComponents: true
      newComponents: false              # Controlled by autonomy policy and admission results
    tokenUsage:
      requireTokenBinding: true
      allowHardcoded: false

  outputRequirements:
    stories: required
    tests: required
    tokenAudit: required                # Agent must produce a token audit confirming no hardcoded values
    catalogDiff: required               # Agent must produce a diff vs. catalog showing what was composed vs. created
```

### 10.1 The prototype-aware Context Strategy

The `prototype-aware` context strategy is a new context strategy (extending RFC-0006 §7.2) that provides the agent with prototype-specific context in addition to the standard token and catalog context:

```
tokens-only → manifest-first → prototype-aware → full
```

When `contextStrategy: prototype-aware`, the agent receives:

1. **The standard manifest-first context** — token schema, component manifest, relevant stories
2. **The prototype structure** — the parsed `figma-json` representation, formatted as a hierarchical component specification the agent can reason about
3. **The token binding map** — for each value reference in the prototype, the resolved token name (so the agent can use the same token names the designer intended)
4. **The catalog match report** — which prototype component patterns map to catalog entries (compose these) and which are new (create these, subject to autonomy and quality gates)
5. **The DID design principles** — from the associated `DesignIntentDocument`, so the agent has the design intent context it needs to make decisions that are aligned with the product's design principles

**Context strategy override:** Consistent with RFC-0006 §7.2, the orchestrator MAY escalate the context strategy from `prototype-aware` to `full` at the impact review stage if the design reviewer determines that the prototype contains interaction complexity not adequately captured in the `figma-json` structure. This override is recorded in the audit log.

### 10.2 New Component Creation from Prototype

When Stage 3 identifies new pattern candidates in a prototype, and the agent encounters those patterns during code generation, the following rules apply:

1. **The agent MUST log an intent-to-create** before generating a new component. The intent log includes: the pattern ID from Stage 3, the agent's reasoning for why no catalog component satisfies the requirement, and the proposed component name.

2. **The intent-to-create triggers a design authority notification** sent to the design lead. The design lead has `PT24H` to respond with `approve-creation`, `redirect-to-catalog` (specifying which catalog component to use instead), or `defer` (pause the generation loop until the design team decides).

3. **If the agent autonomy level is 3** and the pattern was identified as a `newPatternCandidate` in the admission Stage 3 result, the creation proceeds without waiting for the notification response — but the notification is still sent and the creation is still audited.

This is the governance counterpart to RFC-0006 §4.2 P4 (agents must compose before they create), applied to prototype-driven pipeline runs.

---

## 11. Autonomy Policy Extensions

### 11.1 Prototype Autonomy Levels

The `AutonomyPolicy` resource (RFC-0006 §13) is extended with prototype-specific permissions that govern how Figma Make output may trigger pipeline runs.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: frontend-autonomy
  namespace: team-frontend
spec:
  levels:
    - level: 1
      name: "Junior Frontend"
      permissions:
        designSystem:
          # ... existing RFC-0006 permissions ...
        prototype:
          autoTriggerAdmittedPrototype: false   # All admitted prototypes require explicit trigger
          skipStage5Checkpoint: false           # Stage 5 always required
          createNewComponentsFromPrototype: false
          maxNewPatternCandidatesPerAdmission: 0  # Reject admission if any new patterns found
      guardrails:
        requirePrototypeDesignLeadApproval: always
        prototypeNotificationTimeout: "PT24H"

    - level: 2
      name: "Mid Frontend"
      permissions:
        designSystem:
          # ... existing RFC-0006 permissions ...
        prototype:
          autoTriggerAdmittedPrototype: true    # Admitted prototypes auto-trigger pipeline
          skipStage5Checkpoint: false           # Stage 5 still required
          createNewComponentsFromPrototype: true
          maxNewPatternCandidatesPerAdmission: 3  # Up to 3 new patterns per admission
      guardrails:
        requirePrototypeDesignLeadApproval: stage5-only
        prototypeNotificationTimeout: "PT48H"

    - level: 3
      name: "Senior Frontend"
      permissions:
        designSystem:
          # ... existing RFC-0006 permissions ...
        prototype:
          autoTriggerAdmittedPrototype: true
          skipStage5Checkpoint: true            # Requires qualifying conditions (§11.2)
          createNewComponentsFromPrototype: true
          maxNewPatternCandidatesPerAdmission: 10
      guardrails:
        requirePrototypeDesignLeadApproval: notification-only
        prototypeNotificationTimeout: "PT72H"
```

### 11.2 Auto-Trigger Requirements and Earned Admission

**Auto-triggering** means that when a `DesignPrototype` is admitted, a pipeline run is initiated immediately without additional human approval. At Level 1, admitted prototypes do not auto-trigger — the design lead must explicitly initiate a pipeline run. At Levels 2 and 3, admitted prototypes auto-trigger.

**Skipping Stage 5** (the design authority checkpoint) is the most significant autonomy grant in this RFC. It is only available at Level 3, and only under all of the following conditions simultaneously:

1. The `AutonomyPolicy` level for the namespace is 3 (verified continuously, not at admission time)
2. The `DesignPrototype` has `spec.validationPolicy.stage5.onTimeout: auto-approve` explicitly set
3. The `DesignSystemBinding.spec.stewardship.designAuthority.principals` have been notified of the Stage 5 skip policy and have not objected within `PT72H` of policy activation
4. Stages 1–4 all passed without warnings (a Stage 4 `IntentTraceabilityWarning` disqualifies auto-approval)
5. The `spec.intentRef` is present and the DID is not stale

If any of these conditions is not met, Stage 5 runs as a normal human checkpoint regardless of the autonomy level.

**Promotion criteria for prototype autonomy:**

Teams that want to advance their prototype autonomy level MUST meet the following additional criteria beyond the RFC-0006 §13.2 thresholds:

```yaml
promotionCriteria:
  prototype-1-to-2:
    minimumAdmissions: 10              # At least 10 admitted prototypes at Level 1
    conditions:
      - metric: prototype-stage2-first-pass-rate
        operator: ">="
        threshold: 0.85
        rationale: >
          85% of submitted prototypes pass Stage 2 (token compliance) on first
          submission, without requiring revision and resubmission. Demonstrates
          the design team is authoring token-compliant prototypes by default.
      - metric: prototype-design-authority-approval-rate
        operator: ">="
        threshold: 0.90
        rationale: >
          90% of prototypes that reach Stage 5 are approved by the design
          authority reviewer. Demonstrates the admission pipeline is not
          surfacing prototypes that aren't ready for the governed pipeline.
    requiredApprovals: [design-lead, engineering-lead]

  prototype-2-to-3:
    minimumAdmissions: 30
    conditions:
      - metric: prototype-stage2-first-pass-rate
        operator: ">="
        threshold: 0.95
      - metric: prototype-catalog-coverage-rate
        operator: ">="
        threshold: 0.75
        rationale: >
          75% of prototype component patterns resolve to catalog entries on
          average. Demonstrates the design team is composing from the catalog
          by default, not introducing new patterns routinely.
      - metric: prototype-did-association-rate
        operator: ">="
        threshold: 1.00
        rationale: >
          100% of submitted prototypes have a DID association. At Level 3
          (where Stage 5 can be skipped), there must be zero prototypes
          without declared design intent. The DID association is the primary
          accountability mechanism when human review is bypassed.
      - metric: prototype-no-warnings-rate
        operator: ">="
        threshold: 0.90
        rationale: >
          90% of admitted prototypes pass all four deterministic stages with
          no warnings. Demonstrates the design team understands and meets the
          admission requirements reliably before submission.
    requiredApprovals: [design-lead, engineering-lead, design-system-team]
```

**Demotion triggers for prototype autonomy:**

```yaml
demotionTriggers:
  - trigger: prototype-token-compliance-regression
    condition:
      metric: prototype-stage2-first-pass-rate
      operator: "<"
      threshold: 0.70
      window: "14d"
    action: demote-prototype-level-one
    cooldown: "2w"
    rationale: >
      Token compliance regression in prototype submissions indicates the design
      team is drifting from the token system. Increased oversight is required.
  - trigger: prototype-did-association-gap
    condition:
      metric: prototype-did-association-rate
      operator: "<"
      threshold: 0.80
      window: "14d"
    action: demote-prototype-level-one
    cooldown: "2w"
    rationale: >
      Prototypes without DID associations degrade PPA Sα₂ scoring for all tasks
      they generate. Sustained DID association gaps indicate a process breakdown
      that requires closer oversight.
```

---

## 12. Audit Requirements

Every interaction with a `DesignPrototype` resource throughout its lifecycle MUST be recorded in the hash-chained audit log. RFC-0007 extends the audit event vocabulary with the following event types:

| Event type | Trigger | Required fields |
|------------|---------|-----------------|
| `DesignPrototypeCreated` | `DesignPrototype` resource is created | `prototypeId`, `committedBy`, `contentHash`, `figmaMakeRunId`, `fileId`, `frameIds`, `tokenSchemaVersion` |
| `DesignPrototypeValidationStarted` | Validation pipeline begins | `prototypeId`, `admissionPipelineRef` |
| `DesignPrototypeStageCompleted` | Any stage completes (pass or fail) | `prototypeId`, `stage`, `status`, `stageResultSummary`, `completedAt` |
| `DesignPrototypeAdmitted` | All five stages pass | `prototypeId`, `admittedBy`, `admissionRecord`, `pipelineTriggerRef` |
| `DesignPrototypeRejected` | Any stage fails | `prototypeId`, `failedAtStage`, `failureCategory`, `remediationGuideSent`, `notifiedPrincipals` |
| `DesignPrototypeExpired` | Lifecycle transition to Expired | `prototypeId`, `expiredBy`, `reason` — one of: `explicit`, `hash-drift`, `schema-incompatibility` |
| `DesignPrototypeStage5AutoApproved` | Stage 5 auto-approved per autonomy policy | `prototypeId`, `autonomyPolicyRef`, `notifiedPrincipals`, `allConditionsMet: true` |
| `DesignPrototypeHashDriftDetected` | Hash stability check finds mismatch | `prototypeId`, `storedHash`, `currentHash`, `detectedAt` |
| `DesignPrototypeIntentAssociated` | DID reference added post-creation | `prototypeId`, `didRef`, `associatedBy`, `associatedAt` |
| `DesignPrototypePipelinePaused` | Active pipeline paused due to prototype expiry | `prototypeId`, `pipelineRef`, `notifiedPrincipals` |
| `NewPatternCandidateNotified` | Stage 3 new patterns forwarded to design team | `prototypeId`, `newPatternCandidates`, `notifiedPrincipals` |
| `NewComponentCreationIntentLogged` | Agent logs intent to create a new component | `prototypeId`, `patternId`, `proposedComponentName`, `agentReasoning` |

**Audit record format:** All audit events MUST include the standard AI-SDLC audit envelope fields (event ID, timestamp, namespace, principal, previous-event hash, event-specific payload). The hash chain MUST be verifiable independently of the orchestrator.

**Retention:** `DesignPrototype` audit records MUST be retained for a minimum of 90 days after the resource transitions to `Expired`. Rejected prototype records MUST be retained for a minimum of 30 days. The audit records of admitted prototypes that triggered pipeline runs MUST be retained for as long as the pipeline run's audit records are retained.

---

## 13. Integration with RFC-0006

### 13.1 API Surface Boundaries

RFC-0007 reads design files, prototypes, and Make output from Figma. RFC-0006 reads design tokens from Figma Variables. These are distinct Figma API surfaces that MUST NOT overlap (see §6.1 for the complete surface boundary table).

The orchestrator MUST enforce this boundary by registering the two adapters under separate `AdapterBinding` resources with non-overlapping Figma API scopes. If a single Figma API token is used for both adapters (for operational simplicity), the orchestrator MUST verify at startup that the two adapters do not invoke the same API endpoints and MUST log an `AdapterScopeConflict` event if they do.

### 13.2 Token Version Compatibility

The `spec.designSystemRef.tokenSchemaVersion` field in a `DesignPrototype` pins the token schema version that was active when the prototype was canonicalized. RFC-0006 §5.5 defines four `versionPolicy` options that control how the `DesignSystemBinding` responds to schema version advances:

| RFC-0006 `versionPolicy` | RFC-0007 Stage 2 behavior on version advance |
|--------------------------|----------------------------------------------|
| `exact` | Stage 2 fails if `canonicalized version ≠ current version` |
| `minor` | Stage 2 fails if current version is a major-version advance beyond canonicalized version |
| `minor-and-major` | Stage 2 passes if canonical version is within `minor-and-major` range; fails only if schema has been deprecated |
| `latest` | Stage 2 always passes on version advance (validates against current schema) |

When `versionPolicy: latest` is in effect and a `DesignPrototype` was canonicalized against an older schema, Stage 2 runs against the current schema. If any token references in the prototype do not resolve in the current schema (e.g., tokens were deleted in a `design-token.deleted` event), Stage 2 records `TokenSchemaBreakingChange` failures for each unresolved reference. These failures are hard failures — they cannot be waived.

### 13.3 Coverage Threshold Enforcement

RFC-0006 §5.3 and §5.6 define `DesignSystemBinding.spec.compliance.coverage.minimum` as the minimum token coverage threshold for pipeline operations. This threshold applies to Figma Make output through Stage 2 and Stage 3 of the validation pipeline.

**Token coverage:** `spec.validationPolicy.stage2.minimumTokenCoverageRate` in the `DesignPrototype` MUST be ≥ `DesignSystemBinding.spec.compliance.coverage.minimum`. The orchestrator enforces this at `DesignPrototype` creation time.

**Catalog coverage:** `spec.validationPolicy.stage3.minimumCatalogCoverageRate` has no direct RFC-0006 equivalent — it is RFC-0007-native. However, if the `DesignSystemBinding` is part of a multi-brand inheritance chain (RFC-0006 §5.6), the catalog coverage threshold MUST be ≥ the parent binding's `coverage.minimum`. Child bindings may only tighten, not loosen.

---

## 14. Integration with RFC-0008

### 14.1 DID Association Requirements

RFC-0008 §4 defines the `DesignIntentDocument` as the shared root between PPA admission scoring and the design system. RFC-0007 §8.5 requires that `DesignPrototype` resources be associated with a DID through `spec.intentRef`.

This association creates the traceability chain that allows PPA's Sα₂ scoring to operate on work items generated from a Figma Make prototype. Without the association, PPA has no design intent reference for the prototype's output, and Sα₂ scoring for the resulting tasks degrades.

**The DID as prompt grounding:** Teams SHOULD use the DID's `soulPurpose.designPrinciples` as grounding context when authoring Figma Make prompts. A prompt that explicitly references the team's design principles (e.g., "Create a checkout component that embodies Calm Confidence: minimal animation, consistent spatial rhythm, moderate information density") is more likely to produce output that passes Stage 4 and survives the DID association check, because the association is genuine rather than retrospective.

This is a process recommendation, not a technical requirement. The validation pipeline cannot verify what prompt was used to generate a Figma Make run.

### 14.2 C2 Impact Constraint

RFC-0008 §6 defines Connection 2 (C2): `DesignSystemBinding` status hard-gates execution via `min()` in the Eρ₄ formula. This constraint means that if a Figma Make prototype introduces non-compliant components into the governed pipeline, the resulting `DesignSystemBinding.status` degradation will suppress admission scores for *all* tasks touching those components — not just the tasks generated from the prototype.

RFC-0007 mitigates this risk through Stage 2 (token compliance) and Stage 3 (catalog coverage). However, mitigation is not elimination. A prototype may pass Stage 2 and Stage 3 and still introduce components that, after the agent code generation stage, produce code that degrades `DesignSystemBinding.status`. This is expected and acceptable — it is the job of the RFC-0006 quality gates to catch these regressions inside the pipeline.

**What RFC-0007 guarantees:** No `DesignPrototype` is admitted with known token violations (Stage 2 passes before admission). Components with no catalog equivalent are enumerated at admission time (Stage 3), giving the design team and the pipeline visibility into new component creation risk before the agent runs.

**What RFC-0007 does not guarantee:** That agent-generated code from an admitted prototype will achieve token compliance rates above the `DesignSystemBinding` minimum. Code quality is governed by RFC-0006; RFC-0007 governs only the design source artifact.

### 14.3 AdmissionInput sourceType Field

Prototype-derived work items entering PPA admission MUST carry pathway attribution so that the PPA feedback flywheel, drift monitoring, and the missing-DID penalty mechanism (PPA v1.2) can distinguish prototype-originated items from issue-originated items. Without this attribution, flywheel signals from the two pathways are conflated, making it impossible to determine whether scoring errors or drift are coming from the issue pipeline or the prototype pipeline.

When RFC-0007's admission pipeline generates work items from an admitted `DesignPrototype` (via the agent layer at autonomy levels 2 and 3), those work items MUST enter PPA admission with the following fields populated on the `AdmissionInput` interface:

```typescript
interface AdmissionInput {
  // ... existing fields ...

  /**
   * Origin pathway of this work item. Defaults to 'issue' when absent.
   * Used for flywheel attribution, drift source tracking, and the
   * missing-DID penalty mechanism.
   */
  sourceType?: 'issue' | 'prototype-derived' | 'manual';

  /**
   * If sourceType is 'prototype-derived', the DesignPrototype resource
   * this work item was generated from. Used for cascade attribution
   * and audit trail.
   */
  sourcePrototypeRef?: {
    name: string;
    namespace: string;
    admittedAt: string;
  };
}
```

**Required behavior:** The orchestrator MUST set `sourceType: 'prototype-derived'` and populate `sourcePrototypeRef` for all work items generated from an admitted `DesignPrototype`. Items that enter PPA admission from the standard issue triage pathway use the default `sourceType: 'issue'` (implicit when absent for backwards compatibility). The `sourcePrototypeRef.admittedAt` timestamp enables PPA to correlate scoring outcomes with specific prototype admissions during post-hoc analysis.

**Cascade attribution:** When a `DesignPrototype` introduces non-compliant components that degrade `DesignSystemBinding.status` and thereby suppress Eρ₄ for downstream tasks (§14.2 C2 Impact Constraint), the `sourcePrototypeRef` enables operators to trace the suppression to its originating prototype. Without this attribution, ER4 suppression events appear as generic design system health degradation with no clear source.

**PPA v1.2 cross-reference:** PPA v1.2 will add `sourceType` awareness to the `SoulDriftDetected` event's `driftSource` breakdown, enabling per-pathway drift attribution (issue-pipeline drift vs. prototype-pipeline drift as separate sub-dimensions). This RFC defines the contract; PPA v1.2 implements the consumption.

---

## 15. Worked Example

### Scenario

Morgan (design lead) has produced a Figma Make prototype for a checkout redesign. The team is at prototype autonomy Level 2 (Stage 5 requires approval; admitted prototypes auto-trigger). The `DesignSystemBinding` (`acme-design-system`) uses `versionPolicy: minor-and-major` at schema version 3.2.1. The team has a `DesignIntentDocument` (`acme-product-intent`).

### Step 1 — Figma Make Generation (not governed)

Morgan runs Figma Make against the prompt: "Redesign the checkout flow with Calm Confidence: minimal animation, clear step indicators, no layout shift on loading states. Use the Acme DS button and input components." Figma Make produces three candidate outputs. Morgan reviews them and selects the second run as closest to her intent.

### Step 2 — Canonicalization

Morgan triggers the canonicalization flow (via CLI or Figma plugin that calls the orchestrator API). The orchestrator:

1. Calls `figmaMakeAdapter.exportArtifact({ fileId: 'aBcD...', frameIds: ['1234:5678', '1234:5679'], makeRunId: 'run_20260405_12345', format: 'figma-json' })`
2. Computes `sha256(artifact_bytes)` → `sha256:e3b0...`
3. Stores the artifact in the configured artifact store
4. Creates a `DesignPrototype` resource with `status.phase = Canonicalized`
5. Records `DesignPrototypeCreated` in the audit log

### Step 3 — Stage 1: Structural Integrity

The orchestrator parses the `figma-json` artifact.

- 2 frames, 47 layers total: ✅ Passes `minimumLayerCount: 1`
- No empty frames: ✅ Passes `allowEmptyFrames: false`
- `requiresInteractionSpec: false`: ✅ No interaction spec required
- Content hash re-verified: ✅ Matches stored hash

**Result:** Stage 1 `Passed`.

### Step 4 — Stage 2: Token Compliance

The orchestrator calls `figmaMakeAdapter.extractValueReferences(structure)`. The report:

- 312 total value references
- 278 token-bound references (e.g., `color.primary.500`, `spacing.md`, `typography.body`)
- 34 hardcoded references
  - 0 in `color` category: ✅ Zero-tolerance check passes
  - 0 in `spacing` category: ✅
  - 2 in `typography` category (inline font-size overrides in a label): ❌ Zero-tolerance check **fails**

**Result:** Stage 2 `Failed`. Failure category: `token-compliance-failure`.

`PrototypeValidationFailure` is delivered to Morgan with:
- Remediation action (required): "Replace hardcoded `font-size` values in frame `1234:5679` nodes `label-checkout-step`, `label-confirmation` with `typography.label.sm` token."
- Token reference links to the active schema

Morgan updates the Figma frames, re-exports, and creates a new `DesignPrototype` (annotated `ai-sdlc.io/revised-from: checkout-redesign-prototype-001`).

### Step 5 — Stage 2 (second submission)

New prototype: `checkout-redesign-prototype-002`. Stage 1 passes. Stage 2: 314 total references, 314 token-bound, 0 hardcoded. Coverage rate: 1.00.

**Result:** Stage 2 `Passed`.

### Step 6 — Stage 3: Catalog Coverage

Catalog match report:
- 18 component patterns identified
- 14 matched to catalog entries (Button, Input, Label, Stepper, etc.) at confidence ≥ 0.85
- 3 matched at confidence 0.65–0.75 (flagged as `lowConfidenceMatches`)
- 1 unmatched: a "collapsible order summary" pattern with no catalog equivalent

Coverage rate: 17/18 = 0.944. Minimum: 0.60. ✅ Passes rate check.

1 new pattern candidate: `collapsible-order-summary`, estimated complexity: `compound`.

**Result:** Stage 3 `Passed`. `newPatternCandidates: 1` recorded.

### Step 7 — Stage 4: Design Intent Traceability

`spec.intentRef.name: acme-product-intent` resolves to the `DesignIntentDocument`.
- DID exists and is not expired: ✅
- DID's `spec.designSystemRef.name: acme-design-system` matches the prototype's `spec.designSystemRef.name`: ✅
- DID last reviewed: 2026-01-15. Quarterly cadence. Overdue by 80 days: `StaleDesignIntentWarning`

**Result:** Stage 4 `PassedWithWarning`. Warning: `StaleDesignIntentWarning: DID last reviewed 2026-01-15; quarterly review is overdue.`

### Step 8 — Stage 5: Design Authority Checkpoint

Morgan receives a Stage 5 review request. The context includes:
- Prototype preview
- Stage 1–4 summaries (Stage 4 stale DID warning highlighted)
- 1 new pattern candidate: `collapsible-order-summary`
- Target pipeline: `frontend-checkout-pipeline`

Morgan notes the stale DID and schedules a DID review. She approves the prototype for pipeline admission.

**Result:** Stage 5 `Passed`. Approved by `morgan-hirtle`.

### Step 9 — Admission and Trigger

`DesignPrototype.status.phase = Admitted`. `AdmissionRecord` populated. `design-prototype.submitted` trigger emitted to `frontend-checkout-pipeline`.

The orchestrator additionally:
- Notifies the design team about the `collapsible-order-summary` new pattern candidate (C7 integration: if this feature enters the PPA top-10, the notification is surfaced there)
- Records `DesignPrototypeAdmitted` in the audit log

### Step 10 — Governed Pipeline Execution

`frontend-checkout-pipeline` receives the `design-prototype.submitted` trigger. The `prototype-aware` agent context is injected: structured prototype, token binding map, catalog matches (including `collapsible-order-summary` as a new pattern candidate).

The agent composes 17 components from the catalog. It encounters the `collapsible-order-summary` pattern and logs an intent-to-create. Morgan is notified. At Level 2 autonomy, the agent waits `PT24H` for Morgan's response before creating the new component. Morgan responds with `approve-creation`.

The rest of the pipeline executes per RFC-0006: token compliance gate, visual regression, story completeness, design review gate.

---

## 16. Security Considerations

### 16.1 Canonicalization Principal Verification

The `spec.canonicalization.committedBy` field MUST be verified against the `DesignSystemBinding.spec.stewardship.designAuthority.principals` list at the time of `DesignPrototype` creation. The orchestrator MUST reject creation requests where the committing principal is not in this list.

This prevents pipeline automation (e.g., a CI bot) from creating `DesignPrototype` resources and thereby triggering the governed pipeline without human design involvement. Canonicalization is a human act.

### 16.2 Artifact Store Security

The exported `figma-json` artifact stored at canonicalization time is a sensitive design asset. It contains full structural details of the team's design work prior to public release. The artifact store MUST:

- Encrypt artifacts at rest using the configured `encryptionKey`
- Restrict read access to principals with design authority or engineering authority in the namespace
- Not expose artifact content in logs or error messages
- Implement access logging for all artifact reads

### 16.3 Figma API Token Scope

The `figma-make` adapter's API token MUST have read-only scope. Write scope MUST NOT be granted. The orchestrator MUST verify at startup that the configured token does not have write scope (by attempting a test write and confirming it is rejected, or by inspecting the token's permission set if the Figma API exposes this).

A Figma API token with write scope in the `figma-make` adapter would allow the governance system to modify the team's Figma files — a severe violation of the scope boundary.

### 16.4 Prompt Injection via Figma File Content

The Figma file content read by the `figma-make` adapter may contain text added by designers or collaborators. If any part of the `figma-json` artifact is passed to an LLM without sanitization, a malicious collaborator could embed instructions in a Figma layer name or text node that influence the LLM's behavior.

**Mitigation:** All text content extracted from the `figma-json` artifact MUST be sanitized before inclusion in agent context. The `PrototypeAgentContext` built by `buildAgentContext()` MUST strip or escape any text that could be interpreted as instructions by the agent model. The adapter MUST treat all design file content as untrusted user data.

### 16.5 Hash Collision and Pre-image Resistance

The `sha256:` content hash used for canonicalization is SHA-256, which provides 128-bit security against collision attacks. This is sufficient for the integrity guarantees required by this RFC. Teams operating in regulated environments that require stronger hash algorithms MAY configure `sha384:` or `sha512:` by extending the `AdapterBinding` config; the orchestrator MUST support any standard hash algorithm that the team's adapter implementation provides.

### 16.6 Cross-Namespace Access

A `DesignPrototype` in namespace `team-frontend` referencing a `DesignSystemBinding` in namespace `team-platform` constitutes a cross-namespace access. All cross-namespace reads MUST be logged as distinct events in the audit log. The `DesignSystemBinding` owner namespace MUST explicitly grant read access to the `DesignPrototype` namespace — implicit cross-namespace reads are not permitted.

---

## 17. Alternatives Considered

### 17.1 Automated Run Selection

**Considered:** Instead of requiring the designer to select a canonical run, the governance system could automatically select the Figma Make run with the highest token compliance score.

**Rejected:** This violates P1 (canonicalization is a human act). Automated selection on a metric like token compliance would cause designers to optimize Figma Make prompts for metric performance rather than design quality. A prototype that scores 100% on token compliance but produces a poor design would be automatically selected over a prototype that scores 85% but better embodies the team's design principles. Design quality cannot be reduced to a token compliance rate, and the governance system should not pretend otherwise.

### 17.2 Rejecting All Non-Deterministic Sources

**Considered:** Rather than admitting Figma Make output at all, require all pipeline triggers to originate from human-authored, deterministic design artifacts (Figma frames created without generative tools).

**Rejected:** This position treats generative design tools as inherently ungovernable, which is not accurate. The non-determinism of Figma Make is resolved at canonicalization time. After a run is committed as canonical, the artifact is fully deterministic in the sense that matters for governance: it has a stable hash, it can be re-validated, and it produces the same agent context on every run. Excluding generative design output from the governance model would force teams to choose between governance and tooling productivity — an unnecessary tradeoff.

### 17.3 Merging DesignPrototype and DesignSystemBinding

**Considered:** Extending `DesignSystemBinding` with a `prototypes` field rather than introducing a new resource type.

**Rejected:** `DesignSystemBinding` declares what the design system is; `DesignPrototype` declares what a specific design artifact is. These are different levels of abstraction. A `DesignSystemBinding` is a long-lived, team-wide resource that changes infrequently. A `DesignPrototype` is a short-lived, feature-specific resource that changes with every design iteration. Merging them would conflate governance concerns that operate at different timescales and under different authority models. Separate resource types also allow the two to be owned and queried independently.

### 17.4 LLM-Based Token Compliance Detection in Stage 2

**Considered:** Using an LLM to evaluate whether value references in the prototype are semantically token-equivalent (e.g., a hardcoded `#1E40AF` that matches the value of `color.primary.700` should be flagged as a token non-usage rather than a token violation).

**Rejected for Stage 2:** Semantic equivalence detection is useful context but not a substitute for syntactic token binding. If a designer hardcodes a color value that happens to match a token value today, it will break when the token value changes. The governance system should not reward semantic equivalence — it should enforce syntactic binding. An LLM-based check could produce false confidence: "this hardcoded value is semantically correct" — a status that would vanish after the next token migration without any design intervention.

**Future consideration:** An LLM-based semantic equivalence checker could be introduced as a Stage 2 advisory report (not a pass/fail gate) that surfaces cases where hardcoded values match token values and suggests the token name to use. This would be a useful remediation aid without becoming a compliance bypass. This is a candidate for a future v1alpha2 revision.

### 17.5 Inline Validation Without a Validation Pipeline

**Considered:** Running all validation checks inline at canonicalization time rather than as a separate pipeline with distinct stages.

**Rejected:** Inline validation collapses distinct failure modes into a single result, making remediation opaque. If canonicalization fails, the designer needs to know which check failed and why. Staged validation produces stage-specific feedback that maps directly to remediation actions. Additionally, inline validation prevents the validation steps from being audited individually — the audit log would show only "canonicalization succeeded" or "canonicalization failed," losing the stage-level detail that is valuable for trend analysis (e.g., "Stage 2 failure rate has increased 15% over the past month — our token system may have gaps").

---

## 18. Open Questions

The following questions are in scope for review and must be resolved before this RFC advances from draft status.

| # | Question | Context |
|---|----------|---------|
| OQ-1 | **Who triggers the canonicalization flow?** The current spec allows any principal with design authority to trigger canonicalization. Should this be scoped more tightly — e.g., only the designer who produced the Figma Make run? Or should design leads be able to canonicalize runs on behalf of their team? | The stewardship model (§5.5) currently permits any design authority principal. This may be too broad for teams where multiple designers work in the same Figma file simultaneously. |
| OQ-2 | **What is the Figma Make API stability guarantee?** The `figma-make` adapter depends on Figma Make's run export API, which is not yet publicly documented with a stability commitment. If Figma changes the `figma-json` export format in a way that breaks byte-stability of committed runs, the canonicalization model breaks. Should RFC-0007 include a hash migration mechanism for when the export format changes, or should it treat this as an adapter-level concern? | The adapter's `verifyHashStability` method would detect drift, but does not provide a recovery path. |
| OQ-3 | **Should Stage 3 catalog matching use an LLM for low-confidence patterns?** The current spec uses deterministic structural matching. For component patterns with confidence 0.40–0.70, a secondary LLM-based semantic match could improve classification accuracy — at the cost of introducing non-determinism into Stage 3 and adding per-admission LLM token cost. | Consistent with the deterministic-first principle, Stage 3 is currently fully deterministic. An optional LLM advisory pass at the end of Stage 3 (not affecting the pass/fail result) may be worth specifying. |
| OQ-4 | **What is the relationship between DesignPrototype expiry and in-flight PR review?** If a `DesignPrototype` expires while a PR generated from it is in human code review (not yet merged), the spec currently says the orchestrator pauses the pipeline. But the pipeline is already complete — it has emitted a PR. Should expiry affect in-flight PRs, or only in-progress pipeline runs? | The current language (§9.3) says "pause the pipeline." For PRs already emitted, "pause" is meaningless. This needs a clearer definition: expiry should only affect future pipeline runs against the expired prototype, not already-emitted artifacts. |
| OQ-5 | **Should `design-prototype.submitted` events appear in the PPA priority stack?** RFC-0008 C7 notifies the design team about upcoming work based on the PPA priority queue. If a feature enters the queue because of a `design-prototype.submitted` event (rather than a product team work item), the C7 notification would be circular — it would notify the design team about work that originated from the design team. Should C7 filter out design-originated triggers, or should it include them as confirmation that the prototype has entered the PPA queue? | No RFC-0008 position exists yet. This requires input from Product leadership. |

---

## 19. References

| Reference | URL | Relevance |
|-----------|-----|-----------|
| RFC-0006: Design System Governance Pipeline | (internal) | Primary dependency; all adapter contracts, quality gates, autonomy policy, and reconciliation semantics |
| RFC-0008: PPA Triad Integration | (internal) | DesignIntentDocument schema and ownership model; C2 Eρ₄ constraint; C7 lookahead notification |
| RFC-0002: Pipeline Orchestration | (internal) | Trigger vocabulary, stage types, pipeline resource format |
| RFC-0004: CostPolicy | (internal) | Budget accounting; admission stages consume no agent token budget |
| AI-SDLC Framework | https://ai-sdlc.io | Framework overview |
| AI-SDLC Specification Primer | https://ai-sdlc.io/docs/spec/primer | Resource envelope, metadata conventions |
| AI-SDLC Architecture | https://ai-sdlc.io/docs/architecture | Reconciler model, audit log format |
| Tutorial 9: Review Calibration | https://ai-sdlc.io/docs/tutorials/09-review-calibration | Deterministic-first review architecture (basis for §8.1) |
| W3C Design Tokens v1.0 | https://www.w3.org/community/design-tokens/ | Token format standard; token compliance evaluation |
| Figma Make (Figma AI) | https://www.figma.com/ai/ | Generative design tool; source of `DesignPrototype` artifacts |
| Figma REST API | https://www.figma.com/developers/api | File structure, node data, variables |
| Figma Variables API | https://www.figma.com/developers/api#variables | Token-bound value classification in Stage 2 |
| Storybook MCP | https://storybook.js.org/blog/storybook-mcp-sneak-peek/ | ComponentCatalog reference implementation (RFC-0006 §11) |
| Tokens Studio | https://docs.tokens.studio/token-storage/remote | DesignTokenProvider reference implementation (RFC-0006) |
| JSON Schema 2020-12 | https://json-schema.org/specification | Resource validation |
| SHA-256 (FIPS 180-4) | https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf | Content addressing for canonicalization |
