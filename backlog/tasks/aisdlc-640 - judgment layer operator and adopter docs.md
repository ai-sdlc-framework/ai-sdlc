---
id: AISDLC-640
title: >-
  RFC-0049 docs: operator runbook, adopter opt-in guide and promotion runbook for the judgment layer
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-8
  - docs
  - adopter
dependencies:
  - AISDLC-632
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - docs/operations/dor-promotion.md
  - docs/operations/embedding-providers.md
  - docs/operations/README.md
  - docs/operations/doctor.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-facing documentation for the judgment layer. RFC-0049 declares
`requiresDocs: [operator-runbook]` with `deferredDocs: true`; this task satisfies the
requirement and removes the deferral.

## Scope
1. **`docs/operations/judgment-layer.md`** (operator runbook): what the layer does and
   does not do; enabling it (one config file, one env var); providers (`jev`,
   `openai-compatible`) and their options; the three egress classes and what each
   sends; modes `off`, `shadow`, `enforce`; the reasons a judgment is downgraded to
   `shadow`; the judgment log location and record fields; cost attribution; the kill
   switch `AI_SDLC_JUDGMENT=off`; a troubleshooting table keyed by abstain reason.
   It cites RFC-0049 by id.
2. **`docs/operations/judgment-promotion.md`**: the promotion runbook, in the shape of
   `docs/operations/dor-promotion.md`. The corpus path and override path per
   `riskClass`, with the exact bars from RFC-0049 section 8; how to build a corpus with
   each converter; running `cli-judgment eval` and `--sweep`; reading the report;
   pasting the promotion record; rollback (set the mode back to `shadow`); what happens
   on a model version change.
3. **Adopter section** in the runbook: the privacy statement (what leaves the machine
   and to whom, that a local OpenAI-compatible endpoint sends nothing to a third
   party, that a compliance posture can restrict classes), and a minimal working
   config for each provider.
4. **Index:** link both documents from `docs/operations/README.md`.
5. **RFC frontmatter:** remove `deferredDocs` and `deferredDocsDeadline` from
   `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Do not change any other part of
   the RFC.

## Acceptance Criteria
- [ ] `docs/operations/judgment-layer.md` exists, cites `RFC-0049`, and covers enabling, providers, egress classes, modes, downgrade reasons, log, cost, kill switch and troubleshooting.
- [ ] `docs/operations/judgment-promotion.md` exists and states the corpus and override bars for `seam`, `tighten` and `relax` exactly as RFC-0049 section 8, including that `relax` has no override path.
- [ ] Every command shown in both documents runs as written against the shipped CLI (`node pipeline-cli/bin/cli-judgment.mjs ...`).
- [ ] Both documents are linked from `docs/operations/README.md`.
- [ ] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [ ] Neither document contains internal task ids.
- [ ] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
