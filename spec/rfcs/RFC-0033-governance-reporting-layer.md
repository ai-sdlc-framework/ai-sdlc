---
id: RFC-0033
title: Governance Reporting Layer (Periodic Synthesis of the Admission Chain)
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0005
  - RFC-0008
  - RFC-0011
  - RFC-0014
  - RFC-0015
  - RFC-0022
  - RFC-0029
  - RFC-0030
requiresDocs: []
---

# RFC-0033: Governance Reporting Layer

**Document type:** Normative (draft)
**Status:** Draft v1 — Initial proposal. Defines a `GovernanceReport` resource that aggregates telemetry from across the admission chain into periodic auditable summaries.
**Lifecycle:** Draft
**Authors:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author)
**Requires:** RFC-0005 (PPA), RFC-0008 (PPA Triad Integration), RFC-0011 (DoR Gate), RFC-0014 (Dependency Graph Composition), RFC-0015 (Autonomous Pipeline Orchestrator), RFC-0022 (Compliance Posture + Audit Surface), RFC-0029 (Product Pillar Architectural Vision — Principle 5 governance by composition), RFC-0030 (Signal Ingestion Pipeline)

> The bold-style status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Alexander Kline | Head of Product Strategy / Product Authority | ✍️ Authored v1 | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ⏸ Pending | — |
| Morgan Hirtle | Chief of Design / Design Authority | ⏸ Pending | — |

## Revision History

| Version | Date | Author | Notes |
|---------|------|--------|-------|
| v1 | 2026-05-04 | Alexander | Initial draft. Defines `GovernanceReport` resource with five sections (scoring / cost / quality / calibration / R&D synthesis). Read-only — never influences scoring decisions; reads governance chain output after the fact. Composes with RFC-0022 audit evidence packs via shared evidence format. R&D section synthesizes existing telemetry into narratives suitable for tax-credit / R&D documentation without a dedicated agent. |

---

## 1. Summary

The admission chain (signal ingestion → DoR → PPA admission → execution → review → merge → calibration → DID revision proposals) emits structured telemetry at every stage. Today, this telemetry is consumed ad-hoc: operators query `events.jsonl` for orchestrator state, `_dor/calibration.jsonl` for DoR metrics, the PPA composite log for scoring decisions, and so on. Cross-stage synthesis (e.g., "what happened in the pipeline this week, and how did it score?") requires hand-assembly.

This RFC defines a **`GovernanceReport` resource type** that aggregates telemetry into periodic summaries (weekly, sprint, quarterly). The report is **read-only** — it never influences scoring decisions; it reads the governance chain's output after the fact.

The report has five sections: scoring (admission rates, drift events), cost (subscription utilization, burst requests), quality (DoR pass rate, review override rate, post-ship defects), calibration (flywheel signals, DID revision proposals, estimate variance), and R&D (a synthesis of uncertainties addressed + advances achieved + experiments conducted, suitable for R&D-tax-credit documentation).

## 2. Motivation

### 2.1 Cross-stage synthesis requires hand-assembly today

Every individual stage produces structured telemetry. Composing across stages requires the operator to:

- Pull events from `events.jsonl` for the period
- Filter to relevant types
- Cross-reference with `_dor/calibration.jsonl`, PPA composite log, dependency snapshots
- Compute aggregate metrics manually
- Assemble into a readable narrative

This is repetitive, error-prone, and discourages the very governance practice the framework is supposed to enable. Per RFC-0029 Principle 5 (governance by composition), the framework should produce auditable cross-stage output as a standard function, not as an afterthought.

### 2.2 Audit prep is recurring work

Most regulated adopters require periodic governance summaries: SOC2 audits cover quarterly periods; SR&ED tax-credit filings cover annual periods; ISO27001 audits cover continuous evidence. Each requires synthesis of the same underlying telemetry into a different format.

A standard `GovernanceReport` that auditors and accountants can consume directly (or via lightweight format-conversion) saves hand-assembly per audit cycle. Where adoptable, the report's evidence format aligns with RFC-0022's audit evidence packs (shared schema where overlapping).

### 2.3 R&D-credit documentation has a specific shape

R&D tax credits (SR&ED in Canada, equivalents elsewhere) require evidence of:

- **Scientific or technological uncertainty addressed** — what did we not know that we needed to figure out?
- **Advances achieved** — what new capability emerged?
- **Experiments conducted** — what hypotheses did we test?
- **Hypotheses tested with outcomes** — what did we learn?

The framework's existing telemetry contains exactly this signal — demand-cluster SA-resonance gaps surface uncertainties; calibration deltas surface advances; explorations (per RFC-0026) surface hypotheses tested. A standard R&D synthesis section eliminates the bespoke quarterly write-up.

