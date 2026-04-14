# RFC-0006: Design System Governance Pipeline

**Document type:** Normative (final)
**Status:** Final v5 — Token Versioning, Multi-Brand Inheritance, Cross-Platform, Adapter Priority Decisions
**Created:** 2026-03-28
**Revised:** 2026-04-13
**Authors:** [Author Name]
**Reviewers:** [Design Leadership], [Engineering / Agent Systems]
**Spec version:** v1alpha1
**Requires:** RFC-0002 (Pipeline Orchestration), RFC-0004 (CostPolicy)

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Dominique Legault | CTO / Engineering Authority | ✅ Approved | 2026-04-05 |
| Morgan Hirtle | Chief of Design / Design Authority | ✅ Approved | 2026-04-13 |
| Alexander Kline | Head of Product Strategy / Product Authority | ✅ Approved | 2026-04-04 |

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-03-28 | Initial draft |
| v2 | 2026-04-02 | Integrated design leadership and engineering review feedback. Added: Stewardship model (§5.3), Design Review gate (§8.5), design authority checkpoints throughout pipeline (§6), design metrics in autonomy policy (§13), token deletion handling (§12.3), manual resolution timeout (§10.2), correction loop failure payload (§8.4), contextStrategy selection algorithm (§7.2), MCP authentication requirements (§16.3). Revised: Section 4.2 P2 reclassified as organizational decision. Section 15 rewritten with design team co-participation. Open Question 3 (Figma Make) removed — escalated to RFC-0007. |
| v3 | 2026-04-02 | Added Addendum A: Deterministic-First Design Review Architecture. Extends §8.5 with a three-layer automated design quality evaluation model mirroring the Tutorial 9 review calibration architecture. Introduces: Design CI boundary (deterministic accessibility, token, spacing, typography, and interaction state checks), structural design preprocessor, AI agent usability simulation via browser-based task completion testing, design review exemplar bank, and design review feedback flywheel. New adapter interface: `UsabilitySimulationRunner`. |
| v4 | 2026-04-03 | Integrated PPA Triad design leader feedback. Added: Addendum B — PPA Triad Integration (five connections closing Product↔Design edge). Fixed: §10.2 timeout scoping clarified for design review gates vs. token conflicts (Mo feedback). §7.2 context strategy re-selection on scope change at impact review (Mo feedback). §13.2 autonomy thresholds reframed as calibration templates with lower defaults (Mo feedback). §A.5.2 `BrowserSession` interface stub defined (Mo feedback). §A.5.3/§A.8 task auto-selection algorithm with fallback behavior specified (Mo feedback). Open Question 6 elevated and resolved — design review surfaces in Storybook + design tool annotations. Open Question 8 added for soul purpose document gap. |
| v5 | 2026-04-05 | Resolved four open questions as spec decisions. Added: §5.5 Token Versioning Model (semver with four policies: `exact`, `minor`, `minor-and-major`, `latest`; atomic migration; no staged rollouts in v1alpha1). §5.6 Multi-Brand Inheritance Model (`extends` field; layered validation where parent validates first then child; child thresholds can only tighten, not loosen parent thresholds). §5.7 Cross-Platform Bindings (hybrid model; `platform` field on adapter; AND condition for admission scoring across platform bindings). §9.5 Adapter Priority and Reference Implementations (Tokens Studio + Figma as co-first `DesignTokenProvider`; Storybook as `ComponentCatalog`; Playwright as `VisualRegressionRunner`; all project-owned; Figma adapter scope boundary with RFC-0007). Closed OQ-1, OQ-2, OQ-4, OQ-5 in §18. |
| v5 (final) | 2026-04-13 | All-pillar sign-off received. Engineering (Dom Legault, 2026-04-05), Product (Alexander Kline, 2026-04-04 — approved without modification; §5.7 cross-platform AND condition noted as Execution-axis property for PPA v1.2 framing), Design (Morgan Hirtle, 2026-04-13). No spec changes from sign-off round. |

