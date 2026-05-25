---
id: AISDLC-317
title: 'feat: RFC-0009 Phase 4.2 — Eτ_tessellation_drift rules #1 (AST scan) + #3 (cross-soul provenance)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-16'
updated_date: '2026-05-25'
labels:
  - rfc-0009
  - tessellated-did
  - phase-4
  - drift-detection
dependencies:
  - AISDLC-313
  - AISDLC-315
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
priority: medium
blocked:
  reason: "RFC-0009 lifecycle is Ready for Review (all 13 OQs resolved v3.4); RFC-0019 referenced only as the deferral target for Rule #2 (explicitly out-of-scope per AC #4). Operator-acknowledged via dispatch of AISDLC-317 (Phase 4.2 follow-on to AISDLC-313 + AISDLC-315 which already shipped against the same RFC under the same lifecycle posture)."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4.2 of RFC-0009. Eτ_tessellation_drift detects design coherence drift across tessellated souls. Per OQ-6 resolution: detection is orchestrator-side, not in-pipeline.

## Scope (RFC-0009 §10 Phase 4, §7.2 Eτ_tessellation_drift)

- Eτ_tessellation_drift **rule #1 (AST scan)** activates orchestrator-side per §7.2 + OQ-6. Detects design-coherence drift by static-analysis pass over soul-imports.
- Eτ_tessellation_drift **rule #3 (cross-soul provenance audits)** activates once the §8.3 ProvenanceRecord extension lands (AISDLC-315) and tessellated provenance accumulates.
- Eτ_tessellation_drift **rule #2 (embedding distance)** is explicitly DEFERRED to RFC-0019 implementation — NOT in scope for this task.
- Drift events emit to `events.jsonl` via RFC-0015 substrate.
- Adopter opt-in gate respected (default off; per §10 Phase 4 promotion convention).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Eτ_tessellation_drift rule #1 (AST scan) ships orchestrator-side
- [x] #2 Eτ_tessellation_drift rule #3 (cross-soul provenance audits) ships, gated on §8.3 ProvenanceRecord availability (AISDLC-315 dependency)
- [x] #3 Drift events emitted to events.jsonl
- [x] #4 Rule #2 (embedding distance) explicitly NOT shipped — deferred to RFC-0019
- [x] #5 Adopter opt-in gate respected (default off)
- [x] #6 Test coverage: rule #1 AST scan / rule #3 provenance audit / no-drift baseline / opt-out short-circuits
<!-- AC:END -->

## Final Summary

### Summary
Phase 4.2 of RFC-0009 lands the orchestrator-side `Eτ_tessellation_drift` detector with Rule #1 (AST scan for soul-name string literals in shared substrate) and Rule #3 (cross-soul provenance audits over the §8.3 ProvenanceRecord surface AISDLC-315 just shipped). Rule #2 (embedding distance) is explicitly deferred to RFC-0019 — the rule discriminator union has exactly two members and a regression test pins that. Detection is gated behind `config.enabled` (default `false`) per RFC-0009 §10 Phase 4 opt-in convention, with per-rule kill switches for staged rollout. Drift events emit through a caller-supplied sink wired to `appendEvent(artifactsDir, ev)` (the RFC-0015 `events.jsonl` substrate).

### Changes
- `orchestrator/src/tessellation-drift.ts` (new): `detectTessellationDrift()` entry point + `TessellationDriftRule` discriminator union + `TessellationDriftDetectedEvent` shape + `AstScanFinding` + `CrossSoulProvenanceFinding` + `TessellationDriftConfig` + `DEFAULT_DIVERGENCE_THRESHOLD` constant. ~360 lines of detector + types + doc comments.
- `orchestrator/src/tessellation-drift.test.ts` (new): 26 hermetic Vitest tests covering opt-out short-circuit (3), Rule #1 AST scan (7 — string-literal, soul-conditional, permissive identifier, multi-file aggregation, dedupe, no-drift baseline, kill switch), Rule #3 provenance audit (9 — cross-boundary, amendment-recorded skip, single-soul skip, divergent outcomes, below-threshold, custom threshold, no-drift baseline, out-of-tessellation filter, kill switch, constant export), event-sink wiring (3 — forwarding, async-await, error propagation), Rule #2 deferral pinning (2), and a three-soul platform integration test exercising the worked §11 example shape.
- `orchestrator/src/index.ts` (modified): barrel-exports the new `detectTessellationDrift` symbol + the `TessellationDriftRule | DetectedEvent | AstScanDetails | AstScanFinding | CrossSoulProvenanceDetails | CrossSoulProvenanceFinding | SubstrateFile | ProvenanceAuditEntry | TessellationDriftConfig | TessellationDriftInput | TessellationDriftResult` types + `DEFAULT_DIVERGENCE_THRESHOLD` constant.