This is **not** a dedicated R&D agent. It is a standard report section that happens to produce R&D-compatible output.

### 2.4 Read-only is structurally important

The report MUST NOT influence scoring decisions. The temptation to "let the governance report's findings adjust priorities" is the same temptation the framework's deterministic-first principle (RFC-0029 Principle 2) exists to resist. Reports synthesize what happened; they do not change what happens next.

## 3. Goals

1. **First-class `GovernanceReport` resource type** — declarative manifest with period + sections + format
2. **Read-only generator** — agent or library that reads `$ARTIFACTS_DIR/` telemetry, never mutates state
3. **Five canonical sections** — scoring / cost / quality / calibration / R&D synthesis
4. **Period flexibility** — weekly, sprint, quarterly, annual via ISO-8601 period spec
5. **Format alignment with RFC-0022** — overlapping evidence shares schema with compliance audit packs
6. **R&D synthesis without dedicated agent** — synthesize existing telemetry, do not introduce a new evidence-generation path
7. **Deterministic generation** — same inputs → same output (cache-friendly, audit-deterministic)

## 4. Non-Goals

1. **Not a dashboard** — RFC-0023 (Operator TUI) is the live observability surface; this RFC is periodic synthesis
2. **Not a real-time alert system** — alerts on threshold breaches live elsewhere (e.g., RFC-0025 framework-quality monitoring)
3. **Not a proprietary report format** — standard JSON + markdown rendering; adopters can transform to vendor-specific formats
4. **Not a writeback target** — reports are output-only; nothing in the report flows back into scoring
5. **Not a compliance-only tool** — R&D synthesis serves operators without external audit requirements
6. **Not multi-tenant** — single project per report; cross-project rollups are operator-side work

## 5. The GovernanceReport Resource

### 5.1 Manifest schema

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: GovernanceReport
metadata:
  name: weekly-governance-2026-W18
spec:
  period: P1W                          # ISO-8601 duration
  startedAt: 2026-05-01T00:00:00Z
  endedAt: 2026-05-08T00:00:00Z
  format: structured-json+markdown     # default; alternatives possible
  sections:
    - scoring
    - cost
    - quality
    - calibration
    - rd
  shardScope: all-shards               # or specific shardIds[]
status:
  generatedAt: 2026-05-08T01:00:00Z
  contentHash: sha256:abc123...        # deterministic over inputs
  outputPath: $ARTIFACTS_DIR/_governance/weekly-2026-W18.json
```

### 5.2 Generation

A read-only library function `generateGovernanceReport(spec)` reads from:

- `events.jsonl` (RFC-0015 pipeline events)
- `_dor/calibration.jsonl` (RFC-0011 DoR verdicts)
- `_deps/snapshot.<iso>.jsonl` (RFC-0014 dependency snapshots)
- PPA composite log (per shard)
- Burst-spend request log (RFC-0032)
- Signal ingestion logs (RFC-0030)
- Post-ship defect log (where available)

No LLM calls in the read path; the synthesis is structural aggregation + templated narrative generation.

## 6. Section Schemas

### 6.1 Scoring section

```yaml
scoring:
  issuesScored: integer                # admitted to PPA in period
  admissionRate: float                 # passed both DoR + PPA / submitted
  meanComposite: float                 # mean P_adjusted of admitted issues
  topClusters:                         # signal-pipeline derived
    - clusterId: string
      saResonance: float
      signalCount: integer
      didScore: float                  # cluster-level D1 contribution
  driftEvents:
    - type: SoulDriftDetected | DIDRevisionProposal | ProposalExpired
      classification: healthy | unhealthy | ambiguous
      shardId: string
      field: string
      resolved: boolean
```

### 6.2 Cost section

```yaml
cost:
  subscriptionUtilization: float       # 0-1; mean over period
  spilloverSpend: float                # tokens beyond projected window
  burstRequests:
    - requestId: string
      workItemId: string
      compositeScore: float
      cost: float
      status: approved | denied | expired | escalated
  meanERCostEffortAtAdmission: float   # how much cost-pressure was active
  tierRecommendation: string           # operator hint: upgrade / current / downgrade
```

### 6.3 Quality section

```yaml
quality:
  dorPassRate: float                   # first-attempt
  dorRoundsToReady: distribution
  dorCommonFailures:
    - gate: integer (1-7)
      count: integer
      pattern: string
  reviewerOverrideRate: float          # operator overruled review verdict
  postShipDefectsAttributed: integer   # defects attributable to in-period issues
