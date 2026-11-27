---
id: AISDLC-1457
title: Knowledge store reads and writes carry an optional concurrency token
status: In Progress
priority: medium
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies:
  - AISDLC-1456
references:
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/promote.ts
---

## Description

**Five-step review (requirements first).**
1. Question: DEC-0443 option a (operator, 2026-11-27) includes the enterprise's optional opaque concurrency token: two sessions editing the same entry on a shared server must not silently overwrite each other.
2. Delete: nothing.
3. Simplify: `StoredEntry` gains `version?: string` (opaque); `WriteResult` gains `version?: string`; `write` accepts `expectedVersion?: string`. A backend that supports it returns `status: 'conflict'` (add to the status union) when `expectedVersion` does not match. The files backend may ignore the token (returns no `version`, never `conflict`). The core write helpers in `human.ts` and `promote.ts` pass the version they read; on `conflict` they re-read the entry, re-run their own decision and retry, at most 3 attempts in total, then fail with the conflict reported.
4. Accelerate: none.
5. Automate: a test backend that returns `conflict` once proves the re-read and retry; a second that always conflicts proves the bounded failure.

## Acceptance Criteria
- [ ] #1 `version`, `expectedVersion` and the `conflict` status exist and are documented as optional for backends.
- [ ] #2 Helpers re-read, re-run and retry on `conflict`, max 3 attempts, then fail with the conflict (tests with a stub backend).
- [ ] #3 The files backend's behaviour is unchanged (no version, never conflict).
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
