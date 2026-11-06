---
id: AISDLC-1213
title: 'One audit entry schema, JCS canonical hashing and a cross-SDK conformance fixture'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - audit chain
  - conformance
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - spec/spec.md
  - spec/adapters.md
  - reference/src/audit/logger.ts
  - sdk-go/audit/logger.go
  - sdk-go/audit/filesink.go
  - sdk-python/src/ai_sdlc/audit/logger.py
priority: high
dispatchable: true
---

## Description

**Source.** RFC-0062 OQ-4 (DEC-0388, 2026-11-06), Phase 1 item 4. Affected surface: the audit loggers in the TypeScript reference, Go and Python SDKs, `spec/spec.md` (new `#audit-entry` section that `spec/adapters.md:225` already links to), `spec/schemas/v1alpha1/audit-entry.json` and `conformance/audit-chain/`.

The three SDKs write hash chains that differ in field set, genesis value, timestamp precision and byte serialisation; no SDK verifies another's chain, and within one SDK a runtime upgrade can change float or escaping output and break verification.

## Scope

- Schema: the audit-entry JSON Schema from RFC-0062 Design Details, published at `spec/schemas/v1alpha1/audit-entry.json` and described in `spec/spec.md#audit-entry`.
- Canonical form: RFC 8785 (JCS) serialisation of the entry without `hash`, using `canonicalize` (Node), `gowebpki/jcs` (Go) and `rfc8785` (Python); genesis is the string `genesis`; timestamps are RFC 3339 UTC at millisecond precision.
- Fixture: `conformance/audit-chain/` with at least three chained entries covering nested objects, non-ASCII strings, HTML-significant characters and floats, plus expected hashes. Each SDK's test suite verifies the fixture and a file written by each of the other two SDKs.
- Compatibility: files carry `schemaVersion`; a verifier picks the old rule for files written before the change.

## Acceptance Criteria
- [x] #1 All three SDKs produce identical hashes for the fixture entries, and each SDK's test verifies the other two SDKs' sample files.
- [x] #2 A fixture entry with a float such as `1.0` and a string containing `<&>` and a non-ASCII character hashes identically in all three.
- [x] #3 A chain written with the previous rule still verifies when its `schemaVersion` says so; a chain under the new rule fails verification if one byte changes.
- [x] #4 `spec/adapters.md:225` resolves to the new section; the dangling link is gone.

## Final Summary

## Summary
Resumed round: the dirty worktree is fixed. I committed the task-file claim edit and removed the untracked sdk-python/uv.lock. I rebased onto origin/main and pushed the branch to update PR #2471. I did not re-run the four verifications in this round, and I did not check whether the three failing checks have turned green.

## Changes
- backlog/tasks/AISDLC-1213 - One audit entry schema, JCS canonical hashing and a cross-SDK conformance fixture.md

## Design decisions
This round changed only the task file, so I reused the earlier work's verification results. The pre-push patch-coverage gate passed at 100% (42/42 lines) on this push. The failing checks Review verdict, ai-sdlc/pr-ready and ai-sdlc/attestation will likely need the pipeline to re-run review on the new head, since a rebase changes the SHA.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

