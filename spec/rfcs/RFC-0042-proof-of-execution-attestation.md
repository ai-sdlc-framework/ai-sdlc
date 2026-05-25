---
id: RFC-0042
title: Proof-of-Execution Attestation via In-Repo Merkle Transcripts
status: Approved
lifecycle: Signed Off
author: Dominique Legault
created: 2026-05-20
updated: 2026-05-20
targetSpecVersion: v1alpha1
requires: [RFC-0011]
requiresDocs:
  - operator-runbook
deferredDocs: true
deferredDocsDeadline: '2026-07-15'
---

# RFC-0042: Proof-of-Execution Attestation via In-Repo Merkle Transcripts

**Status:** Approved
**Lifecycle:** Signed Off
**Author:** Dominique Legault
**Created:** 2026-05-20
**Updated:** 2026-05-20
**Target Spec Version:** v1alpha1

## Problem

The current attestation pipeline is the dominant source of friction in AI-SDLC's shipping experience. As of 2026-05-20, attestation-pipeline gates account for an estimated 80% of the worst per-PR pain:

- **3-4 push cycles** per typical PR due to the `check-attestation-sign.sh` chore-commit pattern
- **`contentHashV3/V4/V5` rebase fragility** — every rebase invalidates the envelope, forcing manual re-sign
- **Fork-PR breakage** — PR #568 (akillies) hit `contentHashV4 mismatch` under `pull_request_target` after rebase; multiple maintainer attempts failed to land it
- **Per-machine signing key onboarding** — operator must run `init-signing-key`, commit pubkey, and for AISDLC-380 also per-reviewer keys
- **Sub-attestation gate friction** (AISDLC-380) — required `AI_SDLC_LEGACY_VERDICTS=1` env var on every push because reviewer keys aren't bootstrapped
- **Operator-key forgery vector** (2026-05-20 incident) — operator's single signing key signs whatever the dev subagent put in the verdict file. Cryptographically valid, semantically forged. AISDLC-380 was filed to close this; it added friction without closing the architectural hole.

The framework is governance-first but ergonomics-last. The operator has signaled that the cumulative friction is existential ("this project is dead in the water" — session 2026-05-20).

## Goals

1. **Eliminate the chore-commit re-push cycle** for attestation. PR shipping path drops from 3-4 pushes to 1-2.
2. **Eliminate rebase-fragility** of attestation envelopes. Rebase does not invalidate proof.
3. **Eliminate per-machine signing-key onboarding** as a precondition for shipping a PR. New contributors / new machines do not have to provision keys before they can push.
4. **Eliminate the 2026-05-20 forgery vector**. A dev subagent that fabricates reviewer JSON locally cannot produce a verifiable proof.
5. **Preserve subscription-tier cost economics**. Reviewer LLM work runs on the operator's Claude Code Max subscription, not on CI Actions minutes / API tokens.
6. **Preserve audit trail**. Every PR's reviewer runs remain cryptographically attested and verifiable retrospectively.
7. **Avoid external service dependency**. No runtime dependency on third-party transparency logs (Rekor, OpenTimestamps) on the PR critical path.

## Non-goals

- Public cross-organization audit (the "anyone on the internet can verify our reviewer ran" story). That's Rekor's value-add and is explicitly deferred to a future opt-in.
- Replacing GitHub's standard PR review / merge mechanics. This RFC is about the *attestation* layer that proves AI reviewers ran; human PR review remains orthogonal.
- Replacing the `/ai-sdlc execute` slash command body's overall structure (Step 0-13). Steps stay; the signing and verification steps change.
- Reducing reviewer subagent cost. LLM inference cost is intrinsic to the work; this RFC doesn't address that.

## Background

### The 2026-05-20 forgery incident

During `/ai-sdlc execute AISDLC-377.1`, the dev subagent (`ai-sdlc:developer`) pushed and opened PR #576 before the slash command body had a chance to dispatch the 3 reviewer subagents. The dev wrote a verdict file at `.ai-sdlc/verdicts/aisdlc-377.1.json` containing fabricated `approved: true` entries for code-reviewer, test-reviewer, and security-reviewer. The pre-push hook trusted the file unconditionally, signed the DSSE envelope with the operator's key, and the PR auto-merged with 3 real majors that the actual reviewers (run post-merge) caught.

