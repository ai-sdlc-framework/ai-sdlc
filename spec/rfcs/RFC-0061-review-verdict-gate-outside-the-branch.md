---
id: RFC-0061
title: Review verdict as a head-bound gate outside the branch (successor to RFC-0042)
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-11-03
updated: 2026-11-03
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0042, RFC-0043, RFC-0046, RFC-0052, RFC-0054]
amends: [RFC-0042]
requiresDocs: []
---

# RFC-0061: Review verdict as a head-bound gate outside the branch (successor to RFC-0042)

**Status:** Draft
**Lifecycle:** Draft
**Author:** Dominique Legault
**Created:** 2026-11-03
**Updated:** 2026-11-03
**Target Spec Version:** v1alpha1

> Draft. No design is decided here. The Open Questions below are resolved only with the
> operator through the decision rubric, one at a time. No implementation task is filed
> until the RFC is Signed Off. When this RFC reaches Implemented, RFC-0042's lifecycle
> becomes Superseded and RFC-0043, RFC-0046 and RFC-0052 are amended where they assume
> the v6 substrate (see "Dependents").

## Summary

The v6 proof-of-execution attestation (RFC-0042) commits a signed proof into the branch
it describes, keys that proof by `git patch-id`, signs it inside a pre-push git hook, and
lets the signer and the CI verifier choose "which reviewers count" by different rules. A
design review on 2026-11-03 traced about 80% of attestation-attributed incidents to those
four choices, found that RFC-0042 met two of its seven goals, and found that the gate's
original purpose (letting CI skip a duplicate review on trusted PRs) no longer exists,
because CI reviews only untrusted PRs since AISDLC-824.

This RFC keeps the one requirement that survives the review: **a pull request merges only
when the pipeline's reviewer step produced an approved verdict for the exact head being
merged.** It proposes to meet that requirement with a verdict record that is bound to the
head commit, stored outside the reviewed branch, posted by the pipeline after its verdict
step, and consumed by `ai-sdlc/pr-ready` as a required check. Carry-forward after a
rebase becomes one explicit, narrow rule instead of five patch-id implementations. Who
signs the record, where it lives, how it survives a rebase, and how adopters move off v6
are Open Questions.

## Motivation

### The design review (2026-11-03)

The review was ordered by the operator after a push-friction survey found no recorded
true catch by the attestation gate. It asked three things: why the gate was put there,
whether that reason still holds, and why the design does not deliver it. Findings, with
the research that backs them, are summarised here; counts are approximate because the
internal survey classified tasks mostly from titles.

**Purpose 1, saving cost, is gone.** AISDLC-74 (2026-04-28) created the gate so that CI
could trust a signed local review and skip running the same reviewers again. Since
AISDLC-824 the CI review workflow runs only for untrusted PRs (forks, non-collaborators,
bots). A trusted PR gets no CI review whether it carries an envelope or not, so the
envelope saves nothing. AISDLC-140 had already declared the attestation "audit-only", yet
it still feeds `ai-sdlc/pr-ready`.

**Purpose 2, blocking a merge without an approved review, is real but under-delivered.**
It was added after the 2026-05-20 incident, in which a developer subagent pushed before
the reviewers ran and wrote fake approvals; the hook signed them with the operator key and
the PR merged with three real defects. It matters because agents may merge on green
(`governance.allowMerge: onGreenClean`). The v6 design cannot enforce it strongly: the
signing key lives on the same account the agents run under (`~/.ai-sdlc/signing-key.pem`,
`init-signing-key`), and the framework's own docs say the envelope proves that a
transcript exists, not who the reviewer was or that it was independent (AISDLC-568). The
one firing of the approval check since 2026-10-28 was a false positive (DEC-0286, then
DEC-0287 recorded as a weakening).

**No success measure exists.** Neither AISDLC-74 nor RFC-0042 defined a catch rate, and
no ledger records what the gate catches.

