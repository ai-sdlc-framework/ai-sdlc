---
id: RFC-0022
title: Compliance Posture + Audit Surface
status: Draft
lifecycle: Ready for Review
author: Dominique Legault
created: 2026-05-03
updated: 2026-05-16
targetSpecVersion: v1alpha1
requires:
  - RFC-0008
  - RFC-0011
requiresDocs: []
---

# RFC-0022: Compliance Posture + Audit Surface

**Document type:** Normative
**Status:** Ready for Review v0.2 — operator OQ walkthrough complete 2026-05-16; all 7 §13 OQs resolved (in-tree YAML defaults with adopter override in v1, forced attestedNotes + attestedAt + attestedBy auto-fill, hand-curated control-feature-map with per-RFC reviewer check, single .tar.gz audit export, on-demand export only for v1, single posture per project for v1 with loader API designed for v2 multi-posture additive composition, PR template + reviewer-subagent check). §13.1 codifies the consolidated `.ai-sdlc/compliance.yaml` per-org config schema. Implementation broken into 4 phase tasks (AISDLC-322..325).
**Lifecycle:** Ready for Review
**Author:** Dominique Legault (with Claude assist)
**Created:** 2026-05-03
**Updated:** 2026-05-16
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — Dominique Legault (pending)
- [x] Product owner — Alexander Kline (2026-05-04)
- [ ] Operator owner — Dominique Legault (pending)

### Product Authority review

**Endorse strongly.** This is the implementation surface for PPA v1.1's ER5 (Compliance Clearance). PPA introduced ER5 as a per-shard categorical gate but never specified how compliance regimes are declared. RFC-0022 IS that specification.

The `CompliancePosture` resource at `.ai-sdlc/compliance.yaml` + the regime → DerivedGates mapping is exactly the surface ER5 needs. Per RFC-0009 §7.1 + OQ-5 (gating, hard regulatory only), categorical compliance fits a DerivedGates declaration; this RFC operationalizes that.

**Composition with RFC-0033 governance reporting**: RFC-0022's audit evidence packs and RFC-0033's governance-report cost/quality/calibration sections share substantial overlap. **Strongly recommend** a shared evidence schema so operators don't maintain two parallel reporting surfaces. Specifically: RFC-0022's PCI-DSS / SOC2 / HIPAA / FedRAMP control evidence and RFC-0033's `quality.dorCommonFailures` + `cost.burstRequests` + `calibration.didRevisionProposals` should consume the same underlying telemetry with different rendering.

**ER5 categorical gate at type-level**: when RFC-0022 ships, ER5 reads from `posture.regimes[]` to derive categorical locks (HIPAA → `requiresTenantPhysicalIsolation: true`, etc.). RFC-0028's substrate-contract pattern can enforce these locks at the type+CI layer per RFC-0029 Principle 1 (three-axis basis: enforcement is Engineering's function, declared via type-system invariants).

**PPA D3 Bug Urgency interaction**: when RFC-0020 (Session-bug + Severity Scoring, reserved) ships, regulatory-classified bugs (HIPAA breach disclosure, PCI-DSS incident notification) feed RFC-0022 via the audit evidence path. Future cross-reference.

