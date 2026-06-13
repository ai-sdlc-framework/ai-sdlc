---
id: AISDLC-543
title: >-
  fix(orchestrator): eliminate the attestation re-sign races — reconcile signs
  before rebasing, reruns reuse stale event payloads, and the auto-rearm bot
  fights the Conductor's envelopes
status: To Do
assignee: []
labels:
  - orchestrator
  - attestation
  - reconcile
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - pipeline-cli/src/orchestrator/reconcile.ts
  - scripts/verify-attestation.mjs
  - .github/workflows/auto-rebase-open-prs.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-06-12 autonomous drain (8 PRs) hit attestation-verification failures
on 2 of 8 PRs (#909, #912), costing 4 recovery re-signs. Three independent
mechanisms compounded; all are fixable. Evidence: PR #909 (one re-sign) and
PR #912 (three re-signs, including one envelope corrupted to an unparsable
state by conflicting writers).

**Mechanism 1 — reconcile signs BEFORE rebasing.** The `ai-sdlc-pipeline
reconcile` step order is emit-leaves → sign → git-fetch → git-rebase → push.
When origin/main moved after the dev's last rebase, the rebase rewrites the
just-signed subject commit; if the pre-rebase SHA was never pushed (or becomes
unreachable after force-push), CI cannot resolve `subject.sha1`, head-binding
and tree-equivalence both fail, and the verifier falls through to the legacy
path and reports `contentHashV4 mismatch`. Fix: reorder to fetch → rebase →
emit-leaves → sign → push, so the subject is always the SHA that gets pushed.

**Mechanism 2 — workflow reruns reuse stale event payloads.** `gh run rerun`
on a verify-attestation run re-evaluates the ORIGINAL pull_request event
payload. After a bot force-push changed the branch contents, the rerun still
"sees" envelope files from the old payload state and fails on filenames that
no longer exist in the tree (observed: rerun on head cc3c89b complaining about
a 0757093-named envelope absent from that tree). Fix options: have the
verifier resolve the PR head/file list LIVE from the API instead of the event
payload, or document rerun-is-never-valid for this workflow and surface a
"push a fresh synchronize event" remediation in the failure message.

**Mechanism 3 — the auto-rearm/auto-rebase automation and the Conductor fight
over envelopes.** During #912, the automation rebased the branch after a main
landing, re-signed, and committed a `<head-sha>.v6.dsse.json` envelope named
for a head that its own squash then rewrote — leaving a stale-named envelope
that hard-fails the verifier's filename check. A subsequent conflicting write
left the patch-id envelope unparsable. Fix: the bot re-sign path should write
ONLY patch-id-named envelopes (never head-sha-named) per AISDLC-475 Fix B,
drop stale head-sha-named envelopes as part of its rebase (the
`drop-stale-attestation-envelope` logic exists), and take a per-branch
lockfile or `--force-with-lease` failure as a signal to re-read before
re-signing.

The dispatch→merge instrumentation that landed with the profiling work
(`ReconcileCompleted.reSignCount`) should make this class of churn visible in
the corpus aggregator — add a regression assertion that reSignCount stays at
0 for clean drains once these fixes land.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reconcile step order changed to fetch → rebase → emit-leaves → sign → push; hermetic test proves the envelope subject equals the pushed HEAD's parent chain (never an orphaned pre-rebase SHA) when origin/main moved mid-flight
- [ ] #2 Verifier failure message for filename-mismatch states the stale-event-rerun trap and the remediation (fresh synchronize event), OR the verifier resolves PR state live so reruns are valid — one of the two, decided in the PR
- [ ] #3 Automation re-sign path writes only patch-id-named v6 envelopes and removes stale head-sha-named envelopes during its rebase; test covers the squash-after-re-sign sequence observed on PR #912
- [ ] #4 Concurrent-writer protection: a second signer detecting a lease failure or lock re-reads branch state before writing; the corrupted-envelope sequence from #912 is reproduced in a test and no longer corrupts
- [ ] #5 Existing reconcile + verify test suites stay green; a drain-simulation test asserts reSignCount=0 for a clean two-PR concurrent landing
<!-- AC:END -->
