# Independence policy — `requiredTier` (RFC-0046 Phase 4, AISDLC-591)

RFC-0046 introduced `independenceTier` (`none | attested | isolated`), a
per-reviewer-leaf claim about how independently a review was produced, and an
envelope-level `overallIndependenceTier` — the **weakest link** across every
reviewer leaf (AISDLC-588). By default this is **informational only**: it is
always surfaced, but never blocks a merge or a ship. This document covers the
opt-in policy knob that lets an adopter **require** a minimum tier, and how
that requirement is enforced identically regardless of whether your repo uses
GitHub branch protection or a procedural (no-branch-protection) ship flow.

## The three tiers (recap)

| Tier | Meaning | Forgeable by a same-machine coordinator? |
|---|---|---|
| `none` | No independence claim (self-authored / absent). | n/a |
| `attested` | Lower-tier heuristic signal (AISDLC-568's `agentType`/marker check). | Yes — informational only, never load-bearing. |
| `isolated` | Load-bearing claim: the review ran inside an RFC-0043 sandboxed boundary, signed by a clean-room signer distinct from the coordinator's key. | No, by construction. |

## `requiredTier: isolated` is now satisfiable (AISDLC-597, RFC-0047 Phase 5)

RFC-0046 Phase 3's first `isolated` implementation attempt (AISDLC-590)
anchored the claim on a self-asserted `provenance.deployment: 'ci'` string
signed with the *operator's own key* — a 3-reviewer reconcile found this
CRITICAL-forgeable by exactly the threat model RFC-0046 OQ-1 defends against
(a determined same-machine coordinator). That anchor design was deferred to
[RFC-0047](../../spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md), which
owns the re-derivable anchor: verifier-side re-derivation via a CI-only
signing key distinct from the operator's (AISDLC-593/595/596, the
**producer** half of the capability).

RFC-0047 OQ-5 split wiring that producer into **policy enforcement** into a
separate, deliberately scoped follow-up (AISDLC-597), which has now shipped:

- Setting `requiredTier: isolated` in your policy file is now a real,
  enforced requirement — a repo can require the strongest tier and it is
  compared against `overallIndependenceTier` exactly like `none`/`attested`.
- **Infra prerequisites.** Before setting `requiredTier: isolated` in a live
  policy file, your repo needs: (1) a registered ci-only signing key
  (AISDLC-593's key partitioning — distinct from the operator's own key used
  for the `attested` tier) and (2) the isolated-review workflow that
  produces re-derivable evidence for the verifier to check (AISDLC-596's
  isolated producer). Without both, every PR/ship legitimately falls short
  (`policyOutcome=shortfall`) rather than passing — this is the honest
  outcome, not a bug: an adopter with no isolated-review infra simply cannot
  produce an `isolated` envelope.
- **Downgrade-with-reason when the anchor is missing.** If the CI-only
  signing key or the isolated-review workflow output is absent/invalid at
  verification time, the verifier (AISDLC-595) does not silently credit
  `isolated` — it downgrades the envelope's `overallIndependenceTier` to the
  honest floor it CAN verify (`attested` or `none`) and records the reason
  in the verifier's output. A `requiredTier: isolated` policy then correctly
  reports `policyOutcome=shortfall` against the downgraded tier, rather than
  a false `pass` against an unverifiable claim.

## Configuring the policy

Create `.ai-sdlc/independence-policy.yaml` at your repo root:

```yaml
# .ai-sdlc/independence-policy.yaml
requiredTier: attested   # none | attested | isolated
```

- **No file present → `requiredTier: none`.** Zero behavior change for
  existing adopters — this is the default and matches the pre-RFC-0046
  status quo exactly.
- An unrecognized `requiredTier` value causes the loader to throw rather than
  silently downgrading to `none` — a malformed policy file fails loudly.

## Gate-topology-agnostic enforcement — one comparison, two surfaces

RFC-0046 §Rollout (OQ-5) requires the SAME comparison to be enforced whether
or not your repo has GitHub branch protection. The comparison itself lives in
one place: `pipeline-cli/src/attestation/independence-policy.ts`'s
`evaluateIndependencePolicy()`, fed by `loadIndependencePolicy()`. Both
enforcement surfaces below call this same function with the same inputs — a
policy shortfall means the same thing everywhere.