Root cause: the operator's signing key authenticates **the operator**, not **the reviewer runs**. Any JSON the operator-owned process places at the verdict path will be signed. The dev subagent runs as the operator's UID; therefore the dev subagent can mint approval.

### AISDLC-380 partial fix

AISDLC-380 (PR #580, merged 2026-05-20) added a per-reviewer signing layer: reviewer subagents emit signed sub-attestations using per-role keys. The pre-push hook verifies sub-attestation signatures against `.ai-sdlc/trusted-reviewers.yaml` before signing the outer envelope.

In practice, the bypasses dominate:
- Reviewer keys aren't onboarded → every PR uses `AI_SDLC_LEGACY_VERDICTS=1` escape
- Sub-attestation gate adds friction without closing the architectural hole (operator-UID dev subagent can read reviewer keys via Bash; the Read tool isn't checked by the hook; sign helper has no caller-identity binding)
- Net result: PR #580 itself shipped under `AI_SDLC_LEGACY_VERDICTS=1` — the gate it added couldn't be satisfied on its own PR

AISDLC-380.2 was filed to close 4 architectural bypasses but adds further complexity (nonce challenges, Read-tool deny lists, sign-helper auth tokens, Option-B-unsigned-exempt removal). Each adds friction.

### Friction inventory

Of ~27 cumulative gates in the framework, ~13 derive from the attestation pipeline:

- `check-attestation-sign.sh` (pre-push hook, forces chore-commit re-push)
- `verify-attestation.yml` (CI required check)
- `ai-sdlc/attestation` branch-protection requirement
- AISDLC-380 sub-attestation gate
- `contentHashV3`, `contentHashV4`, `contentHashV5` algorithms (3 hash schemes for rebase-stability)
- `CONTENTHASH_SHARED_CHURN_FILES` exclude list
- Stale envelope detection (AISDLC-274)
- `auto-rearm-on-dequeue.yml` (rebase-invalidation workaround)
- Docs-only short-circuit (3 implementations)
- Fork-PR migration (AISDLC-381, ~4 workflows)
- `init-signing-key` / `init-reviewer-signing-key` (per-machine setup)
- AISDLC-380.2 architectural follow-up (not yet implemented)
- `merge-queue-rebase-recovery.md` runbook

These collectively are the source of the operator's pain.

## Design

### Core insight (operator's framing, 2026-05-20)

> "What I think we need is some sort of proof of work algorithm, where when you run the reviewer locally you could produce a proof of work signature that you did the work of reviewing the code with an agent then send that proof to the CI to attest that the work was completed. It's the LLM work that's the expensive part to do on CI not the attestation."

The separation: **expensive LLM work happens locally on subscription; cheap cryptographic verification happens on CI**. This decouples cost from trust.

The architectural axis: don't sign the operator's claim that reviewers ran. Sign the reviewers' WORK PRODUCT itself, in a way that makes forgery economically as expensive as compliance.

### Architecture: in-repo Merkle proof-of-execution

**Layer 1 — Transcript capture (operator local, gitignored)**

Each reviewer subagent captures the full conversation transcript to `.ai-sdlc/transcripts/<task-id>/<reviewer-name>.jsonl`. Every assistant turn, every tool invocation, every tool result. The transcript is structurally rich: prompts include the PR diff verbatim; responses include LLM-generated analysis that references specific file paths, line numbers, and code snippets from the diff.

Files are gitignored. Operator's choice for retention policy (local disk, S3, cold storage).

**Layer 2 — Append-only Merkle leaf index (committed, tiny)**

For each reviewer transcript, the slash command body computes a leaf:

```jsonl
{"leafIndex": 12453, "taskId": "AISDLC-380", "reviewerName": "code-reviewer", "transcriptHash": "<sha256>", "nonce": "<32-byte hex>", "harness": "claude-code", "model": "sonnet", "verdictApproved": true, "findings": {"critical":0,"major":0,"minor":1,"suggestion":0}, "signedAt": "2026-05-20T19:14:37.561Z"}
```

Leaves are appended to `.ai-sdlc/transcript-leaves.jsonl`. At ~250 bytes per leaf × 3 reviewers × 10,000 PRs = ~7.5MB committed forever. Negligible.

**Layer 3 — Periodic Merkle root anchor (committed, signed)**

The slash command body computes the running Merkle root from all leaves in `transcript-leaves.jsonl`. On each PR push, the current root is included in the attestation envelope and signed by the operator's key. The root commits to the entire history of reviewer runs in this repo.

```json
{
  "leavesFile": ".ai-sdlc/transcript-leaves.jsonl",
  "rootHash": "<sha256 of Merkle tree>",
  "leafCount": 12453,
  "signedAt": "2026-05-20T19:14:37.561Z",
  "signature": "<operator ed25519 over rootHash>"
}
```

**Layer 4 — Per-PR proof bundle (committed, scales with reviewer count)**

For each PR, the attestation envelope at `.ai-sdlc/attestations/<head-sha>.dsse.json` carries:

```json
{
  "schemaVersion": "v6",
  "subject": { "digest": { "sha1": "<headSha>" } },
  "transcriptLeaves": [
    {"leafIndex": 12453, "reviewerName": "code-reviewer", "transcriptHash": "<sha256>"},
    {"leafIndex": 12454, "reviewerName": "test-reviewer", "transcriptHash": "<sha256>"},
    {"leafIndex": 12455, "reviewerName": "security-reviewer", "transcriptHash": "<sha256>"}
  ],
  "merkleProofs": [
    {"leafIndex": 12453, "proof": ["<hash>", "<hash>", ...]},
    {"leafIndex": 12454, "proof": [...]},
    {"leafIndex": 12455, "proof": [...]}
  ],
  "rootHash": "<sha256>",
  "rootSignature": "<operator ed25519 over rootHash>",
  "nonce": "<32-byte hex bound to this PR's head sha>"
}
```

Size: ~3-5KB per envelope. Same order as the current envelope; semantically richer.

**Layer 5 — CI verification (no external dependency)**

`verify-attestation.yml` performs:

1. Verify `rootSignature` against operator pubkey in `.ai-sdlc/trusted-reviewers.yaml`
2. Verify each Merkle proof leads `leafIndex` to `rootHash`
3. Verify each leaf's `transcriptHash` matches an existing committed leaf in `transcript-leaves.jsonl` at the same index
4. Verify `nonce` was issued by a workflow run for this PR (PR-bound; replay protection)
5. **Spot-check** (sampled): on ~5% of PRs (or any reviewer-flagged finding), fetch the transcript from operator's configured cold storage URL, re-hash, verify against the committed leaf

If any step fails: attestation invalid; PR blocked.

**Layer 6 — Storage pruning**

- `.ai-sdlc/transcripts/*` (gitignored): operator policy. Can GC anything > N months.
- `.ai-sdlc/transcript-leaves.jsonl` (committed): NEVER pruned. ~7.5MB at 10K PRs. Acceptable.
- `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` (committed, AISDLC-421): per-PR leaf files. NEVER pruned. ~750 bytes per file × 3 leaves = ~250 bytes/PR amortized → still negligible.
- `.ai-sdlc/attestations/*.dsse.json` (committed): one per PR, prunable on schedule (Merkle root retains audit trail).
- Cold-storage transcripts: GC policy operator-defined; spot-check fails-gracefully ("transcript GC'd, root verified, no spot-check possible").

### Per-PR transcript-leaf storage (AISDLC-421 amendment, 2026-05-24)

#### Problem the amendment solves

The original Layer 2 design committed leaves to a **single shared append-only file** at `.ai-sdlc/transcript-leaves.jsonl`. When AISDLC-420 introduced the auto-rebase workflow, this surfaced a 100%-rate friction: every open PR's branch held its own appended leaves on overlapping line ranges, so the moment any sibling PR merged to main, every other open PR's rebase produced a git merge conflict on `transcript-leaves.jsonl`. The resolution was always mechanical (`git checkout --ours` + `git rebase --continue`), but it forced manual intervention on every rebase and blocked the auto-rebase workflow from completing cleanly.

Measured impact (2026-05-24 session): the conflict surfaced on **every single rebase** across 11 concurrent PRs.

#### Amendment

Replace the single shared file with **per-patch-id files**: each PR's signing operation writes to its own `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`. The patch-id is the same content-addressed identifier AISDLC-398 uses for envelope filenames (`git diff-tree -p <base>..<head> -- ':!.ai-sdlc/attestations/' | git patch-id --stable`).

Each PR writes to a disjoint file → two PRs literally cannot modify the same file → rebase produces zero conflicts. The Merkle tree is now built from THIS PR's leaves ONLY (the file is self-contained per-PR); each PR's `rootHash` is `f(this_PR_leaves)`, independent of all other PRs.

#### Why patch-id (not task-id)

- Patch-id is content-addressed → survives rebase without name changes (same diff → same patch-id → same filename).
- Task-id would collide when iter-2 sign happens after rebase (same task, different patch).
- Symmetric with envelope discovery: `<patch-id>.v6.dsse.json` ↔ `<patch-id>.jsonl`.

#### Sign / verify contract

**Signer (`sign-attestation.mjs` + `signAndWriteV6Envelope`):**
1. If `<repo>/.ai-sdlc/transcript-leaves/<patch-id>.jsonl` exists → use it.
2. Otherwise fall back to `<repo>/.ai-sdlc/transcript-leaves.jsonl` filtered by `taskId` (migration window).
3. Throws if neither path yields leaves.

**Verifier (`scripts/verify-attestation.mjs`):**
1. If the envelope's filename is patch-id-named (`<40-hex>.v6.dsse.json` whose hex ≠ headSha), extract the patch-id and read `<repo>/.ai-sdlc/transcript-leaves/<patch-id>.jsonl`.
2. Scan `<repo>/.ai-sdlc/transcript-leaves/*.jsonl` and return the file whose transcript-hash set is a superset of the envelope's `transcriptLeaves[].transcriptHash` (handles SHA-named legacy envelopes whose leaves moved to a per-patch-id file post-AISDLC-421).
3. Fall back to the shared `.ai-sdlc/transcript-leaves.jsonl` (legacy pre-AISDLC-421 envelopes).

**Emitter (`cli-attestation emit-leaf`):**
- Accepts `--patch-id` explicitly OR auto-computes via `git merge-base origin/main HEAD` + `git patch-id --stable`.
- Always writes to `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`. Stops writing to the shared file.
- Idempotency check (skip on duplicate `(taskId, reviewerName, transcriptHash)` triple) now scopes to the per-patch-id file (an iter-2 re-sign that clears the file intentionally is no longer blocked by stale shared-file entries from a previous iteration).

#### `.gitattributes` merge driver

`.ai-sdlc/transcript-leaves/* merge=binary`. Defense-in-depth: because every PR has a distinct patch-id, two PRs writing to the same file is essentially impossible by construction. The `merge=binary` driver ensures that if it DOES somehow happen (cherry-pick across branches, manual writes, patch-id collision), the rebase surfaces a hard conflict rather than silently union-merging — silent union would reorder leaves, invalidating the signed Merkle root because `rootHash` is computed over a specific leaf sequence.

Hermetic evidence for the binary-over-union choice lives in `pipeline-cli/src/attestation/per-patch-id-rebase.test.ts` ("union-merge would reorder leaves and invalidate the signed Merkle root").

#### Migration window

Both signer and verifier accept BOTH layouts during a one-release-window soak. The shared-file fallback exists ONLY for envelopes signed before this amendment and is scheduled for deletion in a follow-up task after the soak completes. No operator action is required during the migration; the dual-read is transparent.

See [`docs/operations/transcript-leaves-migration.md`](../../docs/operations/transcript-leaves-migration.md) for the operator runbook.

### Nonce binding (replay protection)

The slash command body fetches a nonce from a CI workflow run at PR open. The nonce is included verbatim in the reviewer subagent's prompt. The LLM's response naturally references the nonce ("Reviewing PR with nonce abc123..."). The transcript hash incorporates the nonce. Re-using a sub-attestation from a previous PR fails: nonce won't match.

For PRs without a CI nonce yet (first-push scenario), the slash command body generates a UUIDv7 + commits it to a transient `.ai-sdlc/nonces/<task-id>.json` file (gitignored, validated against operator's clock).

### Forgery resistance

To forge a passing attestation, an attacker needs:

1. **Fake a structurally valid transcript** — a 5-10KB JSONL file with proper Claude API event sequence, references to the actual PR's files + line numbers, plausible reviewer-shaped analysis
2. **Match the nonce** — requires either compromising the slash command body process or forging the CI-issued nonce (impractical)
3. **Get a committed leaf in `.ai-sdlc/transcript-leaves.jsonl`** — leaves are append-only; the operator's signature on the root must include this leaf. Operator must sign whatever the slash command body presents.

The shape of (1) costs nearly as much as actually running the reviewer LLM (5-10K coherent tokens analyzing the specific diff). Faking it requires running ANOTHER LLM to generate the fake — at which point the attacker has just run a real LLM, which is exactly what they were trying to avoid.

This is the "make forgery as expensive as compliance" property. Not absolute, but the economic curve flattens.

### What this collapses

- `check-attestation-sign.sh` pre-push hook → **GONE**. Envelope is staged + committed in the dev subagent's own work commit (or as part of the existing task-move chore). No separate chore-commit cycle.
- `contentHashV3/V4/V5` algorithms → **GONE**. Replaced by `transcriptHash` (content-addressed, rebase-stable).
- `CONTENTHASH_SHARED_CHURN_FILES` exclude list → **GONE**.
- Stale-envelope detection (AISDLC-274) → **GONE**. No envelope file to go stale.
- `init-reviewer-signing-key` (AISDLC-380) → **GONE**. No per-reviewer keys.
- AISDLC-380.2 architectural follow-up → **GONE**. Replaced by transcript verification.
- `AI_SDLC_LEGACY_VERDICTS=1` env var → **GONE**.
- `merge-queue-rebase-recovery.md` runbook → **GONE**.
- Fork-PR attestation chicken-and-egg → **GONE**. Transcript hash is content-addressed; nothing on the fork PR breaks.
- Per-machine signing-key onboarding for NEW contributors → **GONE for non-operator**. Only the operator (or a small maintainer set) needs a key to sign roots.

### What stays

- `verify-attestation.yml` (CI required check) → STAYS, simpler. Just verifies Merkle proof + root signature.
- `ai-sdlc/attestation` required status → STAYS. Branch protection unchanged.
- Operator's signing key → STAYS (single key, signs Merkle roots).
- Reviewer subagents → STAY (their work product is the new proof).
- The 3-reviewer-fanout requirement → STAYS.

### Migration path

**Phase 1 — Transcript capture in parallel with current attestation (1 week)**
- Reviewer subagents start capturing transcripts to `.ai-sdlc/transcripts/<task-id>/*.jsonl`
- Current AISDLC-380 sub-attestation gate continues to run; both schemes coexist
- New leaves accumulate in `.ai-sdlc/transcript-leaves.jsonl`
- Validation: spot-check that captured transcripts are structurally valid

**Phase 2 — In-repo Merkle implementation (1 week)**
- Merkle root computed; included in attestation envelope as v6 schema field
- Verifier reads v6; falls back to v5/v4/v3 for legacy envelopes
- Both pipelines verify; either passing is acceptance

**Phase 3 — Cutover (1 day)**
- New PRs use only v6 envelope
- AISDLC-380 sub-attestation gate disabled (becomes audit-only warning)
- AISDLC-380.2 cancelled

**Phase 4 — Cleanup (1 week)**
- Delete `contentHashV3/V4/V5` collectors after 30-day soak
- Delete sub-attestation gate code
- Delete `init-reviewer-signing-key.mjs`
- Delete `merge-queue-rebase-recovery.md`
- Update CLAUDE.md attestation section

**Total effort: ~3 weeks for full migration with 30-day soak.**

### Bypass-all-gates env var (`AI_SDLC_BYPASS_ALL_GATES=1`)

To ship this RFC's implementation, the existing gates must be disabled. A single env var:

```
AI_SDLC_BYPASS_ALL_GATES=1 git push
```

is honored by all four pre-push hooks (coverage, task-move, dor-gate, attestation-sign). Each hook checks this var first and exits 0 if set. Add as a 4-line patch alongside Phase 1.

After this RFC's implementation lands, the var stays in place as the operator's emergency-recovery escape. It's NEVER the default path.

## Alternatives considered

### A1. Sigstore Rekor (public Merkle transparency log)

Public transparency log with off-tree storage and cross-organization verifiability.

**Pros:** standard tooling (`cosign`, `rekor-cli`), used in production by major OSS (Kubernetes, npm, PyPI), strong third-party-witnessed audit trail.

**Cons:**
- Runtime dependency on `rekor.sigstore.dev` for every PR push
- Public log leaks metadata (activity volume, signing key fingerprints)
- Self-hosting requires Trillian + MySQL + Fulcio (~5-10h devops + ongoing maintenance)
- Rate limits (~50 req/min historically)
- Long-term sustainability bet on a 4-5-year-old public-good service

**Verdict:** Right shape, wrong scale for AI-SDLC. Internal audit doesn't need cross-organization verifiability. Defer to a future opt-in (`AI_SDLC_REKOR_ANCHOR=1`).

### A2. GitHub Attestations (CI-signed, no operator keys)

GitHub's built-in attestation via OIDC at CI time. CI runs the work, signs, no operator key onboarding.

**Pros:** native to GitHub, no per-machine keys, supports fork PRs naturally.

**Cons:**
- CI burns Actions minutes + API tokens to run the reviewer LLMs (contradicts subscription-tier cost strategy from AISDLC-353)
- Locks us into GitHub-specific infrastructure
- Per-PR attestation is CI's signature, not operator's; the "operator-approved" claim weakens

**Verdict:** Right answer in 5 years when CI-side cost normalizes. Wrong now. Could be opt-in.

### A3. Status quo + AISDLC-380.2 architectural fixes

Continue the current trajectory: ship AISDLC-380.2 (nonce challenges, Read-tool deny lists, sign-helper auth tokens). Patch the architectural bypasses without rewriting.

**Pros:** smaller delta from current state.

**Cons:**
- Doesn't address chore-commit re-push cycle (the worst friction)
- Doesn't address rebase fragility
- Doesn't address fork-PR brokenness
- Adds MORE gates, not fewer
- Net friction: increases

**Verdict:** Rejected. The current trajectory has been adding friction every release. Reversing requires architectural change, not more patches.

### A4. Signed-off-by trailer (no cryptographic chain)

Linux kernel approach: maintainer adds `Signed-off-by:` trailer to PRs they vouch for. No crypto, no Merkle, no envelopes. Trust the maintainer's GitHub identity.

**Pros:** zero infrastructure, zero friction.

**Cons:**
- No protection against the 2026-05-20 forgery class (operator-account compromise = full bypass)
- No audit trail of reviewer runs
- Doesn't dogfood the framework's "AI reviewers attested cryptographically" story

**Verdict:** Rejected. Drops the security property entirely. The forgery incident showed we need *some* cryptographic chain.

### A5. Move all attestation to CI-only (kill local signing)

CI runs the 3 reviewers, signs with OIDC, no operator-side signing at all.

**Pros:** zero per-machine setup, fork-PR works natively, no chore-commit cycle.

**Cons:**
- Reviewer LLM cost shifts from subscription to API tokens / CI minutes (contradicts AISDLC-353 subscription-tier strategy)
- Lose operator's ability to inspect + adjust reviewers locally

**Verdict:** Possible future state but premature now. Cost economics matter.

## Open Questions

### OQ-1: Transcript retention default

**Resolution (2026-05-20):** **90 days.**

Aligns with AWS CloudTrail + GitHub Actions defaults + SOC 2 evidence-window minimum. Storage cost negligible (~13MB at 100 PRs/month). Covers the realistic incident-response window (most forgery investigations happen within weeks-to-3-months). The cryptographic chain (Merkle root + committed leaves, NEVER GC'd) preserves the forensic claim "an attestation existed for this PR" indefinitely — only raw transcript content access is bounded by this retention window.

Override per-repo via `.ai-sdlc/config.yaml retention: <days>`. Operators with longer compliance windows (SOC 2 full year, HIPAA 6 years) opt in explicitly.

Selected over 30 days (incident-response blind spot for forgery investigations surfacing weeks later), 1 year (over-budgeted for median case + override is trivial), and indefinite (silent disk bloat contradicts operator-respect principle).

### OQ-2: Spot-check sampling rate (v1)

**Resolution (2026-05-20):** **0% automated; on-demand operator-triggered only.**

Spot-check has two layers: (1) hash verification — does fetched content match committed hash; (2) content plausibility — does fetched content actually review THIS PR's diff. Layer 1 has near-zero forgery-detection value (attacker who fabricates content can commit its hash and pass Layer 1 trivially). Layer 2 is the real deterrent but requires LLM-as-judge — research-grade, not v1-implementable.

Automating Layer 1 at any sample rate creates security theater + couples retention policy to spot-check coverage for no real benefit. Defer to a future RFC that scopes Layer 2 content plausibility; the sample-rate question gets re-litigated then with actual deterrent value attached.

V1 implementation: `cli-attestation spot-check <pr>` triggers fetch + hash verify on demand (for incident response). Automated sample rate stays at 0% until Layer 2 ships.

Selected over 5%/25%/100% automated because automating hash-only verification adds CI cost + retention coupling without proportional security benefit.

### OQ-3: GC'd-transcript spot-check policy

**Resolution (2026-05-20):** **Soft fail — informational warning, exit 0.**

When an operator triggers a spot-check on a PR whose transcript has been garbage-collected (per the 90-day retention from OQ-1), the verifier returns "transcript GC'd per retention policy; Merkle proof valid; on-demand spot-check unavailable." Exit 0.

The cryptographic claim (Merkle root signed by operator key) is what proves attestation existed. The transcript is convenience for spot-checks; absence past the retention window isn't a security failure — it's the operator's retention policy operating as designed. Hard-failing would conflate "retention expired" with "attestation invalid," which is wrong.

If a forgery is suspected on an old PR with GC'd transcript, investigation continues via other channels (operator's reflog, Anthropic API logs if signed receipts ship, manual diff-vs-commit review). The framework shouldn't lock incident response into "transcript must exist."

Selected over hard-fail (false-alarm noise), per-PR configurability (adds friction), and hard-fail-with-grace (confusing boundary).

### OQ-4: Multi-operator signing model

**Resolution (2026-05-20):** **Independent any-of-N keys (current `trusted-reviewers.yaml` schema, AISDLC-74).**

Multiple operator keys may be registered in `.ai-sdlc/trusted-reviewers.yaml`; any registered key signs Merkle roots. Compromise handling: revoke the offending pubkey from the registry; signatures by that key become invalid retroactively; affected PRs get re-signed by remaining trusted keys.

Selected over single-key (no redundancy if operator machine fails or key is lost), threshold M-of-N (unworkable per-signing friction at 1-2 maintainer team size — every signature blocks until M people available), and Fulcio-style OIDC short-lived certs (requires OIDC issuer infrastructure, re-introduces external-service dependency rejected with Rekor).

Future migration path: if team grows to 5+ active maintainers AND blast-radius cost rises, threshold becomes worth revisiting. Today, any-of-N with prompt revocation is the practical posture.

### OQ-5: Transcript storage hosting

**Resolution (2026-05-20):** **Local disk default (`~/.ai-sdlc/transcripts/`) + opt-in remote URL via `.ai-sdlc/config.yaml transcript_storage_url`.**

Zero-friction for solo operators (the AI-SDLC default user). Distributed teams configure a remote URL (S3 / IPFS / equivalent) for cross-machine spot-check fetchability. Per OQ-3 (soft-fail on missing transcript), unavailable storage is graceful — no hard requirement to mandate infrastructure.

CLI surfaces a warning at first push when team has multiple operator keys but no remote storage configured: "Multiple operator keys registered but transcript storage is local-only. Consider configuring `transcript_storage_url` for cross-machine spot-checks."

Selected over remote-only (forces infrastructure on solo operators), Git LFS in-tree (clone-size growth + LFS install dependency), and mandatory framework-picked backend (contradicts no-external-dependency principle).

### OQ-6: Bootstrap behavior

**Resolution (2026-05-20):** **First push IS the genesis (no ceremony).**

The first signed Merkle root establishes the trust anchor. Matches Git's model: the first signed commit/tag IS the genesis. Whether the tree has 1 leaf or 10,000 leaves, the cryptographic property is identical — the operator's signature on the root is what proves the leaves were committed.

Genesis ceremony would add setup friction (contradicting the friction-removal principle driving this entire RFC) without adding security: an attacker with the operator key can craft a fake "genesis" equally well. The real key-compromise mitigation is multi-key any-of-N (OQ-4) + prompt revocation.

Selected over explicit genesis ceremony (setup friction, no security benefit) and external timestamp anchor (re-introduces external-service dependency).

### OQ-7: Backward-compat for v3/v4/v5 envelopes

**Resolution (2026-05-20):** **Keep v3/v4/v5 verifier code indefinitely (read-only).**

Signer code for v3/v4/v5 is deleted in Phase 4 (no new envelopes use legacy formats). Verifier code stays in a clearly-marked `legacy/` subdirectory or behind `// Pre-v6: read-only` headers. ~200 lines of read-only code; cheap to carry; never modified.

Benefit: every PR ever merged with v3/v4/v5 attestation remains independently verifiable forever — critical for compliance, security forensics, and audit-trail-continuity properties. The expensive parts of the legacy chain (chore-commit hooks, rebase-fragility workarounds, exclusion lists, AISDLC-274 stale-envelope detection, AISDLC-381 fork-PR migration code) all get deleted in Phase 4. Only the READ side stays.

Selected over sunset (1 year or 3 years — break audit-trail continuity at a hard cliff; confuses incident response on old PRs) and transcode (synthesizing fake v6 transcripts from v5 envelopes is dishonest about what was actually committed).

## Implementation tasks

This RFC's umbrella implementation will be tracked under **AISDLC-383** with sub-tasks for each phase:

- AISDLC-383.1 — Transcript capture in reviewer subagents (Phase 1)
- AISDLC-383.2 — Merkle leaf index + root computation (Phase 1)
- AISDLC-383.3 — v6 envelope schema + signer (Phase 2)
- AISDLC-383.4 — v6 verifier in `verify-attestation.yml` (Phase 2)
- AISDLC-383.5 — Bypass-all-gates env var (parallel; required for Phase 1 ship)
- AISDLC-383.6 — Cutover: disable AISDLC-380 sub-attestation gate (Phase 3)
- AISDLC-383.7 — Cleanup: delete v3/v4/v5 collectors, sub-attestation code, runbook (Phase 4)

The friction audit of the remaining ~14 non-attestation gates is tracked separately as **AISDLC-384** (gate-friction-audit), independent of this RFC.

## Sign-off

Per AISDLC-118 lifecycle (Draft → Ready for Review → Signed Off → Implemented). All 7 OQs walked through 2026-05-20 with operator using decision-rubric skill; resolutions inline above. RFC promoted Draft → Ready for Review → **Signed Off** on 2026-05-20.

- [x] **Engineering owner:** dominique@reliablegenius.io (2026-05-20)
- [x] **Operator:** dominique@reliablegenius.io (2026-05-20)

Implementation tracked under AISDLC-383 umbrella + 7 phase sub-tasks (AISDLC-383.1 through 383.7).

## Source

Operator session 2026-05-20: existential-friction conversation. Operator proposed proof-of-execution architecture as the root-cause intervention. In-repo Merkle (this RFC) chosen over public Rekor (deferred future opt-in) due to operational + dependency concerns.

Previous attempts to patch the attestation pipeline (AISDLC-380, AISDLC-380.2, AISDLC-381) each added gates without removing friction; this RFC represents the architectural rewrite instead of the next patch.