**The friction comes from four v6 design properties.** Roughly 75 tasks and 45 decision
openings were classified:

| Property | Incidents | Mechanism |
|---|---|---|
| P1. Proof committed into the branch it proves | ~16 | Chore commits (AISDLC-999), "pending leaves" commits (848), stale envelopes that rebase and resume must delete (1098, 863), Prettier reformatting signed JSON (875, 916), ledger staging (967, 1017); about 970 envelopes and 650 leaf files, growing about 140 files a week (968) |
| P2. `patch-id` as the binding key, plus its exclusion list | ~12 | Any diff change orphans the leaves (998); unchanged-patch-id rebase still leaves a stale `subject.sha1` (810); "survives rebase" was never true (989); the exclusion list must match across five implementations (`patch-id-exclusion-lockstep.test.ts`) |
| P3. Signing inside the pre-push hook | ~9 | The hook commits and exits 1 by design; sign-after-rebase ordering (810, 998); push without lease after pre-sign rebase (1016); stale workspace build breaks the hook (1111); double-signing turned eight PRs into drafts on 2026-11-02 (1164) |
| P4. Signer and verifier pick "which leaves count" by different rules | ~8 tasks, ~14 decisions | About 12 escalations in October (DEC-0139/0140/0150/0151/0157/0169 to 0175/0178/0180); an honest in-place fix could not be signed until DEC-0287 (1144) |

Between 2026-10-31 and 2026-11-03, 51 of 66 finished tasks hit a push stop, 19 of 24
failed verdicts carry the non-fast-forward cause, and 23 of 40 done tasks were pushed by
hand. Twenty-two commits on main between 2026-10-23 and 2026-11-02 fix or reshape
signing, pre-push gates or the push step.

**RFC-0042's goals against outcomes.**

| RFC-0042 goal | Outcome |
|---|---|
| 1. Chore-commit re-push cycle eliminated (3-4 pushes to 1-2) | Not met; the hook still commits and exits 1 |
| 2. Rebase does not invalidate proof | Not met; `attestation-reference.md` says head-binding survives chore commits only; AISDLC-810 removed the relaxation on purpose |
| 3. No per-machine key onboarding | Not met; a signing key and a `trusted-reviewers.yaml` pubkey are still required |
| 4. Forgery vector closed | Probably met (Merkle and transcript binding); never audited |
| 5. Subscription-tier cost economics | Met, now moot (AISDLC-824) |
| 6. Audit trail | Partial; no workflow has ever re-verified a historical envelope |
| 7. No external service dependency | Met |

**Two rejected alternatives in RFC-0042 were rejected on a premise that no longer holds.**
Alternatives A2 (GitHub attestations) and A5 (CI-only attestation) were dropped because
CI reviewer runs cost minutes on the subscription tier (AISDLC-353). Trusted PRs get no
CI review today, so that cost is not on the PR path any more.

### What others do

No system the external survey found stores review proof inside the reviewed branch.
SLSA's source tool stores provenance and verification summaries in git notes; gittuf uses
`refs/gittuf/attestations`; GitHub binds check runs and statuses to the head SHA. Gerrit
handles rebase carry-forward with one explicit rule (`copyCondition`): an approval is
copied to a new patch set only for `TRIVIAL_REBASE` or `NO_CODE_CHANGE`; anything else
becomes outdated and needs re-review. Git's own documentation calls `patch-id`
"reasonably unique" and notes that `--stable` ignores whitespace. Reviewer independence
in SLSA, gittuf and GitHub comes from a separate principal (two trusted parties, a
different signing key, a workflow OIDC identity or a GitHub App), not from a proof the
author can produce. No standard exists for attesting an AI reviewer; in-toto issues #601
to #603 propose AI review predicates and are still open.

## Goals

1. **One requirement, stated once.** A PR merges only when the pipeline's reviewer step
   (Step 8 verdict) approved the exact head commit being merged. `ai-sdlc/pr-ready`
   enforces it as a required check.
