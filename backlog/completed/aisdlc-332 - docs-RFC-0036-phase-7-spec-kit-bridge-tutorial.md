---
id: AISDLC-332
title: 'docs: RFC-0036 Phase 7 — spec-kit bridge tutorial + getting-started revision'
status: Done
assignee: []
created_date: '2026-05-16'
updated_date: '2026-05-24'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-7
  - docs
dependencies:
  - AISDLC-330
  - AISDLC-331
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: medium
blocked:
  reason: 'RFC-0036 OQs all resolved at 2026-05-16 operator walkthrough; lifecycle remains Ready for Review pending Signed Off; phase 7 docs task implementing the resolved OQs (override per CLAUDE.md upstream-OQ gate convention) — builds on already-merged AISDLC-330 + AISDLC-331.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 7 of RFC-0036 §13. Adopter-facing tutorial for the spec-kit bridge + revision of getting-started flow.

## Scope

- `docs/tutorials/N-spec-kit-bridge.md` — end-to-end walkthrough: install spec-kit → author spec → import to ai-sdlc → dispatch → ship.
- Getting-started revision: prominently mention spec-kit bridge as the recommended adopter authoring path.
- Covers: import command, drift handling, DoR-at-import, upstream-clarification feedback loop.
- Includes troubleshooting section for common adoption blockers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `docs/tutorials/N-spec-kit-bridge.md` ships end-to-end walkthrough
- [x] #2 Getting-started revision mentions spec-kit bridge as recommended authoring path
- [x] #3 Covers import / drift / DoR-at-import / upstream-clarification feedback loop
- [x] #4 Troubleshooting section for common adoption blockers
- [x] #5 Cross-references RFC-0036 OQ resolutions for design rationale
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

## Summary

RFC-0036 Phase 7 docs ship the adopter-facing surface for the spec-kit bridge now that AISDLC-329 (Phase 4 CLI), AISDLC-330 (Phase 5 DoR-at-import), and AISDLC-331 (Phase 6 reconcile/drift) have all merged. The new tutorial walks the full loop end-to-end (install spec-kit → author spec → import → DoR-at-import → dispatch → ship → handle drift), the getting-started revision repositions the recommended adopter authoring path around the bridge, and the tutorials index surfaces the new tutorial alongside the existing six. Every default in the tutorial maps back to one of the twelve RFC-0036 OQ resolutions captured at the 2026-05-16 operator walkthrough, so the rationale is traceable for any future operator who wants to revisit the design.

## Changes

- `docs/tutorials/10-spec-kit-bridge.md` (new): full end-to-end walkthrough — 12 sections covering prerequisites, install, authoring upstream, import, DoR-at-import (admitted / admitted-with-warnings / refused outcomes), analyze-metadata auto-resolution (OQ-7), upstream-clarification feedback loop, dispatch, drift handling via `--reconcile`, configuration reference, troubleshooting, OQ rationale table, and further reading.
- `docs/getting-started/README.md` (modified): "What is AI-SDLC?" section reframed around the Decision Engine substrate + spec-kit bridge as recommended adopter authoring path; new "The recommended adopter authoring path" section with the spec-kit → cli-import-spec → backlog → execute funnel diagram; Next Steps surfaces the Phase 7 tutorial + concepts/spec-driven.md first.
- `docs/tutorials/README.md` (modified): adds entry #7 for the spec-kit bridge tutorial with the "Recommended adopter authoring path" badge so it shows up alongside the existing six tutorials.
- `backlog/tasks/aisdlc-332 - ...md` → `backlog/completed/aisdlc-332 - ...md`: task closure (frontmatter `status: Done`, ACs ticked, finalSummary populated, `blocked.reason` documents the upstream-OQ-gate override path since RFC-0036 is still `Ready for Review` pending Signed Off — same pattern AISDLC-329/330/331 used to ship).

## Design decisions

- **Use tutorial number 10, skip 09.** The existing tutorials numbered 01-09 are already complete (09-review-calibration.md is the latest). Bumping to 10 keeps the spec-kit-bridge tutorial visually distinct from the platform-core series and leaves room for a future companion "11-adopter-rfc.md" tutorial (RFC-0036 §8 names it as the Phase 7 sibling but it's out of scope for this task per the task scope bullets — only "spec-kit bridge tutorial + getting-started revision" is in scope here).
- **Map every default back to an OQ.** The §"Why these defaults?" table in the tutorial pairs each tutorial section with its source OQ. This is the single largest lift toward AC #5 — a reader who wonders "why does DoR refuse instead of admit-with-warnings?" can jump straight to OQ-3's resolution in RFC-0036 §14.
- **Repositioning the getting-started lede.** The previous opening framed AI-SDLC as "an orchestrator that drives AI coding agents." That's the implementation; the new lede frames it as a "Decision Engine" / "contract-to-shipped half of a spec-driven stack" which matches RFC-0036 OQ-9 (decision-engine primary positioning) and the AISDLC-248 family repositioning. This makes the spec-kit bridge entry point feel like the natural next step instead of an extra surface.
- **Pure docs PR — no code, no CLI changes, no schema bumps.** The bridge surface (`cli-import-spec --from`, `--reconcile`, `--rubric`, `--analyze-metadata`) is already shipped; this task only documents it. The tutorial uses the CLI as it exists and references the OQ resolutions verbatim from the RFC.
- **Do NOT add a Resolution marker to RFC-0036.** All 12 OQs were resolved at the 2026-05-16 operator walkthrough and the RFC §14 already reflects this. The CLAUDE.md AISDLC-298 prohibition on dev-subagent inline OQ resolution wasn't invoked.
- **Companion tutorial 11-adopter-rfc.md deliberately deferred.** RFC-0036 §8 names two adopter-facing tutorials (`N-spec-kit-bridge.md` AND `N-adopter-rfc.md`). Only the spec-kit tutorial is in this task's scope per the AC list; the adopter-RFC tutorial belongs to a future Phase 2 task once `ai-sdlc rfc init` ships.

## Verification

- `pnpm build` — clean (no source files touched)
- `pnpm test` — n/a (pure docs PR; no test changes)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Manual: confirmed the new tutorial's links resolve to existing files (`docs/concepts/spec-driven.md`, RFC-0011, RFC-0035, RFC-0036, tutorials index, `docs/getting-started/README.md`).

## Follow-up

- Future task: `11-adopter-rfc.md` companion tutorial (depends on `ai-sdlc rfc init` shipping — RFC-0036 Phase 2).
- Future task: ai-sdlc-io website mirror of the bridge tutorial (RFC-0036 Phase 8 — operator-driven positioning sweep).
- Future task: per-org translator examples for non-spec-kit upstreams (RFC-0036 Phase 10 / OQ-6) — touched lightly in the troubleshooting section here but doesn't deserve its own tutorial until adopter demand surfaces in the Decision Catalog.
<!-- SECTION:FINAL_SUMMARY:END -->
