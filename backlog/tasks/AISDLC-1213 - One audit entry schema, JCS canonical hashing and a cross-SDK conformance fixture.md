---
id: AISDLC-1213
title: 'One audit entry schema, JCS canonical hashing and a cross-SDK conformance fixture'
status: In Progress
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
- [ ] #1 All three SDKs produce identical hashes for the fixture entries, and each SDK's test verifies the other two SDKs' sample files.
- [ ] #2 A fixture entry with a float such as `1.0` and a string containing `<&>` and a non-ASCII character hashes identically in all three.
- [ ] #3 A chain written with the previous rule still verifies when its `schemaVersion` says so; a chain under the new rule fails verification if one byte changes.
- [ ] #4 `spec/adapters.md:225` resolves to the new section; the dangling link is gone.