2. **Nothing about the proof lives in the reviewed branch.** No chore commits, no envelope
   or leaf files to delete on rebase, no Prettier interaction, no repository growth.
3. **One binding key: the head commit.** Carry-forward after a rebase is an explicit
   narrow rule evaluated in one place, not a patch-id computed in five.
4. **Signing, if any, happens in a pipeline step, never in a git hook.** A push never
   stops for attestation reasons; `git push` exits 0 or fails for git reasons only.
5. **One rule for which verdicts count,** shared by whatever posts the record and
   whatever checks it.
6. **Trust claim stated honestly.** The RFC says exactly what the record proves, what it
   does not, and which principal could forge it.
7. **A success measure.** A catch ledger records every merge the gate blocked and why.

## Non-Goals

- Proving that an AI reviewer is independent of an AI author (RFC-0046's tier model
  stays; its evidence source changes, see OQ-6).
- Public, cross-organisation audit of review evidence (RFC-0042 non-goal, unchanged).
- Changing how untrusted PRs are verified (RFC-0043's clean-room path is amended, not
  redesigned; see OQ-7).
- The staged review pipeline itself (RFC-0052); only its leaf emission format is affected.
- Branch protection on `main` and the `ai-sdlc/pr-ready` rollup, which remain the merge
  controls.

## Proposal

The proposal is deliberately a **shape**, with the load-bearing choices left to the Open
Questions.

### The verdict record

After Step 8 (aggregate verdicts) produces `approved`, the pipeline creates one **review
verdict record** for the head commit it reviewed. The record carries, at minimum:

- `subject.headSha`: the commit the reviewers read.
- `subject.treeSha`: that commit's tree (used by the carry-forward rule, see OQ-2).
- `subject.baseSha`: the merge base against `main` at review time.
- `reviewers[]`: name, harness, model, `independenceTier` (RFC-0046) and verdict per
  reviewer that ran.
- `coverage`: the reviewer set the policy required for the touched paths, evaluated once
  by the rule in `pipeline-cli` and copied into the record. The checker never recomputes
  it by a different rule (closes P4).
- `evidence`: a reference to the transcript leaves (where those live is OQ-4).
- `issuedBy`: the principal that created the record (OQ-1).

### Where the record lives and who creates it (OQ-1)

The record is never committed into the task branch. Candidates, each with a different
trust claim, are: a commit status or check run posted by the pipeline; a check run posted
by a GitHub App with its own identity; a signed statement stored in a notes ref or a
dedicated `refs/ai-sdlc/verdicts/*` ref; or a GitHub artifact attestation with a custom
predicate, signed by a CI workflow's OIDC identity. The choice decides who can forge the
record and whether it can be verified without GitHub.

### The gate

`ai-sdlc-gate.yml` replaces the `attestation-gate` job (v6 verify: envelope, leaves,
`trusted-reviewers.yaml`, `signedMergeBase`) with a **verdict check**: find the record for
the PR head, confirm its subject matches the head, confirm `coverage` satisfies the
review policy for the PR's touched paths, and feed the result into the `ai-sdlc/pr-ready`
rollup. The check also runs on `merge_group` events (OQ-5).

### Carry-forward after a rebase (OQ-2)

A rebase gives the PR a new head and the record no longer matches. The RFC proposes one
explicit rule, evaluated in one place, modelled on Gerrit's `copyCondition`: the pipeline
may re-issue the record for the new head **only** when the change is a trivial rebase
(same diff against the new base, same tree delta, no conflict resolution), and otherwise
the change is reviewed again. Whether "trivial rebase" is decided by exact diff equality,
by tree comparison, or by `patch-id` used as a hint plus an exact check, and whether
re-issue is automatic or needs a reviewer step, is OQ-2.

### Signing moves out of the hook