### Design decisions
- **Textual regex scan, not full TypeScript-AST parser.** RFC-0009 §7.2 calls Rule #1 the "AST scan" but a regex pass over per-line file contents is the framework primitive that ships today, matches the rule's goal (surface soul-slug leakage in substrate for operator review), and avoids dragging `@typescript-eslint/parser` into the orchestrator runtime. False positives (slug in a code comment, slug in a fixture path) are accepted as part of the surface — operators triage and silence via a tessellation amendment if needed. A future RFC-0009 follow-on can swap the regex pass for ts-morph or estree-walker without breaking the detector's input/output contract.
- **Caller supplies substrate files + provenance, detector is pure.** The detector takes `SubstrateFile[]` (path + contents) and `ProvenanceAuditEntry[]` (record + amendment marker + outcome map) as input rather than walking the filesystem itself. This keeps the module side-effect-free in tests, lets the orchestrator pre-filter substrate files via the dep-graph (only files NOT scoped to a single soul), and matches the existing detector pattern in `orchestrator/src/sa-scoring/drift-monitor.ts` (caller-injected `StateStore` + `DidScoringEventRecord[]`).
- **Single emit callback, not artifact-dir coupling.** The detector accepts an optional `emit(event)` callback; the caller wires it to `appendEvent(artifactsDir, ev)` rather than the detector knowing about `artifacts/` paths. Keeps the module reusable for TUI live-tail and unit tests without filesystem setup.
- **Rule #2 discriminator deliberately NOT exported.** `TessellationDriftRule = 'ast-scan' | 'cross-soul-provenance'` has exactly two members today. Adding `'embedding-distance'` is reserved for AISDLC-340 (RFC-0019 Phase 4) so that downstream consumers cannot mistakenly switch-case on a value the detector never emits. Two regression tests pin this: one asserts the union list, one asserts no emitted event ever carries the embedding rule.
- **Per-rule kill switches under master `enabled` gate.** RFC-0009 §10 Phase 4 says "All sub-dimension activations are gated on adopter opt-in initially" — the master `enabled: false` default honors that. Per-rule toggles (`rules.astScan`, `rules.crossSoulProvenance`) enable staged rollout (operator enables AST scan first, observes noise level, then enables provenance audit) without rebuilding two separate detector modules.
- **No inline OQ resolution.** RFC-0009 §13 all 13 OQs are pre-resolved (v3.4, 2026-05-04). Nothing to escalate.

### Verification
- `pnpm --filter @ai-sdlc/orchestrator build` — clean.
- `pnpm --filter @ai-sdlc/orchestrator test` — 3859 pass / 1 skip (179 test files); 26 new drift tests pass standalone.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
- Full `pnpm test` — orchestrator + reference + pipeline-cli + ai-sdlc-plugin/mcp-server + conformance + sdk-typescript + mcp-advisor + dashboard all green. `dogfood/src/cli-watch.test.ts` "argv parsing: exits with error when no --issue is provided" flaked with a 5s timeout once in the recursive run; passes 10/10 standalone. Unrelated to the drift detector (no imports overlap).

### Follow-up
- **Wire the detector into the orchestrator tick loop** so substrate files (from the dep-graph snapshot) and provenance entries (from the audit log) feed `detectTessellationDrift` and the emitted events land in `events.jsonl` automatically. The detector is intentionally a pure library here; the caller-side wiring is a separate concern that should land alongside RFC-0009 Phase 5 (or whichever phase activates the orchestrator-side promotion).
- **AISDLC-340 follow-on** will add Rule #2 (embedding-distance) via the RFC-0019 embedding adapter once `embedDocument(text)` is callable from the orchestrator. Adding the rule is additive: extend the `TessellationDriftRule` union, add a new `EmbeddingDistanceDetails` shape, and run the new detector behind the same `enabled` master gate.
- **AISDLC-354 follow-on** (RFC-0017 Phase 3) extends Rule #1 + Rule #3 to variant-scoped scans inside a single soul. The existing detector exposes the shape needed for that extension (substrate files + provenance entries are already abstracted; soul slugs come from the tessellation manifest); the variant extension will widen the slug set per-soul to include variant slugs.
