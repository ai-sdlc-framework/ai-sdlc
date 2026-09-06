---
id: RFC-0046
title: Attested Reviewer Independence
status: Under Review
lifecycle: Ready for Review
author: 'Dominique Legault'
created: 2026-09-06
updated: 2026-09-06
targetSpecVersion: v1alpha1
requires: [RFC-0043]
assumes: [RFC-0042]
requiresDocs: []
---

# RFC-0046: Attested Reviewer Independence

**Status:** Under Review — all 5 OQs resolved via operator rubric walkthrough (2026-09-06). Independence is modeled as a re-derivable **tier** (`independenceTier: none | attested | isolated`) anchored on RFC-0043's sandbox + clean-room boundary; defends against a determined same-machine coordinator; ships opt-in with a configurable, gate-topology-agnostic required-tier policy. RFC-0042 `verdictClass` is deprecated (legacy-read only), not amended.
**Lifecycle:** Ready for Review
**Author:** Dominique Legault
**Created:** 2026-09-06
**Updated:** 2026-09-06
**Target Spec Version:** v1alpha1

> The bold-style status block above is preserved for human readability. The
> YAML frontmatter is the source of truth for tooling.

---

## Summary

RFC-0042 (Proof-of-Execution attestation) proves a review *ran* against the exact
code state. It also ships a secondary field, `verdictClass: 'independent' |
'self-authored'` (AISDLC-568/570/572), that tries to capture whether the review
was produced by a reviewer *independent of the coordinator that makes the ship
decision*. RFC-0042 §273 is explicit that this field is a **same-machine
heuristic, not a proof** — and in practice it has accumulated in-the-wild patches
(AISDLC-572 role-binding; the worktree-project-dir and plugin-namespace gaps in
AISDLC-587) without closing its core claim.

This RFC designs *reviewer independence* as a first-class property with its own
threat model, verification surface, and lifecycle. Independence is a
**re-derivable tier** — `independenceTier: none | attested | isolated` — where the
load-bearing `isolated` tier is anchored on **RFC-0043's sandbox + clean-room
boundary** (isolation the coordinator does not control), defends against a
**determined same-machine coordinator**, and ships **opt-in** with a configurable,
gate-topology-agnostic required-tier policy. RFC-0042's `verdictClass` is
**deprecated** (frozen, legacy-read only) rather than amended.

## Motivation

The gate's headline promise to an adopter is: *"an independent reviewer approved
this change before it merged."* Today that promise is only heuristically backed:

1. **The signal is same-process.** `verdictClass=independent` is credited when a
   Claude Code `SubagentStart` marker for a reviewer role fired within a 30-minute
   window of the transcript's write time (RFC-0042 §269, §271). A coordinator with
   repo Bash/Write access can fabricate the marker file — including forging the
   `agentType` string — without spawning a real subagent (§273).
2. **The strongest signal isn't CI-verifiable.** `harnessTranscriptHash`
   (AISDLC-570) is **sign-time-only, informational** — a fresh CI runner has no
   `~/.claude/projects/` to re-derive it (§277), breaking RFC-0042's own "CI can
   independently re-verify every field" property for the field that matters most.
3. **It's fragile against the real topology.** Worktree-based project-dir
   resolution and the `ai-sdlc:`-namespaced `agentType` both silently downgrade a
   genuine independent review to `self-authored` (AISDLC-587). Every fix is another
   patch to a heuristic whose ceiling is fixed by (1).
4. **"Independent" is a trust word.** Shipping a field named `independent` that a
   determined same-machine coordinator can forge risks over-claiming to adopters
   who read the attestation as a guarantee.

## Goals

