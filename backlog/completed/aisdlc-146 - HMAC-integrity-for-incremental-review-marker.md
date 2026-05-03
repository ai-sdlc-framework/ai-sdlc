---
id: AISDLC-146
title: HMAC integrity for incremental-review marker (Layer 2 defense-in-depth)
status: Done
assignee: []
created_date: '2026-05-02 18:50'
updated_date: '2026-05-02 18:55'
labels:
  - ci
  - security
  - deps
  - follow-up
dependencies:
  - AISDLC-142
references:
  - pipeline-cli/src/incremental-review/incremental.ts
  - pipeline-cli/src/incremental-review/incremental.test.ts
  - .github/workflows/ai-sdlc-review.yml
priority: medium
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file pipeline-cli/src/incremental-review/incremental.ts was
      modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file pipeline-cli/src/incremental-review/incremental.test.ts
      was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file .github/workflows/ai-sdlc-review.yml was modified after
      task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Layer 2 follow-up to AISDLC-142 round 2 review.** AISDLC-142 shipped with a trusted-author filter (Layer 1) that blocks EXTERNAL contributors from posting forged `<!-- ai-sdlc:last-reviewed-contenthash:... -->` markers. The round-2 reviewer recommended HMAC payload integrity as Layer 2 defense — closing the gap that a malicious-but-trusted COLLABORATOR could otherwise exploit by posting a manual marker with a forged contentHash binding.

## Threat model closed by HMAC layer 2

The AISDLC-142 trusted-author filter (Layer 1) prevents EXTERNAL contributors from posting forged markers — they fail the `authorAssociation in {OWNER, MEMBER, COLLABORATOR}` gate. But a TRUSTED COLLABORATOR could still:

1. Post a marker comment manually with a forged `contentHash` binding the publicly-computable current `contentHashV3`.
2. The marker passes Layer 1 (the collaborator IS in the trusted set).
3. The skip-when-unchanged path then trusts the contentHash, skipping all 3 reviewers.
4. A malicious-but-trusted collaborator could thereby skip review on co-authored PRs.

Layer 2 closes the gap by signing the marker payload with an HMAC-SHA256 key only the bot knows (`MARKER_HMAC_SECRET` GitHub secret). Manual marker comments by trusted authors won't carry the right HMAC and get rejected.

## Wire format

| Version | Format | Use |
|---------|--------|-----|
| v0 (legacy AISDLC-142) | `<!-- ai-sdlc:last-reviewed-contenthash:<base64-json> -->` | Accepted on read for in-flight markers; never written by new code |
| v1 (transition) | `<!-- ai-sdlc:last-reviewed-contenthash:v1:<base64-json> -->` | Written when `MARKER_HMAC_SECRET` is unset; emits `console.warn` on parse |
| v2 (HMAC) | `<!-- ai-sdlc:last-reviewed-contenthash:v2:<base64-json>:<hmac-sha256-hex> -->` | Default when `MARKER_HMAC_SECRET` is set; rejected if HMAC fails |

The HMAC input is the EXACT `JSON.stringify(payload)` string that gets base64'd. The 4th `:`-segment is the lowercase hex digest of HMAC-SHA256 keyed by the secret.

## Acceptance criteria

1. `formatMarker()` accepts v1 + v2; defaults to v2 when env has `MARKER_HMAC_SECRET`, falls back to v1 with a `console.warn` (one-time per process) when missing
2. `parseMarker()` accepts v1 (no HMAC check, deprecation warn) + v2 (HMAC required, rejected on mismatch); also accepts the legacy v0 wire format for transition
3. `findMarkerInComments()` returns null for any marker that fails HMAC validation (forged-marker rejection composes through to the freshest-wins scan)
4. Tests cover: v2 valid HMAC parses; v2 tampered HMAC rejected; v2 payload-tampered + re-signed under DIFFERENT secret rejected; v1 marker parses with warning; missing secret env → formatMarker emits v1 + warns, parseMarker rejects v2; trusted-author v1 marker still respected (transition compat)
5. Workflow YAML changes: add `MARKER_HMAC_SECRET` env to analyze + report jobs; PRIOR_SHA grep updated to handle v1/v2 wire formats; report-job inline JS computes HMAC via `node:crypto.createHmac`
6. PR body documents the operator setup step: `gh secret set MARKER_HMAC_SECRET --body "$(openssl rand -hex 32)"`
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added HMAC-SHA256 wire-format integrity (v2 marker) to the AISDLC-142 incremental-review marker, closing the malicious-but-trusted collaborator gap. v2 markers are signed with `MARKER_HMAC_SECRET` (32+ random bytes via `openssl rand -hex 32`) and verified with `crypto.timingSafeEqual`; v1 markers stay accepted on read with a one-time deprecation warning so in-flight markers don't strand the next push in FULL-review mode. The legacy AISDLC-142 wire format (no `vN:` tag) is also accepted as v1 for transition.