Position grounded in RFC-0029 Part II (RFC-0022 endorsement) + Principle 1 (three-axis basis: ER5 is Engineering's enforcement axis).

## Revision History

| Version | Date       | Author    | Notes                                                                                                                                |
| ------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| v1      | 2026-05-03 | dominique | Initial draft surfacing compliance-tracking gap identified during RFC-0009 OQ-11 walkthrough; mirrors RFC-0019's adapter-pattern document structure. |
| v0.2    | 2026-05-16 | dominique | Operator OQ walkthrough resolved all 7 §13 OQs. Resolutions: in-tree YAML defaults + adopter override in v1 (OQ-1), forced attestedNotes + attestedAt + attestedBy auto-fill (OQ-2), hand-curated control-feature-map + per-RFC reviewer check via AISDLC-298 (OQ-3), single .tar.gz audit export with deterministic tar sort (OQ-4), on-demand export only for v1 (OQ-5), single posture per project for v1 with loader API taking CompliancePosture[] list for v2 forward-compat (OQ-6), PR template + reviewer-subagent check composing with AISDLC-298 (OQ-7). §13.1 added consolidating per-org `.ai-sdlc/compliance.yaml` config schema. Lifecycle promoted Draft → Ready for Review. Implementation broken into 4 phase tasks: AISDLC-322 (Phase 1 schema + loader), AISDLC-323 (Phase 2 mapping + composer), AISDLC-324 (Phase 3 init wizard), AISDLC-325 (Phase 4 audit export CLI). |

---

## 1. Summary

The framework today carries a number of compliance-adjacent surfaces — DSSE attestation envelopes (AISDLC-74/146), the trusted-reviewers allowlist (AISDLC-152), secret-pattern matchers (AISDLC-128), DoR calibration logs (RFC-0011), the dependency-graph drift gate (RFC-0014) — but there is **no unified compliance-posture declaration**. RFC-0022 introduces a new resource (`CompliancePosture`, manifest at `.ai-sdlc/compliance.yaml`) where adopters declare which regulatory regimes apply to their project (HIPAA, SOC2-T2, PCI-DSS-L1, GDPR, FedRAMP-Moderate, etc.). The framework derives gate defaults from those regimes (database-branch pool isolation, secret-scan strictness, attestation requirement, audit-log retention, reviewer-authority model) and exports auditor-ready evidence packs via a new `cli-compliance-audit` CLI.

The bootstrap trigger is RFC-0009 OQ-11 (DatabaseBranchPool tessellation): the operator surfaced "do we track anywhere what regulatory compliances we adhere to?" during the OQ-11 walkthrough on 2026-05-04 — the answer was no. RFC-0022 is the answer.

## 2. Motivation

### 2.1 The compliance question came up explicitly during RFC-0009 OQ-11

OQ-11's DatabaseBranchPool decision (`shared-with-rls` vs `per-shard`) is regulation-driven: HIPAA and PCI-DSS effectively require per-shard isolation; SOC2-T2 audit programs accept either with controls evidence; unregulated projects can stay on the cheaper shared-with-rls default. The operator asked the obvious follow-up — "where does the framework record which regulations apply to this project?" — and the honest answer was "nowhere; you'd just remember." That's the gap RFC-0022 closes.

### 2.2 Compliance-relevant surfaces exist but are scattered

A non-exhaustive inventory of today's compliance-adjacent surfaces:

- **DSSE attestation envelopes** (AISDLC-74, AISDLC-146): per-PR provenance + integrity; SOC2 CC8.1 / FedRAMP CM-3 evidence.
- **Trusted-reviewers allowlist** (`config/trusted-reviewers.yaml`, AISDLC-152): access-control changes; SOC2 CC6.6 / HIPAA §164.308(a)(4) evidence.
- **Secret-pattern matchers** (AISDLC-128): credential leakage prevention; PCI-DSS Req. 6.5.10 / SOC2 CC6.7 evidence.
- **DoR calibration log** (`_dor/calibration.jsonl`, RFC-0011): change-management discipline; SOC2 CC8.1 / FedRAMP CM-2/CM-3 evidence.
- **Dependency-graph drift gate** (RFC-0014): change-impact analysis; SOC2 CC8.1 evidence.
- **Subscription-ledger** (RFC-0010 §14): cost-attribution; not strictly compliance but auditor-relevant for ITAR/export-control scenarios.

Each surface produces useful audit signal in isolation, but there is no single artifact an operator can hand to an auditor that says "for the period 2026-Q1, here is the evidence covering these controls." Audit prep today is bespoke per auditor — every quarter the operator hand-assembles whichever subset of the above the auditor asked for.

### 2.3 Adopters in regulated industries need a posture-declaration surface

A future adopter running AI-SDLC inside a HIPAA-covered entity, or a fintech under PCI-DSS-L1, needs a way to **declare** the posture and have the framework adapt the defaults — not have to remember to flip OQ-11 to `per-shard`, set secret-scan strictness to strict, require attestation, and bump retention to 7 years individually. That's six independent settings the operator must keep in sync; one declared posture should drive them all.

### 2.4 Audit prep should be a CLI invocation, not a hand-assembly

Audit evidence today requires the operator to grep the right directories, format the right way for each auditor, and (for some regimes) prove the bundle hasn't been tampered with. A `cli-compliance-audit export --regime SOC2-T2 --period 2026-Q1` invocation that produces a deterministic, content-addressable `.tar.gz` is the obvious shape; this RFC scopes that surface.

## 3. Goals and Non-Goals

### 3.1 Goals

- **Declared posture.** Define a `CompliancePosture` resource at `.ai-sdlc/compliance.yaml` where adopters list applicable regulatory regimes with attestation metadata (who declared, when, rationale).
- **Derived defaults.** Map declared regimes to a closed set of derived gate values (`DerivedGates`); when multiple regimes apply, the tightest constraint wins per axis.
- **Operator override surface.** Allow operators to override any derived gate field-by-field, but only with `attestedNotes` rationale (no silent override).
- **Audit evidence export.** Ship `cli-compliance-audit export` that bundles DSSE envelopes, DoR calibration entries, trusted-reviewer changes, enforcement events, and access-control changes for a date range into a deterministic `.tar.gz`.
- **Init wizard integration.** RFC-0011 init wizard gains a "Compliance posture" step: multi-select regimes, write `.ai-sdlc/compliance.yaml`, expose derived gates for review.
- **Framework-level mapping.** Maintain a canonical regime → controls → AI-SDLC features mapping in-tree (`spec/compliance/regime-mappings.yaml` + `spec/compliance/control-feature-map.md`) so the mapping is versioned, reviewed, and changes through PR review.

### 3.2 Non-Goals

- **Legal advice.** The framework does not tell adopters which regimes apply to them. The operator (or their legal counsel) decides; the `attestedBy`/`attestedAt`/`attestedNotes` fields capture who said yes and why.
- **Real-time compliance monitoring.** v1 is on-demand export only. Continuous-monitoring dashboards, alert pipelines, and SIEM integrations are out of scope; if adopters demand them, a future RFC adds them on top of the same posture-declaration substrate.
- **Automated breach response.** Incident response is a human-in-the-loop activity; the framework provides evidence, not playbooks.
- **Compliance-as-code DSL.** Open Policy Agent / Rego / Cedar style policy languages add a real DSL learning curve and a runtime dependency. The YAML manifest in §5 is sufficient for v1; if adopters demand programmatic policies, defer to a future RFC.
- **Auditor-portal integration.** No direct push to Drata, Vanta, Secureframe, etc. The export is a `.tar.gz` an operator can upload manually; integrations live downstream of the export interface and are out of scope here.
- **Multi-tenant compliance composition.** Each tenant declaring its own posture is a Q6 lean (see §13); the v1 framework supports a single `CompliancePosture` per project. Multi-tenant union semantics ship in a follow-up if needed.

## 4. Architecture

The framework has four components:

```
┌─────────────────────────────────────────────────────────────────┐
│                .ai-sdlc/compliance.yaml                          │
│   (operator-declared regimes + derivedGates overrides + audit   │
│    export specs; init-scaffolded; versioned in adopter repo)    │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│           orchestrator/src/compliance/loader.ts                  │
│  (read manifest → resolve regimes → compose DerivedGates →      │
│   apply operator overrides → return CompliancePosture)          │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│         spec/compliance/regime-mappings.yaml                     │
│  (canonical regime → DerivedGates mapping; "tightest wins"      │
│   composer when multiple regimes declared; data, not schema)    │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│            cli-compliance-audit (export CLI)                     │
│  Reads CompliancePosture.spec.auditExports[]; bundles each      │
│  kind for the requested period into                              │
│  compliance-audit-<regime>-<isoDate>.tar.gz                      │
└──────────────────────────────────────────────────────────────────┘
```

The manifest (component 1) is operator-edited and lives in the adopter repo. The loader (component 2) is the single read path — gate-config loaders consume `posture.spec.derivedGates` rather than each computing their own defaults. The mapping data (component 3) is versioned in-tree so changes go through PR review. The audit-export CLI (component 4) is the operator-facing artifact-producing surface.

## 5. The CompliancePosture resource

Lives at `.ai-sdlc/compliance.yaml`. Schema declared at `spec/schemas/compliance-posture.v1.schema.json`. TypeScript shape:

```typescript
interface CompliancePosture {
  apiVersion: 'ai-sdlc.io/v1alpha1';
  kind: 'CompliancePosture';
  metadata: {
    name: string;                  // canonical project identifier
  };
  spec: {
    regimes: Regime[];             // declared regulatory posture
    derivedGates?: Partial<DerivedGates>; // operator overrides (with attestedNotes)
    auditExports: AuditExportSpec[];      // what to bundle on `cli-compliance-audit export`
  };
}

interface Regime {
  // Canonical regime identifier. Convention: '<framework>-<tier-or-version>'.
  // Examples: 'SOC2-T2', 'HIPAA', 'PCI-DSS-L1', 'GDPR', 'FedRAMP-Moderate', 'ISO-27001:2022'.
  id: string;

  // Optional explicit control list from the regime that the adopter is claiming
  // coverage for. Examples: ['CC6.6', 'CC8.1'] for SOC2; ['§164.308(a)(4)', '§164.312(a)']
  // for HIPAA. Used by the audit export to slice evidence per control.
  controls?: string[];

  // Audit cadence — drives default retention windows and export pre-staging.
  auditFrequency?: 'annual' | 'continuous' | 'on-demand';

  // Attestation metadata — who declared this regime applies, when, why.
  // REQUIRED in v1: framework refuses to load a posture with regimes lacking
  // attestation metadata (forces explicit operator/legal sign-off on each declaration).
  attestedBy: string;              // e.g., 'Dominique Legault' or 'Acme Legal LLP'
  attestedAt: string;              // ISO 8601 date
  attestedNotes?: string;          // operator's rationale (recommended for audit trail)
}

interface DerivedGates {
  // Per RFC-0009 OQ-11. 'shared-with-rls' = single Postgres branch with row-level
  // security tenant isolation. 'per-shard' = one branch per shard / customer.
  databaseBranchPool: 'shared-with-rls' | 'per-shard';

  // Per AISDLC-128. 'minimal' = framework-default patterns only.
  // 'standard' = + common cloud provider keys.
  // 'strict' = + entropy-based detection + adopter-supplied custom patterns.
  secretScanStrictness: 'minimal' | 'standard' | 'strict';

  // Per AISDLC-74/146. When true, framework refuses to merge PRs without a
  // valid DSSE attestation envelope at HEAD.
  attestationRequired: boolean;

  // Floor for log retention. The framework keeps logs (DSSE envelopes, calibration
  // entries, enforcement events, etc.) for at least this many days. GC by mtime.
  auditRetentionDays: number;

  // Per config/trusted-reviewers.yaml.
  // 'open' = any GitHub user can act as reviewer.
  // 'allowlist' = explicit reviewer list; identity-only check.
  // 'allowlist+role' = allowlist + per-role authority (review vs approve vs admin).
  reviewerAuthorityModel: 'open' | 'allowlist' | 'allowlist+role';
}

interface AuditExportSpec {
  // Which kind of evidence to include in the export bundle.
  kind:
    | 'dsse-envelope'           // .ai-sdlc/attestations/*.dsse.json
    | 'dor-calibration'         // _dor/calibration.jsonl
    | 'trusted-reviewers'       // git history of config/trusted-reviewers.yaml
    | 'enforcement-events'      // .ai-sdlc/enforcement/*.jsonl
    | 'access-control-changes'; // git history of CODEOWNERS + branch protection settings

  format: 'json' | 'jsonl' | 'csv';

  retentionPolicy: {
    days: number;                // floor; framework GC removes after `days + grace`
    tier?: 'hot' | 'cold';       // hot = on local disk; cold = expected to be archived externally
  };
}
```

**Why `attestedBy` is mandatory.** Compliance regimes are legal claims; the framework MUST NOT let an operator silently declare HIPAA coverage without recording who said so. A `CompliancePosture` whose regimes lack `attestedBy` fails to load with `MissingComplianceAttestation`.

**Why `derivedGates` is `Partial<>` and operator-overridable.** Per Q2 (§13), every override carries an `attestedNotes` field; the framework refuses to load a posture with `derivedGates` overrides whose notes are missing or empty. The override surface exists because real-world auditors sometimes accept different controls than the framework's lean (e.g., "we're SOC2-T2 but our auditor accepts shared+RLS with quarterly policy review evidence"). Forcing notes makes the rationale audit-traceable.

**Why `auditExports[]` is an array and not a union of all kinds.** Different regimes need different evidence subsets; a HIPAA audit cares about access-control changes, a SOC2-T2 audit cares about DoR calibration. The array lets the operator scope per-regime exports without collecting evidence the auditor doesn't want.

## 6. Regime → DerivedGates mapping

A canonical mapping ships in `spec/compliance/regime-mappings.yaml`. Pseudo-table (the YAML file is the source of truth; this table is the human-readable version):

| Regime              | DB pool                       | Secret scan | Attestation required | Retention                | Reviewer model     |
| ------------------- | ----------------------------- | ----------- | -------------------- | ------------------------ | ------------------ |
| SOC2-T2             | per-shard (recommended)       | strict      | yes                  | 365d hot + 6y cold       | allowlist+role     |
| HIPAA               | per-shard (REQUIRED)          | strict      | yes                  | 7y                       | allowlist+role     |
| PCI-DSS-L1          | per-shard (REQUIRED)          | strict      | yes                  | 1y                       | allowlist+role     |
| GDPR                | per-shard if EU residency     | standard    | yes                  | minimum-necessary        | allowlist          |
| FedRAMP-Moderate    | per-shard (REQUIRED)          | strict      | yes                  | 3y                       | allowlist+role     |
| ISO-27001:2022      | per-shard (recommended)       | strict      | yes                  | 365d hot                 | allowlist+role     |
| (none declared)     | shared-with-rls               | minimal     | no                   | 90d                      | open               |

**Multiple regimes → tightest constraint wins per axis.** Mirrors RFC-0009 OQ-2's `min` composition semantics. Concretely:

- `databaseBranchPool`: any regime requiring `per-shard` wins.
- `secretScanStrictness`: ordinal `minimal < standard < strict`; max wins.
- `attestationRequired`: any regime requiring `true` wins.
- `auditRetentionDays`: max wins.
- `reviewerAuthorityModel`: ordinal `open < allowlist < allowlist+role`; max wins.

**Operator override semantics.** When `spec.derivedGates.<field>` is set, that value wins regardless of regime composition — but the framework refuses to load the posture if the override lacks an `attestedNotes` entry under `spec.derivedGates._notes.<field>`. (The schema places notes in a sibling map keyed by field name to keep the override values themselves typed.)

**Composition example.** An adopter declares `[SOC2-T2, HIPAA]`:
- `databaseBranchPool: 'per-shard'` (HIPAA wins; SOC2 only recommends).
- `secretScanStrictness: 'strict'` (both regimes agree).
- `attestationRequired: true`.
- `auditRetentionDays: 2555` (HIPAA's 7y wins over SOC2's 365d-hot-floor).
- `reviewerAuthorityModel: 'allowlist+role'`.

If the operator overrides `databaseBranchPool: 'shared-with-rls'`, the loader requires `_notes.databaseBranchPool` to be a non-empty string explaining the deviation; load fails with `MissingDerivedGateOverrideNotes` otherwise.

## 7. Init wizard integration

The RFC-0011 init wizard (`ai-sdlc init`) gains a "Compliance posture" step inserted after the project-metadata step and before the gate-config step. UX sketch:

```
> Compliance posture
?  Which regulatory regimes apply to this project? (multi-select; <space> to toggle, <enter> to confirm)
   [ ] SOC2 Type 2 (Service Organization Control)
   [ ] HIPAA (Health Insurance Portability and Accountability Act)
   [ ] PCI-DSS Level 1 (Payment Card Industry Data Security Standard)
   [ ] GDPR (General Data Protection Regulation; EU)
   [ ] FedRAMP Moderate (US federal)
   [ ] ISO 27001:2022
   [x] (none — unregulated project)
?  Who is attesting these regimes apply? <Dominique Legault>
?  Notes on the attestation (optional, audit-visible): <demo project; no PII; unregulated>

✓ Wrote .ai-sdlc/compliance.yaml with derived gates:
   databaseBranchPool: shared-with-rls
   secretScanStrictness: minimal
   attestationRequired: false
   auditRetentionDays: 90
   reviewerAuthorityModel: open

  Review with: cat .ai-sdlc/compliance.yaml
  Override any field with the attestedNotes pattern (see docs/operations/compliance-posture.md).
```

**For RFC-0009 OQ-11 specifically:** when the gate-config step computes the DatabaseBranchPool default, it reads `.ai-sdlc/compliance.yaml` (just written) and pre-selects the right value:
- "(none declared)" → `shared-with-rls` (cheaper, wizard-confirms).
- Any regime requiring per-shard → `per-shard` (wizard tells the operator why: "HIPAA declared at .ai-sdlc/compliance.yaml requires per-shard isolation").

This collapses what would otherwise be two independent operator decisions (compliance posture + DB pool choice) into one (compliance posture; DB pool follows).

## 8. Audit evidence export

```
$ npx cli-compliance-audit export --regime SOC2-T2 --period 2026-01-01..2026-12-31
[1/5] Reading CompliancePosture from .ai-sdlc/compliance.yaml... (declared regimes: SOC2-T2)
[2/5] Filtering auditExports[] by regime SOC2-T2... 5 kinds in scope
[3/5] Collecting evidence for period 2026-01-01..2026-12-31...
       dsse-envelope:           247 envelopes (.ai-sdlc/attestations/*.dsse.json)
       dor-calibration:         1,832 entries (_dor/calibration.jsonl)
       trusted-reviewers:       12 changes (git log config/trusted-reviewers.yaml)
       enforcement-events:      89 events (.ai-sdlc/enforcement/*.jsonl)
       access-control-changes:  4 changes (CODEOWNERS + branch protection)
[4/5] Bundling into compliance-audit-SOC2-T2-2026-12-31.tar.gz...
[5/5] Writing manifest with sha256(content) for tamper-evidence...
       Bundle: compliance-audit-SOC2-T2-2026-12-31.tar.gz (3.2 MB)
       Manifest: compliance-audit-SOC2-T2-2026-12-31.manifest.json (sha256 of each contained file)
       Tamper-evidence: bundle is content-addressable; same period + same evidence → byte-identical .tar.gz.
```

**Idempotency contract.** Running the same export twice with the same `--period` produces a byte-identical `.tar.gz` unless new evidence has been written in the meantime. The manifest captures sha256 of every contained file plus a sha256-of-sha256s "bundle hash" that an auditor can independently recompute. This is the same content-addressable pattern AISDLC-146 uses for DSSE envelopes (`contentHashV3`).

**Bundle layout.**

```
compliance-audit-SOC2-T2-2026-12-31.tar.gz
├── manifest.json                   # sha256 per file + bundle hash + period + regime
├── posture.yaml                    # snapshot of .ai-sdlc/compliance.yaml at export time
├── dsse-envelope/
│   ├── <sha-1>.dsse.json
│   └── ...
├── dor-calibration/
│   └── 2026-01-01_to_2026-12-31.jsonl
├── trusted-reviewers/
│   └── git-log.json
├── enforcement-events/
│   └── 2026-01-01_to_2026-12-31.jsonl
└── access-control-changes/
    └── git-log.json
```

**`--regime` semantics.** When the project's posture declares multiple regimes, `--regime <id>` filters the `auditExports[]` array to entries that name `<id>` (or are unscoped). `--regime all` exports the union. The default (no `--regime` flag) exports the union with a manifest noting all declared regimes — handy for "give me everything for last quarter" runs.

**`--period` semantics.** Inclusive on both ends; ISO 8601 dates only. `--period 2026-Q1` is sugar for `2026-01-01..2026-03-31`. Future short-forms (`--period last-quarter`, `--period ytd`) are out of scope for v1.

## 9. Implementation Plan

Four phases. Critical path: 1 → 2 → 3/4 (parallel).

### Phase 1 — Resource schema + loader (0.5 week)

- `spec/schemas/compliance-posture.v1.schema.json` — JSON Schema for `CompliancePosture`.
- `orchestrator/src/compliance/types.ts` — TypeScript interfaces per §5.
- `orchestrator/src/compliance/loader.ts` — read manifest, validate against schema, return parsed posture.
- `orchestrator/src/compliance/errors.ts` — `MissingComplianceAttestation`, `MissingDerivedGateOverrideNotes`, `UnknownRegime`, etc.
- Default ships with "(none declared)" baseline posture for projects without `.ai-sdlc/compliance.yaml`.
- Unit tests: schema validation; missing-attestation rejection; missing-override-notes rejection; default baseline returned on missing manifest.

**Exit criteria:** loader returns a `CompliancePosture`; gate readers can consume `posture.spec.derivedGates` (even if today's gate readers ignore the field — wiring lands in Phase 3).

### Phase 2 — Regime → DerivedGates mapping + composer (1 week)

- `spec/compliance/regime-mappings.yaml` — canonical mapping per §6 table; data, not schema.
- `orchestrator/src/compliance/composer.ts` — read regime list, look up each regime's derived gates from the YAML, compose with "tightest wins" semantics, apply operator overrides last.
- `spec/compliance/control-feature-map.md` — hand-curated cross-reference of regime controls (e.g., SOC2 CC6.6) to AI-SDLC features (e.g., trusted-reviewers allowlist + DSSE attestation). Reviewed annually per Q3 lean.
- Unit tests: each regime in §6 table → expected DerivedGates; multi-regime composition (SOC2+HIPAA, GDPR alone, etc.); operator-override precedence.

**Exit criteria:** mapping table covers SOC2/HIPAA/PCI-DSS/GDPR/FedRAMP/ISO-27001; tests assert tightest-constraint wins for each axis; operator overrides always win when notes present.

### Phase 3 — Init wizard step (0.5 week)

- Amend RFC-0011 wizard with the §7 "Compliance posture" step.
- Multi-select prompt with regime descriptions; attestation prompt; notes prompt.
- Write `.ai-sdlc/compliance.yaml` with declared regimes + computed `derivedGates` + operator-visible review block.
- For OQ-11 specifically: gate-config step reads compliance.yaml, pre-selects DB-pool default, surfaces the rationale.
- Integration test: fresh checkout → `ai-sdlc init` → declares HIPAA → resulting compliance.yaml has correct derivedGates → DB-pool config defaults to per-shard.

**Exit criteria:** new init flow tested end-to-end against a fresh checkout; OQ-11 default flips correctly based on declared regimes.

### Phase 4 — Audit evidence export CLI (1 week)

- `pipeline-cli/bin/cli-compliance-audit.mjs` (entry point).
- `--dry-run`: enumerate evidence in scope, count entries, show bundle size estimate.
- `--export`: collect → bundle → write `.tar.gz` + manifest per §8.
- Bundle-format spec: manifest schema, file naming conventions, idempotency contract.
- Integration test: against a fixture corpus (200 fake envelopes, 1K calibration entries, etc.) → export produces valid `.tar.gz` containing all kinds → second export of the same period is byte-identical.

**Exit criteria:** export against fixture corpus produces valid `.tar.gz` with all five kinds; manifest sha256s round-trip; idempotency test passes (two consecutive exports of unchanged corpus = identical bundles).

## 10. Schema Changes

### 10.1 New schema: `spec/schemas/compliance-posture.v1.schema.json`

JSON Schema for the `CompliancePosture` resource per §5. Validates manifest at load time; the loader refuses to operate on a non-conforming `.ai-sdlc/compliance.yaml`.

### 10.2 New data file: `spec/compliance/regime-mappings.yaml`

Canonical regime → DerivedGates mapping per §6. Data, not schema — versioned in-tree so changes are visible in PR review. Operator forks may override per project (Q1 lean).

### 10.3 New cross-reference: `spec/compliance/control-feature-map.md`

Hand-curated table mapping regime controls (SOC2 CC6.6, HIPAA §164.312(a), etc.) to AI-SDLC features that produce relevant evidence. Reviewed annually per Q3 lean. Not normative — informational reference for auditors and adopters.

### 10.4 New CLI: `cli-compliance-audit`

Lives at `pipeline-cli/bin/cli-compliance-audit.mjs`. Subcommands: `export` (Phase 4), `dry-run` (alias for `export --dry-run`), `validate-manifest` (verify a previously-exported bundle's manifest).

### 10.5 Optional Pipeline.spec.compliance pointer (deferred to v2)

v1 keeps the manifest at the canonical `.ai-sdlc/compliance.yaml` path; no `Pipeline.spec.compliance` field. If adopters need to point at a non-default path (e.g., `compliance/posture.yaml`), a pointer field can land in v2 without breaking existing posture files.

## 11. Backward Compatibility

- Adopters without `.ai-sdlc/compliance.yaml` get the "(none declared)" baseline posture (`shared-with-rls`, `minimal` secret scan, `attestationRequired: false`, 90d retention, `open` reviewer model). This matches today's pre-RFC-0022 behavior — no derived-gate change for existing projects.
- New adopters via `ai-sdlc init` hit the §7 compliance step; can answer "(none)" for unregulated projects and get the same baseline.
- Schema changes (§10.1, §10.2) are additive only; existing pipelines that don't reference compliance continue to function unchanged.
- The audit export CLI is additive; no existing CLI behavior changes.
- Operator override surface is opt-in — operators who don't want to override anything just leave `spec.derivedGates` unset.

## 12. Alternatives Considered

### 12.1 Distributed approach — keep compliance bits scattered across configs

**Rejected: this is what we have today.** Trusted reviewers in `config/trusted-reviewers.yaml`, secret patterns in `config/secret-patterns.yaml`, attestation requirement in CI workflow definitions, retention in ad-hoc GC scripts. No source of truth, no way for an adopter to declare posture once and have it propagate. The motivation in §2 is exactly this gap.

### 12.2 Separate compliance tool out-of-band

**Rejected: drift risk.** A second tool (Drata, Vanta, Secureframe, a custom script, etc.) that reads framework artifacts but lives outside the framework drifts immediately — every framework change risks invalidating the tool's assumptions. The framework that produces the evidence is the right place to declare what evidence to produce and how to bundle it.

### 12.3 Compliance-as-code DSL (Open Policy Agent / Cedar / Rego)

**Deferred to a future RFC.** Programmable policy engines are powerful but add a runtime dependency, a DSL learning curve, and a debugging story for adopters. The YAML manifest in §5 covers the v1 use case (declare regimes; framework derives defaults; operator overrides with notes) without any of that. If adopters want programmable policies later, a future RFC layers OPA/Cedar on top of the same posture-declaration substrate.

### 12.4 Auto-detect regimes from code/config heuristics

**Rejected: false-positive risk + legal claim.** Inferring "this codebase looks HIPAA-y" from package.json dependencies or directory names is fragile and dangerous — declaring a regime is a legal claim that requires human attestation. The framework refuses to guess; the operator (or their counsel) declares.

### 12.5 Vendor-lock to a specific compliance platform

**Rejected.** Each adopter has a compliance platform of choice (Drata, Vanta, Secureframe, in-house, etc.). The framework produces a portable `.tar.gz` an operator can upload anywhere; integrations live downstream and are out of scope.

### 12.6 Ship with empty regime-mappings.yaml and let adopters fill it in

**Rejected.** Forcing every adopter to research SOC2 / HIPAA / PCI-DSS gate defaults from scratch defeats the purpose of a "framework derives defaults from declared posture" pattern. Ship the canonical leans in-tree (§6) and let adopters override per project; the framework's opinion is the value.

## 13. Open Questions — resolved (operator walkthrough 2026-05-16)

> **Resolution status (2026-05-16):** All 7 OQs resolved via operator walkthrough. Lifecycle promoted Draft → Ready for Review. §13.1 below codifies the consolidated `.ai-sdlc/compliance.yaml` per-org config schema. Implementation broken into 4 phase tasks: AISDLC-322 (Phase 1 schema + loader), AISDLC-323 (Phase 2 mapping + composer), AISDLC-324 (Phase 3 init wizard), AISDLC-325 (Phase 4 audit export CLI).

The following normative answers were established by operator walkthrough on **2026-05-16**:

### Q1: Where does the regime → controls mapping live? Versioned with the framework or external?

**Lean: versioned with the framework** at `spec/compliance/regime-mappings.yaml`. Changes go through PR review; adopters can override per project via a future `compliance.yaml`-side `regimeOverrides` field if they need to (deferred — not in v1). External hosting (e.g., a compliance-mappings-as-a-service surface) introduces a runtime fetch and a versioning story; in-tree YAML is simpler and matches how the framework versions other reference data (`spec/schemas/`, `spec/compliance/control-feature-map.md`).

**Resolution (2026-05-16):** **Hybrid — in-tree YAML defaults + adopter override exposed in v1.** `spec/compliance/regime-mappings.yaml` ships in-tree (matches OPA / HashiCorp Sentinel / Chef InSpec / ESLint convention). Adopter override via `compliance.yaml regimeOverrides: { <regimeKey>: { <controlName>: <value> } }` exposed from day 1 (not deferred to v2). Matches the per-org-configurability convention adopted across RFC-0024 / 0025 / 0031 / 0035. **Selected over in-tree-only** because regulated-industry adopters always have bespoke interpretations of compliance frameworks; the override hook is small schema surface that future-proofs the framework for the inevitable adopter who reads HIPAA differently than the framework's reference interpretation.

### Q2: How are operator overrides on `derivedGates` audited?

**Lean: every override carries an `attestedNotes` entry; framework refuses to load a posture if an override is present without notes.** Forcing explicit rationale makes overrides audit-traceable — an auditor can inspect `compliance.yaml` and see "shared-with-rls because our auditor accepts X with quarterly policy review evidence" rather than discovering an undocumented deviation. The schema keeps notes in a sibling `_notes` map keyed by field name to preserve override-value typing.

**Resolution (2026-05-16):** **Forced `attestedNotes` + auto-filled `attestedAt` + `attestedBy` from git committer.** Loader rejects override without notes per the author Lean. **Two additional zero-cost audit-richness fields added:** `attestedAt: <ISO-timestamp>` (auto-filled at write time via `cli-compliance set-override`) and `attestedBy: <email>` (auto-filled from git committer config; matches the "Co-Authored-By" convention). Auditor sees who/when/why in one read; PCI-DSS / SOC2 audit pattern requires in-document rationale, not commit-message archaeology. **Selected over notes-only** because the auto-fill fields cost zero operator friction; adopters needing stricter attestation can layer a 2-person workflow on top (out of scope for v1).

### Q3: What's the source of truth for "control" mappings (SOC2 CC6.6 → which AI-SDLC feature produces evidence)?

**Lean: maintain `spec/compliance/control-feature-map.md` as a hand-curated cross-reference, reviewed annually.** Auto-generation from regime documents would be nice but requires parsing legalese (every framework's control language is different). Hand curation with annual review is the pragmatic v1 answer; if the cross-reference becomes a maintenance burden, a future RFC can introduce structured-data sourcing.

**Resolution (2026-05-16):** **Hand-curated `spec/compliance/control-feature-map.md` (structured markdown tables, parseable for tooling later) + per-RFC compliance-impact reviewer check (composes with OQ-7 and AISDLC-298 reviewer-subagent).** Annual review remains the backstop; per-RFC inline updates catch drift as new RFCs ship. **Selected over structured-YAML-+-renderer** because markdown tables are effectively structured (parseable) without an extra schema + renderer + CI sync step; defer YAML migration to a future RFC if a gap-linter or compliance dashboard surfaces actual demand. Selected over auto-generation because legalese-parsing fragility means generated mappings need human verification anyway.

### Q4: Audit export format — single tar OR per-kind directory?

**Lean: single `.tar.gz` for portability.** Auditors get one file; uploading 5 separate directories to a portal is friction. The bundle layout (§8) preserves directory structure inside the archive so an extracted bundle is still navigable per-kind. `.tar.gz` over `.zip` because `tar` preserves POSIX permissions and content-hash determinism is easier (gzip with `-n` strips timestamps).

**Resolution (2026-05-16):** **Single `.tar.gz`** per the author Lean. POSIX permissions matter for attestation files; content-hash determinism is foundational for compliance integrity. `tar` with `--sort=name --mtime=...` (Reproducible Builds pattern) ensures byte-identical bundles for identical-content periods. Bundle layout (§8) preserves directory structure inside the archive. **Selected over `.zip`** despite Windows-auditor familiarity because the technical-determinism benefit outweighs the one-line documentation cost (auditors use 7-zip on Windows; AI-SDLC's audit consumers are sophisticated as it's a developer-tooling framework).

### Q5: Real-time compliance monitoring vs on-demand export?

**Lean: on-demand export only for v1.** Continuous monitoring (alert on every secret-scan failure, every reviewer-allowlist change, every retention-policy violation) is a real adopter ask but adds an event-streaming substrate, an alert routing story, and an integration matrix the framework doesn't have today. v1 ships the export; if adopters demand continuous monitoring, a future RFC layers it on the same posture substrate (the events are already JSONL — a streaming consumer is additive, not blocking).

**Resolution (2026-05-16):** **On-demand export only for v1** per the author Lean. Events already accumulate in `events.jsonl` (RFC-0015 substrate); a future v2 RFC can layer a streaming consumer that tails the file with per-org cadence + alert taxonomy properly designed. **Selected over hybrid digest** because digest cadence (weekly vs monthly vs quarterly) + delivery surface (email vs Slack vs S3 upload) is per-org configurable and deserves a properly-scoped v2 RFC, not a cheap v1 cron addition.

### Q6: How does this interact with multi-tenant SubscriptionPlan (RFC-0010)?

**Lean: each tenant has its own `CompliancePosture`; framework composes the union with "tightest wins" semantics.** A platform adopter running multiple SubscriptionPlans where one tenant is HIPAA-bound and another is unregulated should get HIPAA-tier defaults globally (the framework can't selectively apply per-shard isolation only to the HIPAA tenant — that's a per-tenant concern at the data layer, not a framework default). Multi-tenant composition is mostly out of scope for v1 (single posture per project), but the loader should be designed so multi-posture composition is additive in v2.

**Resolution (2026-05-16):** **Single posture per project for v1; v2 designs multi-tenant tightest-wins** per the author Lean. **Critical design constraint baked into v1:** loader API takes a `CompliancePosture[]` list (single-element in v1) — NOT a `CompliancePosture` — so v2 multi-tenant is additive, not a breaking change. The "additive in v2" claim only holds if v1's loader is shaped this way. **Selected over multi-tenant-from-v1** because composition rules (tightest-wins union vs per-tenant isolation) need actual multi-tenant adopters to validate against; designing without that evidence risks the wrong default.

### Q7: When the framework adds a new feature, what process ensures the regime mapping is updated?

**Lean: PR template includes a "compliance impact" checkbox; reviewer asks for `regime-mappings.yaml` + `control-feature-map.md` updates if applicable.** Lightweight process discipline rather than a tooling gate (a static analyzer that flags "this PR touches secret-scan but doesn't update the mapping" is over-engineered for v1). If the discipline slips, a future RFC can add a CI gate.

**Resolution (2026-05-16):** **PR template checkbox + reviewer-subagent gate (composes with AISDLC-298).** Author's checkbox + reviewer-ask as the human-facing surface, backed by AISDLC-298's reviewer-subagent that flags "PR touches `spec/compliance/*` or related code paths without updating mapping files" as a critical finding. **Phased rollout:** ship the PR template alone in Phase 4 (RFC-0022 implementation); layer the reviewer-subagent rule once AISDLC-298 ships (additive enhancement, doesn't block RFC-0022). **Selected over checkbox-only** because pure-process discipline slips when reviewers are busy; the subagent gate catches misses without requiring a separate CI workflow.

### 13.1 Configuration Schema (per-org defaults)

Per-organization configurability is mandatory across the resolved OQs. The consolidated `.ai-sdlc/compliance.yaml` schema:

```yaml
compliance:
  posture:                              # OQ-6 — single posture in v1; loader API takes list for v2 forward-compat
    regimes:                            # adopter declares applicable regimes
      - hipaa
      - soc2
    attestation:                        # OQ-2 — auto-filled audit fields
      attestedBy: Dominique Legault    # auto-filled from git committer
      attestedAt: "2026-05-16T14:30:00Z"          # auto-filled at write time

  regimeOverrides:                      # OQ-1 — adopter overrides ship in v1, not deferred to v2
    hipaa:
      db-isolation: shared-with-rls     # operator override
      _notes:
        db-isolation: "Our auditor accepts shared-with-rls with quarterly policy review evidence (case #ABC-123)"

  derivedGates:                         # composed from regimes + overrides
    secret-scan: strict
    db-isolation: shared-with-rls       # operator override applied
    retention-days: 2190                # 6 years for HIPAA
    attestation-required: true
    _notes:                             # OQ-2 — sibling map; loader rejects override without notes
      db-isolation: "See compliance.regimeOverrides.hipaa._notes"

  audit-export:                         # OQ-4 — single .tar.gz
    format: tar.gz
    bundleLayoutVersion: 1
    sortMode: deterministic             # tar --sort=name --mtime=<fixed> for content-hash determinism

  monitoring:                           # OQ-5 — on-demand only for v1
    mode: on-demand                     # 'continuous' deferred to future RFC
```

Default constants ship in the `ai-sdlc init` compliance template. The regime → derived-gates mapping lives in-tree at `spec/compliance/regime-mappings.yaml` (OQ-1 base) + control-feature cross-reference at `spec/compliance/control-feature-map.md` (OQ-3). Auto-tuning + continuous monitoring + multi-tenant composition are future work; operator-configurable from day one.

## 14. References

- **RFC-0008** (PPA Triad Integration) — admission composite + audit-trail substrate. CompliancePosture sits in the same substrate; audit exports include PPA-derived enforcement events.
- **RFC-0009 OQ-11** (DatabaseBranchPool tessellation) — primary trigger source. The compliance-tracking gap surfaced during the OQ-11 walkthrough on 2026-05-04 directly motivates this RFC.
- **RFC-0011** (Definition-of-Ready Gate for Pipeline Admission) — change-management discipline; the DoR calibration log is one of the audit-export evidence kinds.
- **RFC-0019** (Embedding Provider Adapter Framework) — same adapter-framework pattern reference for document structure (interface + registry + capability matrix + lifecycle); RFC-0022 mirrors RFC-0019's section layout.
- **AISDLC-128** (secret patterns) — secret-scan strictness consumer; reads `posture.spec.derivedGates.secretScanStrictness`.
- **AISDLC-74, AISDLC-146** (DSSE attestation, HMAC marker) — provenance + integrity surfaces; DSSE envelopes are the canonical audit-export evidence kind.
- **AISDLC-152** (CI-attestor cleanup + trusted-reviewers governance) — access-control surface; trusted-reviewers changes are an audit-export evidence kind.
- **RFC-0010 §13** (HarnessAdapter Framework) — capability-matrix + override-with-notes pattern referenced by the operator-override semantics in §6.
- **RFC-0014** (Dependency Graph Composition) — drift gate produces enforcement events that the audit export bundles.

## 15. Sign-Off

- [ ] Engineering owner — Dominique Legault (pending)
- [ ] Product owner — Alex (pending)
- [ ] Operator owner — Dominique Legault (pending)

## 16. Revision History

| Version | Date       | Author    | Notes                                                                                                                                |
| ------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| v1      | 2026-05-03 | dominique | Initial draft surfacing compliance-tracking gap identified during RFC-0009 OQ-11 walkthrough; mirrors RFC-0019's adapter-pattern document structure. |
| v0.2    | 2026-05-16 | dominique | Operator OQ walkthrough resolved all 7 §13 OQs. Resolutions: in-tree YAML defaults + adopter override in v1 (OQ-1), forced attestedNotes + attestedAt + attestedBy auto-fill (OQ-2), hand-curated control-feature-map + per-RFC reviewer check via AISDLC-298 (OQ-3), single .tar.gz audit export with deterministic tar sort (OQ-4), on-demand export only for v1 (OQ-5), single posture per project for v1 with loader API taking CompliancePosture[] list for v2 forward-compat (OQ-6), PR template + reviewer-subagent check composing with AISDLC-298 (OQ-7). §13.1 added consolidating per-org `.ai-sdlc/compliance.yaml` config schema. Lifecycle promoted Draft → Ready for Review. Implementation broken into 4 phase tasks: AISDLC-322 (Phase 1 schema + loader), AISDLC-323 (Phase 2 mapping + composer), AISDLC-324 (Phase 3 init wizard), AISDLC-325 (Phase 4 audit export CLI). |