- Define **what reviewer independence must assert**, and **to whom**.
- Pin an explicit **threat model** boundary.
- Choose a **mechanism** that matches the claim.
- Settle the **relationship to RFC-0042** (mint, don't amend).
- Preserve **adopter ergonomics** — achievable in the normal worktree topology
  without a downstream fork of framework logic (the LT-539 anti-pattern).

## Non-Goals

- Re-litigating RFC-0042's **forgery resistance** (that a review *ran*). PoE stands.
- Proving reviewer **judgment quality** / prompt-bias freedom (RFC-0042 §279).
- Reviewer **human identity**. Independence here is process/decision separation.
- Changing the **trusted-reviewers key model**.

## Proposal

Reviewer independence is a **re-derivable tier** carried on each v6 transcript leaf
(and aggregated per-envelope), owned entirely by this RFC:

```
independenceTier: 'none' | 'attested' | 'isolated'
```

- **`none`** — no independence signal (equivalent to RFC-0042 `self-authored`). The
  review may have been produced by the coordinator's own process.
- **`attested`** — the current same-machine harness heuristic (RFC-0042
  `verdictClass=independent`'s mechanism, honestly renamed): a `SubagentStart`
  reviewer-role marker fired for this leaf. **Explicitly non-load-bearing / lower
  tier** — a determined same-machine coordinator can forge it. Retained as
  informational context (OQ-2 hybrid), never as the independence guarantee.
- **`isolated`** — **the load-bearing, re-derivable independence claim.** The review
  ran inside an **RFC-0043 `SandboxDriver` boundary** the coordinator process cannot
  reach, connected to model inference via the `inference.local`
  credential-withholding proxy; the sandbox emits an **unsigned** report; the
  **clean-room signer** (RFC-0043 Stage 4, key never in the sandbox) binds it into
  the v6 envelope. Because the review is produced in isolation the coordinator does
  not control and anchored by the clean-room boundary, a determined same-machine
  coordinator cannot forge it (OQ-1). The `isolated` anchor is **CI-re-derivable**
  via RFC-0043's `deployment: ci` path (different infra); the sandbox's unsigned
  report is the informational, sign-time context (OQ-2 hybrid).

**Aggregation.** A per-envelope `overallIndependenceTier` is the **weakest link**
across reviewer leaves (any `none` ⇒ `none`; all `≥ attested` ⇒ `attested`; all
`isolated` ⇒ `isolated`), mirroring RFC-0042's `overallVerdictClass`.

**Rollout (OQ-5).** The `isolated` tier is **opt-in per-PR** and **informational by
default** (surfaced in the attestation + PR, never blocks). A per-repo policy knob
(`independence-policy.yaml`: `requiredTier: none | attested | isolated`) can
**require** a minimum tier, enforced via `ai-sdlc/pr-ready` where GitHub branch
protection exists, and via the **ship-skill** for procedural-gate adopters (repos
without branch protection, e.g. local-trades). Mechanism available; enforcement is
the adopter's choice.

## Design Details

### Schema Changes

New optional per-leaf field (owned by RFC-0046; additive to the v6 leaf so legacy
leaves hash unchanged, mirroring the AISDLC-568 `verdictClass` additive precedent):

```json
{
  "properties": {
    "independenceTier": {
      "type": "string",
      "enum": ["none", "attested", "isolated"],
      "description": "Reviewer-independence tier for this leaf (RFC-0046). Absent on legacy leaves; treated as 'none' when absent. 'isolated' is the only tier that constitutes an independence claim; 'attested' is informational lower-tier context."
    }
  }
}
```

### Behavioral Changes

- **Producer (`isolated`).** The reviewer fan-out for a PR requesting the `isolated`
  tier runs each reviewer inside the RFC-0043 sandbox (`SandboxDriver`, Docker v1
  reference) via `inference.local`. The sandbox emits the unsigned report; the
  clean-room signer mints the v6 envelope and stamps each leaf `independenceTier:
  isolated`. This path `requires:` RFC-0043's `clean-room-signer` + `SandboxDriver`
  substrate.
- **Producer (`attested`).** When the `isolated` tier is not requested/available,
  the existing AISDLC-568 marker heuristic sets `attested` (fixing the AISDLC-587
  produce-side gaps as part of that lower tier — worktree project-dir + `agentType`
  namespace — so the honest lower tier is at least correctly computed).
- **Verifier.** Cross-checks the envelope's declared `independenceTier` against the
  Merkle-proved leaf value (tamper ⇒ reject). For `isolated`, re-derives the
  anchor via the RFC-0043 clean-room/CI path where present; for `attested`, treats
  it as informational (not re-derivable, not load-bearing). Emits per-leaf +
  `overallIndependenceTier`.
- **Policy enforcement.** `requiredTier` compared against `overallIndependenceTier`;
  failure blocks via `ai-sdlc/pr-ready` (branch-protection repos) or the ship-skill
  (procedural-gate repos).

### Migration Path

RFC-0042 `verdictClass` is **deprecated, not removed**: it remains readable on
legacy envelopes and is frozen (no new semantics). The `overall` computation
dual-reads — `independenceTier` when present, falling back to `verdictClass`
(`independent` → treated as `attested`; `self-authored`/absent → `none`) for legacy
envelopes. No historical envelope is re-interpreted.

## Backward Compatibility

- Additive leaf field ⇒ legacy v6 leaves hash unchanged and verify unchanged.
- `verdictClass` stays valid on historical envelopes; RFC-0042 is **not amended**
  (a see-also pointer to RFC-0046 is added under Phase-7 cross-reference only).
- Adopters see no behavior change unless they opt into the `isolated` tier or set a
  `requiredTier` policy.

## Alternatives Considered

Captured as the rejected options in each Open Question resolution below.

## Implementation Plan

- [x] Resolve OQ-1..OQ-5 via operator rubric walkthrough (this PR).
- [ ] Phase 1 — `independenceTier` leaf schema + verifier dual-read + `overall` aggregation; deprecate `verdictClass` (legacy-read).
- [ ] Phase 2 — `attested` tier: fix the AISDLC-587 produce-side gaps (worktree project-dir + `agentType` namespace) under the honest lower-tier name.
- [ ] Phase 3 — `isolated` tier: wire the internal reviewer fan-out through the RFC-0043 SandboxDriver + clean-room signer; stamp `independenceTier: isolated`.
- [ ] Phase 4 — policy knob (`requiredTier`) + enforcement via `ai-sdlc/pr-ready` and the procedural ship-skill.
- [ ] Add the RFC-0042 see-also cross-reference (light pointer, not an amendment).

## Open Questions

*All resolved 2026-09-06 via operator decision-rubric walkthrough.*

1. **OQ-1 — What is the threat model boundary?**

   **Resolution (2026-09-06, full rubric):** **Defend against a determined
   same-machine coordinator (option B).** Independence must hold even against a
   coordinator willing to forge marker files / `agentType`. Industry research: SLSA
   (isolated builder), in-toto/Sigstore (distinct signing identities), forge-side
   required reviews, and Certificate Transparency all anchor independence in a party
   the subject-of-attestation does not control; local subject-controlled markers are
   universally non-authoritative (RFC-0042 §273 concedes this). **Counter-argument:**
   "over-engineering for a single-operator tool — if you don't trust your own
   coordinator your key is already compromised." Rebuttal: the claim is for a
   *downstream* consumer who trusts the operator's *key* but not that the automated
   coordinator reviewed its own ship decision; an A-level (non-adversarial) heuristic
   transmits zero information to that party. **Selected over A** (forgeable ⇒ not a
   property), **over C** (adversarial-signer needs multi-party infra disproportionate
   now; kept as a future tier), **over D** (B is achievable, so don't forfeit the
   property).

2. **OQ-2 — What must `independent` assert, and to whom?**

   **Resolution (2026-09-06, full rubric):** **Hybrid — the load-bearing
   independence anchor is CI-re-derivable; sign-time-only signals are retained but
   non-load-bearing (option C).** OQ-1=B requires a claim that survives a party who
   doesn't fully trust the coordinator, so a sign-time-only operator vouch (the
   `harnessTranscriptHash` model) re-collapses to "trust the operator" and is
   insufficient. Industry research: SLSA/in-toto/Sigstore/CT are built for
   third-party re-verification; TPM/TEE remote attestation is the sign-time-vouched
   contrast. **Counter-argument:** "re-derivability is impossible for ephemeral LLM
   reviewers with no published pubkey." Rebuttal: the reviewer needs a *signing
   credential distinct from the coordinator's* (a key-provisioning/isolation problem,
   OQ-3), not a human identity; if genuinely impractical it degrades to a labeled
   lower tier. **Selected over** sign-time-only (defeats OQ-1) **and pure-re-derivable**
   (C still admits genuinely-sign-time-only informational signals like the harness
   transcript, just not as the claim).

