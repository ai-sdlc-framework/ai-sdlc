---
id: RFC-0027
title: Design Coherence Drift Detection
status: Draft
lifecycle: Draft
author: Morgan Hirtle
created: 2026-05-04
updated: 2026-10-22
targetSpecVersion: v1alpha1
requires:
  - RFC-0006
  - RFC-0008
  - RFC-0009
  - RFC-0018
assumes:
  - RFC-0017
  - RFC-0028
  - RFC-0035
requiresDocs: []
---

# RFC-0027: Design Coherence Drift Detection

**Document type:** Normative
**Status:** Draft v0.2. Responds to Design Authority sign-off condition C3 on RFC-0009 (design vertex underspecification). Meets four of C3's five items; the fifth (voice register structure) is re-scoped by the Design Authority's RFC-0017 OQ-5 ruling and stays open (§5.1.6). Two parts in one RFC: (A) structured enrichment of the design vertex, and (B) a design coherence drift rule that measures implemented design against that vertex. Part B needs Part A to measure against, which is why they are proposed together. Part A is written so it can be signed off on its own if Part B's open questions take longer (§9).
**Lifecycle:** Draft
**Created:** 2026-05-04 (reserved)
**Updated:** 2026-10-22
**Authors:** Morgan Hirtle (Design Authority)
**Requires:** RFC-0006 (Design System Governance), RFC-0008 (PPA Triad Integration: `SoulDriftDetected`, `DesignIntentDrift`, identity-field reconciliation), RFC-0009 (Tessellated Design Intent Documents), RFC-0018 (In-Soul Journey Pattern: drift rule registry). RFC-0018 is at Ready for Review; Part B cannot ship until it is Implemented.
**Assumes:** RFC-0017 (In-Soul Variant Pattern), RFC-0028 (drift composition, OQ-7.2), RFC-0035 (Decision Catalog routing)

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter at the top of the file is the source of truth for tooling
> (CI, dashboards, the RFC index in `README.md`).

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Morgan Hirtle | Chief of Design / Design Authority | ✍️ Authored v0.2. ✅ Conditional sign-off on v0.2: Part A (design vertex enrichment) and the C3 record in §5.1.6 are ratified; Part A may be ratified and implemented ahead of Part B. Conditions for full sign-off: (1) the §11 practitioner validation pass is completed on the reference implementation; (2) no change to the boundary of the `judgment` class, and no automated aesthetic or imperative scoring, without Design Authority review; (3) no material change to accessibility floor inheritance or the blocking rule before the validation pass without Design Authority review. | 2026-10-22 |
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | [PENDING — Engineering Authority] | |
| Alexander Kline | Head of Product Strategy / Product Authority | [PENDING — Product Authority] | |

**Review asks by pillar:**

- **Engineering Authority:** wiring the registry dispatcher into a required PR check (§9 Phase 2); resolving the DSB accessibility standard from the RFC-0006 audit gate (§5.1.1); the stateless baseline proposal flow (§5.5); the evidence file schema (§5.3.2); identity-field seeding on upgrade (§6.6); shared component-definition conflicts (§5.2); and OQ-4, OQ-7, OQ-8, OQ-9 and OQ-10.
- **Product Authority:** the single-home composition table (§6.5), the Eτ_expression term and its constant `k` (§6.5.1, OQ-5), pillar attribution of that term (§6.5.2), and OQ-8. Product's position in draft RFC-0029 asks for this signal.

---

## 1. Summary

RFC-0009 C3 records that the design vertex "carries 2 unstructured fields against Engineering's 6 and Product's 5." Design intent therefore lives in free text, and the framework cannot check whether a product still looks and behaves the way its soul says it should.

This RFC does two things:

1. **Part A, design vertex enrichment.** Adds five optional structured fields to `triad.design`: `accessibilityFloor`, `componentPolicy`, `authoredAgainst`, `voiceRef`, and `principles`. Where the information already exists elsewhere in the DID or the Design System Binding (DSB), the new field points to it and does not re-declare it.
2. **Part B, design coherence drift.** Defines `DesignCoherenceDriftRule`, registered in the tessellation drift rule registry alongside the RFC-0009 §7.2 rules and RFC-0018's journey state-ID rule. It compares each soul's enriched design vertex against evidence of what is implemented and emits `DesignCoherenceDrift` findings through the RFC-0035 Decision Catalog.

RFC-0006 measures artifacts against the design system. This RFC measures the design system and its artifacts against each soul's declared intent. It reuses RFC-0006 outputs as evidence, adds checks only where RFC-0006 has none, and does not re-score anything RFC-0008 already scores (§6.5).

**Practitioner validation source:** InternalAdopter's design pipeline, which runs static and rendered design checks with a recorded accessibility baseline. The patterns in §5 come from that work, generalised.

## 2. Motivation

Practitioners report four gaps the current spec cannot close.

**Design intent is not machine-checkable.** An imperative such as `"accessibility-floor: WCAG-AA"` (RFC-0009 §11.2 platform example) is a string. Nothing parses it or inherits it, and nothing tells a reviewer when a soul's implementation falls below it. RFC-0018 gives journeys a structured `accessibility` block whose `wcagLevel` may only rise above the parent, but the parent level has no structured home.

**The existing design drift check matches keywords.** The shipped `DesignIntentDrift` reconciler (RFC-0008) flags a `soulPurpose.designPrinciples` entry when no DSB compliance rule matches it by keyword. It can tell whether a rule with a similar word exists. It cannot tell whether the product honours the principle.

**Design system drift and soul drift are never joined.** RFC-0006 emits `TokenDriftDetected`, `TokenViolationFound`, visual regression results and Addendum A design CI results per artifact. None of these is attributed to a soul, so a soul whose surfaces have drifted far from its declared intent looks the same as one that has not.

**Version skew is silent.** A soul's design imperatives were written against a specific token and catalog version. When the DSB moves (RFC-0006 §5.5), nothing asks the Design Authority whether those imperatives still hold.

InternalAdopter's pipeline addresses each of these locally. That work also surfaced failure modes (checks that pass without running, scan scopes that hide findings, inline waivers that silence audits) that any framework-level drift rule must guard against. §5.8 turns those into requirements.

## 3. Goals