### Surface 1 — branch-protection repos (`ai-sdlc/pr-ready`)

`.github/workflows/ai-sdlc-gate.yml`'s `independence-policy-gate` job:

1. Cheaply reads `.ai-sdlc/independence-policy.yaml`'s `requiredTier:` scalar
   (a single grep — no `pnpm install`). When it's `none` (or the file is
   absent), the job passes immediately with zero build cost — this is the
   overwhelming majority case and matches the "no behavior change by
   default" contract.
2. Only when an adopter has opted into `attested`/`isolated` does the job pay
   for the orchestrator build and run:

   ```bash
   node pipeline-cli/bin/cli-attestation.mjs independence-policy \
     --head "$HEAD_SHA" \
     --base "$BASE_SHA"
   ```

   which re-verifies the v6 envelope, extracts `overallIndependenceTier`, and
   evaluates it against the loaded policy. A non-`pass` outcome (or an
   invalid envelope) fails the job, which fails `ai-sdlc/pr-ready`, which
   blocks merge via standard branch protection.

Docs-only PRs skip this job (mirrors `attestation-gate`'s skip condition) and
are allowed via `allowed-skips` in the `re-actors/alls-green` aggregator.

### Surface 2 — procedural-gate repos (ship-skill)

Repos without GitHub branch protection (e.g. an adopter using a purely
procedural "ship" step — a slash command, a pre-push hook, a CLI wrapper —
with no PR-merge gate at all) invoke the **exact same CLI command** as a
precondition of shipping:

```bash
node pipeline-cli/bin/cli-attestation.mjs independence-policy \
  --head "$(git rev-parse HEAD)" \
  --base "$(git merge-base origin/main HEAD)"
```

A non-zero exit code means "do not ship" — the ship-skill should refuse to
proceed (push, tag, deploy, whatever "ship" means in that adopter's flow)
until the policy outcome is `pass`. Because this is the SAME binary and the
SAME `evaluateIndependencePolicy()` call the branch-protection surface uses,
there is no drift between "what blocks a PR" and "what blocks a ship" —
verified by the hermetic test suite in
`pipeline-cli/src/attestation/independence-policy.test.ts` (see the
"gate-topology-agnostic enforcement" describe block, which exercises the
comparison from two simulated call sites and asserts they agree).

## Output — always surfaced, even when `requiredTier: none`

`cli-attestation independence-policy` prints, regardless of enforcement
outcome (AC-3 — the tier is informational context even when it isn't
blocking anything):

```
status=valid
reason=ok
overallIndependenceTier=attested
requiredTier=none
policyOutcome=pass
policyMessage=independence tier 'attested' (informational — requiredTier: none)
```

A malformed `.ai-sdlc/independence-policy.yaml` (e.g. an unrecognized
`requiredTier` value) fails **closed**: the CLI prints an `ERROR:` line to
stderr, exits non-zero, and never prints a `policyOutcome=` line at all — a
broken config must never be silently treated as `requiredTier: none`.

## Degrading correctly for procedural adopters

A procedural-gate adopter (no branch protection) has no PR-merge gate to
attach a required status check to at all — the entire enforcement surface
IS the ship-skill invocation above. This is a deliberate degrade, not a
gap: RFC-0046 OQ-5 explicitly ships the mechanism (the policy file + the
evaluator) once, and lets each topology wire its own "refuse to proceed on
non-pass" call site. If your ship-skill doesn't yet call
`cli-attestation independence-policy`, setting a `requiredTier` above `none`
in your policy file has **no effect** — the policy is enforced only where a
caller actually invokes the comparison. Branch-protection repos get this for
free via `ai-sdlc-gate.yml`; procedural-gate repos must wire the call
themselves into their own ship flow, per the recipe above.

## See also

- [RFC-0046 — Attested Reviewer Independence](../../spec/rfcs/RFC-0046-attested-reviewer-independence.md) — §Proposal (Rollout), OQ-5.
- [RFC-0047 — Re-derivable Isolated Anchor](../../spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md) — the producer-side fix for `isolated`.
- `pipeline-cli/src/attestation/independence-policy.ts` — the single source of truth for the policy comparison.
- `.github/workflows/ai-sdlc-gate.yml` (`independence-policy-gate` job) — the branch-protection enforcement surface.
