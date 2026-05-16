---
id: AISDLC-325
title: 'feat: RFC-0022 Phase 4 — `cli-compliance-audit` export CLI + deterministic .tar.gz bundle + PR template'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0022
  - compliance
  - phase-4
  - audit-export
dependencies:
  - AISDLC-322
  - AISDLC-323
references:
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0022 §9 Implementation Plan. Ships the audit evidence export CLI + PR template (OQ-7 process discipline).

## Scope (RFC-0022 §9 Phase 4, §8 audit evidence export)

- `pipeline-cli/bin/cli-compliance-audit.mjs` (entry point).
- `--dry-run`: enumerate evidence in scope, count entries, show bundle size estimate.
- `--export`: collect → bundle → write `.tar.gz` + manifest per §8.
- Bundle-format spec: manifest schema, file naming conventions, idempotency contract.
- **OQ-4 deterministic bundle:** `tar --sort=name --mtime=<period-end-timestamp>` + `gzip -n` for content-hash determinism (Reproducible Builds pattern). Two consecutive exports of unchanged corpus produce byte-identical bundles.
- **OQ-5 on-demand only:** no continuous streaming; one-shot export per invocation. Streaming substrate deferred to future RFC.
- **OQ-7 process discipline:** PR template addition with "Compliance impact" checkbox. Reviewer ask for `regime-mappings.yaml` + `control-feature-map.md` updates when applicable. Subagent-gate enhancement deferred until AISDLC-298 ships.
- Integration test: against a fixture corpus (200 fake envelopes, 1K calibration entries, etc.) → export produces valid `.tar.gz` containing all kinds → second export of the same period is byte-identical.

## Exit criteria

Export against fixture corpus produces valid `.tar.gz` with all five kinds; manifest sha256s round-trip; idempotency test passes (two consecutive exports of unchanged corpus = identical bundles).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `pipeline-cli/bin/cli-compliance-audit.mjs` entry point ships
- [ ] #2 `--dry-run` enumerates evidence, counts entries, estimates bundle size
- [ ] #3 `--export` writes `.tar.gz` + manifest per §8
- [ ] #4 OQ-4 deterministic packing: `tar --sort=name --mtime=<period-end>` + `gzip -n`
- [ ] #5 Two consecutive exports of unchanged corpus → byte-identical bundles (idempotency test)
- [ ] #6 Manifest sha256s round-trip on extraction
- [ ] #7 OQ-7 PR template addition with "Compliance impact" checkbox
- [ ] #8 Integration test against fixture corpus (200 envelopes, 1K calibration entries) → valid bundle with all 5 kinds
<!-- AC:END -->