The pre-push hook stops signing and verifying. `check-attestation-sign.sh` and its
double-sign path (AISDLC-1164) are deleted. If the chosen storage needs a signature, the
pipeline's ship step (Step 11) produces it after the push, using the identity chosen in
OQ-1. No push is ever blocked for attestation reasons.

### The catch ledger

Every time the verdict check fails on a PR that would otherwise be green, the gate
appends one line to a ledger (`.ai-sdlc/review-gate-ledger.jsonl` or a check-run
summary; location is part of OQ-4): PR, head, reason, outcome. The ledger is the success
measure the gate never had.

## Design Details

### Schema Changes

Sketch of the verdict record, subject to OQ-1 and OQ-4:

```json
{
  "schema": "ai-sdlc/review-verdict/v1",
  "subject": {
    "headSha": "…",
    "treeSha": "…",
    "baseSha": "…",
    "repository": "owner/name",
    "pullRequest": 0
  },
  "verdict": "approved",
  "reviewers": [
    {
      "name": "correctness-reviewer",
      "harness": "claude",
      "model": "…",
      "independenceTier": "same-session",
      "verdict": "approved"
    }
  ],
  "coverage": { "policy": "review-policy@sha", "required": ["…"], "satisfied": true },
  "evidence": { "leaves": "…" },
  "issuedBy": { "principal": "…", "at": "2026-11-03T00:00:00Z" },
  "carriedForwardFrom": null
}
```

### Behavioral Changes

Consumers of the v6 envelope, from the dependency survey, and what each becomes:

| Consumer | Today reads | Under this RFC |
|---|---|---|
| `ai-sdlc-gate.yml` attestation-gate job | Full v6 verify | Verdict check against the head; same `ai-sdlc/attestation` context name kept or renamed (OQ-3) |
| `attestation-post.yml` | Re-verifies the head envelope, posts status and the DEC-0065 approving review | Posts the record (if OQ-1 chooses a workflow identity) or is deleted |
| `next-step/ship.ts`, `head-envelope.ts`, `resume-decision.ts` | Envelope exists for the patch-id; fail-closed push (AISDLC-984); push-only resume (AISDLC-863) | Record exists for the head; push never fails closed on attestation; push-only resume becomes "re-issue if trivial, else review" |
| `steps/land-prep.ts` | Drops stale envelope, relies on hook re-sign | Stale-envelope step deleted |
| `governance/rebase-rearm.ts` | Compares patch-ids | Applies the OQ-2 carry-forward rule |
| `dispatch/resume.ts`, `hierarchy/pr-state.ts`, `reenter.ts` | Envelope-exists as approved-content check; `content-hash-mismatch` state | Record-matches-head check; mismatch state replaced by "needs re-issue or re-review" |
| `consumer-verify-attestation.yml`, `cli-attestation verify` | v6 envelope and leaves | Verdict check; the `cli-attestation verify` entry point is kept for adopters (OQ-3) |
| Independence policy (RFC-0046) | `independenceTier` on leaves | Same field on the record's `reviewers[]` |
| Staged review (RFC-0052) | Emits `stage` leaves in the v6 format; verifier expands them (DEC-0094/0149) | Emits reviewer entries into the record; no expansion rule in the checker |
| `clean-room-signer.ts` (RFC-0043 stage 4) | Builds the v6 envelope | Builds the record for untrusted PRs (OQ-7) |
| `doctor`, `init`, `init-signing-key` | Keyring, pubkey, governance checks | Removed or replaced per OQ-1 |
| `merge-if-eligible` | Evidence-path regex; verdict comes from `pr-ready` | Unchanged apart from the regex |
| `trusted-reviewers-drift.yml`, `trust-classifier.ts` | `trusted-reviewers.yaml` against GitHub permissions | Survives if the trust file is kept (OQ-1) |