## Changes
- `pipeline-cli/src/incremental-review/incremental.ts` (modified):
  - New `MARKER_HMAC_SECRET_ENV`, `MarkerVersion` exports + module-level warn latch
  - `formatMarker(payload, opts?)`: env-driven version selection (v2 when secret set, v1 otherwise) + explicit override hooks for tests
  - `parseMarker(commentBody, opts?)`: version dispatch (v0/v1/v2), HMAC verification via `crypto.timingSafeEqual`, structural guards on the HMAC segment
  - `findMarkerInComments`/`findTrustedMarkerInComments` thread `opts.secret` through
  - `_resetWarnLatchForTests` test-only helper for deterministic warn-once assertions
- `pipeline-cli/src/incremental-review/incremental.test.ts` (modified): 24 new tests across 4 describe blocks (formatMarker version selection, parseMarker v2 HMAC validation, parseMarker v1 backward-compat, findMarkerInComments HMAC-aware filtering); `beforeEach` resets warn-latch + env between tests
- `pipeline-cli/src/index.ts` (modified): export `MARKER_HMAC_SECRET_ENV` + `MarkerVersion` from package barrel
- `.github/workflows/ai-sdlc-review.yml` (modified):
  - `MARKER_HMAC_SECRET` env added to `incremental` step (analyze job) + `Update incremental-review marker` step (report job)
  - `PRIOR_SHA` grep updated to handle v1/v2 wire formats (awk strips `vN:` prefix and trailing `:<hmac>` segment)
  - Report-job inline JS computes HMAC via `node:crypto.createHmac` and emits v2 when secret is provisioned, v1 + `core.warning` otherwise

## Design decisions
- **HMAC over the JSON string, not the base64**: keeps HMAC input human-decodable for forensic comparison; verifier re-derives the JSON from base64 before HMAC check (single canonical form).
- **Empty-string secret treated as missing**: GitHub Actions evaluates unset secrets to `""`, so `process.env.MARKER_HMAC_SECRET || ''` length-check guards against silently signing a v2 marker with a zero-length key.
- **`timingSafeEqual` for HMAC comparison**: defense against timing-leak attacks even though the HMAC segment is short (64 hex chars).
- **One-time `console.warn` latch**: pre-flight, workflow, and slash-command body all reach into this module repeatedly per push; without the latch, CI logs flood with the same banner. Test-only `_resetWarnLatchForTests` keeps the warn-once assertions deterministic.
- **Throw on `formatMarker({version: 2})` without secret**: refusing to emit an unverifiable marker is safer than silently degrading — every verifier would reject it anyway.
- **Accept legacy v0 wire format as v1**: in-flight markers on PRs that pre-date AISDLC-146 must NOT strand on the next push. Without the silent v0→v1 hop, every such PR would re-run FULL review on the first post-deploy push (mass cost regression).

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1002/1002 pass (73 in `incremental.test.ts`, 24 new for AISDLC-146)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Workflow YAML re-parses via `yaml@2.8.2`; jobs unchanged: `attestation-precheck`, `analyze`, `report`, `post-skip-results`

## Follow-up
- Operator setup (one time): `gh secret set MARKER_HMAC_SECRET --body "$(openssl rand -hex 32)"` so the analyze + report jobs see the secret. Until provisioned, the workflow runs in v1 fallback mode (functional but no HMAC integrity); the operator-facing `core.warning` in the report job makes the gap visible in CI logs.
- Drop v1 acceptance after one or two PR cycles once in-flight markers self-migrate (track via grep over recent PR comments).
<!-- SECTION:FINAL_SUMMARY:END -->
