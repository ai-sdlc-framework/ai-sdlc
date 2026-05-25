---
id: AISDLC-335
title: 'docs: RFC-0036 Phase 10 — BYO translator pattern docs for non-spec-kit upstreams'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-10
  - docs
dependencies:
  - AISDLC-329
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: medium
blocked:
  reason: 'RFC-0036 lifecycle is Ready for Review; all 12 §14 OQs resolved via operator walkthrough 2026-05-16 (RFC §14 header) — implementation phases AISDLC-326..336 cleared to proceed.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 10 of RFC-0036 §13. Adapter-pattern documentation for non-spec-kit upstreams (Linear, Notion, plain markdown). Per OQ-6 resolution: single BYO translator pattern, not N first-party adapters.

## Scope (OQ-6)

- `docs/concepts/adopter-translators.md` — explains the BYO translator pattern: adopters with non-spec-kit upstreams write their own translator that emits the canonical task-import format.
- Canonical task-import format spec (the contract the translator must produce).
- Reference translator scaffold at `.ai-sdlc/translators/<adopter>.ts`.
- Worked example: a minimal Linear → ai-sdlc translator.
- Note: new first-party adapter requests become Decisions in the RFC-0035 catalog; this doc explains how adopters can vote with their voice on which adapters should graduate to first-party.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `docs/concepts/adopter-translators.md` ships
- [x] #2 Canonical task-import format spec documented (translator output contract)
- [x] #3 Reference translator scaffold at `.ai-sdlc/translators/<adopter>.ts`
- [x] #4 Worked example: minimal Linear → ai-sdlc translator
- [x] #5 Documents the path from BYO → first-party adapter promotion (via RFC-0035 Decision)
<!-- AC:END -->

## Implementation Summary

Shipped Phase 10 of RFC-0036 §13 — adopter-facing docs for the BYO translator pattern that lets non-spec-kit upstreams (Linear, Notion, plain markdown, internal RFC repos) feed the AI-SDLC spec-kit bridge by writing a small translator that emits the canonical spec-kit-compatible `tasks.md` format.

### New files

- `docs/concepts/adopter-translators.md` — full concepts doc covering: why BYO over N first-party adapters; canonical `tasks.md` format spec (`v0.8-headings` layout + required fields); translator contract; install-time convention path `.ai-sdlc/translators/<adopter>.ts`; full workflow loop; BYO → first-party promotion path via RFC-0035 Decision Catalog.
- `docs/examples/translators/example-adopter.ts` — typed translator scaffold with adopter-fill-in markers for `fetchUpstreamRecords()` and `mapToTask()`; reusable `renderTasksMarkdown()` + `writeTasksMd()` helpers.
- `docs/examples/translators/linear-translator.ts` — worked example: Linear GraphQL → `tasks.md`, with AC extraction from `- [ ] AC: …` / `- AC: …` checklist markers, body normalisation, idempotent output writing.
- `docs/examples/translators/README.md` — examples index; explains the dependency-free copy-and-adapt pattern.

### Modified files

- `docs/concepts/spec-driven.md` — cross-references table gains a link to the new adopter-translators doc.
- `docs/examples/README.md` — adds a "Translator Examples" section to the examples index.
- `docs/tutorials/10-spec-kit-bridge.md` — troubleshooting "My non-spec-kit upstream can't feed the bridge" section gains a "Detailed walkthrough" pointer to the new docs.

### Design decisions

- **Scaffold lives at `docs/examples/translators/` in the framework repo, documented as `.ai-sdlc/translators/<adopter>.ts` in adopter repos.** The framework's `.ai-sdlc/**` is governance-blocked for safety; the example surface is `docs/examples/` by convention (already houses `adapter-implementation.ts` and other RFC-0003 reference impls). The concepts doc explicitly calls out the adopter install path.
- **Framework-import-free TypeScript.** Adopters copy the files verbatim into their own repos; no `@ai-sdlc/*` imports keep the scaffolds portable across any TypeScript-strict project.
- **No new tests.** Pure docs + reference TypeScript that compiles + lints clean against the existing `docs/examples/` tsconfig conventions.
- **BYO → first-party promotion routed via RFC-0035.** Per OQ-6: adopters who want their upstream graduated file a `Decision` in the catalog; the operator weighs accumulated demand signal asynchronously without blocking framework releases (G0 non-blocking pipeline contract).

### Verification
- `pnpm build` — clean
- `pnpm test` — 639 test files across 9 packages, all pass
- `pnpm lint` — clean
- `pnpm format:check` — clean