---

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Problem Statement](#3-problem-statement)
4. [Proposal](#4-proposal)
5. [New Resource Type: DesignSystemBinding](#5-new-resource-type-designsystembinding)
   - [5.5 Token Versioning Model](#55-token-versioning-model)
   - [5.6 Multi-Brand Inheritance Model](#56-multi-brand-inheritance-model)
   - [5.7 Cross-Platform Bindings](#57-cross-platform-bindings)
6. [Pipeline Integration](#6-pipeline-integration)
7. [AgentRole Extensions](#7-agentrole-extensions)
8. [Quality Gate Extensions](#8-quality-gate-extensions)
9. [Adapter Contracts](#9-adapter-contracts)
   - [9.5 Adapter Priority and Reference Implementations](#95-adapter-priority-and-reference-implementations)
10. [Reconciliation Semantics](#10-reconciliation-semantics)
11. [Storybook MCP Integration](#11-storybook-mcp-integration)
12. [Design Token Lifecycle](#12-design-token-lifecycle)
13. [Autonomy Policy Extensions](#13-autonomy-policy-extensions)
14. [Worked Example](#14-worked-example)
15. [Migration Path](#15-migration-path)
16. [Security Considerations](#16-security-considerations)
17. [Alternatives Considered](#17-alternatives-considered)
18. [Open Questions](#18-open-questions)
19. [References](#19-references)
20. [Addendum A: Deterministic-First Design Review Architecture](#addendum-a-deterministic-first-design-review-architecture)
21. [Addendum B: PPA Triad Integration](#addendum-b-ppa-triad-integration)

---

## 1. Summary

This RFC introduces governed design system pipelines into the AI-SDLC Framework. It defines how human engineers, human designers, and AI coding agents collaborate across the design-to-code lifecycle — using design tokens as the shared contract, Storybook as the code-side source of truth, and a configurable design tool (typically Figma) as the design-side authority.

The proposal adds one new resource type (`DesignSystemBinding`), three new adapter interfaces (`DesignTokenProvider`, `ComponentCatalog`, and `VisualRegressionRunner`), new quality gate rule types for visual regression, design token compliance, and design review, extensions to `AgentRole` for design-system-aware code generation via Storybook MCP, and a stewardship model that establishes shared authority between design and engineering leadership over design system governance decisions.

---

## 2. Motivation

### 2.1 The Design–Code Synchronization Problem

Frontend teams maintain two parallel representations of their UI system: a design tool (typically Figma) and a component codebase. These representations inevitably drift because:

- Design tools model visual intent; code models behavior, constraints, and state
- Changes in design must be manually translated to code (lossy)
- Changes in code (discovered constraints, performance tradeoffs) rarely flow back to design
- No governance exists for AI agents generating frontend components

This is fundamentally an architectural problem, not a tooling gap. The current AI-SDLC specification governs backend-oriented pipelines but provides no primitives for the design-to-code lifecycle — a gap that grows more consequential as AI agents generate an increasing share of frontend code.

### 2.2 The AI Agent Amplification Risk

Without design system governance, AI coding agents amplify the drift problem:

- Agents default to patterns from training data, not the team's established conventions
- Generated components bypass design token usage, introducing hardcoded values
- No validation exists to confirm generated UI matches the declared design system
- Component proliferation accelerates — agents create new components rather than reusing existing ones from the catalog
- Storybook documentation drifts as agents add components without corresponding stories
- Agents produce output that is technically compliant but designerly poor — no existing gate catches this

### 2.3 The Design Authority Gap

Current AI coding agent governance is built entirely on engineering metrics: test coverage, security scans, linting. No framework exists for preserving design authority — the judgment of whether a component is well-designed, contextually appropriate, and consistent with a product's design language — within an AI-augmented pipeline. This RFC treats design authority as a first-class governance concern, not a downstream quality check.

### 2.4 Industry Trajectory

The W3C Design Tokens specification reached v1.0 in October 2025, establishing a vendor-neutral standard for design decisions. Storybook MCP (Model Context Protocol) provides machine-readable component manifests that allow AI agents to generate code conforming to an existing design system. Figma Make uses generative AI to produce prototypes grounded in a team's design library. These primitives are mature enough to compose into a governed pipeline.

### 2.5 Strategic Alignment

This RFC is consistent with the AI-SDLC design principles:

| Principle | Application |
|-----------|-------------|
| DP-1: Separate WHAT from HOW | Teams declare design system constraints; agents resolve implementation |
| DP-2: Declarative over imperative | Token schemas and component catalogs defined in YAML |
| DP-5: Tool-agnostic via adapters | Figma, Penpot, Sketch abstracted behind `DesignTokenProvider` |
| DP-6: Progressive enforcement | Token compliance starts advisory, graduates to hard-mandatory |
| DP-7: Earned autonomy | Agents earn permission to create new components vs. compose existing ones |
| DP-8: Reconciliation over point-in-time | Continuous token drift detection, not one-shot audits |

---

## 3. Problem Statement

The AI-SDLC Framework currently has no mechanism to:

1. Declare a design system as a governed resource that agents must conform to
2. Validate that AI-generated frontend code uses design tokens rather than hardcoded values
3. Enforce visual regression checks as quality gates within a pipeline
4. Provide AI agents with machine-readable component catalogs (preventing component duplication)
5. Reconcile design token changes across Figma, code, and Storybook automatically
6. Track design system compliance as a dimension of agent autonomy
7. **Preserve design authority within an AI-augmented pipeline** — ensuring that design leadership retains decision-making power over design system governance, visual baselines, token schemas, and component quality
8. **Define a design review gate** that evaluates whether agent output is well-designed, not merely technically compliant

This RFC addresses all eight gaps.

---

## 4. Proposal

### 4.1 Architectural Overview

The proposal composes three industry primitives into a governed AI-SDLC pipeline with shared design-engineering authority:

```
┌──────────────────────────────────────────────────────────────────┐
│                    AI-SDLC GOVERNANCE LAYER                      │
│   DesignSystemBinding | QualityGates | AutonomyPolicy            │
│   Stewardship: design + engineering co-authority                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────┐    ┌──────────────┐    ┌─────────────────────┐  │
│  │ DESIGN TOOL│    │ DESIGN TOKENS│    │  STORYBOOK + MCP    │  │
│  │ (authority │───▶│  (contract)  │◀───│  (code truth)       │  │
│  │  level is  │    │  W3C DTCG    │    │  Component Manifest  │  │
│  │  configura-│    └──────┬───────┘    └──────────┬──────────┘  │
│  │  ble)      │           │                       │              │
│  └────────────┘    ┌──────▼───────────────────────▼──────────┐  │
│                    │        AI CODING AGENT                   │   │
│                    │  Context: tokens + manifest + stories    │   │
│                    │  Output: component + story + tests       │   │
│                    └─────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              DESIGN REVIEW CHECKPOINT                     │   │
│  │  Human design judgment at impact analysis, baseline       │   │
│  │  approval, and component quality review                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                     ADAPTER LAYER                                │
│  DesignTokenProvider | ComponentCatalog | VisualRegressionRunner  │
└──────────────────────────────────────────────────────────────────┘
         ▼                    ▼                      ▼
   ┌──────────┐       ┌─────────────┐       ┌──────────────┐
   │  Figma   │       │  Storybook  │       │  Chromatic   │
   │  Penpot  │       │  Histoire   │       │  Percy       │
   │  Tokens  │       │  Ladle      │       │  Playwright  │
   │  Studio  │       │             │       │              │
   └──────────┘       └─────────────┘       └──────────────┘
```

### 4.2 Design Principles Specific to This RFC

**P1 — Tokens are the contract, not Figma alone and not code alone.** Design tokens in W3C DTCG format are the single authoritative representation of shared design decisions. Both design tools and code are derived from or validated against tokens.

**P2 — Design tool authority level is an organizational decision, not an architectural default.**

Different organizations position their design tools differently within the design-to-code lifecycle. This RFC does not prescribe a single model. Instead, the `DesignSystemBinding` resource exposes a `designToolAuthority` configuration (see §5) that each team sets according to their organizational structure.

The three supported authority levels:

| Level | Design Tool Role | Code Role | Tradeoffs |
|-------|-----------------|-----------|-----------|
| `exploration` | Ideation and prototyping; not behavioral spec | Storybook is the behavioral source of truth | Maximizes engineering autonomy. Risk: design intent is lost in translation. |
| `specification` | Carries annotations, interaction states, responsive rules, accessibility requirements; is the behavioral spec | Code implements the spec; deviations require design approval | Preserves design authority. Risk: pipeline complexity increases; design bottleneck possible. |
| `collaborative` | Design tool and code both carry authority in their respective domains; tokens are the binding contract | Design owns visual intent; engineering owns behavioral implementation | Balanced model. Risk: requires mature communication norms; ambiguity at domain boundaries. |

**This is a significant organizational decision.** Teams adopting this RFC MUST explicitly discuss and configure this field with both design and engineering leadership present. The default value is `collaborative`, which imposes no assumptions about which discipline has final authority.

**P3 — Code is the truth for component runtime behavior.** Storybook stories are the living specification for how components render, compose, and handle state at runtime. This does not diminish the design tool's authority over visual intent, interaction design, or accessibility requirements — those concerns are governed by the `designToolAuthority` setting and the design review gates defined in §8.5.

**P4 — Agents must compose before they create.** AI agents should reuse existing components from the catalog before creating new ones. New component creation requires higher autonomy and additional quality gates.

**P5 — Visual validation is necessary but not sufficient.** Quality gates include visual regression testing to catch unintended pixel changes. However, visual regression does not evaluate design quality, contextual appropriateness, or design language consistency. A separate design review gate (§8.5) is required for those judgments. See §8.5.1 for the explicit scope distinction.

**P6 — Design authority is a first-class governance concern.** Design leadership retains decision-making power over visual baselines, token schemas, component quality, and conflict resolution policy. This authority is enforced through the stewardship model (§5.3), design review gates (§8.5), and design metrics in the autonomy policy (§13).

---

## 5. New Resource Type: DesignSystemBinding

A `DesignSystemBinding` declares the design system that a pipeline's frontend stages must conform to. It follows the standard AI-SDLC resource envelope.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system
  namespace: team-frontend
  labels:
    system: acme-ds
    version: "3.2"
spec:
  # --- STEWARDSHIP (§5.3) ---
  stewardship:
    designAuthority:
      principals: ["design-lead", "design-system-team"]
      scope:
        - conflictResolution
        - visualBaselines
        - tokenSchema
        - designToolAuthority
        - compliance.disallowHardcoded
    engineeringAuthority:
      principals: ["engineering-lead", "platform-team"]
      scope:
        - catalog
        - visualRegression.config
        - compliance.coverage
        - sync.schedule
    sharedAuthority:
      principals: ["design-lead", "engineering-lead"]
      scope:
        - sync.direction
        - compliance.coverage.minimum
    changeApproval:
      requireBothDisciplines: true       # Changes to sharedAuthority fields require both
      auditAllChanges: true

  # --- ORGANIZATIONAL DECISION (§4.2 P2) ---
  designToolAuthority: collaborative     # exploration | specification | collaborative

  # --- TOKEN SOURCE ---
  tokens:
    provider: figma-tokens-studio
    format: w3c-dtcg
    source:
      repository: "acme-org/design-tokens"
      branch: main
      path: "tokens/"
    versionPolicy: minor-and-major           # exact | minor | minor-and-major | latest (§5.5)
    # pinnedVersion: "3.2.1"                 # Required when versionPolicy is exact
    sync:
      direction: bidirectional
      schedule: "PT15M"                  # ISO 8601 duration (see §5.4)
      conflictResolution: manual         # code-wins | design-wins | manual
      manualResolutionTimeout: "PT48H"   # Required when conflictResolution is manual
      onTimeout: escalate                # escalate | fallback-design-wins | fail
      escalateTo: ["design-lead", "engineering-lead"]
      prBranch: "ai-sdlc/token-sync-{timestamp}"

  # --- COMPONENT CATALOG ---
  catalog:
    provider: storybook-mcp
    source:
      repository: "acme-org/component-library"
      storybookUrl: "https://storybook.acme.dev"
      manifestPath: ".storybook/component-manifest.json"
    discovery:
      mcpEndpoint: "https://storybook.acme.dev/mcp"
      refreshInterval: "PT1H"

  # --- VISUAL REGRESSION ---
  visualRegression:
    provider: chromatic
    config:
      projectToken: "${CHROMATIC_TOKEN}"
      diffThreshold: 0.01
      viewports: [375, 768, 1280, 1920]

  # --- TOKEN COMPLIANCE ---
  compliance:
    disallowHardcoded:
      - category: color
        pattern: "#[0-9a-fA-F]{3,8}"
        message: "Use a color token instead of hardcoded hex"
      - category: spacing
        pattern: "\\d+px"
        exclude: ["0px", "1px"]
        message: "Use a spacing token instead of pixel values"
      - category: typography
        pattern: "font-size:\\s*\\d+"
        message: "Use a typography token"
    coverage:
      minimum: 85
      target: 95

  # --- DESIGN REVIEW (§8.5) ---
  designReview:
    required: true                       # Enable design review gate
    reviewers: ["design-lead", "senior-designer"]
    scope:
      - visual-quality                   # Aesthetic and design language consistency
      - contextual-fit                   # Does the component work in its page/flow context?
      - interaction-design               # Are states, transitions, and behaviors correct?
      - accessibility-intent             # Does the design meet accessibility goals (beyond WCAG)?
    triggerConditions:
      alwaysOn:
        - new-component                  # New components always require design review
        - token-schema-change            # Token additions or removals
      configurable:
        - semantic-token-cascade         # When a semantic token change affects 5+ components
          threshold: 5
        - visual-regression-diff         # When visual diff exceeds threshold
          threshold: 0.05                # 5% pixel diff triggers design review

status:
  lastTokenSync:
    timestamp: "2026-03-28T14:30:00Z"
    tokensChanged: 3
    result: success
  catalogHealth:
    totalComponents: 142
    documentedComponents: 138
    coveragePercent: 97.2
  tokenCompliance:
    currentCoverage: 91.3
    violations: 4
    trend: improving
  designReview:
    pendingReviews: 2
    averageReviewTime: "PT4H"
    approvalRate: 0.87
  conditions:
    - type: TokensSynced
      status: "True"
      lastTransition: "2026-03-28T14:30:00Z"
    - type: CatalogAvailable
      status: "True"
      lastTransition: "2026-03-28T12:00:00Z"
    - type: ComplianceMet
      status: "True"
      lastTransition: "2026-03-28T14:30:00Z"
    - type: DesignReviewCurrent
      status: "True"
      lastTransition: "2026-03-28T10:00:00Z"
```

### 5.1 Schema Requirements

The `DesignSystemBinding` resource MUST be validated against JSON Schema (draft 2020-12). The following fields are REQUIRED:

- `spec.stewardship` — MUST define at least one `designAuthority` principal and one `engineeringAuthority` principal
- `spec.designToolAuthority` — MUST be one of: `exploration`, `specification`, `collaborative`
- `spec.tokens.format` — MUST be one of: `w3c-dtcg`, `style-dictionary`, `custom`
- `spec.tokens.source.repository` — MUST be a valid Git repository reference
- `spec.tokens.versionPolicy` — MUST be one of: `exact`, `minor`, `minor-and-major`, `latest` (see §5.5)
- `spec.tokens.pinnedVersion` — REQUIRED when `versionPolicy` is `exact`; MUST be a valid semver string
- `spec.catalog.provider` — MUST reference a registered `AdapterBinding`
- `spec.compliance.coverage.minimum` — MUST be an integer between 0 and 100
- `spec.tokens.sync.manualResolutionTimeout` — REQUIRED when `conflictResolution` is `manual`

When `spec.extends` is present (see §5.6):
- `spec.extends` — MUST reference an existing `DesignSystemBinding` by name in the same namespace
- Child `spec.compliance.coverage.minimum` MUST be greater than or equal to the parent's value
- Child `spec.compliance.disallowHardcoded` entries MAY add new categories but MUST NOT remove parent categories
- The orchestrator MUST reject a child binding that attempts to set any compliance threshold below the parent binding's value for the same field

### 5.2 Token Format

When `spec.tokens.format` is `w3c-dtcg`, tokens MUST conform to the W3C Design Tokens Format Module specification (v1.0, October 2025). Example:

```json
{
  "color": {
    "primary": {
      "$type": "color",
      "$value": "#3B82F6",
      "$description": "Primary brand color"
    },
    "text": {
      "primary": {
        "$type": "color",
        "$value": "{color.neutral.900}",
        "$description": "Default text color"
      }
    }
  },
  "spacing": {
    "4": {
      "$type": "dimension",
      "$value": "1rem"
    }
  }
}
```

### 5.3 Stewardship Model

The `stewardship` block defines who has authority over which aspects of the `DesignSystemBinding` resource. This is a governance requirement, not a technical detail.

**Rationale:** Fields like `conflictResolution`, `compliance.coverage.minimum`, and `designToolAuthority` encode organizational power dynamics — whether design or engineering has final say when decisions conflict. These fields MUST NOT be modifiable without the appropriate authority.

**Authority scopes:**

| Scope | Description | Default Authority |
|-------|-------------|-------------------|
| `conflictResolution` | Whether code or design wins on token conflicts | Design |
| `visualBaselines` | Approval of visual regression baselines | Design |
| `tokenSchema` | Token additions, removals, and restructuring | Design |
| `designToolAuthority` | The authority level of the design tool (§4.2 P2) | Shared |
| `compliance.disallowHardcoded` | Which hardcoded values are disallowed | Design |
| `catalog` | Component catalog configuration | Engineering |
| `visualRegression.config` | Diff thresholds, viewports, provider | Engineering |
| `compliance.coverage` | Token coverage targets and minimums | Shared |
| `sync.direction` | Whether sync is unidirectional or bidirectional | Shared |
| `sync.schedule` | How frequently tokens sync | Engineering |

**Enforcement:** The orchestrator's admission pipeline (see Architecture §Admission Pipeline) MUST enforce stewardship constraints. A change to a `designAuthority`-scoped field submitted by a principal not listed in `designAuthority.principals` MUST be rejected. Changes to `sharedAuthority`-scoped fields MUST require approval from at least one principal in each discipline when `changeApproval.requireBothDisciplines` is `true`.

**Audit:** All changes to a `DesignSystemBinding` resource MUST be recorded in the hash-chained audit log with the submitter's identity, the fields changed, and the approvals received.

### 5.4 Sync Schedule Format

The `sync.schedule` field MUST accept ISO 8601 duration format (e.g., `PT15M` for every 15 minutes, `PT1H` for hourly). Cron expressions are NOT supported in v1alpha1 due to dialect inconsistencies across providers.

**Rationale (reviewer feedback):** Cron parsing is not standardized; a schedule valid in one provider's implementation may be rejected by another. ISO 8601 durations are unambiguous and universally parseable.

If time-of-day scheduling is required (e.g., "sync at 2am daily"), teams SHOULD use their CI/CD scheduler to invoke the sync externally and configure `sync.schedule: manual` in the binding.

---

### 5.5 Token Versioning Model

Token schemas follow semantic versioning (semver). Teams configure update behavior via the `spec.tokens.versionPolicy` field. This is a **required field** with no implicit default — teams must explicitly choose a policy so the choice is visible and auditable.

#### Version Policies

| Policy | Accepts | Blocks | Typical Use Case |
|--------|---------|--------|-----------------|
| `exact` | Only the pinned version | Everything else | Production surfaces where any unreviewed token change is a deployment risk |
| `minor` | Minor and patch releases | Breaking and major releases | Stable products that accept non-breaking additions |
| `minor-and-major` | Major, minor, and patch | Breaking (schema-restructuring) releases | Products that track the design system actively but cannot absorb structural migrations automatically |
| `latest` | All releases including breaking | Nothing | Design system development environments; never production |

When `versionPolicy` is `exact`, the `spec.tokens.pinnedVersion` field is REQUIRED and MUST be a valid semver string (e.g., `"3.2.1"`). The orchestrator MUST block any token sync that would apply a schema version other than the pinned version.

**Breaking change detection:** The `DesignTokenProvider` adapter MUST implement `detectBreakingChange(fromVersion, toVersion): boolean` to report whether a new schema version is breaking relative to the current. A breaking change is defined as any token removal, token rename, type change, or alias restructuring. Value changes (e.g., a color value update) are non-breaking. The orchestrator uses this result to block syncs that exceed the configured policy boundary.

#### Atomic Migration Model

Token schema migrations in v1alpha1 are **atomic**. There is no staged rollout or dual-write period where old and new token names coexist.

**Rationale:** Dual-write introduces a class of governance failure — agents may use either the old or new token depending on which sync they received, producing inconsistent output across pipeline runs. Atomic migration eliminates this ambiguity: before the migration there is one token schema; after the migration there is a different token schema; there is no valid in-between state.

**Operational model:**

1. A breaking token schema change (rename, removal, restructuring) is classified as a breaking release in semver.
2. The `DesignTokenProvider` adapter emits a `TokenSchemaBreakingChange` event when detected.
3. The orchestrator **blocks all affected pipeline runs** until the migration is applied or explicitly deferred by a design authority principal.
4. The design lead applies the migration: the new token schema is deployed, all references are updated in a single atomic PR (agent-assisted per §12.1).
5. After merge, the version policy is updated to reflect the new schema version.

**Staged rollouts are NOT supported in v1alpha1.** Teams that require phased migration across multiple product surfaces (e.g., a legacy web app and a new mobile app on different release cycles) should treat each surface as a separate `DesignSystemBinding` instance with its own `versionPolicy`, and coordinate migration timing through shared stewardship principals rather than through dual token names.

```yaml
# Example: production surface pinned to a specific version
spec:
  tokens:
    versionPolicy: exact
    pinnedVersion: "3.2.1"

# Example: design system staging environment tracking latest
spec:
  tokens:
    versionPolicy: latest
```

---

### 5.6 Multi-Brand Inheritance Model

Organizations with multiple brands sharing a common base design system use `spec.extends` to declare a parent–child relationship between `DesignSystemBinding` resources.

```yaml
# Base binding — central design system team owns this
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-base-design-system
  namespace: team-design-system
spec:
  compliance:
    coverage:
      minimum: 85
      target: 95
  # ... full base spec

---

# Brand-specific child binding — brand team owns this
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-brand-enterprise
  namespace: team-enterprise
spec:
  extends: acme-base-design-system          # Reference to parent binding

  # Brand-specific token overrides
  tokens:
    source:
      repository: "acme-org/enterprise-tokens"
      branch: main
      path: "tokens/enterprise/"
    versionPolicy: minor-and-major

  # Child MAY tighten compliance thresholds — MUST NOT loosen them
  compliance:
    coverage:
      minimum: 92                           # Higher than parent's 85 — valid
      target: 98                            # Higher than parent's 95 — valid

  # Brand-specific stewardship — brand design lead has authority
  # over brand-specific fields; base system authority is inherited
  stewardship:
    designAuthority:
      principals: ["enterprise-design-lead"]
      scope:
        - tokenSchema
        - visualBaselines
```

#### Layered Validation Execution Model

When a `DesignSystemBinding` has an `extends` reference, validation executes in two independent layers:

```
Admission input (task or PR)
        │
        ▼
┌─ Layer 1: Parent Validation ───────────────────────────────┐
│  Parent DesignSystemBinding thresholds and rules           │
│  Executed against parent's compliance settings             │
│  Result: pass | fail                                       │
└────────────────────────────────────────────────────────────┘
        │ (only continues if parent passes)
        ▼
┌─ Layer 2: Child Validation ────────────────────────────────┐
│  Child DesignSystemBinding overrides and additions         │
│  Executed against child's (tightened) compliance settings  │
│  Result: pass | fail                                       │
└────────────────────────────────────────────────────────────┘
        │ (passes only if BOTH layers pass)
        ▼
  Combined result: pass (both layers pass) | fail (either layer fails)
```

**Both layers must pass.** A child binding cannot configure its way out of a parent constraint. The parent validates first at its own threshold; the child then validates at its own (equal or higher) threshold. This structurally enforces the central design system team's authority while giving brand teams the ability to apply stricter standards for their surface.

**Threshold tightening constraint:** A child binding MAY set any compliance threshold to a value *greater than or equal to* the parent's value for the same field. A child binding MUST NOT set any compliance threshold to a value *less than* the parent's value. The orchestrator MUST reject child bindings that violate this constraint at admission time, not at validation time.

**Design authority in inheritance:** The layered validation model encodes a governance interpretation: the central design system team's authority (parent layer) is structurally enforced by the execution order. Brand design leads operate within the envelope defined by the parent. Brand-specific `stewardship.designAuthority.principals` govern brand-specific fields; they cannot override fields governed by the parent binding's stewardship.

**Depth limit:** Inheritance chains are limited to **two levels** (parent → child) in v1alpha1. Grandchild bindings (child of a child) are NOT supported. This limit may be revisited in v1beta1.

---

### 5.7 Cross-Platform Bindings

When a design system targets multiple platforms (React/web, iOS, Android), the binding model uses a **hybrid approach**: a shared base binding governs the canonical W3C DTCG token set, and platform-specific extension bindings handle platform-native token expressions. The extension bindings use the `extends` mechanism defined in §5.6.

```yaml
# Base binding — platform-neutral W3C DTCG tokens
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system-base
  namespace: team-design-system
spec:
  tokens:
    format: w3c-dtcg
    # ... canonical token source

---

# Platform extension — React/web
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system-web
  namespace: team-frontend-web
spec:
  extends: acme-design-system-base
  tokens:
    platform: web                           # NEW field — see adapter note below
    source:
      repository: "acme-org/design-tokens"
      path: "tokens/web/"                   # CSS custom properties output

---

# Platform extension — iOS (v1beta1 scope — community adapter)
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system-ios
  namespace: team-frontend-ios
spec:
  extends: acme-design-system-base
  tokens:
    platform: ios                           # Swift constants output
    source:
      repository: "acme-org/design-tokens"
      path: "tokens/ios/"
```

#### Platform Field

The `spec.tokens.platform` field identifies the platform-specific token expression format. Valid values in v1alpha1:

| Value | Token Expression Format | v1alpha1 Status |
|-------|------------------------|----------------|
| `web` | CSS custom properties | Supported (project-owned adapter — §9.5) |
| `ios` | Swift constants / Swift UI tokens | v1beta1 — community adapter |
| `android` | Compose theme values | v1beta1 — community adapter |

The `DesignTokenProvider` adapter MUST document which `platform` values it supports. An adapter that does not set `platform` is treated as platform-neutral and operates on the canonical W3C DTCG representation.

#### Cross-Platform Admission Scoring (AND Condition)

When a task touches code areas governed by multiple platform bindings, the admission scoring result is an **AND condition across all applicable bindings**:

- The task must satisfy the **base binding** validation
- The task must satisfy **every platform extension binding** that applies to the affected code areas
- If **any** binding fails validation, the task is blocked

This is consistent with the atomic migration model (§5.5): there is no concept of "partially compliant" across platforms. A task that passes web token compliance but would fail iOS token compliance for a shared design decision is blocked until the design decision can be resolved across all platforms.

```
Task affecting web + iOS code areas
        │
        ├─→ Base binding validation → pass
        ├─→ Web extension binding validation → pass
        └─→ iOS extension binding validation → fail
                                               │
                                               ▼
                        Task blocked. All bindings must pass.
```

**Admission scoring integration:** The `designSystemReadiness` field in `AdmissionInput` (RFC-0008 §A.2) aggregates platform binding results using `min()` — the lowest readiness score across all applicable bindings determines the composite readiness signal. This preserves the hard-gate behavior defined in RFC-0008 §6 (C2) without requiring the scoring model to enumerate individual platform results.

---

## 6. Pipeline Integration

### 6.1 New Stage Type: `design-system`

Pipelines MAY include stages of type `design-system` that reference a `DesignSystemBinding`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: frontend-delivery
  namespace: team-frontend
spec:
  triggers:
    - event: issue.assigned
      filter: { labels: ["frontend", "ai-eligible"] }
    - event: design-token.changed
      source: acme-design-system

  providers:
    sourceControl:
      type: github
      config: { org: "acme-org" }
    designSystem:
      type: design-system-binding
      config: { ref: "acme-design-system" }

  stages:
    # Stage 1: Resolve design context
    - name: design-context
      type: design-system
      actions:
        - resolve-tokens
        - resolve-catalog
        - assess-reusability
      output:
        tokenSnapshot: true
        catalogManifest: true
        reusabilityScore: true

    # Stage 2: Design impact review (NEW — addresses reviewer feedback §1)
    # For token-change triggers: design lead reviews impact before agent executes
    - name: design-impact-review
      type: design-review
      condition: "trigger.event == 'design-token.changed'"
      approval:
        required: true
        reviewers: ["design-lead"]
        blocking: true
        timeout: PT24H
        onTimeout: pause                 # Do not auto-proceed without design review
      context:
        show:
          - tokenDiff                    # What tokens changed
          - affectedComponents           # Which components are impacted
          - cascadeAnalysis              # Which are intentional exceptions?
          - reusabilityScore
      annotation: >
        Design lead reviews the impact analysis and confirms that the
        token change SHOULD cascade to all affected components. Components
        that are intentional exceptions can be excluded from agent scope.

    # Stage 3: Implement component
    - name: implement
      agent: frontend-agent
      timeout: PT30M
      context:
        designSystem: acme-design-system
      constraints:
        requireStory: true
        requireTokenUsage: true
        preferComposition: true
      onFailure:
        strategy: retry
        maxRetries: 3
        retryDelay: PT30S
        scope: design-gates-only

    # Stage 4: Validate design compliance (technical gates)
    - name: technical-review
      qualityGates:
        - token-compliance
        - visual-regression
        - story-completeness
        - accessibility-check

    # Stage 5: Design quality review (NEW — human design judgment)
    - name: design-quality-review
      type: design-review
      condition: "designReview.triggerConditions.met == true"
      approval:
        required: true
        reviewers: ["design-lead", "senior-designer"]
        blocking: true
        timeout: PT48H
        onTimeout: pause
      context:
        show:
          - storyScreenshots              # Component rendered at all viewports
          - visualDiffs                   # If any visual regression diffs exist
          - tokenUsageReport              # Which tokens the component uses
          - pageContext                   # Where the component lives in the product

    # Stage 6: Standard code review
    - name: review
      qualityGates: [coverage, security, human-review]

    # Stage 7: Deploy
    - name: deploy

  routing:
    complexityBased:
      simple:
        strategy: autonomous
        qualityGates: [token-compliance, visual-regression]
        designReview: conditional        # Only if triggerConditions met
      moderate:
        strategy: ai-with-review
        qualityGates: [token-compliance, visual-regression, human-review]
        designReview: required
      complex:
        strategy: human-led
        qualityGates: [all]
        designReview: required
```

### 6.2 New Trigger: `design-token.changed`

Pipelines MAY declare a `design-token.changed` trigger that fires when tokens are updated in the design tool or the token repository. The trigger includes:

```yaml
triggers:
  - event: design-token.changed
    source: acme-design-system
    filter:
      categories: ["color", "spacing"]
      scope: semantic
    designReview:
      impactAnalysis: true               # NEW: require design review of impact
      cascadeThreshold: 5                # If 5+ components affected, require review
      excludable: true                   # Design lead can exclude components from agent scope
```

When this trigger fires, the orchestrator MUST:

1. Diff the changed tokens against the previous snapshot
2. Identify all components consuming the changed tokens (via static analysis or manifest)
3. **Present the impact analysis to design authority for review** (when `designReview.impactAnalysis` is `true` or the number of affected components exceeds `cascadeThreshold`)
4. Allow design authority to exclude specific components that are intentional exceptions
5. Execute the pipeline with the approved component scope
6. Create a PR with the token update, rebuilt components, and updated Storybook stories

### 6.3 Token Deletion Trigger

A `design-token.deleted` event MUST be emitted when a token is removed from the provider. This event follows the same structure as `design-token.changed` with additional constraints:

```yaml
triggers:
  - event: design-token.deleted
    source: acme-design-system
    designReview:
      required: true                     # Token deletion ALWAYS requires design review
      blocking: true
```

**Rationale (reviewer feedback):** Token deletion is a design decision with high cascading risk. Components referencing a deleted token will fail silently or fall through to browser defaults. The orchestrator MUST NOT auto-remediate token deletions without design authority approval. See §12.3 for full token deletion handling.

---

## 7. AgentRole Extensions

### 7.1 Design-System-Aware Agent

The `AgentRole` spec is extended with a `designSystem` block:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: frontend-agent
  namespace: team-frontend
spec:
  role: "Frontend Engineer"
  goal: "Implement UI components that conform to the design system"
  backstory: >
    You are a senior frontend engineer specializing in component-driven
    development. You always use design tokens, compose existing components
    before creating new ones, and produce Storybook stories for every
    component you create or modify.

  tools:
    - code_editor
    - terminal
    - test_runner
    - storybook_mcp
    - design_token_resolver

  constraints:
    maxFilesPerChange: 15
    requireTests: true
    requireStory: true
    requireTokenUsage: true

  designSystem:
    binding: acme-design-system
    contextStrategy: manifest-first
    contextStrategyOverride: auto        # Allow orchestrator to escalate strategy
    componentCreationPolicy: compose-or-justify

  handoff:
    produces:
      - type: component
        schema: "ai-sdlc.io/component-output/v1"
      - type: story
        schema: "ai-sdlc.io/story-output/v1"
      - type: token-usage-report
        schema: "ai-sdlc.io/token-report/v1"
```

### 7.2 Context Strategy and Runtime Selection

The `contextStrategy` field controls how the agent receives design system context. The `contextStrategyOverride` field controls whether the orchestrator may escalate the strategy at runtime.

| Strategy | Description | Token Cost | Use Case |
|----------|-------------|------------|----------|
| `manifest-first` | Component Manifest + token subset relevant to task | Low | Default for most tasks |
| `tokens-only` | Full token set, no component manifest | Minimal | Token-only updates (re-theming) |
| `full` | Complete manifest + all tokens + story examples | High | Complex new components |

**Selection algorithm (addresses reviewer feedback §1):**

When `contextStrategyOverride` is `auto`, the orchestrator MUST select the context strategy using the following decision tree:

```
1. Is the trigger `design-token.changed` with no component modifications?
   → tokens-only

2. Does the task involve modifying or composing existing components only?
   → manifest-first

3. Does the task involve creating a new component?
   → full

4. Does the task touch both tokens AND component composition?
   → full (escalate from manifest-first)

5. Is the reusability score from design-context stage < 0.5?
   → full (catalog insufficient for this task)
```

When `contextStrategyOverride` is `fixed`, the orchestrator MUST use the declared `contextStrategy` without modification.

**Design authority input:** When `designToolAuthority` is `specification` or `collaborative`, the design impact review stage (§6.1) MAY override the context strategy to `full` if the design reviewer determines the task requires compositional judgment that `tokens-only` would not support. This override is recorded in the audit log.

**Re-selection on scope change (addresses reviewer feedback):** The context strategy selection algorithm runs *before* the design impact review stage. If the design impact review changes the approved component scope (e.g., the design lead includes components that were originally excluded, or expands a token-only update into a component modification), the orchestrator MUST re-run the selection algorithm against the updated scope. Specifically:

1. After the design impact review stage completes, the orchestrator compares the approved scope against the scope used for initial strategy selection.
2. If the scope has changed (components added, removed, or the task nature has shifted from token-only to component-modification), the orchestrator re-evaluates the decision tree with the updated inputs.
3. If the re-evaluation produces a different strategy (e.g., `tokens-only` → `full`), the orchestrator updates the agent context before the implement stage begins.
4. The strategy change is recorded in the audit log with the reason: `scope-changed-at-impact-review`.
5. If the re-evaluation produces the same strategy, no action is taken.

---

## 8. Quality Gate Extensions

### 8.1 Token Compliance Gate

A new rule type `designTokenCompliance` is added to the `QualityGate` resource:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: token-compliance
  namespace: team-frontend
spec:
  scope:
    filePatterns: ["src/components/**/*.tsx", "src/components/**/*.css"]
  gates:
    - name: no-hardcoded-colors
      enforcement: hard-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: color
        maxViolations: 0

    - name: spacing-tokens
      enforcement: soft-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: spacing
        maxViolations: 3

    - name: overall-coverage
      enforcement: advisory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        metric: token-coverage
        operator: ">="
        threshold: 85
```

### 8.2 Visual Regression Gate

A new rule type `visualRegression` validates that UI changes are intentional:

```yaml
    - name: visual-diff
      enforcement: soft-mandatory
      rule:
        type: visualRegression
        designSystem: acme-design-system
        config:
          diffThreshold: 0.01
          failOnNewStory: false
          requireBaseline: true
        override:
          approvers: ["design-lead"]
```

### 8.3 Story Completeness Gate

A new rule type `storyCompleteness` validates that components have adequate Storybook coverage:

```yaml
    - name: story-exists
      enforcement: hard-mandatory
      rule:
        type: storyCompleteness
        config:
          requireDefaultStory: true
          requireStateStories: true
          requireA11yStory: true
          minStories: 3
```

### 8.4 Autonomous Correction Loop

When visual regression or token compliance gates fail, the orchestrator MAY invoke the autonomous correction loop. The loop is governed by the pipeline's `onFailure` strategy and subject to a design review exit condition.

**Failure context payload (addresses reviewer feedback §2):**

All `VisualRegressionRunner` adapter implementations MUST provide a structured failure payload conforming to the following minimum schema:

```typescript
interface VisualRegressionFailure {
  /** Component and story identifiers */
  componentName: string;
  storyName: string;

  /** Viewport at which the failure occurred */
  viewport: number;

  /** Quantified diff */
  diffPercentage: number;

  /** Structured region data for agent self-correction */
  changedRegions: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    expectedTokens?: string[];          // Token references in the affected region
    actualValues?: string[];            // Computed values found
  }>;

  /** Diff image URL (for audit, not primary agent input) */
  diffImageUrl?: string;

  /** Affected token references */
  affectedTokens: string[];

  /** Baseline snapshot URL */
  baselineUrl: string;

  /** Current snapshot URL */
  currentUrl: string;
}
```

**Rationale:** An agent that receives only a pass/fail result will thrash through retries without making meaningful corrections, consuming cost budget (per RFC-0004) without converging. Structured region data with affected token references gives the agent actionable context for self-correction.

**Design review exit condition (addresses reviewer feedback §2):**

The correction loop MUST terminate and escalate to design review when ANY of the following conditions are met:

1. `maxRetries` is reached without convergence
2. The agent's correction changes a token reference (not just a layout adjustment)
3. The cumulative cost of loop iterations exceeds the per-execution `softLimit` (per RFC-0004)
4. The design review gate's `triggerConditions` are met at any iteration

When the loop escalates to design review, the full iteration history (each attempt's code diff and visual diff) MUST be included in the review context.

```
Agent generates component + story
        │
        ▼
Run interaction tests (via MCP)
        │
    Pass? ──Yes──▶ Run visual regression
    │                    │
    No               Pass? ──Yes──▶ Run token compliance
    │                    │                  │
    ▼                    No             Pass? ──Yes──▶ Design review
Feed structured              │                  │       conditions met?
failures to agent       Feed structured    No        │
    │                   failures to agent   │    No ──▶ Done
    ▼                       │          Feed structured
Re-generate                 ▼          failures       Yes ──▶ Escalate to
(check exit             Re-generate    to agent               design review
 conditions)                                │
                                            ▼
                                       Re-generate
                                       (check exit conditions)
```

### 8.5 Design Review Gate (NEW)

A new gate type `designReview` is introduced to evaluate whether agent output meets design quality standards that technical gates cannot assess.

#### 8.5.1 Scope Distinction: Visual Regression vs. Design Review

These two gates evaluate fundamentally different concerns and MUST NOT be conflated:

| Concern | Visual Regression Gate | Design Review Gate |
|---------|----------------------|-------------------|
| Question answered | "Did something change that shouldn't have?" | "Is this well designed?" |
| Evaluator | Automated pixel comparison | Human design judgment |
| Catches | Unintended visual changes | Poor spacing, unclear hierarchy, broken visual rhythm, contextual misfit, interaction design flaws |
| Misses | Intentional changes that are poorly designed | Pixel-level regressions below diff threshold |
| Enforcement | Automated pass/fail | Human approval/rejection with structured feedback |

A component can be token-compliant, visually regression-clean, accessibility-passing, and designerly wrong. The design review gate exists to catch this class of failure.

#### 8.5.2 Design Review Gate Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: design-quality-review
  namespace: team-frontend
spec:
  gates:
    - name: design-review
      enforcement: hard-mandatory
      rule:
        type: designReview
        designSystem: acme-design-system
        reviewers: ["design-lead", "senior-designer"]
        minimumReviewers: 1
        timeout: PT48H
        onTimeout: pause
        triggerConditions:
          always:
            - new-component
            - token-schema-change
          conditional:
            - condition: semantic-token-cascade
              threshold: 5                # 5+ components affected
            - condition: visual-diff-exceeds
              threshold: 0.05             # 5% pixel diff
            - condition: complexity-score
              threshold: 7                # Task complexity ≥ 7
        reviewContext:
          include:
            - storyScreenshots
            - visualDiffs
            - tokenUsageReport
            - pageContext                  # Where the component lives in the product
            - designToolAnnotations        # Figma annotations if designToolAuthority is specification
            - correctionLoopHistory        # If the agent went through retry iterations
        feedback:
          structured: true
          categories:
            - visual-quality
            - contextual-fit
            - interaction-design
            - accessibility-intent
            - design-language-consistency
          actionOnReject: return-to-agent  # Agent receives structured feedback and re-attempts
          maxRejections: 2                 # After 2 rejections, escalate to human implementation
```

#### 8.5.3 Design Review Feedback Loop

When a design reviewer rejects agent output, the rejection MUST include structured feedback:

```typescript
interface DesignReviewFeedback {
  decision: 'approved' | 'rejected' | 'approved-with-comments';
  reviewer: string;
  categories: Array<{
    category: 'visual-quality' | 'contextual-fit' | 'interaction-design'
             | 'accessibility-intent' | 'design-language-consistency';
    rating: 'pass' | 'minor-issue' | 'major-issue';
    comment?: string;
  }>;
  /** Specific, actionable guidance for the agent */
  actionableNotes?: string;
  /** Reference to design tool annotations or mockups */
  referenceUrls?: string[];
}
```

The orchestrator MUST feed this structured feedback back to the agent if `actionOnReject` is `return-to-agent`. After `maxRejections` consecutive rejections, the pipeline MUST pause and reassign the task to a human engineer.

---

## 9. Adapter Contracts

### 9.1 DesignTokenProvider Interface

```typescript
interface DesignTokenProvider {
  /** Fetch current tokens in W3C DTCG format */
  getTokens(options?: {
    categories?: string[];
    scope?: 'primitive' | 'semantic' | 'component';
    mode?: string;
  }): Promise<DesignTokenSet>;

  /** Diff tokens between two snapshots */
  diffTokens(
    baseline: DesignTokenSet,
    current: DesignTokenSet
  ): Promise<TokenDiff>;

  /** Identify deleted tokens between snapshots */
  detectDeletions(
    baseline: DesignTokenSet,
    current: DesignTokenSet
  ): Promise<TokenDeletion[]>;

  /** Push token changes back to the design tool */
  pushTokens(
    tokens: DesignTokenSet,
    options?: { branch?: string; message?: string }
  ): Promise<PushResult>;

  /** Subscribe to token change events */
  onTokensChanged(
    callback: (diff: TokenDiff) => void
  ): Unsubscribe;

  /** Subscribe to token deletion events */
  onTokensDeleted(
    callback: (deletions: TokenDeletion[]) => void
  ): Unsubscribe;

  /**
   * Determine whether a schema version change is breaking relative to the
   * current version. Used by the orchestrator to enforce tokenVersionPolicy.
   * A change is breaking if it includes any token removal, rename, type
   * change, or alias restructuring. Value changes are non-breaking.
   */
  detectBreakingChange(
    fromVersion: string,
    toVersion: string
  ): Promise<{ isBreaking: boolean; breakingChanges: string[] }>;

  /** Report the current token schema version */
  getSchemaVersion(): Promise<string>;
}
```

Implementations MUST be provided for:

| Provider | Status | Owner | Notes |
|----------|--------|-------|-------|
| `tokens-studio` | Required | Project (reference) | First `DesignTokenProvider` reference implementation |
| `figma-variables` | Required | Project (reference) | Native Figma Variables API; token extraction only (see §9.5) |
| `style-dictionary` | Optional | Community | Amazon's token transformer |
| `penpot-tokens` | Optional | Community | Open-source design tool |

### 9.2 ComponentCatalog Interface

```typescript
interface ComponentCatalog {
  /** Get the component manifest (Storybook MCP format) */
  getManifest(): Promise<ComponentManifest>;

  /** Resolve a component by name or pattern */
  resolveComponent(query: {
    name?: string;
    category?: string;
    capabilities?: string[];
  }): Promise<ComponentMatch[]>;

  /** Check if a component exists that satisfies a requirement */
  canCompose(requirement: ComponentRequirement): Promise<CompositionPlan>;

  /** Get stories for a component */
  getStories(componentName: string): Promise<Story[]>;

  /** Validate generated code against the catalog */
  validateAgainstCatalog(
    code: string,
    options?: { strict?: boolean }
  ): Promise<ValidationResult>;
}
```

### 9.3 VisualRegressionRunner Interface

```typescript
interface VisualRegressionRunner {
  /** Capture baselines for all stories */
  captureBaselines(stories: Story[]): Promise<BaselineSet>;

  /** Compare current state against baselines */
  compareSnapshots(options: {
    stories: Story[];
    baselines: BaselineSet;
    viewports: number[];
    diffThreshold: number;
  }): Promise<VisualDiffResult>;

  /** Provide structured failure context for agent self-correction */
  getFailurePayload(
    diffResult: VisualDiffResult
  ): Promise<VisualRegressionFailure[]>;

  /** Approve a visual change (update baseline) */
  approveChange(diffId: string, approver: string): Promise<void>;
}
```

The `getFailurePayload` method MUST return structured data conforming to the `VisualRegressionFailure` interface defined in §8.4. Implementations MUST NOT return only a pass/fail status or an unstructured diff image URL.

Implementations MUST be provided for:

| Provider | Status | Owner | Notes |
|----------|--------|-------|-------|
| `playwright-visual` | Required | Project (reference) | Self-hosted; project-owned reference implementation |
| `chromatic` | Optional | Community | Storybook-native visual testing |
| `percy` | Optional | Community | BrowserStack visual testing |

---

### 9.4 UsabilitySimulationRunner Interface

*(Defined in Addendum A §A.5.2)*

---

### 9.5 Adapter Priority and Reference Implementations

The following adapters are **project-owned reference implementations**. They are built and maintained by the AI-SDLC project, not contributed by the community. Each serves as the canonical example for adapter authors building against that interface.

| Adapter | Interface | Priority | Status |
|---------|-----------|----------|--------|
| Tokens Studio | `DesignTokenProvider` | 1st (co-first) | v1alpha1 |
| Figma Variables | `DesignTokenProvider` | 1st (co-first) | v1alpha1 |
| Storybook MCP | `ComponentCatalog` | 2nd | v1alpha1 |
| Playwright | `VisualRegressionRunner` | 3rd | v1alpha1 |
| Usability Simulation | `UsabilitySimulationRunner` | 4th | Unassigned — v1beta1 or community |

**Rationale for co-first `DesignTokenProvider` adapters:**

Tokens Studio and Figma are built simultaneously because validating the `DesignTokenProvider` interface against two real implementations before locking the spec surface is architecturally important. If the two adapters expose a disagreement in the interface shape (e.g., one requires a field the other cannot provide), that is a spec gap that must be resolved before either adapter ships. Co-first development is a forcing function for interface correctness.

**Figma adapter scope boundary (RFC-0007 separation):**

The Figma `DesignTokenProvider` adapter is scoped exclusively to **token extraction** — reading the token schema from Figma Variables and translating it to W3C DTCG format. It does not cover:

- Generating components from Figma designs
- Reading Figma design files for layout or interaction spec
- Any Figma Make (generative AI prototyping) workflow

Those concerns belong to RFC-0007 (Figma Make pipeline integration, not yet written). The boundary is: this adapter reads tokens; RFC-0007 reads designs. These adapters MUST NOT overlap in their Figma API surface. If a Figma API call could be attributed to either scope, it belongs in RFC-0007.

**Storybook MCP as `ComponentCatalog`:**

Storybook is the project-owned `ComponentCatalog` reference implementation, consistent with §4.2 P3 (Storybook is the code-side truth for component runtime behavior). The Storybook MCP adapter provides the component manifest, story enumeration, and test execution capabilities required by the `ComponentCatalog` interface. See §11 for full Storybook MCP integration specification.

**Playwright as `VisualRegressionRunner`:**

Playwright is the project-owned `VisualRegressionRunner` reference implementation. It is self-hosted (no external service dependency), supports cross-browser screenshot capture, and has native screenshot diffing. The adapter wraps Playwright's visual comparison API and translates results into the `VisualRegressionFailure` structured payload required by §8.4.

**`UsabilitySimulationRunner` — unassigned:**

The `UsabilitySimulationRunner` interface (Addendum A §A.5.2) is the most complex adapter and requires browser automation infrastructure. It is not assigned to a project-owned implementation in v1alpha1. It MAY be contributed by the community or addressed in a future project-owned implementation. Teams requiring usability simulation before a community adapter exists may implement the interface directly.

---

## 10. Reconciliation Semantics

The reconciler MUST implement continuous design system reconciliation:

```
┌──────────────┐     ┌──────────────┐     ┌───────────┐
│ Token Source  │     │  Codebase    │     │ Storybook │
│ (Figma/Git)  │     │ (Components) │     │ (Stories) │
└──────┬───────┘     └──────┬───────┘     └─────┬─────┘
       │                    │                   │
       ▼                    ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│              RECONCILIATION CONTROLLER                        │
│                                                              │
│  1. Observe token source → detect changes and deletions      │
│  2. Observe codebase → detect token usage drift              │
│  3. Observe Storybook → detect undocumented changes          │
│  4. Diff all three against DesignSystemBinding spec          │
│  5. Route to design review or agent based on impact scope    │
│  6. Act: trigger pipeline, create PR, alert                  │
│                                                              │
│  Properties: level-triggered, idempotent,                    │
│              eventually consistent                           │
└──────────────────────────────────────────────────────────────┘
```

### 10.1 Reconciliation Events

The controller MUST emit the following events:

| Event | Condition | Action |
|-------|-----------|--------|
| `TokenDriftDetected` | Token source differs from code | Trigger `design-token.changed` pipeline |
| `TokenDeleted` | Token removed from source (NEW) | Trigger `design-token.deleted` pipeline; require design review |
| `TokenSchemaBreakingChange` | Adapter reports `isBreaking: true` for version update | Block all affected pipeline runs; require design authority approval before applying migration (§5.5) |
| `ComponentUndocumented` | Component exists without story | Create advisory issue |
| `TokenViolationFound` | Hardcoded value found in code | Log to audit, enforce per gate policy |
| `CatalogStale` | Manifest older than `refreshInterval` | Refresh manifest via MCP |
| `VisualBaselineMissing` | Story exists without visual baseline | Capture baseline (requires design approval per §5.3) |
| `DesignReviewOverdue` | Pending design review exceeds timeout | Escalate per `onTimeout` policy |

### 10.2 Conflict Resolution

When `spec.tokens.sync.direction` is `bidirectional`, conflicts may arise. The `conflictResolution` field governs behavior:

| Strategy | Behavior |
|----------|----------|
| `code-wins` | Token values in code take precedence; design tool is updated |
| `design-wins` | Token values in the design tool take precedence; code is updated |
| `manual` | Conflict creates an issue assigned to the `sharedAuthority` principals; pipeline pauses |

**Manual resolution timeout (addresses reviewer feedback §5):**

When `conflictResolution` is `manual`, the `manualResolutionTimeout` field (REQUIRED) defines the maximum duration the pipeline may remain paused. The `onTimeout` field defines the behavior when the timeout expires:

| onTimeout | Behavior |
|-----------|----------|
| `escalate` | Create an escalation alert to `escalateTo` principals; pipeline remains paused for an additional `manualResolutionTimeout` period; if still unresolved, fail the pipeline |
| `fallback-design-wins` | Resolve the conflict using `design-wins` strategy; record as auto-resolved in audit log |
| `fail` | Fail the pipeline; token conflict remains unresolved until manually addressed |

The pause is scoped based on the type of resolution required:

- **Token conflict resolution:** The pause is scoped to the **affected token(s) only**. Pipeline activity on unrelated tokens and components MUST NOT be blocked by a pending manual resolution.
- **Design quality review timeout (§8.5.2):** The pause is scoped to the **affected component(s) only**. A design review timeout on Component A MUST NOT block pipeline activity on unrelated Component B, even within the same pipeline run. If a pipeline run produces multiple components and only some require design review, the reviewed components may proceed independently.
- **Design impact review timeout (§6.1 Stage 2):** The pause blocks the **entire pipeline run** for the triggering event, because the design lead's scope decision (which components to include/exclude) affects all downstream stages. This is an intentional bottleneck — the alternative is agent execution without design-approved scope.

---

## 11. Storybook MCP Integration

### 11.1 MCP Tool Registration

The Storybook MCP server MUST be registered as a tool available to agents via `AdapterBinding`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: storybook-mcp
  namespace: team-frontend
spec:
  interface: ComponentCatalog
  provider: storybook-mcp
  config:
    endpoint: "https://storybook.acme.dev/mcp"
    manifestPath: ".storybook/component-manifest.json"
  authentication:                        # NEW (addresses reviewer feedback §7)
    type: bearer-token
    tokenSecret: "${STORYBOOK_MCP_TOKEN}"
    scopes:
      - manifest:read
      - stories:read
      - tests:execute
    # Write scopes (baseline approval) require design authority principal
    writeScopes:
      - baselines:write
      requiredAuthority: designAuthority
  healthCheck:
    endpoint: "/health"
    interval: PT5M
```

### 11.2 Agent Context Injection

When an agent executes within a pipeline that has a `designSystem` provider, the orchestrator MUST:

1. Fetch the Component Manifest from the Storybook MCP endpoint
2. Fetch the relevant token subset from the `DesignTokenProvider`
3. Construct a context payload combining both
4. Apply the context strategy selection algorithm (§7.2)
5. Inject the payload into the agent's system prompt or tool context

The Component Manifest includes component interfaces, variants, design token bindings, validated usage examples, and test suites — enabling the agent to generate code that conforms to the team's actual patterns rather than generic training data.

### 11.3 Autonomous Validation Loop

After agent code generation, the orchestrator MAY invoke the Storybook MCP autonomous correction loop, subject to the exit conditions defined in §8.4. Each loop iteration MUST be recorded in the audit log with the agent's changes, test results, structured failure payloads, and token consumption (per RFC-0004 CostPolicy).

---

## 12. Design Token Lifecycle

### 12.1 Token Change Flow

```
Designer updates token in Figma
        │
        ▼
Tokens Studio commits to Git (W3C DTCG format)
        │
        ▼
AI-SDLC detects design-token.changed trigger
        │
        ▼
Orchestrator diffs tokens, identifies affected components
        │
        ▼
┌─ Design impact review (§6.1 Stage 2) ─────────────────────┐
│  Design lead reviews impact analysis                       │
│  Confirms cascade scope                                    │
│  Excludes intentional exceptions                           │
└────────────────────────────────────────────────────────────┘
        │
        ▼
Style Dictionary transforms tokens → CSS variables / JS modules
        │
        ▼
AI agent rebuilds affected components with new token values
        │
        ▼
Quality gates: token compliance + visual regression + tests
        │
        ▼
Design review gate (if triggerConditions met — §8.5)
        │
        ▼
PR created with: token update + component changes + story updates
        │
        ▼
Human review (if routing requires it)
        │
        ▼
Merge → Storybook redeploys → baselines update
```

### 12.2 Token Provenance

Every token change MUST be recorded in the hash-chained audit log with:

- Source: `figma` | `code` | `agent` | `manual`
- Actor: designer ID, agent ID, or developer ID
- Diff: previous value → new value
- Impact: list of affected components
- Pipeline run ID
- Design review decision (if applicable): approved / excluded components / rejected

### 12.3 Token Deletion Handling (NEW — addresses reviewer feedback §4)

Token deletion is a distinct lifecycle event from token modification. Deleted tokens create a class of failure (silent fallthrough to browser defaults) that is more severe than a value change.

**The orchestrator MUST handle token deletions as follows:**

1. **Detection:** The `DesignTokenProvider.detectDeletions()` method identifies tokens present in the previous snapshot but absent in the current snapshot.

2. **Event:** A `TokenDeleted` reconciliation event is emitted with:
   - The deleted token's full path, type, and last known value
   - All components referencing the deleted token (via static analysis or manifest)
   - Whether the token was a primitive, semantic, or component token
   - Whether any other tokens alias the deleted token

3. **Design review (REQUIRED):** Token deletion ALWAYS requires design authority approval before the pipeline acts. The design reviewer must confirm:
   - The deletion is intentional (not accidental)
   - A replacement token exists (and what it is), OR
   - The affected components should be refactored to remove the reference

4. **Agent remediation:** After design approval, the agent receives the deletion context and the design reviewer's remediation guidance. The agent updates affected components to reference the replacement token or removes the dependency.

5. **Quality gates:** All standard gates apply. Additionally, the orchestrator MUST verify that no component in the codebase references the deleted token after remediation (zero-reference check).

```yaml
# Reconciliation event
- event: TokenDeleted
  condition: token removed from provider
  action:
    - notify: designAuthority.principals
    - createIssue:
        assignTo: designAuthority.principals
        priority: high
        blocking: true                   # Pipeline cannot auto-remediate without approval
    - waitForApproval:
        timeout: PT48H
        onTimeout: escalate
```

---

## 13. Autonomy Policy Extensions

Design system tasks introduce new autonomy dimensions. The `AutonomyPolicy` resource is extended with design-specific permissions and metrics from both disciplines.

### 13.1 Autonomy Levels

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
          modifyExistingComponents: true
          createNewComponents: false
          modifyTokens: false
          modifyStories: true
          approveVisualDiffs: false
      guardrails:
        requireApproval: all
        requireDesignReview: always       # Design review on every output
        maxComponentsPerPR: 1

    - level: 2
      name: "Mid Frontend"
      permissions:
        designSystem:
          modifyExistingComponents: true
          createNewComponents: true
          modifyTokens: false
          modifyStories: true
          approveVisualDiffs: false
      guardrails:
        requireApproval: design-gates-only
        requireDesignReview: conditional   # Only when triggerConditions met
        maxComponentsPerPR: 3

    - level: 3
      name: "Senior Frontend"
      permissions:
        designSystem:
          modifyExistingComponents: true
          createNewComponents: true
          modifyTokens: true
          modifyStories: true
          approveVisualDiffs: false        # See §13.3 for rationale
      guardrails:
        requireApproval: none
        requireDesignReview: conditional
        maxComponentsPerPR: 10
```

### 13.2 Promotion Criteria with Design Metrics

Promotion thresholds include both engineering and design quality metrics.

**Calibration requirement (addresses reviewer feedback):** The values below are **calibration templates, not defaults.** Every team MUST run a calibration pass during Phase 1 of the migration (§15) to set thresholds appropriate to their design system maturity. The orchestrator SHOULD provide a calibration mode that observes pipeline operations for a defined period and recommends initial thresholds based on observed data.

The template values below represent a **mature design system** with 100+ components in the catalog. Teams with younger systems MUST adjust downward — the rationale annotations indicate the expected calibration range for each metric. If a team finds itself needing to deviate from a template value more often than not, the template value itself should be updated for that team, not overridden per-evaluation.

```yaml
  promotionCriteria:
    "1-to-2":
      minimumTasks: 30
      conditions:
        # --- Engineering metrics ---
        - metric: token-compliance-rate
          operator: ">="
          threshold: 0.95
          calibrationRange: [0.85, 0.98]
          rationale: >
            High token compliance demonstrates the agent understands
            the token system. Calibrate lower end (0.85) during
            Phase 1–2 migration; raise toward 0.98 as token coverage
            matures.
        - metric: visual-regression-pass-rate
          operator: ">="
          threshold: 0.90
          calibrationRange: [0.80, 0.95]
          rationale: >
            Visual regression pass rate measures technical correctness.
            Does not measure design quality — see design metrics below.
        - metric: component-reuse-rate
          operator: ">="
          threshold: 0.60
          calibrationRange: [0.40, 0.85]
          rationale: >
            Template set at 0.60 to accommodate teams at any catalog
            maturity level. Teams with fewer than 50 components may
            need 0.40–0.50. Teams with 200+ components SHOULD raise
            to 0.75–0.85. This metric is the most sensitive to catalog
            size — calibrate it first during Phase 1.
        # --- Design metrics ---
        - metric: design-review-approval-rate
          operator: ">="
          threshold: 0.80
          calibrationRange: [0.70, 0.90]
          rationale: >
            The percentage of design review submissions approved on
            first or second attempt. Measures whether agent output
            meets design quality standards as judged by human designers.
        - metric: design-review-rejection-categories
          operator: "none-major"
          window: "30d"
          rationale: >
            No major-issue rejections in any design review category
            within the trailing 30-day window. Minor issues are acceptable.
      requiredApprovals: [design-lead, engineering-lead]

    "2-to-3":
      minimumTasks: 100
      conditions:
        - metric: token-compliance-rate
          operator: ">="
          threshold: 0.98
          calibrationRange: [0.93, 0.99]
        - metric: visual-regression-pass-rate
          operator: ">="
          threshold: 0.95
          calibrationRange: [0.88, 0.98]
        - metric: component-reuse-rate
          operator: ">="
          threshold: 0.75
          calibrationRange: [0.60, 0.90]
        - metric: design-review-approval-rate
          operator: ">="
          threshold: 0.90
          calibrationRange: [0.82, 0.95]
        - metric: design-review-first-pass-rate
          operator: ">="
          threshold: 0.75
          calibrationRange: [0.65, 0.85]
          rationale: >
            75% of design reviews approved without any rejection cycle.
            Demonstrates the agent produces design-quality output
            consistently, not just technically compliant output.
        - metric: new-component-design-acceptance
          operator: ">="
          threshold: 0.85
          calibrationRange: [0.75, 0.92]
          rationale: >
            For tasks where the agent created a new component (not
            composition), what percentage were accepted by design review?
      requiredApprovals: [design-lead, engineering-lead, design-system-team]

  demotionTriggers:
    - trigger: token-compliance-below-threshold
      condition:
        metric: token-compliance-rate
        operator: "<"
        threshold: 0.70
        window: "7d"
      action: demote-one-level
      cooldown: "2w"
    - trigger: visual-regression-failure-streak
      condition:
        metric: consecutive-visual-failures
        operator: ">="
        threshold: 5
      action: demote-one-level
      cooldown: "2w"
    # NEW: Design quality demotion triggers
    - trigger: design-review-rejection-streak
      condition:
        metric: consecutive-design-rejections
        operator: ">="
        threshold: 3
      action: demote-one-level
      cooldown: "2w"
      rationale: >
        Three consecutive design review rejections indicates the agent
        is producing output that meets technical standards but fails
        design quality standards. Demotion increases oversight.
    - trigger: design-major-issue
      condition:
        metric: design-review-major-issues
        operator: ">="
        threshold: 2
        window: "14d"
      action: demote-one-level
      cooldown: "4w"
```

### 13.3 Rationale: `approveVisualDiffs: false` at All Levels

Visual diff approval remains a human-only action at all autonomy levels, including Level 3. This is an intentional asymmetry, not an oversight.

**Why Level 3 agents can propose token changes but cannot approve visual diffs:**

Token changes are structural decisions with bounded, predictable effects — the agent can reason about token references, cascading aliases, and value transformations. Visual diff approval requires aesthetic judgment: "does this look right in context?" This is a qualitatively different capability that the current state of AI cannot reliably perform.

A Level 3 agent proposing a token change is analogous to an engineer writing a database migration — the effect is predictable and testable. Approving a visual diff is analogous to a design director signing off on a brand change — it requires judgment that cannot be reduced to a metric.

**This asymmetry is intentional and SHOULD be revisited** as AI visual reasoning capabilities mature. Teams MAY submit an RFC to introduce limited visual diff approval at Level 3+ for diffs below a configurable threshold (e.g., < 0.5% pixel diff on agent-authored stories). Such an RFC would require design leadership co-authorship.

---

## 14. Worked Example

### Scenario: Designer Updates Primary Brand Color

1. **Trigger:** Designer changes `color.primary` from `#3B82F6` to `#2563EB` in Figma using Tokens Studio.

2. **Token Sync:** Tokens Studio commits the change to `acme-org/design-tokens` repository on branch `ai-sdlc/token-sync-1711612800`.

3. **Reconciler Detects:** The AI-SDLC reconciler observes the `design-token.changed` event. It diffs the token set and identifies `color.primary` changed.

4. **Impact Analysis:** The orchestrator queries the Storybook MCP Component Manifest. It identifies 23 components that reference `color.primary` through semantic tokens `color.surface.brand` and `color.text.inverse`.

5. **Design Impact Review (NEW):** Because 23 components exceed the `cascadeThreshold` of 5, the pipeline pauses and presents the impact analysis to the design lead. The design lead reviews the 23 affected components and identifies 2 components (`AlertBanner`, `LegacyHeader`) that are intentional exceptions — they use the old primary color for a specific accessibility reason. The design lead excludes these 2 components from the agent scope and approves the cascade for the remaining 21.

6. **Routing:** Task complexity is scored as 4 (moderate — many components but mechanical change). Routing strategy: `ai-with-review`.

7. **Agent Execution:**
   - The frontend agent receives the token diff, Component Manifest, and the design-approved scope (21 components)
   - Context strategy: `tokens-only` (no component composition needed)
   - Style Dictionary transforms the updated token to CSS variables
   - The agent rebuilds all 21 components' Storybook stories with the new token value
   - No code changes needed (components reference tokens, not raw values)
   - Agent produces a token-usage-report confirming all references are indirect

8. **Quality Gates:**
   - Token compliance: PASS (100% coverage, no hardcoded values)
   - Visual regression: 21 stories show visual diffs (expected)
   - Story completeness: PASS (all stories present)
   - Tests: PASS (no behavioral changes)

9. **Design Quality Review:** Because visual diffs exist on 21 components, the design review gate's `triggerConditions` are met. The design lead reviews the story screenshots at all viewports and confirms the new primary color renders correctly in context. Approved.

10. **PR Created:** PR includes token update, rebuilt Storybook, visual diff screenshots, design review approval, excluded component rationale, and token provenance entry.

11. **Post-Merge:** Storybook redeploys. Visual baselines update (with design approval). Reconciler confirms convergence. Audit log records the full chain: designer → Figma → tokens → design impact review → agent → quality gates → design quality review → PR → merge.

---

## 15. Migration Path

Each phase involves joint participation from design and engineering leadership. No phase is engineering-only.

### Phase 1: Co-Discovery (Weeks 1–4)

**Joint kick-off:** Design and engineering leads co-author the initial `DesignSystemBinding` resource, explicitly agreeing on:
- `designToolAuthority` setting (exploration / specification / collaborative)
- `conflictResolution` strategy
- `stewardship` authority assignments
- Initial `compliance.disallowHardcoded` rules

**Engineering tasks:**
- Deploy `DesignSystemBinding` with all gates set to `advisory`
- Run token compliance analysis to establish baseline coverage
- Identify components with hardcoded values
- Deploy Storybook MCP endpoint

**Design tasks:**
- Review the initial compliance report to agree on what counts as a violation vs. an intentional exception
- Co-author the initial token schema (verify that the existing token structure accurately represents design intent)
- Identify components that are intentional exceptions to token coverage

**Joint output:** A shared compliance baseline document, reviewed and signed off by both leads, that serves as the starting configuration.

### Phase 2: Baseline Establishment (Weeks 5–8)

**Engineering tasks:**
- Graduate `no-hardcoded-colors` to `soft-mandatory`
- Agent begins remediating token violations in existing components
- Capture visual regression baselines for all Storybook stories

**Design tasks:**
- **Review and approve all visual baselines before they become the regression standard.** Baselines established without design input become the enforced design standard — if the baseline captures a component that was always intended to be revised, it will enforce the wrong state as correct.
- Identify components in the baseline that need revision and flag them for exclusion or redesign before enforcement begins

**Joint tasks:**
- Begin tracking agent token-compliance-rate for autonomy scoring
- First design review gate dry run: design lead reviews agent output with `advisory` enforcement to calibrate the review process

### Phase 3: Full Governance (Weeks 9–12)

**Engineering tasks:**
- Graduate remaining technical gates to `hard-mandatory`
- Enable `design-token.changed` trigger for automatic reconciliation
- Enable autonomous correction loop for visual regression failures

**Design tasks:**
- Graduate design review gate to `hard-mandatory` for new components and token schema changes
- Calibrate design review `triggerConditions` thresholds based on Phase 2 dry run data
- Establish the design review SLA (target review time)

**Joint tasks:**
- Review first month of design review data to calibrate autonomy promotion thresholds (§13.2)
- Begin autonomy promotions based on combined engineering + design metrics

### Phase 4: Bidirectional Sync and Maturation (Weeks 13+)

**Engineering tasks:**
- Enable `bidirectional` token sync (code changes flow back to design tool)
- Grant Level 3 agents permission to propose token changes

**Design tasks:**
- Monitor code-to-design token pushback for unintended overrides
- Establish the design review cadence for Level 3 agent token proposals

**Joint tasks:**
- Quarterly review of `DesignSystemBinding` configuration (stewardship assignments, thresholds, authority level)
- Evaluate whether `designToolAuthority` setting should be adjusted based on operational experience

---

## 16. Security Considerations

### 16.1 Token Exposure

Design tokens contain brand values (colors, typography) that may be considered proprietary. The `DesignSystemBinding` resource MUST support:

- Token values stored as secrets (referenced via `${SECRET_NAME}`)
- Token diffs in audit logs MAY be redacted for external SIEM export
- MCP endpoints MUST require authentication (see §16.3)

### 16.2 Agent Scope

Agents operating under design system constraints MUST NOT:

- Access design tokens for systems outside their namespace
- Push token changes without the `modifyTokens` permission
- Approve their own visual regression diffs
- Modify `DesignSystemBinding` fields outside their authority scope (per §5.3 stewardship model)

### 16.3 MCP Authentication (addresses reviewer feedback §7)

Storybook MCP endpoints expose the full component manifest, which may include proprietary component patterns, internal naming conventions, and usage examples. The following authentication requirements are MANDATORY:

**Minimum requirements:**
- All MCP endpoints MUST require Bearer token authentication
- Tokens MUST be scoped to specific operations: `manifest:read`, `stories:read`, `tests:execute`, `baselines:write`
- Read-only scopes (`manifest:read`, `stories:read`) MAY be granted to agent execution environments
- Write scopes (`baselines:write`) MUST require a principal listed in the `designAuthority` of the associated `DesignSystemBinding`
- Tokens MUST have a configurable TTL (default: 24 hours) and MUST be rotated via the orchestrator's JIT credentials system (see Architecture §Security)

**Cross-namespace access:**
- Agents MUST NOT access MCP endpoints for design systems outside their namespace without an explicit `AdapterBinding` in their namespace that references the cross-namespace endpoint
- Cross-namespace access MUST be logged as a distinct event type in the audit log

### 16.4 Supply Chain

Token files from external design tools (Figma, Penpot) MUST be validated against the W3C DTCG schema before ingestion. Malformed or unexpected token types MUST be rejected. Token deletion events MUST be validated to ensure they originated from an authorized design tool session, not from a compromised integration.

---

## 17. Alternatives Considered

### 17.1 Figma as Sole Source of Truth

**Rejected.** Treating Figma as the sole authoritative source forces a one-directional flow (design → code) and ignores engineering constraints discovered during implementation. Design tokens as the shared contract preserve both design intent and engineering reality. However, this RFC does not demote Figma arbitrarily — the `designToolAuthority` configuration (§4.2 P2) allows teams to position Figma as `specification`-level authority if that matches their organizational structure.

### 17.2 Code-Only Design System (No Design Tool Integration)

**Rejected.** Excluding designers from the governed workflow would reduce adoption. Professional designers will continue using visual tools. The adapter architecture allows design tools to participate at the authority level that fits each team.

### 17.3 Embedding Design Governance in QualityGate Without a New Resource Type

**Considered but rejected.** Design system configuration (tokens, catalogs, visual regression, sync direction, conflict resolution, stewardship) is complex enough to warrant its own resource type. Overloading `QualityGate` would violate the single-responsibility principle and make schema validation unwieldy.

### 17.4 Separate Pipeline for Design vs. Code

**Rejected.** Maintaining separate pipelines for design token changes and code changes would reintroduce the synchronization problem this RFC solves. A unified pipeline with design-aware stages keeps the lifecycle atomic.

### 17.5 Design Review as Optional Add-On

**Considered but rejected.** Early drafts of this RFC treated design review as a configurable enhancement rather than a core gate type. Reviewer feedback demonstrated that technical gates (visual regression, token compliance) are necessary but insufficient — they cannot evaluate design quality, contextual fit, or design language consistency. Design review is a first-class concern, not an optional extra.

---

## 18. Open Questions

1. ~~**Token versioning strategy**~~ **Resolved in v5 (§5.5).** Token schemas follow semver. Teams configure update behavior via `spec.tokens.versionPolicy`: `exact` (pin to a specific version), `minor` (accept minor and patch), `minor-and-major` (accept major, minor, and patch), or `latest` (track head). Migrations are atomic — no staged rollouts or dual-write periods. Breaking changes block all affected pipeline runs until a design authority principal approves the migration and it is applied everywhere simultaneously. Staged rollouts across multiple product surfaces are handled by separate `DesignSystemBinding` instances with coordinated stewardship, not by dual token names.

2. ~~**Multi-brand support**~~ **Resolved in v5 (§5.6).** Multi-brand bindings use the `extends` field to declare a parent–child relationship. Validation executes in two independent layers: the parent validates first at its own thresholds, then the child validates at its own thresholds. Both layers must pass — a child cannot configure its way out of a parent constraint. Child bindings may only tighten compliance thresholds (set values ≥ parent); any attempt to loosen a threshold is rejected at admission time. Inheritance depth is limited to two levels in v1alpha1.

3. ~~**Figma Make as pipeline input**~~ **Escalated to RFC-0007.** Figma Make output is non-deterministic — two runs from the same prompt produce structurally different components. Accepting non-deterministic design artifacts as pipeline triggers introduces unpredictability at the source of the governance chain. This requires its own treatment of: prompt-to-component determinism requirements, validation of Figma Make output before it enters the governed pipeline, and the `DesignPrototypeProvider` adapter interface specification.

4. ~~**Cross-framework tokens**~~ **Resolved in v5 (§5.7).** Cross-platform bindings use the hybrid model: a shared base binding governs the canonical W3C DTCG token set, and platform-specific extension bindings (using `extends`) handle platform-native token expressions. The `spec.tokens.platform` field identifies the expression format (`web`, `ios`, `android`). Admission scoring uses an AND condition across all applicable platform bindings — a task must satisfy every applicable binding or it is blocked. The `designSystemReadiness` composite in RFC-0008 §A.2 aggregates platform results using `min()`. In v1alpha1, only the `web` platform has a project-owned adapter; `ios` and `android` are v1beta1 community adapters.

5. ~~**Community adapter priority**~~ **Resolved in v5 (§9.5).** Four project-owned reference implementations are committed: Tokens Studio and Figma Variables as co-first `DesignTokenProvider` adapters (v1alpha1), Storybook MCP as the `ComponentCatalog` adapter (v1alpha1), and Playwright as the `VisualRegressionRunner` adapter (v1alpha1). The Figma adapter is scoped to token extraction only; Figma Make and design file reading belong to RFC-0007. `UsabilitySimulationRunner` is unassigned in v1alpha1 and will be community-contributed or addressed in a future project-owned implementation.

6. ~~**Design review tooling**~~ **Resolved.** The design review gate's structured feedback interface (§8.5.3) is surfaced through two complementary channels:
   - **Primary surface: Storybook-hosted review UI.** The published Storybook instance serves as the review environment where design leads see rendered components at all viewports alongside the structured feedback form (categories, ratings, actionable notes). This is consistent with §4.2 P3 — Storybook is the code-side truth and the natural place to evaluate component behavior. The `DesignSystemBinding.spec.catalog.storybookUrl` provides the endpoint.
   - **Annotation channel: Design tool comments.** When `designToolAuthority` is `specification` or `collaborative`, the review gate SHOULD also surface a link to the design tool annotations (e.g., Figma comments) that correspond to the component being reviewed. The design lead can cross-reference the rendered Storybook output against their original design annotations. This does not require a new UI surface — it links two existing surfaces.
   - **Integration:** The orchestrator creates a review request in the team's configured notification channel (Slack, Teams, email) with direct links to both the Storybook story and the relevant design tool file. The structured feedback response is submitted via the orchestrator's API (REST or dashboard UI), not via Figma or Storybook directly. The feedback is recorded in the audit log.

7. ~~**Autonomy threshold calibration**~~ **Partially resolved in v4.** §13.2 now frames all thresholds as calibration templates with explicit `calibrationRange` fields. The remaining question is whether the orchestrator should provide an automated calibration mode that observes pipeline operations during Phase 1 and recommends initial thresholds based on observed data — rather than requiring teams to manually select values within the calibration range. This is a tooling decision, not a spec decision, and MAY be addressed in the orchestrator implementation rather than the specification.

8. **Soul purpose document and PPA Triad integration — Escalated to RFC-0008.** The PPA Triad Integration Analysis identifies a foundational gap: RFC-0006 governs the design system, PPA governs product priority, but neither document defines the authoritative *design intent artifact* that both need to reference. PPA's Sα₂ (Vibe Coherence) assesses alignment against "brand and UX guidelines" maintained independently from the `DesignSystemBinding`, creating a duplication problem that will become a divergence problem. Additionally, five integration connections between the PPA scoring model and RFC-0006's `DesignSystemBinding` resource are specified in the Triad Analysis but are out of scope for this RFC. These include: design system health as a product prioritization input (Eρ₄), design authority as a formal human curve channel (HC_design), and delivery risk adjustment based on code area quality metrics (Dπ₁). RFC-0008 addresses all five connections and resolves the soul purpose document ownership question as a prerequisite.

---

## 19. References

- [W3C Design Tokens Format Module, v1.0 (October 2025)](https://www.w3.org/community/design-tokens/)
- [Storybook MCP — Component Manifest Specification](https://storybook.js.org/blog/storybook-mcp-sneak-peek/)
- [Tokens Studio — Remote Token Storage](https://docs.tokens.studio/token-storage/remote)
- [Style Dictionary — Token Transformer](https://amzn.github.io/style-dictionary/)
- [AI-SDLC Specification v1alpha1](https://ai-sdlc.io/docs/spec/spec)
- [RFC-0002: Pipeline Orchestration](https://ai-sdlc.io/docs/spec/rfcs/RFC-0002-pipeline-orchestration)
- [RFC-0004: CostPolicy Extension](https://ai-sdlc.io/docs/spec/rfcs/RFC-0004-cost-policy)
- [RFC-0008: PPA Triad Integration](https://ai-sdlc.io/docs/spec/rfcs/RFC-0008-ppa-triad-integration) (companion RFC)
- [Builder.io — AI Automation in Design Systems](https://www.builder.io/blog/design-system-ai-automation)
- [axe-core — Accessibility Engine for Automated Web UI Testing](https://github.com/dequelabs/axe-core)
- [AI-SDLC Tutorial 9 — Review Agent Calibration](https://ai-sdlc.io/docs/tutorials/09-review-calibration)
- [UXAgent — LLM-Agent-Based Usability Testing Framework (CHI EA '25)](https://arxiv.org/abs/2502.12561)
- [UXCascade — Scalable Usability Testing with Simulated User Agents](https://arxiv.org/html/2601.15777v1)
- [design-lint — Automated Design System Linting](https://design-lint.lapidist.net/)
- [W3C WAI — Web Accessibility Evaluation Tools List](https://www.w3.org/WAI/test-evaluate/tools/list/)

---

## Addendum A: Deterministic-First Design Review Architecture

**Added:** 2026-04-02
**Motivation:** Design leadership feedback (§8.5) established the need for a design review gate distinct from visual regression. Engineering feedback (Tutorial 9 review calibration) demonstrated that the AI-SDLC already has a proven **deterministic-first, LLM-second** architecture for code review. This addendum extends that architecture to design review, defining what can be automated deterministically, what requires AI agent evaluation, and what requires human design judgment.

**Cross-reference:** This addendum extends §8.5 (Design Review Gate) and provides the implementation specification for the `designCI` layer referenced in the pipeline (§6.1).

---

### A.1 The Problem: Unstructured Design Review

Design review as practiced today is analogous to pre-linting code review: a senior designer manually checks everything in a single pass — accessibility violations, token compliance, spacing consistency, typography adherence, interactive state completeness, usability, AND aesthetic quality. This bundles mechanical checks (which have deterministic pass/fail answers) with judgment calls (which require human expertise), creating a bottleneck that scales poorly and buries high-value design judgment under routine verification work.

The AI-SDLC review calibration architecture (Tutorial 9) solved the equivalent problem for code review by establishing a CI boundary: deterministic tools handle lint, typecheck, and coverage; the AST preprocessor handles structural analysis; LLM agents handle only what remains. Design review needs the same layered architecture.

---

### A.2 Three-Layer Design Review Architecture

```
Component + Storybook Story
  │
  ├─→ [Deterministic] Design CI (accessibility, tokens, spacing, type scale, states)
  │     └─→ Pass/fail — no human or AI review needed
  │
  ├─→ [Deterministic] Structural Design Preprocessor (complexity, completeness, grid)
  │     └─→ Structural findings — prepended to review context
  │
  ├─→ [AI Agent] Usability Simulation (browser-based task completion testing)
  │     ├─→ Structured findings with confidence scores + evidence
  │     ├─→ Confidence filtering (<0.5 suppressed)
  │     └─→ Meta-review (medium confidence → lightweight verification)
  │
  └─→ [Human] Design Lead Review (only what survives all automated layers)
        └─→ Aesthetic quality, brand consistency, visual rhythm,
            contextual fit, design language coherence
```

This mirrors the Tutorial 9 architecture exactly:

| Tutorial 9 (Code Review) | Addendum A (Design Review) |
|--------------------------|---------------------------|
| CI/CD (lint, typecheck, tests, coverage) | Design CI (accessibility, tokens, spacing, type scale, states) |
| AST Preprocessor (complexity, file length, imports) | Structural Design Preprocessor (component complexity, completeness, grid adherence) |
| CI Boundary (agents skip CI-covered categories) | Design CI Boundary (design reviewers skip automated categories) |
| LLM Review Agents (structured reasoning, evidence required) | AI Usability Simulation Agents (task completion, structured findings) |
| Principles + Exemplars (7 principles + 20 labeled examples) | Design Principles + Exemplars (design-specific principle bank) |
| Meta-Review (Haiku verifies medium-confidence findings) | Simulation Meta-Review (lightweight verification of medium-confidence usability findings) |
| Feedback Flywheel (accept/dismiss calibrates thresholds) | Design Feedback Flywheel (design lead accept/dismiss calibrates design thresholds) |

---

### A.3 Layer 1: Design CI Boundary

Every design review agent prompt and every human design reviewer receives a **Design CI Boundary** section listing exactly what automated checks handle. Reviewers — both human and AI — are told to skip those categories.

#### A.3.1 Deterministic Design Checks

The following checks are fully deterministic (binary pass/fail) and MUST be executed in CI before any AI or human review occurs:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: design-ci
  namespace: team-frontend
spec:
  scope:
    filePatterns: ["src/components/**/*.tsx", "src/components/**/*.stories.tsx"]
  gates:
    # --- ACCESSIBILITY (axe-core + Pa11y) ---
    - name: wcag-aa-automated
      enforcement: hard-mandatory
      rule:
        type: accessibilityAudit
        engine: axe-core
        standard: WCAG22-AA
        config:
          rules:
            - color-contrast               # 4.5:1 normal text, 3:1 large text
            - aria-roles                    # Valid ARIA role values
            - aria-valid-attr-value         # Valid ARIA attribute values
            - button-name                   # Buttons have accessible names
            - image-alt                     # Images have alt text
            - label                         # Form elements have labels
            - link-name                     # Links have discernible text
            - focus-visible                 # Focus indicators present
            - scrollable-region-focusable   # Scrollable regions keyboard-accessible
          # Run against every Storybook story at every configured viewport
          viewports: [375, 768, 1280, 1920]
          runAgainst: all-stories

    # --- TOKEN COMPLIANCE (from §8.1) ---
    - name: no-hardcoded-colors
      enforcement: hard-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: color
        maxViolations: 0

    - name: spacing-token-compliance
      enforcement: hard-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: spacing
        maxViolations: 0

    - name: typography-token-compliance
      enforcement: hard-mandatory
      rule:
        type: designTokenCompliance
        designSystem: acme-design-system
        category: typography
        maxViolations: 0

    # --- TOUCH TARGET VALIDATION ---
    - name: touch-targets
      enforcement: hard-mandatory
      rule:
        type: interactiveElementSize
        minimumSize:
          width: 44                        # 44px minimum (WCAG 2.5.8)
          height: 44
        applyTo: ["button", "a", "input", "select", "textarea", "[role='button']"]

    # --- TYPOGRAPHY SCALE ADHERENCE ---
    - name: type-scale
      enforcement: soft-mandatory
      rule:
        type: typographyScaleCompliance
        designSystem: acme-design-system
        config:
          # All font-size values must exist in the defined type scale
          allowedSizes: token-defined      # Only sizes from typography tokens
          checkProperties: ["font-size", "line-height", "letter-spacing"]

    # --- SPACING GRID COMPLIANCE ---
    - name: spacing-grid
      enforcement: soft-mandatory
      rule:
        type: spacingGridCompliance
        designSystem: acme-design-system
        config:
          # All spacing values must be multiples of the base unit
          baseUnit: 4                      # 4px base grid
          allowedOffGrid: ["1px", "0px"]   # Border widths and zero
          checkProperties: ["margin", "padding", "gap", "top", "right", "bottom", "left"]

    # --- COLOR PALETTE COMPLIANCE ---
    - name: color-palette
      enforcement: hard-mandatory
      rule:
        type: colorPaletteCompliance
        designSystem: acme-design-system
        config:
          # No color values outside the defined palette
          allowedSources: [primitive-tokens, semantic-tokens]
          checkProperties: ["color", "background-color", "border-color", "box-shadow", "outline-color"]

    # --- INTERACTIVE STATE COMPLETENESS ---
    - name: state-completeness
      enforcement: soft-mandatory
      rule:
        type: interactiveStateCompleteness
        config:
          requiredStates:
            button: [default, hover, focus, active, disabled, loading]
            input: [default, focus, filled, error, disabled]
            link: [default, hover, focus, visited]
            card: [default, hover, focus]
          verification: storybook-stories  # Each required state must have a story
```

#### A.3.2 Design CI Boundary Declaration

The Design CI boundary is injected into all downstream review contexts (both AI usability simulation and human design review) so reviewers do not duplicate automated checks:

```yaml
# Prepended to all design review contexts
designCIBoundary:
  automated:
    - category: accessibility-wcag-aa
      tool: axe-core
      scope: "Color contrast, ARIA roles/attributes, focus management, labels, alt text"
      reviewerAction: skip
    - category: token-compliance
      tool: design-token-linter
      scope: "Hardcoded colors, spacing, typography values"
      reviewerAction: skip
    - category: touch-targets
      tool: interactive-element-validator
      scope: "44px minimum interactive element size"
      reviewerAction: skip
    - category: type-scale
      tool: typography-scale-linter
      scope: "Font sizes, line heights, letter spacing against token scale"
      reviewerAction: skip
    - category: spacing-grid
      tool: spacing-grid-linter
      scope: "Margin, padding, gap values against base grid"
      reviewerAction: skip
    - category: color-palette
      tool: palette-compliance-checker
      scope: "All color values from defined palette"
      reviewerAction: skip
    - category: state-completeness
      tool: story-state-checker
      scope: "Required interactive states have Storybook stories"
      reviewerAction: skip
  humanReviewFocus:
    - "Aesthetic quality and visual polish"
    - "Design language consistency across component family"
    - "Visual hierarchy and information architecture"
    - "Contextual fit within page/flow"
    - "Brand alignment and emotional tone"
    - "Responsive behavior quality (beyond breakpoint correctness)"
    - "Motion and transition appropriateness"
```

---

### A.4 Layer 2: Structural Design Preprocessor

Before any AI agent or human reviews the component, deterministic structural analysis runs — the design equivalent of the Tutorial 9 AST preprocessor:

```typescript
interface StructuralDesignAnalysis {
  /** Component complexity score (1-10) */
  complexityScore: number;

  /** Factors contributing to complexity */
  complexityFactors: {
    variantCount: number;                 // Number of component variants
    propCount: number;                    // Number of configurable props
    responsiveBreakpoints: number;        // Number of breakpoint behaviors
    interactiveStates: number;            // Number of state permutations
    composedComponents: number;           // Number of child components used
    tokenReferences: number;              // Number of distinct tokens referenced
  };

  /** Spacing consistency analysis */
  spacingAnalysis: {
    onGridValues: number;                 // Count of values on the spacing grid
    offGridValues: number;                // Count of values off-grid
    consistencyScore: number;             // 0.0 – 1.0
    offGridLocations: Array<{
      property: string;
      value: string;
      file: string;
      line: number;
    }>;
  };

  /** Typography audit */
  typographyAudit: {
    uniqueFontSizes: number;              // Should be low (from scale)
    uniqueLineHeights: number;
    uniqueLetterSpacings: number;
    allOnScale: boolean;                  // All values from the type scale?
    deviations: Array<{
      property: string;
      value: string;
      nearestScaleValue: string;
      file: string;
      line: number;
    }>;
  };

  /** Color usage audit */
  colorAudit: {
    uniqueColors: number;                 // Total distinct color values
    tokenizedColors: number;              // Colors via token reference
    hardcodedColors: number;              // Colors as raw values
    paletteCompliance: number;            // 0.0 – 1.0
  };

  /** Interactive state coverage */
  stateCoverage: {
    requiredStates: string[];
    coveredStates: string[];
    missingStates: string[];
    coveragePercent: number;
  };

  /** Component reuse analysis */
  reuseAnalysis: {
    existingComponentsUsed: string[];     // Which catalog components are composed
    newElementsIntroduced: string[];      // Net-new UI elements not from catalog
    reuseScore: number;                   // 0.0 – 1.0
  };
}
```

These findings are prepended to the review context as **"Pre-Verified Structural Analysis"** — human reviewers and AI agents skip re-analyzing structural properties already covered.

Components scoring 7+ on complexity are flagged as **high-complexity** and automatically trigger the design review gate regardless of other trigger conditions.

---

### A.5 Layer 3: AI Agent Usability Simulation

This layer applies the AI-SDLC's LLM-second principle to design evaluation. AI agents interact with rendered components in a real browser environment, performing task-based usability testing at scale.

#### A.5.1 Architecture

```
Storybook Story (rendered in browser via Playwright/Puppeteer)
        │
        ▼
┌─────────────────────────────────────────────────────┐
│            USABILITY SIMULATION RUNNER               │
│                                                     │
│  1. Deploy story to headless browser environment    │
│  2. Generate persona set from demographic config    │
│  3. For each persona:                               │
│     a. Assign task prompt (e.g., "submit this form")│
│     b. Agent interacts with live DOM via connector  │
│     c. Record: actions, hesitations, errors, path   │
│     d. Measure: completion rate, action count, time │
│  4. Aggregate findings across personas              │
│  5. Produce structured results with confidence      │
│                                                     │
└─────────────────────────────────────────────────────┘
        │
        ▼
Structured usability findings (confidence-scored)
```

#### A.5.2 Adapter Interface: UsabilitySimulationRunner

```typescript
/** Browser session handle for usability simulation */
interface BrowserSession {
  /** Unique session identifier */
  sessionId: string;

  /** The deployed story URL in the headless browser */
  storyUrl: string;

  /** Browser and viewport configuration */
  environment: {
    browser: 'chromium' | 'firefox' | 'webkit';
    viewport: { width: number; height: number };
    theme?: string;
    locale?: string;
  };

  /** Session lifecycle */
  isActive: boolean;
  createdAt: string;                      // ISO 8601
  ttl: string;                            // ISO 8601 duration — auto-cleanup

  /** DOM connector for agent interaction */
  connector: {
    /** Get simplified DOM representation for agent parsing */
    getPageState(): Promise<PageState>;
    /** Execute an action (click, type, scroll) by element reference */
    executeAction(action: AgentAction): Promise<ActionResult>;
    /** Capture screenshot for audit trail */
    captureScreenshot(): Promise<string>;  // Base64 image
  };
}

interface UsabilitySimulationRunner {
  /** Deploy a Storybook story to a browser environment for testing */
  deployStory(story: Story, options: {
    viewport: number;
    theme?: string;                       // light | dark
    locale?: string;
  }): Promise<BrowserSession>;

  /** Generate persona set for simulation */
  generatePersonas(config: {
    count: number;                        // Number of simulated users
    demographics?: {
      techConfidence: 'low' | 'medium' | 'high';
      ageRange?: [number, number];
      accessibilityNeeds?: string[];      // e.g., ["screen-reader", "keyboard-only"]
    };
  }): Promise<Persona[]>;

  /** Run a task-based usability simulation */
  runSimulation(session: BrowserSession, options: {
    persona: Persona;
    task: TaskPrompt;
    maxActions: number;                   // Circuit breaker
    timeout: string;                      // ISO 8601 duration
  }): Promise<SimulationResult>;

  /** Aggregate results across multiple persona simulations */
  aggregateResults(
    results: SimulationResult[]
  ): Promise<AggregatedUsabilityReport>;
}

interface TaskPrompt {
  /** Natural language task description */
  instruction: string;
  /** Expected outcome for pass/fail determination */
  successCriteria: {
    type: 'element-state' | 'navigation' | 'form-submission' | 'custom';
    /** CSS selector or description of expected end state */
    target: string;
  };
  /** Expected action count for efficiency scoring */
  expectedActions?: number;
}

interface SimulationResult {
  persona: Persona;
  task: TaskPrompt;

  /** Did the agent complete the task? */
  completed: boolean;

  /** Task completion metrics */
  metrics: {
    actionsTaken: number;
    expectedActions: number;
    efficiency: number;                   // expectedActions / actionsTaken
    timeElapsed: string;                  // ISO 8601 duration
    errorsEncountered: number;
    backtrackCount: number;               // Times the agent reversed course
    hesitationCount: number;              // Pauses > 2s between actions
  };

  /** Full action trace for audit */
  actionTrace: Array<{
    action: string;                       // "click", "type", "scroll", "navigate"
    target: string;                       // Element description
    timestamp: string;
    agentReasoning?: string;              // Why the agent chose this action
  }>;

  /** Identified usability issues */
  findings: UsabilityFinding[];
}

interface UsabilityFinding {
  severity: 'critical' | 'major' | 'minor' | 'advisory';
  confidence: number;                     // 0.0 – 1.0
  category: 'navigation' | 'discoverability' | 'feedback' | 'error-recovery'
           | 'efficiency' | 'learnability' | 'affordance';

  /** Evidence-first: what the agent actually experienced */
  evidence: {
    taskAttempted: string;
    personaProfile: string;
    actionsTaken: number;
    expectedActions: number;
    failurePoint?: string;                // Where the agent got stuck
    failureScenario: string;              // Narrative of what went wrong
    affectedElement?: string;             // CSS selector or description
  };

  message: string;                        // Human-readable finding
}
```

#### A.5.3 Task Prompt Library

Teams define a library of reusable task prompts that exercise common interaction patterns:

```yaml
# .ai-sdlc/usability-tasks.yaml
tasks:
  - id: form-submission
    instruction: "Fill out this form with valid information and submit it"
    successCriteria:
      type: form-submission
      target: "form[data-testid='contact-form']"
    expectedActions: 5
    applicableTo: ["Form", "ContactForm", "SignupForm", "CheckoutForm"]

  - id: primary-action-discovery
    instruction: "Find and click the primary action button on this page"
    successCriteria:
      type: element-state
      target: "[data-testid='primary-cta']"
    expectedActions: 2
    applicableTo: ["Card", "Hero", "Banner", "Modal"]

  - id: navigation-depth
    instruction: "Navigate to the third-level menu item 'Account Settings'"
    successCriteria:
      type: navigation
      target: "/settings/account"
    expectedActions: 4
    applicableTo: ["Navigation", "Sidebar", "Header"]

  - id: error-recovery
    instruction: "Submit the form with invalid data, then correct the errors and resubmit"
    successCriteria:
      type: form-submission
      target: "form[data-testid='contact-form']"
    expectedActions: 8
    applicableTo: ["Form", "ContactForm", "SignupForm"]

  - id: keyboard-only-completion
    instruction: "Complete this task using only the keyboard — no mouse clicks"
    successCriteria:
      type: form-submission
      target: "form"
    expectedActions: 10
    personas:
      techConfidence: high
      accessibilityNeeds: ["keyboard-only"]
    applicableTo: ["Form", "Modal", "Dialog"]
```

#### A.5.3.1 Task Auto-Selection Algorithm

When a pipeline stage specifies `tasks: auto-select` (§A.8), the orchestrator MUST select tasks from the library using the following algorithm:

```
1. Determine the component type from the Storybook story metadata
   (e.g., "Form", "Card", "Navigation", "Modal")

2. Filter the task library: select all tasks where the component type
   appears in the task's `applicableTo` array.

3. If multiple tasks match:
   a. Run ALL matching tasks. Multiple tasks exercising different
      interaction patterns (e.g., form-submission AND error-recovery
      for a Form component) provide complementary coverage.
   b. If the total number of matching tasks exceeds the configured
      `maxTasksPerComponent` (default: 5), prioritize by:
      - Tasks with `severity: critical` failure history (from feedback flywheel)
      - Tasks covering distinct `category` values (maximize coverage breadth)
      - Tasks matching the component's interactive states

4. If NO tasks match (component type not in any `applicableTo` array):
   a. Generate a generic task prompt using the component's Storybook
      story metadata:
      - If the component has interactive elements (buttons, inputs):
        generate "Interact with the primary action in this component"
      - If the component is display-only (cards, badges, alerts):
        generate "Identify the key information presented by this component"
      - If the component is a container (layout, page, section):
        skip usability simulation (no meaningful task to assign)
   b. Log a `TaskLibraryGap` event so the team can add a task
      prompt for this component type.
   c. Generic tasks are assigned `confidence: 0.6` ceiling — findings
      from generic tasks cannot exceed 0.6 confidence because the
      task was not specifically designed for the component.

5. If the component has `personas` specified in any matching task,
   use those personas. Otherwise, use the default persona set
   from the pipeline's usability simulation config.
```

**The `TaskLibraryGap` event feeds the feedback flywheel (§A.7):** Repeated gaps for the same component type surface as a calibration signal, prompting the team to author specific task prompts.

#### A.5.4 Confidence Filtering and Meta-Review

Following the Tutorial 9 pattern:

- Findings below **0.5 confidence** are automatically suppressed
- **Critical/major** findings MUST include a `failureScenario` with specific agent actions and the element where the failure occurred
- Medium-confidence findings (0.5–0.8) go through a **meta-review** — a lightweight LLM call evaluating: "Is this a real usability issue or an artifact of the simulation?"

```typescript
interface UsabilityMetaReview {
  finding: UsabilityFinding;
  decision: 'keep' | 'suppress';
  adjustedSeverity?: 'critical' | 'major' | 'minor' | 'advisory';
  rationale: string;
}
```

The meta-reviewer receives the finding, the agent's full action trace, the component's structural analysis, and the design CI results. It returns keep/suppress with a rationale.

---

### A.6 Layer 4: Design Principles and Exemplar Bank

Instead of unbounded design rules, the system uses a small set of **design review principles** and a bank of **labeled examples** — exactly mirroring the Tutorial 9 approach.

#### A.6.1 The 7 Design Review Principles

1. **Evidence-First** — Trace the user's path or don't flag it. A usability issue without an action trace is not a valid finding.
2. **Deterministic-First** — Defer to Design CI for accessibility, tokens, spacing, type scale, state completeness. Do not duplicate automated checks.
3. **Context Awareness** — Evaluate the component in its page/flow context, not just in isolation. A component that works in Storybook but breaks visual rhythm on the actual page is a valid finding.
4. **Severity Honesty** — No failure scenario = not critical/major. If the agent completed the task but took one extra step, that is minor at most.
5. **Signal Over Noise** — One well-evidenced usability finding is worth more than ten vague aesthetic observations.
6. **Persona Grounding** — Findings must specify which persona type experienced the issue. A finding that only affects a "high-tech-confidence" persona interacting non-standardly is advisory, not major.
7. **Scope Discipline** — Don't flag design choices that are consistent with the established design language. The simulation tests usability, not aesthetic preference.

#### A.6.2 Design Exemplar Bank

Stored in `.ai-sdlc/design-review-exemplars.yaml`:

```yaml
exemplars:
  - id: submit-button-below-fold
    type: true-positive
    category: discoverability
    scenario: |
      Mobile viewport (375px). Contact form submit button rendered
      below the fold. 3/5 simulated users scrolled past it without
      noticing. Agent with "low-tech-confidence" persona abandoned task.
    verdict: "major — primary CTA not discoverable on mobile"
    principle: evidence-first
    confidence: 0.88

  - id: hover-state-missing-not-usability
    type: false-positive
    category: affordance
    scenario: |
      Agent flagged that a card component has no hover state.
      Card is used in a mobile-only context where hover does
      not apply.
    verdict: "not a usability issue — context is mobile-only"
    principle: context-awareness

  - id: three-extra-actions-on-complex-form
    type: false-positive
    category: efficiency
    scenario: |
      Agent took 8 actions to complete a 5-field form (expected: 5).
      Extra actions were: scrolling to read field labels, pausing
      to read helper text, tabbing between fields. These are
      normal exploratory behaviors.
    verdict: "not a usability issue — exploratory behavior is expected"
    principle: severity-honesty

  - id: error-message-not-associated
    type: true-positive
    category: error-recovery
    scenario: |
      Agent submitted form with invalid email. Error message appeared
      at top of form, not adjacent to the email field. Agent with
      "low-tech-confidence" persona could not locate the error and
      abandoned after 3 attempts.
    verdict: "major — error message not associated with field, recovery impossible for some users"
    principle: evidence-first
    confidence: 0.91

  - id: keyboard-trap-in-modal
    type: true-positive
    category: navigation
    scenario: |
      Keyboard-only agent opened modal dialog. Focus was not trapped
      inside modal. Agent tabbed out of modal into background content
      and could not return. Task abandoned.
    verdict: "critical — focus trap missing, keyboard users cannot complete task"
    principle: evidence-first
    confidence: 0.95
    note: "This should also be caught by axe-core — verify Design CI is running"

  - id: aesthetic-spacing-preference
    type: false-positive
    category: affordance
    scenario: |
      Agent flagged that padding between card title and body text
      "feels too tight." Spacing value is 16px, which is the
      semantic token spacing.component.card.content.
    verdict: "not a usability issue — spacing conforms to design system tokens"
    principle: deterministic-first
```

**To calibrate a new false positive:** Add an exemplar to the YAML file. No code changes needed. Same workflow as Tutorial 9.

---

### A.7 Design Review Feedback Flywheel

Track how design leads respond to both AI usability findings and deterministic check escalations:

| Signal | Meaning | Action |
|--------|---------|--------|
| **Accept** (designer agrees, files fix) | True positive | Strengthens exemplar bank |
| **Dismiss** (designer rejects finding) | False positive | Add to exemplar bank as false-positive |
| **Override** (designer approves despite automated failure) | Intentional exception | Add to exception list; recalibrate rule |
| **Escalate** (designer flags issue automation missed) | False negative | Add to exemplar bank as true-positive; consider new Design CI rule |

```typescript
interface DesignReviewFeedbackStore {
  /** Record a design reviewer's response to a finding */
  record(entry: {
    prNumber: number;
    finding: UsabilityFinding | DesignCIResult;
    signal: 'accepted' | 'dismissed' | 'overridden' | 'escalated';
    reviewer: string;
    category: string;
    comment?: string;
    timestamp: string;
  }): void;

  /** Calculate design review precision */
  precision(): number;                     // accepted / (accepted + dismissed)

  /** Identify categories with high false-positive rates */
  highFalsePositiveCategories(): Array<{
    category: string;
    dismissRate: number;
  }>;

  /** Identify categories where automation is missing findings */
  falseNegativeCategories(): Array<{
    category: string;
    escalationRate: number;
  }>;
}
```

Over time, this data:
- Calibrates confidence thresholds for usability simulation findings
- Identifies categories that need new exemplars
- Identifies deterministic checks that should be added to Design CI (if designers keep escalating the same class of issue, it should be automated)
- Provides the `design-review-approval-rate` and `design-review-first-pass-rate` metrics used in autonomy promotion criteria (§13.2)

---

### A.8 Integration with Pipeline Stages

The three-layer design review architecture integrates into the pipeline defined in §6.1 as follows:

```yaml
stages:
  # ... (stages 1-3 from §6.1: design-context, design-impact-review, implement)

  # Stage 4: Design CI (Layer 1 — fully automated)
  - name: design-ci
    type: quality-gate
    qualityGates: [design-ci]             # All gates from §A.3.1
    context:
      structuralAnalysis: true            # Run Layer 2 preprocessor simultaneously
    onFailure:
      strategy: retry                     # Agent can auto-fix Design CI failures
      maxRetries: 3
      scope: design-ci-only

  # Stage 5: Usability Simulation (Layer 3 — AI agent, deterministic-first)
  - name: usability-simulation
    type: usability-test
    condition: "designReview.triggerConditions.met == true OR component.isNew == true"
    config:
      runner: usability-simulation-runner
      personaCount: 5
      tasks: auto-select                  # Select from task library based on component type
      viewports: [375, 1280]              # Mobile + desktop
      confidenceThreshold: 0.5
      enableMetaReview: true
    onFailure:
      strategy: retry                     # Agent receives structured findings and re-attempts
      maxRetries: 2

  # Stage 6: Design Lead Review (Layer 4 — human judgment, only what survives)
  - name: design-lead-review
    type: design-review
    condition: "designReview.triggerConditions.met == true"
    context:
      include:
        - designCIBoundary                # "You don't need to check these"
        - structuralAnalysis              # Preprocessor findings
        - usabilitySimulationReport       # AI agent findings that survived filtering
        - storyScreenshots
        - visualDiffs
        - pageContext
    approval:
      required: true
      reviewers: ["design-lead", "senior-designer"]
      blocking: true
      timeout: PT48H

  # ... (remaining stages from §6.1: code review, deploy)
```

---

### A.9 Design CI Boundary Summary

| Category | Tool / Method | Type | Enforcement | Human Review? |
|----------|--------------|------|-------------|--------------|
| WCAG AA accessibility | axe-core, Pa11y | Deterministic | hard-mandatory | No |
| Color contrast (4.5:1 / 3:1) | axe-core color-contrast | Deterministic | hard-mandatory | No |
| ARIA roles and attributes | axe-core aria-* rules | Deterministic | hard-mandatory | No |
| Focus management | axe-core focus-visible | Deterministic | hard-mandatory | No |
| Token compliance (color) | design-token-linter | Deterministic | hard-mandatory | No |
| Token compliance (spacing) | design-token-linter | Deterministic | hard-mandatory | No |
| Token compliance (typography) | design-token-linter | Deterministic | hard-mandatory | No |
| Touch target size (44px) | interactive-element-validator | Deterministic | hard-mandatory | No |
| Typography scale adherence | typography-scale-linter | Deterministic | soft-mandatory | No |
| Spacing grid compliance | spacing-grid-linter | Deterministic | soft-mandatory | No |
| Color palette compliance | palette-compliance-checker | Deterministic | hard-mandatory | No |
| Interactive state completeness | story-state-checker | Deterministic | soft-mandatory | No |
| Component structural complexity | structural-preprocessor | Deterministic | advisory (context) | No |
| Task completion (usability) | AI agent browser simulation | LLM-second | soft-mandatory | Only if critical/major finding |
| Aesthetic quality | Human design judgment | Human | hard-mandatory (when triggered) | Yes — this is the point |
| Design language consistency | Human design judgment | Human | hard-mandatory (when triggered) | Yes |
| Contextual fit in page/flow | Human design judgment | Human | hard-mandatory (when triggered) | Yes |
| Visual rhythm and hierarchy | Human design judgment | Human | hard-mandatory (when triggered) | Yes |

**The design lead's review time is focused entirely on the bottom four rows.** Everything above is handled before the review reaches them.

---

### A.10 Metrics and Autonomy Integration

The design review architecture produces metrics that feed directly into the autonomy promotion criteria defined in §13.2:

| Metric | Source | Used In |
|--------|--------|---------|
| `design-ci-pass-rate` | Layer 1: Design CI | Baseline competence — agents that fail Design CI repeatedly are not ready for promotion |
| `usability-simulation-pass-rate` | Layer 3: AI simulation | Agents producing components that simulated users cannot use are not ready for promotion |
| `design-review-approval-rate` | Layer 4: Human review | The ultimate measure — does the design lead approve the output? |
| `design-review-first-pass-rate` | Layer 4: Human review | Measures whether the agent produces design-quality output without rejection cycles |
| `design-ci-auto-fix-rate` | Layer 1 + correction loop | How often the agent self-corrects Design CI failures without human intervention |
| `usability-finding-accuracy` | Feedback flywheel | Precision of the simulation — used to calibrate confidence thresholds |