1. **Structured design vertex.** Structured fields comparable in rigour to the engineering and product vertices, responding to RFC-0009 C3.
2. **Reference, not duplicate.** Every new field that overlaps the DID or DSB points to the existing source of truth.
3. **Tighten-only accessibility inheritance.** Platform DID → Soul DID → Journey, consistent with RFC-0017 (variants inherit the soul's compliance floor) and RFC-0018 (journeys may raise `wcagLevel`).
4. **One drift rule, many evidence sources.** A single `DesignCoherenceDriftRule` that consumes RFC-0006 outputs, static scans and rendered checks.
5. **Deterministic first.** Automated findings come only from deterministic or rendered evidence. Judgment calls stay with the Design Authority (RFC-0017 §5.2).
6. **Baseline ratchet.** Existing findings are recorded; new ones surface; the baseline only grows through an explicit Design Authority decision.
7. **Trustworthy checks.** Every check reports whether it ran. No silent skips, no self-waivers.
8. **One scoring home per finding.** No finding type changes more than one admission signal (§6.5).
9. **Backward compatibility.** DIDs without the new fields behave identically, including after upgrade (§6.6).

## 4. Non-Goals

1. **Re-specifying RFC-0006.** Token compliance, visual regression, story completeness, the design review gate and Addendum A design CI stay in RFC-0006. This RFC consumes their results.
2. **A content or voice model.** RFC-0017 OQ-5 placed voice and register outside the visual token layer and pointed to a future content-layer RFC. This RFC adds a pointer to the existing `brandIdentity` voice fields only (§5.1.4, OQ-3).
3. **Automated aesthetic judgment.** The rule does not score taste, personality fit, or imperative conflicts. Those are Design Authority calls.
4. **Semantic or embedding-based coherence.** RFC-0009 §7.2 rule #2 (embedding distance, RFC-0019) is out of scope.
5. **Prescribing tools.** The RFC names check categories and evidence shapes, not specific linters, browsers or accessibility engines.
6. **Variant-level accessibility floors.** RFC-0017 §5.3 fixes a variant's `complianceFloor` to `inherit`, and §5.5 treats a different WCAG level as grounds for a separate soul. This RFC keeps that ruling.
7. **Changing Eρ₅.** Compliance clearance (RFC-0018 §6.2, RFC-0022) is untouched.

## 5. Proposal

### 5.1 Part A: design vertex enrichment

All new fields are optional. Each new object accepts an optional `identityClass` (`core` or `evolving`, per RFC-0008 Addendum B); the defaults are listed per field.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: example-soul
spec:
  parentTessellation: example-platform
  triad:
    design:
      authority: design-lead
      inheritsFrom: example-platform
      imperatives:                      # unchanged, still free text
        - "visual-identity: example-specialization"
      overrides: {}                     # unchanged
      accessibilityFloor:               # 5.1.1
        wcagLevel: AA
        wcagVersion: "2.2"
        conformanceTarget: 100
        minTargetSizePx: 24
        reducedMotion: recommended
      componentPolicy:                  # 5.1.2
        mode: catalog-only
        exceptions:
          - component: legacy-widget
            decisionRef: DEC-0042
            expires: 2027-03-31
      authoredAgainst:                  # 5.1.3
        tokenVersion: "1.4.0"
        catalogVersion: "1.4.0"
      voiceRef:                         # 5.1.4
        source: brandIdentity
      principles:                       # 5.1.5
        - id: destructive-actions-recoverable
          statement: "Destructive actions are reversible or confirmed before they run."
          verification: judgment
        - id: status-not-color-alone
          statement: "Status is never conveyed by colour alone."
          verification: rendered
          ruleRef: use-of-color
        - id: one-primary-action
          statement: "Each screen has at most one primary action."
          verification: deterministic
          ruleRef: single-primary-action
```

#### 5.1.1 `accessibilityFloor`

The minimum accessibility conformance any surface in this soul may ship at.

| Field | Type | Notes |
|---|---|---|
| `wcagLevel` | enum `A`, `AA`, `AAA` | Same enum as RFC-0018 §6.1 |
| `wcagVersion` | enum `2.0`, `2.1`, `2.2`, `3.0` | Same enum as RFC-0018 §6.1. RFC-0018 OQ-7 superseded-version advisory applies |
| `conformanceTarget` | number 0 to 100 | Optional here; when absent, 100. RFC-0018 requires it at journey level. WCAG 3.0 scoring-model caveat (RFC-0018 OQ-7) applies |
| `minTargetSizePx` | number | Optional. When absent, the WCAG requirement for the declared level applies (24 at 2.2 AA, SC 2.5.8). Adopters may set 44 (SC 2.5.5, AAA) |
| `reducedMotion` | enum `required`, `recommended` | Optional. `required` is a product choice: the related criterion (SC 2.3.3) is AAA, so it goes beyond an AA floor |

**Inheritance.** Platform → Soul → Journey. Variants inherit the soul's floor and cannot override it (RFC-0017 §5.3).

- `wcagLevel`, `conformanceTarget`, `minTargetSizePx` and `reducedMotion` are tighten-only: a child may raise them and may not lower them.
- `wcagVersion` may move forward within the 2.x line without review. Moving to `3.0` changes the scoring model (RFC-0018 OQ-7), so it requires a Decision (`accessibility-floor-wcag3-adoption`) answered by the Design Authority.
- A journey's `accessibility` block (RFC-0018 §5.3) is validated against the effective soul floor. A violation emits `AccessibilityFloorInheritanceViolation` and rejects the declaration.

**Relationship to variant `designOverrides`.** RFC-0017 `designOverrides` such as `motionProfile` and `typographyScale` set a variant's default look and feel. The floor governs what users get when they ask for reduced motion or larger text. A variant override never lowers the floor; for example, `motionProfile: full` is valid under `reducedMotion: required`, as long as the surface honours the user's reduced-motion preference.

**Relationship to the DSB.** The DSB schema has no accessibility field. The DSB's accessibility standard is the `standard` value of its RFC-0006 Addendum A §A.3.1 `accessibilityAudit` quality gate rule (for example `WCAG22-AA`). The rule parses that value into `{wcagVersion, wcagLevel}` (`WCAG22-AA` → `2.2`, `AA`; `WCAG21-AAA` → `2.1`, `AAA`). The effective floor for any check is the stricter of the soul floor and the parsed DSB standard. If the parsed standard is weaker than a soul's floor, that is a `declared` finding (§5.6). If the DSB has no `accessibilityAudit` gate, the comparison reports `not-applicable`, not a mismatch.

**Target size exceptions.** Checks against `minTargetSizePx` must apply the WCAG exceptions for the declared criterion (spacing, inline targets, equivalent targets, user-agent controls, essential presentation). A raw size comparison without them produces false positives on inline links.

`identityClass` default: `core`. A change to a `core` field follows RFC-0008's core identity change handling (`CoreIdentityChanged`, `SoulGraphStale`). That approval path matches RFC-0009 C1: Design authors the field, and the triad co-declares identity.

#### 5.1.2 `componentPolicy`

How strictly this soul's surfaces must stay inside the DSB component catalog. The catalog itself is not re-declared; it resolves through the DID's existing `designSystemRef` and the RFC-0006 §9.2 catalog interface.

| Field | Type | Notes |
|---|---|---|
| `mode` | enum `catalog-only`, `catalog-preferred`, `unrestricted` | `catalog-only` treats any uncatalogued component as a finding; `catalog-preferred` reports it as advisory; `unrestricted` disables the check |
| `exceptions[]` | `{component, decisionRef, expires}` | Each exception cites a Decision Catalog entry answered by the Design Authority, and an expiry date. Expired exceptions revert to findings |

`identityClass` default: `evolving`.

#### 5.1.3 `authoredAgainst`

The DSB token and catalog versions the Design Authority last reviewed this vertex against. It records a review. The version pin itself stays in DSB `spec.tokens.versionPolicy` and `pinnedVersion` (RFC-0006 §5.5).

| Field | Type | Notes |
|---|---|---|
| `tokenVersion` | semver string | Set when the Design Authority last confirmed the vertex against the DSB token set |
| `catalogVersion` | semver string | Optional. Same, for the component catalog |

When the resolved DSB version moves past `authoredAgainst` by a minor or major version, the rule emits a `version-skew` finding asking the Design Authority to re-confirm. Updating `authoredAgainst` closes it. A `version-skew` finding is expected, healthy drift: it records that the system moved and intent needs re-confirming, not that something broke.

`identityClass` default: `evolving`.

#### 5.1.4 `voiceRef`

A pointer to where this soul's voice is defined.

| Field | Type | Notes |
|---|---|---|
| `source` | enum `brandIdentity`, `inherit` | `brandIdentity` resolves to the DID's existing `brandIdentity.voiceAttributes[]` and `voiceAntiPatterns[]`; `inherit` resolves to the parent's |

`voiceRef` names where voice is defined today. It adds no voice tokens and no new voice fields, following RFC-0017 OQ-5, which placed content register outside the visual token layer and anticipated a sibling `contentOverrides` block in a future content-layer RFC. A pointer is not structure, so this field does not meet C3's "voice register structure" item. That item is re-scoped and stays open (§5.1.6, OQ-3).

`identityClass` default: `core`.

#### 5.1.5 `principles[]`

`principles[]` is the home for C3's "interaction principles": structured design imperatives about how a soul's surfaces behave. They sit beside free-text `imperatives`, which remain valid and continue to feed Sα₂. `principles[].statement` does not enter the Sα₂ text corpus in v1.

| Field | Type | Notes |
|---|---|---|
| `id` | kebab-case string, unique within the soul | |
| `statement` | string | One short sentence a check can test or a reviewer can confirm |
| `verification` | enum `deterministic`, `rendered`, `judgment` | How conformance is established (§5.3) |
| `ruleRef` | string | Required when `verification` is `deterministic` or `rendered`. Identifies the check that evaluates it |
| `designPrincipleRef` | string | Optional. Links to a `soulPurpose.designPrinciples` entry this principle puts into practice |

**Boundary with `soulPurpose.designPrinciples`.** `designPrinciples` describe identity (why the product looks and feels as it does) and carry `measurableSignals`. `principles` describe interaction behaviour that a reviewer or a check can confirm on a specific surface. A principle may put a design principle into practice; it does not replace it.

Principles marked `judgment` are never evaluated automatically. They appear in design review checklists, and findings against them are recorded as Decisions by the Design Authority or a named delegate.

`identityClass` default: `evolving`.

#### 5.1.6 C3 record

How this RFC answers each item in RFC-0009 C3:

| C3 item | Status | Where |
|---|---|---|
| Accessibility floor | Met | `accessibilityFloor` (§5.1.1) |
| Component catalog reference | Met | `componentPolicy`, resolving the catalog through `designSystemRef` (§5.1.2) |
| Design token version | Met | `authoredAgainst`, with the pin left in the DSB (§5.1.3) |
| Voice register structure | Re-scoped, open | The Design Authority's RFC-0017 OQ-5 ruling places voice outside the visual token layer. `voiceRef` points to the existing `brandIdentity` fields; structure is carried open against the future content-layer RFC (§5.1.4, OQ-3) |
| Interaction principles | Met | `principles[]` (§5.1.5) |

The RFC-0009 C3 record is updated to match when this RFC is signed off (§9).

### 5.2 Canon hierarchy

Drift detection needs one answer to "which source is right?".

1. **The DSB is canon for token values.** If a design specification or artifact disagrees with the DSB about a token value, the specification or artifact is wrong.
2. **Component definitions are shared.** RFC-0006 §5.3 gives the catalog to the Engineering Authority, and design keeps authority over component quality (RFC-0006 §4.2, P6). When the catalog and a ratified design specification disagree about a component definition, the rule raises a `design-coherence-component-conflict` Decision to both the Design Authority and the Engineering Authority. Neither side is presumed correct, and the finding does not count toward `coherence` until the Decision is answered.
3. **The design vertex is canon for intent.** If the DSB cannot express something the vertex requires (for example, its accessibility standard is weaker than the soul floor), the finding is raised against the DSB.
4. **Derived design specifications are caches.** A human- or agent-readable specification generated from the DSB (a generated design specification or token export) is never canon. Automated runs must not edit it; changes go through the owning repository's review.

### 5.3 Part B: what the rule measures

`DesignCoherenceDriftRule` evaluates four evidence classes per soul.

| Class | Evidence | Examples | Source |
|---|---|---|---|
| `declared` | DID and DSB configuration only | DSB accessibility standard weaker than soul floor; `authoredAgainst` behind resolved DSB version; expired `componentPolicy` exception; `principles` entry with a `ruleRef` that resolves to no registered check | New |
| `static` | Source or artifact scan | Off-token colour or radius values; uncatalogued components under `catalog-only`; principle checks marked `deterministic` | Reads the tool output behind RFC-0006 `TokenViolationFound` and `ComponentUndocumented`; adds principle checks |
| `rendered` | Headless render of the surface | Contrast below floor; target size below floor; keyboard focus that is unreachable or not visible; status shown by colour alone; reduced motion not honoured where required | Reads RFC-0006 Addendum A §A.3.1 results where present; adds floor-specific and principle checks |
| `judgment` | Design Authority review | Imperative conflicts; personality fit; principles marked `judgment` | Never automated |

#### 5.3.1 Surface attribution

`static` and `rendered` findings must be attributed to a soul (and, where possible, a journey) before they can be scored or block anything. The framework has no surface-to-soul mapping today; RFC-0009 §8.3 `ProvenanceRecord` records which souls a piece of work targeted, which is related but not sufficient. RFC-0006 §10.1 events carry no payload, so attribution has to come from the underlying tool output, not from those events.

Adopters who enable `static` or `rendered` classes declare attribution in config (`surfaceAttribution`, §10.1): path, route or artifact globs mapped to soul IDs, with optional journey IDs and a default fidelity. Findings on surfaces that match no entry are reported as `unattributed`, count toward no soul's score, and never block. OQ-2 asks whether attribution should move into the DID itself.

#### 5.3.2 Evidence files

The framework does not run browsers or scanners itself. Adopters produce `static` and `rendered` evidence with their own tools and write it as files conforming to a versioned `design-coherence-evidence` schema. Each record carries: check ID, check status (§5.8), surface ID, fidelity, evidence class, finding details, and the name and version of the tool that produced it. The rule reads these files through `RuleScanTarget` (§6.3).

On a pull request, evidence covers changed surfaces. A full run over all attributed surfaces runs on the default branch on a schedule the adopter sets (nightly recommended).

### 5.4 Fidelity modes

Artifacts at different stages need different strictness. Fidelity is recorded on each evidence record, defaulting from `surfaceAttribution`.

| Fidelity | Evaluated | Not evaluated |
|---|---|---|
| `sketch` | Nothing. The artifact carries a draft marker (metadata or visible) | All classes |
| `structure` | Catalog membership; required states as defined by the catalog entry or the soul's principles; principles that do not depend on colour or motion | Colour, contrast, focus styling, motion |
| `full` | All `declared`, `static` and `rendered` checks | `judgment` (manual only) |

On production substrate, fidelity below `full` is ignored unless a Decision answered by the Design Authority allows it for that surface. A report produced in `structure` mode must say so in its status line.

### 5.5 Baseline ratchet

The first `full` run for a soul records every current `static` and `rendered` finding in a baseline file with a stable fingerprint (rule, surface ID, normalised location, normalised evidence; no line numbers). The baseline file stores one fingerprint per line, sorted, so changes diff cleanly.

Registry rules are stateless, so the rule never writes the baseline. Baseline contents are passed in through `RuleScanTarget`, and the rule reports against them:

- A finding in the baseline is reported as `baselined` and does not block.
- A finding not in the baseline is `new`.
- A baselined finding that no longer reproduces produces a `baseline-prune` proposal. A CLI command applies accepted proposals and commits the shrunken baseline in the same pull request.
- Adding to the baseline requires a Decision (`design-coherence-baseline-expansion`) answered by the Design Authority. A CI check rejects baseline growth that cites no Decision ID.

**Cold start.** This adapts RFC-0028 OQ-7.2 rule 4, under which structural detection stays live during calibration. Here, the blocking accessibility check (§5.6) is live from the first pull request after the baseline is written. Only the scored signal (§6.5) reports `calibrating` for its first 30 days.

### 5.6 Severity and routing

The rule registers at severity `high` and downgrades per finding, as the registry allows. Each emitted `DriftEvent` carries typed `details` with `soulId`, optional `journeyId`, and `evidenceClass`. `high` findings are projected as `structural` drift under RFC-0028's `substrate-drift` scope. Blocking follows RFC-0028 OQ-7.2 rule 1 (structural drift blocks the pull request) and takes effect where the adopter runs the registry dispatcher as a required check (§9 Phase 2). All non-blocking findings route as G0 non-blocking Decisions under RFC-0035.

| Finding | Severity | Blocking | Decision |
|---|---|---|---|
| `new` attributed finding that falls below the effective `accessibilityFloor` | `high` | Yes | `design-coherence-accessibility-regression` |
| DSB accessibility standard weaker than soul floor | `medium` | No; caps Eρ₄ for the soul (§6.5) | `design-coherence-floor-mismatch` |
| `new` off-token value or uncatalogued component under `catalog-only` | `medium` | No | `design-coherence-structural-drift` |
| `version-skew` (§5.1.3) | `medium` | No | `design-coherence-version-skew` |
| Expired `componentPolicy` exception | `medium` | No | `design-coherence-exception-expired` |
| A check that applies did not run (§5.8) | see OQ-7 | No | `design-coherence-check-not-run` |
| Uncatalogued component under `catalog-preferred` | `warning` | No | none (report only) |
| `baselined` or `unattributed` finding | none | No | none |

**Why one blocking case.** An accessibility floor regression is a deterministic pass/fail against a declared threshold on a specific new change, which is the structural shape RFC-0028 rule 1 blocks on. It also preserves the accessibility floors that Product Authority's RFC-0018 endorsement depends on. A floor mismatch is a configuration gap whose fix belongs to the owning authority (§5.9), and blocking unrelated pull requests over it would penalise the wrong people, so it caps readiness instead.

**The block cannot be switched off quietly.** Once a soul declares `accessibilityFloor`, `blocking.accessibilityRegression` can be set to `false` only through a Decision answered by both the Design Authority and the Product Authority.

### 5.7 Exceptions and waivers

- **No inline waivers.** Suppression comments or attributes inside an artifact are ignored by this rule. An artifact cannot silence its own audit.
- **Central exceptions only.** Exceptions live in the DID (`componentPolicy.exceptions`) or in rule config (`canonExceptions`, §10.1), each citing a Decision Catalog entry.
- **Canon exceptions.** When a DSB value itself trips a rule (for example a decorative token that is below contrast by design), the finding is reported once as a canon exception to the owning authority (§5.9), and not against each artifact that uses it.

### 5.8 Check integrity

InternalAdopter's practice showed that drift checks fail quietly more often than they fail loudly.

**Normative requirements.** These apply to any implementation of this rule.

1. **Every check reports a status:** `ran`, `not-run` (with reason), or `not-applicable` (with reason). A missing status is treated as `not-run`.
2. **Never skip silently.** `not-run` on a check that applies at the artifact's fidelity emits `design-coherence-check-not-run`.
3. **Every check has a control.** The conformance suite (§9) pairs each check with a fixture that must fail. A check that cannot be shown to fail is not a check.
4. **Grade tool output.** Where an agent runs checks, conformance is judged from each check's structured output. The agent's summary of that output is never the evidence.
5. **Framework failures are flagged.** When an applicable check is `not-run` for an environment or tooling cause, the snapshot (§6.4) sets `frameworkFailure: true`. Calibration log entries scored against that snapshot set `frameworkFailureExcluded: true` (RFC-0025, as referenced in RFC-0029), and the Eτ_expression term is treated as 0.
6. **Tool provenance (SHOULD).** Each evidence record SHOULD carry the name and exact version of every tool that produced it. Whether exact pinning with a committed lockfile is required is for the Engineering Authority to decide (OQ-10).

**Implementation notes (non-normative).** These are lessons from InternalAdopter's practice. They are tooling decisions, so the Engineering Authority decides whether any of them become normative (OQ-10).

- **Scope before scan.** Exclude review-only scaffolding from scan scope, instead of filtering its results afterwards. Some detectors deduplicate findings, so scaffolding scanned first can mask drift in the surface.
- **Write evidence last.** Write evidence files only after a successful run, and delete any stale copy at the start, so freshness can be trusted when evidence is reused.

### 5.9 Automation proposes, authorities decide

The rule reports. It never changes intent.

1. **No automated edits to canon or intent.** The rule never edits the DID, the DSB, a derived design specification, or the baseline. Changes to these go through a Decision answered by the owning authority, or through repository review.
2. **Findings route to the owning authority.** Findings about the design vertex route to the Design Authority. Findings about the DSB route by RFC-0006 §5.3 ownership: token schema and accessibility standard findings to the Design Authority, catalog findings to the Engineering Authority, and component-definition conflicts to both (§5.2). This RFC adds no new cross-pillar veto.
3. **Re-check on version change.** When a check, its tooling pin, or the soul's `authoredAgainst` changes, artifacts are re-checked against the current specification before old results are reused. Results produced under an older specification are not carried forward silently.
4. **Evidence is labelled.** Every finding carries the evidence class that produced it (§5.3). Findings that depend on incomplete evidence, such as an unattributed surface, are marked as such.

## 6. Design Details

### 6.1 Schema changes

Add to `triad.design` in `spec/schemas/design-intent-document.schema.json`. The block has `additionalProperties: false` today, so these are explicit additions. `identityClass` references the existing `#/$defs/identityClass` definition.

```json
{
  "accessibilityFloor": {
    "type": "object",
    "required": ["wcagLevel", "wcagVersion"],
    "additionalProperties": false,
    "properties": {
      "wcagLevel": { "type": "string", "enum": ["A", "AA", "AAA"] },
      "wcagVersion": { "type": "string", "enum": ["2.0", "2.1", "2.2", "3.0"] },
      "conformanceTarget": { "type": "number", "minimum": 0, "maximum": 100 },
      "minTargetSizePx": { "type": "number", "minimum": 0 },
      "reducedMotion": { "type": "string", "enum": ["required", "recommended"] },
      "identityClass": { "$ref": "#/$defs/identityClass" }
    }
  },
  "componentPolicy": {
    "type": "object",
    "required": ["mode"],
    "additionalProperties": false,
    "properties": {
      "mode": { "type": "string", "enum": ["catalog-only", "catalog-preferred", "unrestricted"] },
      "exceptions": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["component", "decisionRef", "expires"],
          "additionalProperties": false,
          "properties": {
            "component": { "type": "string" },
            "decisionRef": { "type": "string", "pattern": "^DEC-[0-9]{4,}$" },
            "expires": { "type": "string", "format": "date" }
          }
        }
      },
      "identityClass": { "$ref": "#/$defs/identityClass" }
    }
  },
  "authoredAgainst": {
    "type": "object",
    "required": ["tokenVersion"],
    "additionalProperties": false,
    "properties": {
      "tokenVersion": { "type": "string" },
      "catalogVersion": { "type": "string" },
      "identityClass": { "$ref": "#/$defs/identityClass" }
    }
  },
  "voiceRef": {
    "type": "object",
    "required": ["source"],
    "additionalProperties": false,
    "properties": {
      "source": { "type": "string", "enum": ["brandIdentity", "inherit"] },
      "identityClass": { "$ref": "#/$defs/identityClass" }
    }
  },
  "principles": {
    "type": "array",
    "items": {
      "type": "object",
      "required": ["id", "statement", "verification"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "statement": { "type": "string" },
        "verification": { "type": "string", "enum": ["deterministic", "rendered", "judgment"] },
        "ruleRef": { "type": "string" },
        "designPrincipleRef": { "type": "string" },
        "identityClass": { "$ref": "#/$defs/identityClass" }
      },
      "allOf": [
        {
          "if": { "properties": { "verification": { "enum": ["deterministic", "rendered"] } } },
          "then": { "required": ["ruleRef"] }
        }
      ]
    }
  }
}
```

Matching TypeScript types are added in `reference/src/core/types.ts` (§9 Phase 1).

### 6.2 Kind naming

RFC-0017 and RFC-0018 examples use `kind: SoulDID`, which the shipped schema does not accept. A Soul DID is a `DesignIntentDocument` with `parentTessellation` set. This RFC uses the schema-valid form. Aligning the RFC-0017 and RFC-0018 examples, and RFC-0018's use of "Capability Coverage" for Cκ (RFC-0005 defines Cκ as Calibration), is out of scope and noted for an editorial follow-up.

### 6.3 Rule registration

`DesignCoherenceDriftRule` implements the shipped `TessellationRule` interface and registers through the existing registry (`register(rule)`). The registry dispatches rules concurrently, so rules have no order and this RFC refers to the rule by name. Draft RFC-0029 calls it the "fourth detection rule"; RFC-0018's journey state-ID rule and RFC-0028's type-registry rule have since also been described as fourth, so the ordinal is no longer meaningful.

The registry carries the label `Tessellation§13RuleRegistry`. RFC-0009's drift rules are in §7.2 (RFC-0009 §13 is Open Questions). This RFC cites §7.2 and treats the registry name as an inherited label.

Today the registry dispatcher is called only from tests, and the RFC-0028 structural gate runs from a skippable pre-push hook. Part B's blocking case depends on the dispatcher running as a required PR check (§9 Phase 2).

`RuleScanTarget` gains one optional field. All inputs are passed in, so the rule stays stateless:

```ts
designCoherence?: {
  effectiveFloors: Record<SoulId, AccessibilityFloor>;
  dsbResolution: Record<SoulId, {
    tokenVersion: string;
    catalogVersion?: string;
    a11yStandard?: { wcagVersion: string; wcagLevel: string };   // parsed from the accessibilityAudit gate, §5.1.1
  }>;
  surfaceAttribution: SurfaceAttribution[];        // §5.3.1
  evidence: DesignCoherenceEvidenceRecord[];       // §5.3.2
  baselines: Record<SoulId, string[]>;             // fingerprint lines, §5.5
};
```

### 6.4 Per-soul snapshot

The rule writes a `DesignCoherenceSnapshot` per soul on every default-branch run. Snapshots are built from default-branch evidence only, so a pull request that is already blocked for a regression does not also lower the soul's score.

```ts
interface DesignCoherenceSnapshot {
  soulId: string;
  status: 'calibrating' | 'measured';
  coherence: number | null;         // 0..1; null while calibrating or below minChecksForScore
  scoredChecks: number;             // checks that count toward coherence (§6.5)
  checksApplicable: number;
  checksRan: number;
  newFindings: number;
  baselinedFindings: number;        // reported beside coherence so a large baseline cannot read as health
  judgmentPrinciplesUnreviewed: number;
  frameworkFailure: boolean;        // §5.8 item 5
  byClass: { declared: number; static: number; rendered: number };
}
```

`coherence` is the share of scored checks that pass, with baselined findings excluded from both sides. It is `null` until at least `minChecksForScore` scored checks have run (§10.1), so a soul with almost no evidence cannot score as coherent. How the snapshot reaches ET and whether it travels on `SoulDriftDetected` is OQ-8.

### 6.5 Scoring composition: one home per finding

RFC-0008 already scores token compliance and catalog health through Sα₂, Eρ₄, and its own C3 (design risk) and C6 inputs. (RFC-0008's C3 is unrelated to RFC-0009 sign-off condition C3.) To avoid counting the same evidence twice, each finding type in this RFC changes exactly one thing.

| Finding | Single home |
|---|---|
| `new` accessibility regression | Merge gate only (§5.6). No score effect |
| Floor mismatch | Eρ₄ cap for the soul (Design's dimension) |
| `declared` (other than floor mismatch), `rendered`, and principle findings | Eτ_expression, through `coherence` (§6.5.1) |
| Token and catalog `static` findings | No new score. Reported in `byClass` only, since RFC-0008 already scores them |
| Work that repairs open findings | An automated HC_design `advances-design-coherence` signal (RFC-0008 §9.2) |
| Component-definition conflict (§5.2) | None until the Decision is answered |
| `not-run` from a framework cause | Excluded from `coherence` and from calibration (§5.8 item 5) |

Sα₂ is unchanged. Coherence looks back at what was built, and Sα₂ looks forward at incoming work; RFC-0008 OQ-5 accepted that kind of pairing as parallel signals at different timescales.

**Eρ₄ cap.** While a `design-coherence-floor-mismatch` finding is open, Eρ₄ for the soul is capped at a value set at the operator walkthrough. The cap applies only to work items with `hasFrontendComponents` (RFC-0008 §A.5), and after the lifecycle-phase floor.

#### 6.5.1 Eτ_expression

```
Eτ_expression = (1 − coherence) × k
```

- Applies only to work items that add or change attributed surfaces in that soul.
- Work items that close open `DesignCoherenceDrift` findings are exempt.
- A `null` coherence contributes 0, mirroring RFC-0008 §7.4 (missing data means no adjustment).
- A snapshot with `frameworkFailure: true` contributes 0.
- `k` is a constant fixed in this spec, not configurable per team. Its value is set at the operator walkthrough (OQ-5).

#### 6.5.2 Pillar attribution

RFC-0008 §A.6 attributes Eτ to the Product pillar. Eτ_expression measures Design drift, so in the Pillar Perspective Breakdown `pillarBreakdown.product.governedDimensions.eTau` carries `breakdown.expression`, and tension detection counts that share toward the Design pillar.

### 6.6 Behavioural changes

- **Admission.** Work items that reference an open `DesignCoherenceDrift` Decision receive the HC_design `advances-design-coherence` signal (§6.5). No other work item is boosted, so new work that adds drift is never lifted by the soul's low coherence.
- **Design review gate (RFC-0006 §8.5).** Open `new` findings for a surface are listed in the review packet. The gate's pass/fail logic is unchanged.
- **Identity fields.** The reconciler's identity-field flattening (`reference/src/reconciler/`) walks the five new `triad.design` fields only. It does not walk `imperatives` or `overrides`. On the first reconcile after upgrade, the snapshot is seeded without emitting identity-change events, the same way `plannedChanges` is first seeded, so existing DIDs do not fire `EvolvingIdentityChanged` on upgrade.
- **Demand routing.** When RFC-0030 demand clusters carry accessibility or usability language for a soul, they are cross-referenced to that soul's open coherence findings, consistent with the RFC-0017 and RFC-0018 Product reviews.

### 6.7 Relationship to `DesignIntentDrift`

The shipped `DesignIntentDrift` reconciler (RFC-0008) remains. It answers "does the DSB have any rule for this design principle?". `DesignCoherenceDrift` answers "does the implementation meet this soul's structured design intent?". They run side by side in v1. Whether `DesignIntentDrift` should later stop firing for principles linked through `designPrincipleRef` is OQ-4.

### 6.8 Migration path

1. Ship the schema additions. All are optional; existing DIDs validate unchanged, and identity reconciliation is seeded silently on first run (§6.6).
2. Register the rule with `enabled: false` by default, matching the shipped variant drift extension, which is also disabled by default.
3. On enable for a soul: the first `full` run writes the baseline; the blocking check is live from the next pull request where the dispatcher runs as a required check; the scored signal calibrates for 30 days.
4. Adopters can migrate free-text `imperatives` such as `"accessibility-floor: WCAG-AA"` into `accessibilityFloor` at their own pace. A lint advisory flags imperatives that look like a structured field.

## 7. Backward Compatibility

**Not a breaking change.** Every new field is optional, the rule is opt-in, and identity reconciliation does not fire on upgrade. Souls without the new fields produce no `DesignCoherenceDrift` findings.

One soft regression: enabling the rule on a soul and then introducing a change that falls below its floor will block a pull request that previously passed. This is intended. The baseline means existing violations do not block, only new ones.

## 8. Alternatives Considered

### 8.1 Split schema enrichment and drift detection into two RFCs

The RFC-0009 OQ-3 and OQ-7 precedent favours narrow RFCs. **Not taken** because C3 commits the enrichment "as RFC-0027", the registry row commits RFC-0027 to drift detection, and drift detection has nothing structured to measure without the enrichment. To limit the cost of bundling, Part A is written to be signed off and implemented first (§9).

### 8.2 Re-declare token version and catalog on the design vertex

Put `tokenVersion` and `catalog` on the vertex as authoritative values. **Rejected** because RFC-0006 §5.5 and the DID `designSystemRef` already own them. Two sources of truth for one value is the drift this RFC exists to detect.

### 8.3 Add a voice register token to the design vertex

Model voice as structured tokens here, as C3 literally lists. **Rejected** for consistency with RFC-0017 OQ-5. `voiceRef` names the existing structure instead. See OQ-3.

### 8.4 Make every finding blocking

Treat all drift as structural. **Rejected** because it would turn a drift signal into a merge gate for configuration gaps and aesthetic choices. Only new accessibility floor regressions block.

### 8.5 Automate imperative-conflict detection

Use a model to judge whether implementations honour free-text imperatives. **Rejected** for v1. RFC-0017 §5.2 makes conflict identification a Design Authority judgment call, and this RFC is deterministic-first. Semantic coherence can be revisited alongside RFC-0019.

### 8.6 Boost Cκ for work on low-coherence souls

The v0.1 draft boosted Cκ for any work item targeting a soul with low coherence. **Rejected** because Cκ is the Calibration multiplier (RFC-0005), an Engineering dimension, and because a soul-wide boost lifts new work that adds drift as well as work that fixes it. The HC_design signal (§6.5) lifts only repair work.

## 9. Implementation Plan

Sizes are relative estimates.

**Part A** (can proceed once Part A is signed off, independent of Part B's open questions):

- [ ] Phase 1 (M): schema additions to `triad.design`; types in `reference/src/core/types.ts`; `AccessibilityFloorInheritanceViolation` validator against RFC-0018 journey blocks; identity-field flattening for the five new fields with silent first-run seeding; migration lint for structured-looking imperatives

**Part B:**

- [ ] Phase 2 (M): `DesignCoherenceDriftRule` with `declared` class only; parse the DSB `accessibilityAudit` standard; registry registration; `RuleScanTarget.designCoherence`; Decision routing; wire the registry dispatcher into a required PR check
- [ ] Phase 3 (L): `design-coherence-evidence` schema; `surfaceAttribution` config; `static` and `rendered` evidence ingestion; principle checks; fidelity handling
- [ ] Phase 4 (M): baseline fingerprints, `baseline-prune` proposals and the CLI that applies them; baseline-growth CI check; `DesignCoherenceSnapshot`; §6.5 composition (Eρ₄ cap, Eτ_expression, HC_design signal, pillar attribution)
- [ ] Phase 5 (M): InternalAdopter reference implementation (§11); conformance suite with a failing control per check (§5.8 item 3); glossary entries (`accessibilityFloor`, `componentPolicy`, `authoredAgainst`, `voiceRef`, `principles`, `fidelity`, `DesignCoherenceDrift`, `DesignCoherenceSnapshot`, `Eτ_expression`)
- [ ] On sign-off, update the RFC-0009 C3 record item by item to match §5.1.6 (four met, voice register re-scoped and open)
- [ ] Update the RFC-0027 row in `spec/rfcs/README.md` (status, lifecycle, OQ count, file, notes; drop "Fourth")
- [ ] Author or update each doc surface declared in `requiresDocs` (currently `[]`, pending tutorial and runbook decision)

The recurring cost is dominated by rendered checks (estimate). Phase task IDs to be allocated at the operator walkthrough.

## 10. Open Questions

**OQ-1: `minTargetSizePx` and RFC-0006 Addendum A.** Addendum A §A.3.1 sets 44px and labels it SC 2.5.8, which specifies 24px at AA (44px is SC 2.5.5, AAA). Should this RFC's stricter-of rule apply Addendum A's 44px as written, or should Addendum A's label be corrected first so adopters know they are opting into AAA? Author's lean: correct the label as an erratum and keep 44px as the RFC-0006 default.

**OQ-2: Where attribution lives.** §5.3.1 puts surface attribution in config. Should it instead be a DID field (for example `spec.surfaces[]`), so it is reviewed with the soul? Author's lean: config for v1; promote to the DID at two or more adopter requests.

**OQ-3: Closing the voice register item.** C3's "voice register structure" item is re-scoped and open (§5.1.6). What closes it? Author's lean: the content-layer RFC that RFC-0017 anticipates, triggered by a `Decision: content-layer-voice-activation-request` at two or more adopter requests (the RFC-0017 OQ-8 pattern). Until then, `voiceRef` is the only voice field on the design vertex.

**OQ-4: `DesignIntentDrift` for linked principles.** Once `principles[].designPrincipleRef` is populated, the keyword match is redundant for linked principles. Options: leave shipped behaviour unchanged; annotate linked principles only; or stop `DesignIntentDrift` firing for a linked principle once its `ruleRef` resolves and its check has run. This changes shipped behaviour. Defer to Engineering Authority.

**OQ-5: `k` and weighting.** `coherence` is an unweighted pass ratio with a minimum-evidence floor, and `k` is fixed in the spec. What value should `k` take? Should coherence later be weighted by journey criticality (RFC-0018)? Weighting by surface traffic would duplicate Dπ, and weighting by severity would double-count the blocking case. Author's lean: unweighted in v1; journey criticality is the only weighting to revisit.

**OQ-6: Where the baseline lives.** In the substrate repository (reviewed like code) or in framework state (`.ai-sdlc/`)? Author's lean: substrate repository, so baseline changes appear in the same pull request as the code that caused them, with a code-owner entry for the Design Authority.

**OQ-7: Severity of `not-run`.** Some runners cannot start a browser or bind a port. Options: `medium` on every `not-run`; or `warning` per run, escalating to `medium` after three consecutive `not-run` results for the same check, so runners without browsers do not flood the catalog while a check that never runs still surfaces. Defer to Engineering Authority.

**OQ-8: How the snapshot reaches ET.** `SoulDriftDetected` is emitted per SA dimension after sustained violation windows and has no `soulId`, so a per-soul snapshot has no natural place on it. Options: (a) add `driftSource.expressionDrift` and carry the latest snapshot on SA-2 events, as RFC-0029 asks; (b) feed `coherence` as samples into the existing statistical drift evaluation, which already provides calibration and reconciliation options, and persist the snapshot in the state store for Eτ to read at runtime; (c) a standing snapshot plus a threshold-crossing event with hysteresis. Needs Engineering and Product Authority input.

**OQ-9: Fidelity on evidence.** §5.4 records fidelity per evidence record with a per-glob default in `surfaceAttribution`, since RFC-0006 §7.1 `produces` entries describe artifact types and fidelity belongs to each artifact. Engineering Authority to confirm.

**OQ-10: Tooling requirements in §5.8.** Should scope-before-scan, evidence-written-last, and exact tool pinning with a committed lockfile be normative? They are listed as implementation notes and a SHOULD because they are tooling decisions. Defer to Engineering Authority.

### 10.1 Configuration schema (draft)

```yaml
# .ai-sdlc/design-coherence-config.yaml (per-org defaults; per-Soul overrides via spec.designCoherenceConfig)
designCoherence:
  enabled: false                       # opt-in, §6.8
  surfaceAttribution: []               # [{ match: "<glob>", soul: "<soul-id>", journey: "<journey-id>", fidelity: full }], §5.3.1
  evidence:
    schemaVersion: v1                  # design-coherence-evidence, §5.3.2
    pullRequestScope: changed-surfaces
    fullRunSchedule: nightly
  calibration:
    statisticalWindowDays: 30          # scored signal only; blocking check is live after baseline, §5.5
  score:
    minChecksForScore: 10              # coherence is null below this, §6.4
  blocking:
    accessibilityRegression: true      # false only via Decision answered by Design and Product, §5.6
  baseline:
    location: substrate                # OQ-6
    expansionDecision: design-coherence-baseline-expansion
  canonExceptions: []                  # [{ rule, token, decisionRef, reason }], §5.7
  integrity:
    requireCheckStatus: true           # §5.8
    ignoreInlineWaivers: true          # §5.7
    requirePinnedTooling: true
```

## 11. Practitioner Validation Plan

InternalAdopter's design pipeline drives validation.

| Validation | Criterion |
|---|---|
| Schema fit | Each InternalAdopter product's existing design specification maps onto the enriched vertex without loss and without re-declaring DSB values |
| Floor inheritance | A journey that tries to lower the soul's `wcagLevel` is rejected; one that raises it is accepted |
| Upgrade safety | Upgrading a repository with existing DIDs fires no identity-change events |
| Evidence reuse | At least one RFC-0006 check result is consumed as evidence without re-running the underlying check |
| Attribution | Every finding on a validation surface is attributed or explicitly `unattributed`; none is silently dropped |
| Baseline ratchet | A new contrast failure on a baselined surface blocks; fixing a baselined one produces a prune proposal that shrinks the baseline when applied |
| Check integrity | Each check's control fixture fails as expected; a run with the rendering tool withheld reports `not-run` and does not pass |
| No double count | A token violation changes no admission score beyond what RFC-0008 already applies |
| Signal | `coherence` for each product moves in the expected direction across one planned regression and one planned fix |

Design Authority's sign-off on this RFC will be conditional on this pass, as with RFC-0017.

## 12. References

- [RFC-0005 Product Priority Algorithm](RFC-0005-product-priority-algorithm.md): Cκ as Calibration
- [RFC-0006 Design System Governance](RFC-0006-design-system-governance-v5-final.md): design authority principle (§4.2, P6), DSB (§5), ownership (§5.3), token versioning (§5.5), handoff artifacts (§7.1), design review gate (§8.5), catalog interface (§9.2), reconciliation events (§10.1), design CI and accessibility audit gate (Addendum A §A.3.1)
- [RFC-0008 PPA Triad Integration](RFC-0008-ppa-triad-integration-final-combined.md): `DesignIntentDrift`, `SoulDriftDetected`, HC_design signals (§9.2), missing-data handling (§7.4), pillar attribution (§A.6), `hasFrontendComponents` (§A.5), `identityClass` (Addendum B)
- [RFC-0009 Tessellated Design Intent Documents](RFC-0009-tessellated-design-intent-documents.md): design vertex (§5.1), ownership (§5.1.1), drift rules (§7.2), `ProvenanceRecord` (§8.3), sign-off conditions C1 and C3
- [RFC-0017 In-Soul Variant Pattern](RFC-0017-in-soul-variant-pattern.md): `complianceFloor: inherit` (§5.3), separate-soul boundary (§5.5), conflict resolution as Design Authority judgment (§5.2), `designOverrides`, voice register ruling (OQ-5)
- [RFC-0018 In-Soul Journey Pattern](RFC-0018-in-soul-journey-pattern.md): journey accessibility block and enums (§6.1), WCAG elevation (§5.3), WCAG version evolution (OQ-7), rule registry (OQ-10)
- [RFC-0028 Engineering Axis Substrate Enforcement](RFC-0028-engineering-axis-substrate-enforcement.md): drift composition and cold start (OQ-7.2)
- [RFC-0029 Product Pillar Architectural Vision](RFC-0029-product-pillar-architectural-vision.md) (Draft): Product's position on this RFC; `expressionDrift`; `frameworkFailureExcluded`
- [RFC-0035 Decision Catalog Operator Routing](RFC-0035-decision-catalog-operator-routing.md): G0 non-blocking routing
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): SC 1.4.1 Use of Color, SC 2.3.3 Animation from Interactions, SC 2.5.5 Target Size (Enhanced), SC 2.5.8 Target Size (Minimum)

## 13. Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.0 | 2026-05-04 | Morgan Hirtle | Number reserved under RFC-0009 Design Authority sign-off condition C3. |
| v0.1 | 2026-10-22 | Morgan Hirtle | First draft. Part A: five optional structured design vertex fields that reference existing DID and DSB sources. Part B: `DesignCoherenceDriftRule`, four evidence classes, surface attribution, fidelity modes, baseline ratchet, one blocking case, check integrity requirements. |
| v0.2 | 2026-10-22 | Morgan Hirtle | Revised after review against each authority's scope. Engineering scope: frontmatter moves RFC-0008 and RFC-0018 to `requires`; DSB accessibility standard resolved from the RFC-0006 audit gate; `identityClass` `$ref` corrected; stateless baseline with prune proposals; silent identity seeding on upgrade; evidence file schema; registry dispatcher wired as a required check; severity registration and typed event details. Product scope: Cκ boost replaced with an HC_design repair signal; one scoring home per finding (§6.5) to remove double counting; Eτ_expression term with fixed `k`; Eτ_expression attributed to the Design pillar; framework failures excluded from calibration; blocking toggle requires a Design and Product Decision. Design scope: `principles[]` named as the C3 interaction-principles home with an interaction example; floor relationship to `designOverrides`; judgment findings recorded by the Design Authority or a named delegate; fidelity cannot be lowered on production substrate without a Decision; `judgmentPrinciplesUnreviewed` in the snapshot. OQ-4 and OQ-7 deferred to Engineering Authority; OQ-8 restated with options. Design Authority decisions: C3 recorded item by item (§5.1.6), with voice register re-scoped by the RFC-0017 OQ-5 ruling and left open; component-definition conflicts between the catalog and a ratified design specification go to both Design and Engineering Authority (§5.2); §5.8 tooling items moved to implementation notes and a SHOULD, with OQ-10 deferring them to Engineering Authority. 10 open questions. |