```

### 6.4 Calibration section

```yaml
calibration:
  flywheelSignals:
    accept: integer
    dismiss: integer
    escalate: integer
    override: integer
  didRevisionProposals:
    - proposalId: string
      field: string
      classification: healthy | unhealthy | ambiguous
      status: pending | approved | denied | expired
      confidence: high | medium | low
  estimateVariance:
    - stage: plan | implement | review
      meanBucketMiss: float            # signed; positive = overestimate
      n: integer
```

### 6.5 R&D synthesis section

```yaml
rd:
  uncertaintiesAddressed:              # from low-saResonance clusters surfaced
    - description: string
      sourceClusterId: string
  advancesAchieved:                    # from calibration deltas + post-ship retention
    - description: string
      evidence: { meanCompositeBefore, meanCompositeAfter, periodSpanned }
  experimentsConducted: integer        # exploration workstreams completed (RFC-0026)
  hypothesesTested:                    # from exploration handoff artifacts
    - hypothesis: string
      outcome: confirmed | refuted | inconclusive
      evidence: string
```

The R&D synthesis is **template-driven narrative** generated from existing structured telemetry; no LLM is required for v1 (an LLM-augmented version may follow). The narratives are operator-reviewed before submission to any external party.

## 7. Composition with RFC-0022 Audit Evidence Packs

Where this RFC's evidence overlaps with RFC-0022's audit evidence packs, both consume a shared schema. Specifically:

- `cost` section overlaps with RFC-0022 cost-control evidence
- `quality.dorCommonFailures` overlaps with RFC-0022 change-management evidence
- `calibration.didRevisionProposals` overlaps with RFC-0022 governance-decision evidence

Operators running both reports do not maintain two parallel evidence formats; the underlying schema is the same, the rendering differs.

## 8. Cadence and Triggering

Reports generate on a schedule (cron-like) or on-demand. Default cadences:

- **Weekly** — operator-throughput / drift / burst-request signals
- **Sprint** (P2W default) — calibration / quality / DoR pattern signals
- **Quarterly** (P3M) — R&D synthesis, audit-prep snapshot
- **Annual** (P1Y) — full R&D-tax-credit-ready synthesis

Reports are deterministic over their inputs; same period + same data → same content hash. Operators can re-generate without re-running expensive synthesis.

## 9. Open Questions

### 9.1 LLM-augmented narrative generation

Should the R&D synthesis include LLM-generated narratives (with operator-edit) for non-quantitative description? **Position**: NO for v1; templates only. LLM-augmented narratives can land in v2 if the v1 templates prove too rigid. Deterministic-first per RFC-0029 Principle 2.

### 9.2 Cross-project rollups

Operators running multiple projects may want consolidated reports. **Position**: defer to v2; v1 is single-project. Cross-project rollup is a downstream consumer of single-project reports.

### 9.3 Evidence freshness

How fresh does telemetry need to be for a report? **Position**: report MUST declare its `dataFreshness` (oldest reading included); operators decide if it's fresh enough. No automatic re-fetch; reports are snapshots.

### 9.4 PII / sensitive content in narratives

R&D synthesis may surface customer signals (from RFC-0030 clusters). **Position**: by default, signals are anonymized in the report (cluster summary only, no individual customer attribution). RFC-0022 compliance posture may override (regulated industries with auditor data access requirements).

### 9.5 Tamper-evidence

Should reports be content-addressed and integrity-attested (e.g., DSSE-signed)? **Position**: yes for `quarterly` and `annual` cadences; optional for shorter periods. Mirrors RFC-0022 audit evidence pack integrity requirements.

## 10. Non-goals (re-stated)

- Not a dashboard. Not real-time. Not proprietary format. Not a writeback target. Not compliance-only. Not multi-tenant.

## 11. References

- **RFC-0005**: PPA framework spec
- **RFC-0008**: PPA Triad Integration (composite log inputs)
- **RFC-0011**: Definition-of-Ready Gate (calibration log inputs)
- **RFC-0014**: Dependency Graph Composition (snapshot inputs)
- **RFC-0015**: Autonomous Pipeline Orchestrator (events.jsonl input)
- **RFC-0022**: Compliance Posture + Audit Surface (shared evidence schema)
- **RFC-0024**: Emergent Issue Capture + Triage (capture log inputs)
- **RFC-0026**: Exploration Workstream Pattern (R&D experiment inputs)
- **RFC-0029**: Product Pillar Architectural Vision (Principle 5 governance by composition)
- **RFC-0030**: Signal Ingestion Pipeline (cluster log inputs)
- **RFC-0031**: Calibration-Driven DID Revision Proposal (proposal log inputs)
- **RFC-0032**: Cost-Governance Seam (burst-request log inputs)

---

**End of RFC-0033.**