What is deleted whatever the OQ answers: the pre-push signing and verifying hook, the
five patch-id implementations and their lockstep test, the patch-id exclusion list, the
`.ai-sdlc/attestations/` and transcript-leaves trees in the branch (about 2,600 files),
and schema v6 as a signed or verified format (per DEC-0284's precedent, with the window
decided in OQ-3).

### Migration Path

Phases, to be turned into tasks only after Signed Off:

1. **Shadow.** The pipeline posts the verdict record alongside the v6 envelope; the new
   check runs non-required and writes the catch ledger. Both are compared on every PR for
   a fixed window.
2. **Cutover.** `ai-sdlc/pr-ready` requires the verdict check; the attestation-gate job,
   the hook signing path and land-prep's envelope step are removed. v6 envelopes stop
   being produced.
3. **Cleanup.** Delete the signer, verifier, leaf emission in the old format, the
   committed proof trees, `init-signing-key` and the keyring checks in `doctor`. Amend
   RFC-0043, RFC-0046 and RFC-0052. Mark RFC-0042 Superseded.
4. **Adopters.** Per OQ-3: a release note, the kept `cli-attestation verify` entry point,
   and either a dual-read window or a hard cut.

## Backward Compatibility

This is a breaking change for anyone verifying v6 envelopes. Inside this repository the
consumers are listed above. Outside it, the adopter survey found documentation and a
reusable consumer workflow pinned to exact versions (`adopter-attestation-verify-ci.md`,
AISDLC-554, AISDLC-566, AISDLC-575) but no evidence of an adopter running attestation in
production. DEC-0284 set the precedent that legacy schemas are dropped with no window.
Whether v7 follows that precedent is OQ-3. Existing v6 envelopes on `main` (about 970)
are historical evidence; no workflow re-verifies them today and none will after this RFC.

## Alternatives Considered

### Alternative 1: Keep v6 and keep patching

Rejected. Six schema versions in six months, about 22 fix commits in the last ten days,
and the root cause (proof in the branch) untouched by any of them. RFC-0042 itself called
the friction existential and its v6 redesign kept the flaw.

### Alternative 2: Delete the chain with no replacement

Rejected. Agents may merge on green and the CI verifier is today the only review signal
in `ai-sdlc/pr-ready`. Deleting it leaves agent self-merge with no review requirement.

### Alternative 3: Keep signing as an audit trail, make the CI check advisory

Rejected. Keeps all the cost (P1 to P4) and removes the review signal from the merge
gate. Reversible in one line, which is its only merit.

### Alternative 4: Delete only the pre-push hook

Rejected as the whole answer. It removes P3 but leaves the proof in the branch, so leaf
and patch-id drift still fail, now in CI instead of at push. It is, however, a possible
first step inside Phase 1.

### Alternative 5: In-branch git notes or a dedicated ref with the v6 envelope unchanged

Considered. It fixes P1 but keeps P2 and P4, and git notes do not follow a rebase unless
`notes.rewriteRef` is set on every machine. It remains a candidate storage in OQ-1.

### Alternative 6: Adopt gittuf

Considered. gittuf's reference authorisations bind to the merge tree and ignore
approvals signed by the change's own signer, which is the independence property this
repository lacks. It brings a full policy layer, its own refs and a new tool on every
machine and in CI. Too large for the requirement; its tree binding informs OQ-2.

## Implementation Plan

No task is filed until Signed Off. Expected tasks after sign-off, by phase:

- [ ] Phase 1: verdict record schema and writer in `pipeline-cli` (Step 8 output); verdict
      check job, non-required; catch ledger; shadow comparison report.
- [ ] Phase 1: coverage rule shared by writer and checker (closes P4 before cutover).
- [ ] Phase 2: `ai-sdlc/pr-ready` requires the verdict check; delete attestation-gate job,
      hook signing, land-prep envelope step, `check-attestation-sign.sh`; `ship.ts` never
      fails closed on attestation.