3. **OQ-3 — What mechanism backs the claim?**

   **Resolution (2026-09-06, full rubric):** **Generalize RFC-0043's
   sandbox-isolated reviewer + clean-room signer to the internal-review path;
   independence becomes a tier (option A).** RFC-0043 (Signed Off, phases 1-7,
   AISDLC-497..515) already ships the exact primitive — an in-sandbox reviewer
   fan-out via `inference.local` and a clean-room signer whose key never enters the
   sandbox — built for untrusted contributors; OQ-1=B is the same isolation problem
   pointed inward. This is SLSA-L3 shaped (isolate the sensitive step in an
   environment the requester doesn't control, sign in a clean room). `requires:
   RFC-0043`. **Substantive gap surfaced by the walkthrough:** the reviewer-independence
   need was about to be solved by patching the same-machine heuristic a third time
   (AISDLC-587) when a signed-off sandbox+clean-room substrate already existed — the
   walkthrough redirected from "invent a distinct-key scheme" to "generalize shipped
   substrate." **Counter-argument:** "sandboxing every internal review is heavy;
   RFC-0043 chose `deployment: ci` for untrusted PRs *because* it's a costlier
   surface." Rebuttal: independence is a **tier**, opt-in for PRs that need the claim
   (OQ-5); routine PRs stay on the honest lower tier — the sandbox cost is spent
   deliberately, on already-cost-optimized runtime. **Selected over B** (bespoke
   keys: key-isolation on a shared FS is unsolved without a sandbox — B-with-sandbox
   ≡ A), **over C** (CI-only removes the local path RFC-0043 kept; C stays the
   transparency tier), **over D** (per OQ-1=B).

4. **OQ-4 — Relationship to RFC-0042's `verdictClass`?**

   **Resolution (2026-09-06, full rubric):** **Mint a new field
   (`independenceTier: none | attested | isolated`) owned by RFC-0046; deprecate
   `verdictClass` (frozen, legacy-read only) — do not amend RFC-0042 (option B).**
   Industry research: Kubernetes/Stripe/in-toto never mutate a shipped field's
   meaning — they add a new field/predicate and dual-read during migration;
   retroactively re-interpreting a signed value is the anti-pattern. The `attested`
   tier absorbs the old heuristic under an honest name; `isolated` is the OQ-3
   proof; `none` = self-authored. **Counter-argument:** "two fields is more surface —
   one evolved enum (C) is simpler." Rebuttal: dual-read (new field wins, legacy
   fallback) is a bounded, standard migration; C's rename of the shipped
   `independent` value retroactively changes what every historical v6 envelope
   asserts — the exact in-place amendment the "mint a new RFC" convention exists to
   prevent. **Selected over A/C** (both re-interpret shipped `verdictClass`
   semantics); B keeps RFC-0042 immutable and honest.

5. **OQ-5 — Rollout posture for adopters?**

   **Resolution (2026-09-06, full rubric):** **Opt-in default (informational) +
   configurable, gate-topology-agnostic required-tier policy (option A+C).** Default:
   `isolated` is opt-in per-PR and never blocks; a per-repo `requiredTier` knob can
   require a minimum tier, enforced via `ai-sdlc/pr-ready` (branch-protection repos)
   or the ship-skill (procedural-gate adopters like local-trades). Industry research:
   SLSA levels are self-declared/progressive; GitHub required-reviews and npm
   provenance are per-project opt-in — mechanism available, enforcement is a project
   policy knob. **Counter-argument:** "opt-in informational = nobody actually gets
   independence." Rebuttal: the property is real whenever the `isolated` tier is
   present; A ships the mechanism + visibility, C makes it enforceable for those who
   choose the policy — forcing default-on (B) taxes every high-frequency,
   subscription-billed internal PR against standing cost concerns and RFC-0043's own
   population-split reasoning. **Selected over B** (sandbox-on-every-PR
   disproportionate) **and over pure-A** (high-assurance adopters need enforceable
   policy) — ship A default *plus* C as a configurable knob that degrades correctly
   for procedural-gate repos.

## References

- [RFC-0042 — Proof-of-Execution Attestation](RFC-0042-proof-of-execution-attestation.md) (§267 honest scope, §269-279 `verdictClass`/`harnessTranscriptHash`, DEC-0012/DEC-0013)
- [RFC-0043 — Untrusted-Contributor PR Verification](RFC-0043-untrusted-contributor-pr-verification.md) (`SandboxDriver`, `inference.local` proxy, clean-room signer — the isolation substrate this RFC generalizes)
- AISDLC-568 (`verdictClass` opt-b), AISDLC-570 (`harnessTranscriptHash` opt-a), AISDLC-572 (role-binding fix), AISDLC-587 (worktree/namespace produce-side gaps — the trigger for this RFC)
- `docs/whitepapers/proof-of-execution.md` §2.2 (out-of-scope table)

## Sign-Off

| Pillar | Owner | Status |
|---|---|---|
| Engineering Authority | Dominique Legault | ⏸ Pending |
| AI-SDLC Operator | Dominique Legault | ⏸ Pending |
| Product | Alex | ⏸ Pending |
| Design Authority | Morgan | ⏸ Pending |

## Revision History

| Date | Version | Change |
|---|---|---|
| 2026-09-06 | 0.1 | Initial draft — problem framing + 5 OQs. |
| 2026-09-06 | 0.2 | All 5 OQs resolved via operator rubric walkthrough. Model: `independenceTier` tier (none/attested/isolated) anchored on RFC-0043 sandbox+clean-room; threat boundary = determined same-machine coordinator; re-derivable hybrid anchor; new field deprecating `verdictClass` (no RFC-0042 amendment); opt-in + configurable gate-agnostic policy. Lifecycle Draft → Ready for Review; `requires: RFC-0043` added. |
