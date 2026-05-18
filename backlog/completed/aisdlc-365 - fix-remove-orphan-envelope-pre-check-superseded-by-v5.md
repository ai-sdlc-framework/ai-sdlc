---
id: AISDLC-365
title: 'fix(attestation): remove orphan-envelope pre-check — superseded by V5 (was kicking out parallel PRs from queue)'
status: Done
assignee: []
created_date: '2026-05-18'
labels:
  - attestation
  - merge-queue
  - critical
  - hotfix
dependencies:
  - AISDLC-362
priority: critical
references:
  - scripts/verify-attestation.mjs
---

## Why this is critical

Operator observation 2026-05-18: even after AISDLC-362 (V5) landed, every PR queue probe was still failing with `orphan envelope(s) detected: <hash>.dsse.json`. Whichever PR landed first kicked out all the other parallel PRs from the merge queue.

## Root cause

`scripts/verify-attestation.mjs` had an EARLY orphan-envelope pre-check (line 1031) that ran BEFORE per-envelope V5/V4/V3 resolution:

```js
if (all.length >= 1) {
  const { orphans, total } = detectOrphanEnvelopes(lowerHead, baseSha, repoRoot);
  if (orphans.length > 0) {
    return { status: 'invalid', reason: 'orphan envelope(s) detected: ...' };
  }
}
```

The orphan check uses the envelope filename's SHA (= `subject.digest.sha1` at sign time) and rejects when that SHA can't be found in the rebased commit graph. After ANY queue rebase, the original commit SHA is gone → orphan → hard reject — even when V5 hash matches the rebased HEAD's file content cleanly.

V5 IS the content-bound trust root. An orphan subject SHA is moot if V5 hash matches. The pre-check was firing on every queue rebase, blocking parallel merges. Whichever PR landed first invalidated every other PR's subject SHA via queue-rebase, kicking them all out.

## Fix

Removed the orphan-envelope pre-check entirely. Per-envelope `resolveSubjectShaForEnvelope()` already falls back to `'v5-head'` when subject SHA isn't reachable — it correctly anchors the chore-commit allowlist check on PR HEAD instead of the orphan subject SHA. V5 + the existing fallback provide the trust binding without needing the orphan pre-check.

## Acceptance criteria

- [x] Remove the orphan-envelope `detectOrphanEnvelopes` pre-check at line 1031 of `scripts/verify-attestation.mjs`. Leave the helper function exported (other callers may use it for advisory output).
- [x] Add explanatory comment naming this task + AISDLC-362.
- [ ] Verify all 528/532-style queued PRs no longer get kicked out post-merge of sibling.

## Out of scope

- `detectOrphanEnvelopes` function deletion — keep for potential advisory/cleanup tooling
- Refactoring `resolveSubjectShaForEnvelope` — its existing v5-head fallback is correct
