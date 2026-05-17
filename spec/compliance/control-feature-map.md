# Compliance Control → AI-SDLC Feature Map

**Purpose:** Hand-curated cross-reference of regulatory regime controls to AI-SDLC
framework features that produce compliance-relevant evidence.

**Scope:** SOC 2 Type 2, HIPAA, PCI-DSS Level 1, GDPR, FedRAMP Moderate, ISO 27001:2022.

**Review cadence:** Annually; additionally updated per-RFC when a new RFC adds framework
features (RFC-0022 §13 Q7 process discipline). Reviewer subagent flags PRs touching
`spec/compliance/` or related code paths without updating this file.

**Format:** Structured markdown tables — parseable for tooling, renderable for humans.
Each table row carries: Control ID, Control name, AI-SDLC feature, Evidence pointer,
DerivedGate axis.

---

## SOC 2 Type 2

SOC 2 Trust Service Criteria (TSC) — Change Management (CC8) and Logical Access (CC6)
are the primary evidence-bearing categories for AI-SDLC.

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| CC6.1 | Logical and physical access controls | Trusted-reviewers allowlist (AISDLC-152) | `git log config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| CC6.2 | Prior to issuing system credentials, the entity registers and authorizes new internal and external users | Regime attestation metadata (`attestedBy`, `attestedAt`, `attestedNotes`) in `.ai-sdlc/compliance.yaml` | `posture.spec.regimes[].attestedBy` | `attestationRequired: true` |
| CC6.6 | Logical access security measures to protect against threats from sources outside its system boundaries | DSSE attestation envelopes (AISDLC-74, AISDLC-146) + trusted-reviewers allowlist | `.ai-sdlc/attestations/*.dsse.json`, `config/trusted-reviewers.yaml` | `attestationRequired: true`, `reviewerAuthorityModel: allowlist+role` |
| CC6.7 | The transmission and movement of information is restricted to authorized internal and external users and roles | Secret-scan strictness gate (AISDLC-128) | Pre-push hook rejections logged to `.ai-sdlc/enforcement/*.jsonl` | `secretScanStrictness: strict` |
| CC7.2 | The entity monitors system components and the operation of those components for anomalies | Pipeline enforcement events (RFC-0015) + audit scheduler (orchestrator audit-scheduler.ts) | `.ai-sdlc/enforcement/*.jsonl`, `events.jsonl` | `auditRetentionDays: 2555` |
| CC8.1 | The entity authorizes, designs, develops or acquires, configures, documents, tests, and implements changes to infrastructure, data, software, and procedures | DSSE attestation envelopes + DoR calibration log (RFC-0011) | `.ai-sdlc/attestations/*.dsse.json`, `_dor/calibration.jsonl` | `attestationRequired: true` |

---

## HIPAA

Health Insurance Portability and Accountability Act — Security Rule (45 CFR Part 164).

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| §164.308(a)(1) | Security management process | CompliancePosture declaration with attested regimes | `.ai-sdlc/compliance.yaml` | `attestationRequired: true` |
| §164.308(a)(3) | Workforce security — authorization and supervision | Trusted-reviewers allowlist + per-role authority (AISDLC-152) | `config/trusted-reviewers.yaml` + `git log config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| §164.308(a)(4) | Information access management — access authorization | Trusted-reviewers allowlist; CODEOWNERS; branch protection settings | `config/trusted-reviewers.yaml`, CODEOWNERS, branch protection audit export | `reviewerAuthorityModel: allowlist+role` |
| §164.308(a)(5) | Security awareness and training — protection from malicious software | Secret-scan strictness gate (AISDLC-128) + entropy-based pattern detection | Pre-push hook scan logs | `secretScanStrictness: strict` |
| §164.310(d)(2)(iii) | Accountability — data backup plan; PHI isolation | Database-branch pool per-shard isolation (RFC-0009 OQ-11) | `posture.spec.derivedGates.databaseBranchPool` | `databaseBranchPool: per-shard` |
| §164.312(a)(1) | Access control — unique user identification | DSSE attestation envelope `attestedBy` field + trusted-reviewers allowlist | `.ai-sdlc/attestations/*.dsse.json` → `subject`, `config/trusted-reviewers.yaml` | `attestationRequired: true`, `reviewerAuthorityModel: allowlist+role` |
| §164.312(b) | Audit controls | Pipeline enforcement events + DoR calibration log + DSSE envelopes | `.ai-sdlc/enforcement/*.jsonl`, `_dor/calibration.jsonl`, `.ai-sdlc/attestations/` | `auditRetentionDays: 2190` |
| §164.530(j) | Documentation — retention (6 years) | Audit retention floor enforced by framework GC policy | `posture.spec.derivedGates.auditRetentionDays` (2190 days) | `auditRetentionDays: 2190` |

---

## PCI-DSS Level 1

Payment Card Industry Data Security Standard v4.0 — Level 1 merchant/service provider.

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| Req. 3 | Protect stored account data | Database-branch pool per-shard isolation | `posture.spec.derivedGates.databaseBranchPool` | `databaseBranchPool: per-shard` |
| Req. 6.3.3 | All system components are protected from known vulnerabilities | Secret-scan strictness strict + DSSE attestation at merge | `.ai-sdlc/attestations/*.dsse.json` | `secretScanStrictness: strict`, `attestationRequired: true` |
| Req. 6.5 | Changes to all system components are managed securely | DSSE attestation envelopes (change provenance) + DoR calibration gate (RFC-0011) | `.ai-sdlc/attestations/*.dsse.json`, `_dor/calibration.jsonl` | `attestationRequired: true` |
| Req. 7.2 | Access to system components and data is appropriately defined and assigned | Trusted-reviewers allowlist + per-role authority | `config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| Req. 10.2 | Audit log record contents | Pipeline enforcement events + DSSE envelope metadata | `.ai-sdlc/enforcement/*.jsonl`, `.ai-sdlc/attestations/*.dsse.json` | `auditRetentionDays: 365` |
| Req. 10.3.3 | Audit logs, including those for external-facing technologies, are promptly backed up to a centralized, internal log server | Audit export CLI (`cli-compliance-audit export`) | `compliance-audit-PCI-DSS-L1-<date>.tar.gz` | `auditRetentionDays: 365` |
| Req. 10.7 | Failures of critical security controls are detected, reported, and responded to promptly | Pipeline failure events + admission enforcement logging | `.ai-sdlc/enforcement/*.jsonl`, `events.jsonl` | `auditRetentionDays: 365` |

---

## GDPR

General Data Protection Regulation (EU) 2016/679.

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| Art. 5(1)(b) | Purpose limitation | CompliancePosture attestation with purpose documented in `attestedNotes` | `.ai-sdlc/compliance.yaml` → `spec.regimes[].attestedNotes` | `attestationRequired: true` |
| Art. 5(1)(e) | Storage limitation (data minimisation) | Audit retention floor; GC policy enforced at `auditRetentionDays` | `posture.spec.derivedGates.auditRetentionDays` (365 days default; adopter SHOULD override downward) | `auditRetentionDays: 365` |
| Art. 17 | Right to erasure | Database-branch pool per-shard isolation enables tenant-scoped erasure | `posture.spec.derivedGates.databaseBranchPool` | `databaseBranchPool: per-shard` |
| Art. 25 | Data protection by design and by default | Secret-scan gate (standard strictness) + DSSE attestation at merge | `.ai-sdlc/attestations/*.dsse.json`, pre-push scan logs | `secretScanStrictness: standard`, `attestationRequired: true` |
| Art. 30 | Records of processing activities | DoR calibration log + pipeline enforcement events (processing record) | `_dor/calibration.jsonl`, `.ai-sdlc/enforcement/*.jsonl` | `auditRetentionDays: 365` |
| Art. 32 | Security of processing | Secret-scan strictness (standard+ covering cloud provider keys) | Pre-push hook rejections | `secretScanStrictness: standard` |
| Art. 33 | Notification of a personal data breach to the supervisory authority | Pipeline breach-detection events (enforcement events); DSSE envelope integrity proof | `.ai-sdlc/enforcement/*.jsonl`, `.ai-sdlc/attestations/*.dsse.json` | `attestationRequired: true` |

---

## FedRAMP Moderate

US Federal Risk and Authorization Management Program — Moderate baseline.
Implemented via NIST SP 800-53 Rev 5 controls.

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| AC-2 | Account Management | Trusted-reviewers allowlist + per-role authority (AISDLC-152) | `config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| AC-6 | Least Privilege | Trusted-reviewers allowlist restricts who can approve + merge | `config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| AU-3 | Content of Audit Records | DSSE envelope metadata (subject, timestamp, content hash) + enforcement event schema | `.ai-sdlc/attestations/*.dsse.json`, `.ai-sdlc/enforcement/*.jsonl` | `attestationRequired: true` |
| AU-9 | Protection of Audit Information | DSSE envelope content-hash (V3/V4) tamper evidence | `.ai-sdlc/attestations/*.dsse.json` → `contentHashV4` | `attestationRequired: true` |
| AU-11 | Audit Record Retention (3 years) | Audit retention floor 1095 days (3 × 365) | `posture.spec.derivedGates.auditRetentionDays` (1095) | `auditRetentionDays: 1095` |
| CM-2 | Baseline Configuration | DoR calibration log (change baseline evidence) | `_dor/calibration.jsonl` | `attestationRequired: true` |
| CM-3 | Configuration Change Control | DSSE attestation at every merge + PR review gate | `.ai-sdlc/attestations/*.dsse.json`, `config/trusted-reviewers.yaml` | `attestationRequired: true`, `reviewerAuthorityModel: allowlist+role` |
| RA-5 | Vulnerability Monitoring and Scanning | Secret-scan strictness strict + entropy-based pattern detection (AISDLC-128) | Pre-push hook rejection logs | `secretScanStrictness: strict` |
| SC-4 | Information in Shared Resources | Database-branch pool per-shard isolation (prevents cross-tenant data bleed) | `posture.spec.derivedGates.databaseBranchPool` | `databaseBranchPool: per-shard` |

---

## ISO 27001:2022

ISO/IEC 27001:2022 — Information security management systems.
Annex A controls referenced below.

| Control ID | Control Name | AI-SDLC Feature | Evidence Pointer | DerivedGate Axis |
|-----------|-------------|-----------------|-----------------|-----------------|
| A.5.15 | Access control — access control policy | Trusted-reviewers allowlist + per-role authority | `config/trusted-reviewers.yaml` | `reviewerAuthorityModel: allowlist+role` |
| A.5.36 | Compliance with policies, rules, and standards | CompliancePosture resource with attested regimes; enforcement events | `.ai-sdlc/compliance.yaml`, `.ai-sdlc/enforcement/*.jsonl` | `attestationRequired: true` |
| A.8.2 | Privileged access rights | Trusted-reviewers per-role authority model; branch protection enforcement | `config/trusted-reviewers.yaml`, CODEOWNERS | `reviewerAuthorityModel: allowlist+role` |
| A.8.5 | Secure authentication | DSSE attestation envelope as merge-gate credential proof | `.ai-sdlc/attestations/*.dsse.json` | `attestationRequired: true` |
| A.8.10 | Information deletion | Database-branch per-shard isolation enabling tenant-scoped deletion | `posture.spec.derivedGates.databaseBranchPool` | `databaseBranchPool: per-shard` |
| A.8.12 | Prevention of data leakage | Secret-scan strictness strict (entropy-based detection) | Pre-push hook rejection logs | `secretScanStrictness: strict` |
| A.8.15 | Logging — minimum 365 days | Audit retention floor 365 days | `posture.spec.derivedGates.auditRetentionDays` (365) | `auditRetentionDays: 365` |
| A.8.32 | Change management | DSSE attestation + DoR calibration gate + trusted-reviewer review gate | `.ai-sdlc/attestations/*.dsse.json`, `_dor/calibration.jsonl` | `attestationRequired: true`, `reviewerAuthorityModel: allowlist+role` |

---

## Evidence Pointer Glossary

| Evidence Kind | Location | Produced by |
|--------------|---------|------------|
| DSSE attestation envelope | `.ai-sdlc/attestations/<sha>.dsse.json` | `scripts/check-attestation-sign.sh` + reviewer subagents |
| DoR calibration entries | `_dor/calibration.jsonl` | `pipeline-cli/src/dor/` (RFC-0011) |
| Trusted-reviewers history | `git log config/trusted-reviewers.yaml` | Git; captured by `cli-compliance-audit export` |
| Enforcement events | `.ai-sdlc/enforcement/*.jsonl` | Admission gate + action enforcement (orchestrator) |
| Access-control changes | `CODEOWNERS` + branch protection API | Git + GitHub API; captured by `cli-compliance-audit export` |
| Pipeline events | `events.jsonl` | RFC-0015 autonomous orchestrator |

---

## Maintenance Notes

- **Annual review:** Owner (dominique@reliablegenius.io) reviews this file annually against
  each framework's updated control catalog. Scheduled as a recurring backlog task.
- **Per-RFC updates:** When a new RFC adds framework features, the RFC PR must include an
  update to this file mapping the new feature to relevant controls (RFC-0022 §13 Q7).
  Reviewer subagent (AISDLC-298) flags missing updates as a critical finding.
- **Not normative:** This document is informational — it describes what evidence the
  framework produces, not legal advice on compliance obligations.