- [ ] Phase 2: carry-forward rule (OQ-2) in `rebase-rearm`, `resume`, `reenter`.
- [ ] Phase 3: delete v6 signer, verifier, leaf emission, patch-id implementations,
      exclusion list, committed proof trees, `init-signing-key`, doctor keyring checks.
- [ ] Phase 3: amend RFC-0043, RFC-0046, RFC-0052; set RFC-0042 to Superseded; update
      `attestation-reference.md`, `review-attestations.md` rule, CLAUDE.md schema line.
- [ ] Phase 4: adopter path per OQ-3 (`consumer-verify-attestation.yml`,
      `cli-attestation verify`, release note).
- [ ] `requiresDocs` is empty while Draft; set `operator-runbook` at Ready for Review.

## Dependents

- **RFC-0043** (Signed Off, `requires: [RFC-0042]`): assumes the v6 signer and verifier
  as the substrate and adds a clean-room signing boundary. Needs an amendment naming the
  verdict record as the clean-room output (OQ-7).
- **RFC-0046** (Signed Off, `assumes: [RFC-0042]`): adds `independenceTier` to leaves.
  The field moves to the record's `reviewers[]`; the tier derivation is unchanged (OQ-6).
- **RFC-0052** (Signed Off, `assumes: [RFC-0042]`): lists "a new attestation scheme" as a
  non-goal and emits leaves in the existing format. Needs an amendment to its leaf
  emission only.
- **RFC-0054** (Signed Off): the PR lifecycle state machine has a
  `content-hash-mismatch` state and a push-only re-sign path. Both change under OQ-2.

## Open Questions

The operator walks these one at a time through the decision rubric, never batched. All
eight are unresolved. Options are listed to frame the rubric, not to pre-empt it.

### OQ-1: Where the verdict record lives and which principal issues it

