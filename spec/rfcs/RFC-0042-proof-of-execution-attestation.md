---
id: RFC-0042
title: Proof-of-Execution Attestation via In-Repo Merkle Transcripts
status: Draft
lifecycle: Draft
author: Dominique Demers
created: 2026-05-20
updated: 2026-05-20
targetSpecVersion: v1alpha1
requires: [RFC-0011]
requiresDocs: [operator-runbook]
---

# RFC-0042: Proof-of-Execution Attestation via In-Repo Merkle Transcripts

**Status:** Draft
**Lifecycle:** Draft
**Author:** Dominique Demers
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
- `.ai-sdlc/attestations/*.dsse.json` (committed): one per PR, prunable on schedule (Merkle root retains audit trail).
- Cold-storage transcripts: GC policy operator-defined; spot-check fails-gracefully ("transcript GC'd, root verified, no spot-check possible").

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

How long should the operator's local transcripts be retained by default?

- 30 days — small disk footprint, spot-checks only work for recent PRs
- 90 days — moderate footprint, covers most "post-merge audit" use cases
- 1 year — large footprint, covers retrospective compliance audits
- Indefinite — let the operator GC; framework doesn't impose

**No default chosen.** Operator decides per-repo via `.ai-sdlc/config.yaml`.

### OQ-2: Spot-check sampling rate

What fraction of PRs should CI spot-check (re-hash the transcript against the committed leaf)?

- 5% — minimal CI cost, statistically detects systematic forgery
- 25% — significant deterrent, moderate CI cost
- 100% (every PR) — full enforcement, requires transcript always available, defeats the storage-pruning benefit

**No default chosen.** Recommend starting at 25% during cutover, dropping to 5% after 90 days of clean operation.

### OQ-3: Transcript availability requirement for old PRs

If an old PR's transcript has been GC'd and a spot-check is needed (e.g. forensic audit), what's the policy?

- Soft fail (warning) — root + leaves preserve cryptographic audit; content access is best-effort
- Hard fail (revoke PR's attestation status) — pressure operators to retain transcripts longer

**Lean: soft fail.** Cryptographic audit (root + leaves) is the durable claim; transcript content is convenience.

### OQ-4: Multi-operator (multi-maintainer) signing

If multiple maintainers can sign roots, how is operator-key compromise handled?

- Single operator key (current) — simpler, single point of failure
- Threshold signature (M-of-N) — more complex, no single point of failure
- Multiple independent operator keys, any-of-N (current AISDLC-74 model) — simple, any key compromise = invalidate that key's signed roots

**Lean: keep any-of-N (current model).** Threshold signatures are over-engineering for current team size.

### OQ-5: Storage hosting for transcripts

Where do operators store transcripts for spot-check fetchability?

- Local disk only (operator-managed) — no infrastructure
- Repo-configured S3 bucket — adds AWS dep but standard
- Git LFS — keeps in-tree but bloats clone size
- IPFS / Sigstore artifact store — decentralized

**Lean: local disk + configurable URL.** Default to `~/.ai-sdlc/transcripts/` with optional remote URL for distributed teams.

### OQ-6: Bootstrap behavior

The first reviewer transcript in a fresh repo has no prior leaves. What does verification do?

- Accept any signed root with leafCount > 0 — assume operator's intent
- Require a "genesis" leaf manually committed by the operator — explicit bootstrap step

**Lean: accept any signed root.** No genesis ceremony; the operator's first push IS the genesis.

### OQ-7: Migration from existing AISDLC-380 envelopes

Existing envelopes use schemaVersion v5. After v6 ships, do v5 envelopes remain verifiable indefinitely?

- Yes — v5 verifier code stays in `verify-attestation.mjs` permanently
- No — v5 sunsets 1 year post-cutover; old PRs grandfather under "merge-time was valid"

**Lean: keep v5 verifier indefinitely.** Cost of maintaining backward-compat is small; benefit of "every historical PR is still verifiable" is real.

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

Per AISDLC-118 lifecycle (Draft → Ready for Review → Signed Off → Implemented). This RFC is currently in Draft.

- [ ] **Engineering owner:** dominique@reliablegenius.io
- [ ] **Operator:** dominique@reliablegenius.io

Sign-off pending operator walkthrough of OQs.

## Source

Operator session 2026-05-20: existential-friction conversation. Operator proposed proof-of-execution architecture as the root-cause intervention. In-repo Merkle (this RFC) chosen over public Rekor (deferred future opt-in) due to operational + dependency concerns.

Previous attempts to patch the attestation pipeline (AISDLC-380, AISDLC-380.2, AISDLC-381) each added gates without removing friction; this RFC represents the architectural rewrite instead of the next patch.