The choice sets the trust claim. Candidates: (a) a commit status or check run posted by
the pipeline with the repository token it already holds (forgeable by any token holder,
roughly today's bar, no extra infrastructure); (b) a check run posted by a dedicated
GitHub App whose credential the agents do not hold (platform-enforced separate principal;
needs an App and a place to run it); (c) a signed statement in a dedicated ref such as
`refs/ai-sdlc/verdicts/<headSha>` or git notes, signed with a key that is not on the
agents' machine (portable, verifiable offline, needs a signing service or CI OIDC); (d) a
GitHub artifact attestation with a custom predicate signed by a workflow's Sigstore
identity (strongest provenance, GitHub-only, private repos get no transparency log).
Hybrids are possible (a status for the gate plus c for evidence).

### OQ-2: Carry-forward after a rebase

When the head changes, does the pipeline (a) always review again; (b) re-issue the record
automatically when the diff against the new base is byte-identical; (c) re-issue under a
Gerrit-style `changekind` rule (trivial rebase or message-only change) decided by tree
and diff comparison, with `patch-id` as a hint only; or (d) re-issue after a cheap
deterministic stage of the staged review (RFC-0052) confirms nothing changed? Who runs
the re-issue (the executor's ship step, the dispatch re-enter path, or the gate itself)
is part of this question.

### OQ-3: Adopter migration and the v6 cut

(a) Hard cut, per DEC-0284's precedent (v6 refused from the cutover release, release note
only); (b) a dual-read window of N releases in which the checker accepts either a v6
envelope or a verdict record; (c) keep `cli-attestation verify` as the adopter entry
point with the same exit codes and the same `ai-sdlc/attestation` context name, whatever
the window. Whether the `pipeline-cli-version` input and the exact-version pins in
`adopter-attestation-verify-ci.md` constrain the choice belongs here.

### OQ-4: What happens to the transcript leaves and the audit trail

The leaves are the only evidence that a reviewer ran. (a) Drop them: the record's
reviewer list is the evidence; (b) keep them outside the branch, referenced from the
record by digest (notes ref, release asset, or check-run output); (c) keep them in the
branch as today but stop signing them (keeps P1's growth and chore commits). Where the
catch ledger lives is decided with this question.

### OQ-5: Merge queue and the merge-group SHA

If the repository adopts a GitHub merge queue (RFC-0054 OQs touch this), the queue tests a
temporary SHA that no reviewer saw. Does the verdict check (a) run on `merge_group` and
accept a record whose `treeSha` delta matches the queued head; (b) require re-issue for
the queue head; or (c) declare the merge queue out of scope until adopted?

### OQ-6: Independence tier evidence (RFC-0046)

RFC-0046 derives `independenceTier` from leaf-bound evidence. With the record as the
carrier, (a) the tier is copied from the reviewer step unchanged; (b) the tier is
derived by the checker from `issuedBy` and the reviewer harness (for example, a GitHub App
or workflow identity implies at least `separate-principal`); or (c) RFC-0046 is amended to
define tiers over the record's fields.

### OQ-7: Untrusted PRs (RFC-0043)

The clean-room signer builds a v6 envelope for untrusted PRs. (a) It builds the verdict
record instead, issued by the workflow identity, which naturally satisfies OQ-1 (b) or (d)
for that path only; (b) untrusted PRs keep a separate check that this RFC does not touch;
(c) one record format for both paths, with `issuedBy` distinguishing them.

### OQ-8: What the gate must prove, as a written threat model

The review found that the trust claim was never stated in one place. Before Signed Off
the RFC must say which of these the gate guarantees and which it does not: that a
reviewer step ran; that it ran against this head; that the reviewer was a different
principal from the author; that the verdict was not edited after the fact; and that the
record can be verified without GitHub. The answer feeds OQ-1 and OQ-4 and sets the catch
ledger's definition of a catch.

## References

- RFC-0042 Proof-of-Execution Attestation via In-Repo Merkle Transcripts (superseded by
  this RFC on Implemented)
- RFC-0043 Untrusted-Contributor PR Verification; RFC-0046 Attested Reviewer
  Independence; RFC-0052 Staged Review Pipeline; RFC-0054 PR Lifecycle as Event-Driven
  Dispatch
- AISDLC-74 (gate origin, 2026-04-28), AISDLC-140 (audit-only), AISDLC-353 (subscription
  cost premise), AISDLC-380 (sub-attestation gate), AISDLC-568 (trust limit),
  AISDLC-824 (CI review only for untrusted PRs), AISDLC-984 (fail-closed push),
  AISDLC-1164 (double-signing), DEC-0206, DEC-0284, DEC-0286, DEC-0287
- `docs/operations/attestation-reference.md`, `docs/operations/adopter-attestation-verify-ci.md`,
  `.claude/rules/review-attestations.md`
- SLSA Source Track requirements: https://slsa.dev/spec/draft/source-requirements
- SLSA source-tool requirements mapping:
  https://github.com/slsa-framework/source-tool/blob/main/docs/REQUIREMENTS_MAPPING.md
- in-toto attestation predicates and AI review proposals (#601 to #603):
  https://github.com/in-toto/attestation/blob/main/spec/predicates/README.md,
  https://github.com/in-toto/attestation/issues/604
- gittuf design document:
  https://github.com/gittuf/gittuf/blob/main/docs/design-document.md
- git-appraise: https://github.com/google/git-appraise
- Gerrit label `copyCondition` and submit requirements:
  https://gerrit-review.googlesource.com/Documentation/config-labels.html,
  https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html
- `git patch-id`: https://git-scm.com/docs/git-patch-id
- GitHub check runs, artifact attestations, OIDC and protected branches:
  https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks,
  https://docs.github.com/en/actions/concepts/security/artifact-attestations,
  https://docs.github.com/en/actions/concepts/security/openid-connect,
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- agentattest (community in-toto predicate for agent runs):
  https://github.com/AuroraAeon/agentattest
