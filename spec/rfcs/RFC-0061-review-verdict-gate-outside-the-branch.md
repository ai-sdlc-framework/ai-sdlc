---
id: RFC-0061
title: Review verdict as a head-bound gate outside the branch (successor to RFC-0042)
status: Implemented
lifecycle: Implemented
author: 'Dominique Legault'
created: 2026-11-03
updated: 2026-11-06
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0042, RFC-0043, RFC-0046, RFC-0052, RFC-0054]
amends: [RFC-0042]
requiresDocs:
  - operator-runbook
---

# RFC-0061: Review verdict as a head-bound gate outside the branch (successor to RFC-0042)

**Status:** Signed Off (v0.3, Engineering and Operator 2026-11-03). All eight Open Questions resolved with the operator on 2026-11-03: error-resistant trust claim (OQ-8); verdict ref pushed atomically by Step 11, CI posts the gate result (OQ-1); clean-replay carry-forward evaluated by the gate (OQ-2); hard v6 cut with names kept (OQ-3); leaves in the verdict ref, derived catch report (OQ-4); merge-queue rule decided, built later (OQ-5); tier derived once at Step 8 (OQ-6); untrusted PRs through a split CI writer (OQ-7).
**Lifecycle:** Signed Off
**Author:** Dominique Legault
**Created:** 2026-11-03
**Updated:** 2026-11-03
**Target Spec Version:** v1alpha1

> Signed Off (Engineering and Operator, 2026-11-03). The eight Open Questions were resolved with the operator through the
> decision rubric on 2026-11-03, one at a time; each carries a Resolution block below. The
> phase tasks are filed after this RFC lands on `main`. When this RFC reaches Implemented, RFC-0042's lifecycle
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

The verdict record, as resolved by OQ-1, OQ-4, OQ-6 and OQ-7. It is stored as `record.json` in the
tree of `refs/ai-sdlc/verdicts/<headSha>`, beside `leaves.jsonl`. `independenceTier` uses the
shipped RFC-0046 values `none | attested | isolated`:

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
      "independenceTier": "attested",
      "verdict": "approved"
    }
  ],
  "coverage": { "policy": "review-policy@sha", "required": ["…"], "satisfied": true },
  "evidence": { "leaves": "leaves.jsonl", "digest": "sha256:…" },
  "issuedBy": { "principal": "pipeline-step-11 | ci-clean-room", "at": "2026-11-03T00:00:00Z" },
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
- [x] Phase 4: adopter path per OQ-3 (`consumer-verify-attestation.yml`,
      `cli-attestation verify`, release note).
- [x] `requiresDocs` set to `operator-runbook` at Ready for Review (2026-11-03).

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

The operator walked these one at a time through the decision rubric on 2026-11-03, never
batched. All eight are resolved; the original question text is kept above each Resolution.
The walkthrough took OQ-8 first because it bounds OQ-1 and OQ-4.

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

**Resolution (2026-11-03, full rubric):** **Verdict ref plus CI status.** Step 11 pushes the
task branch and `refs/ai-sdlc/verdicts/<headSha>` in one `git push --atomic`; the ref's tree holds
`record.json` (and the leaves, OQ-4a). The CI gate reads the ref, checks subject and coverage, and
posts the result into `ai-sdlc/pr-ready` with the workflow token it already uses. Industry research:
SLSA's source tool and git-appraise keep review data in refs or notes outside the branch; gittuf uses
`refs/gittuf/attestations`; GitHub check runs can be created only by a GitHub App, and a commit status
carries a description of at most 140 characters. **Substantive gaps surfaced:** the repository has no
GitHub App and every status today is posted by CI with `github.token`
(`attestation-post.yml`); the local pipeline's user token can post statuses but never check runs, so
option (a) "check run posted by the pipeline" was not available as written; a status alone cannot hold
the record body. **Refinement:** the OQ-8 fence becomes a concrete rule: a push to
`refs/ai-sdlc/verdicts/*` is refused unless it comes from the Step 11 ship step (or the trusted CI
writer of OQ-7); the namespace needs a pruning policy (refs of heads on closed or merged PRs) decided
in the Phase 1 task. **Counter-argument:** "A custom ref namespace is new machinery; one status from
Step 11 is one API call." Rebuttal: the digest in a status would point at nothing, because the body
must live somewhere for the catch report and for audit, and a status lands after the `pull_request`
event, so the gate would need a second trigger and a race window; the atomic push delivers the record
with the head. **Selected over a local status only, a PR comment or asset, and a GitHub App now**
because it keeps the full record, readable without GitHub, with no new principal, as OQ-8 allows.

### OQ-2: Carry-forward after a rebase

When the head changes, does the pipeline (a) always review again; (b) re-issue the record
automatically when the diff against the new base is byte-identical; (c) re-issue under a
Gerrit-style `changekind` rule (trivial rebase or message-only change) decided by tree
and diff comparison, with `patch-id` as a hint only; or (d) re-issue after a cheap
deterministic stage of the staged review (RFC-0052) confirms nothing changed? Who runs
the re-issue (the executor's ship step, the dispatch re-enter path, or the gate itself)
is part of this question.

**Resolution (2026-11-03, full rubric):** **Clean-replay rule, evaluated by the gate.** An
earlier verdict for the same PR carries forward to a new head only when (i) the new head's tree equals
the reviewed head's tree (message-only change), or (ii) `git merge-tree --write-tree
--merge-base=<reviewed baseSha> <new baseSha> <reviewed headSha>` is conflict-free and its tree equals
the new head's tree. Anything else needs a fresh review. Industry research: Gerrit's `copyCondition`
copies approvals only for `TRIVIAL_REBASE` and `NO_CODE_CHANGE`; gittuf binds approvals to the merge
tree; git documents `patch-id` as only "reasonably unique". **Substantive gaps surfaced:**
`governance/rebase-rearm.ts` and `next-step/resume-decision.ts` decide "rebase only" by patch-id
equality alone and never compare trees; this rule replaces that comparison (replacement semantics:
the patch-id path is deleted, not kept beside the new rule). **Refinement:** one pipeline-cli function
implements the rule; the CI gate calls it, finding earlier records for the PR among the verdict refs,
and writes `carriedForwardFrom` into its result; resume and rebase re-arm call the same function
locally to decide whether review is needed. No rebasing path writes a verdict, so Step 11 stays the
only local writer. Requires git 2.40 or later. **Counter-argument:** "A clean replay is not
semantically safe; main may have changed code the PR calls." Rebuttal: re-review would show reviewers
the same diff, since their remit is the change; interaction breakage is what CI tests on the new head
catch, the same risk Gerrit's trivial-rebase rule accepts. **Selected over always re-review,
byte-identical diff and a staged-review confirmation stage** because those spend reviewer cost or add
writers outside Step 11 without adding coverage the tests do not already give.

### OQ-3: Adopter migration and the v6 cut

(a) Hard cut, per DEC-0284's precedent (v6 refused from the cutover release, release note
only); (b) a dual-read window of N releases in which the checker accepts either a v6
envelope or a verdict record; (c) keep `cli-attestation verify` as the adopter entry
point with the same exit codes and the same `ai-sdlc/attestation` context name, whatever
the window. Whether the `pipeline-cli-version` input and the exact-version pins in
`adopter-attestation-verify-ci.md` constrain the choice belongs here.

**Resolution (2026-11-03, full rubric):** **Hard cut, names kept.** v6 is refused as a
signed or verified format from the cutover release (DEC-0284 precedent). `cli-attestation verify`, its
exit codes, the `consumer-verify-attestation.yml` workflow and the `ai-sdlc/attestation` status context
keep their names and check the verdict record instead. Industry research: Kubernetes and Stripe run
9-12 month deprecation windows because they have real external consumers; GitHub branch protection
names required checks by context string, so a renamed context is never posted and blocks every PR.
**Substantive gaps surfaced:** the consumer workflow pins an exact `pipeline-cli-version` (default
0.31.0) and the adopter doc tells adopters to pin both the workflow SHA and that version, so a pinned
adopter moves producer and verifier together; no external adopter consuming attestation was found.
**Refinement:** the release note and `adopter-attestation-verify-ci.md` state that the names are kept
for branch-protection compatibility and now mean the verdict check. **Counter-argument:** "No adopter
exists; delete the adopter path rather than keep a misleading name." Rebuttal: absence of evidence is
not evidence of absence for a published, documented workflow; keeping the names costs one doc
paragraph, and the path can still be deleted after a release passes with no consumer. **Selected over
a renamed cut, a dual-read window and deleting the adopter path** because the version pin already
protects adopters, a window would keep alive the code this RFC deletes, and a rename silently breaks
required-check rules.

### OQ-4: What happens to the transcript leaves and the audit trail

The leaves are the only evidence that a reviewer ran. (a) Drop them: the record's
reviewer list is the evidence; (b) keep them outside the branch, referenced from the
record by digest (notes ref, release asset, or check-run output); (c) keep them in the
branch as today but stop signing them (keeps P1's growth and chore commits). Where the
catch ledger lives is decided with this question.

**Resolution (2026-11-03, full rubric; asked as two sub-questions):**

- **OQ-4a, leaves: stored in the verdict ref.** The leaves are kept as plain JSONL (`leaves.jsonl`) in
  the tree of the verdict ref beside `record.json`, referenced from the record by digest. The Merkle
  construction and the signing code are still deleted. Industry research: in-toto and SLSA keep
  evidence as separate digest-referenced statements outside the source tree; git-appraise keeps review
  data in refs. **Gap surfaced:** about 1,063 leaf files and 1,271 envelopes are committed today, and
  outside the signer and verifier only sizing and housekeeping code reads them
  (`attestation-growth.ts`, doctor gitignore checks, `ship.ts`, `merge-if-eligible.ts`). Under OQ-8 the
  gate no longer relies on them; they become investigation evidence. **Counter-argument:** "Nobody
  audited a leaf in six months; drop them." Rebuttal: every catch or false positive in the new ledger
  needs explaining (DEC-0286 was diagnosed from leaf content), and storing them in a ref OQ-1 already
  pushes costs one file. **Selected over dropping, Actions artifacts (90-day expiry, GitHub-only) and
  keeping them in the branch (P1).**
- **OQ-4b, catch ledger: derived report.** The gate writes a reason code into its status description
  (`no-record`, `subject-mismatch`, `coverage-short`, `replay-dirty`, or `tier-short`), and a report
  command compiles catches (verdict check failed while every other `ai-sdlc/pr-ready` input passed)
  from GitHub status history on demand. Industry research: delivery metrics tooling such as DORA
  dashboards derives from event history rather than a second log. **Gap surfaced:** no ledger of gate
  outcomes exists today; `.ai-sdlc/reviews/<task>.jsonl` measures reviewers, not the gate, and is out
  of this RFC's scope. **Counter-argument:** "Statuses on force-pushed-away heads can be
  garbage-collected." Rebuttal: the report can snapshot its output on demand if that ever matters, and
  catches on never-merged heads are the least important to keep. **Selected over a CI-appended ledger
  ref (needs write permission and append retries) and a periodic ledger PR (churn).**

### OQ-5: Merge queue and the merge-group SHA

If the repository adopts a GitHub merge queue (RFC-0054 OQs touch this), the queue tests a
temporary SHA that no reviewer saw. Does the verdict check (a) run on `merge_group` and
accept a record whose `treeSha` delta matches the queued head; (b) require re-issue for
the queue head; or (c) declare the merge queue out of scope until adopted?

**Resolution (2026-11-03, full rubric):** **Rule decided now, built when the queue
returns.** The merge queue stays out of scope while it is disabled. The rule is fixed now: on
`merge_group`, the gate applies the OQ-2 clean-replay check of the PR's reviewed diff against the
queue base, with no re-issue. Industry research: GitHub's queue runs required checks on a temporary
branch of the PR stacked on the queue base; Gerrit's submit-time rebase applies the same trivial-rebase
rule. **Substantive gaps surfaced:** the queue is disabled (`merge_group` removed from
`ai-sdlc-gate.yml` under AISDLC-400, restore note kept), and `merge-without-queue.md` says dropping the
queue was safe only because v6 envelopes were base-independent; that reasoning must be restated for
the verdict record. **Refinement:** the RFC records that a direct squash merge of a head that is
behind `main` is already covered: GitHub's squash is a three-way replay of the reviewed diff onto
current `main`, refused on conflict, which is what OQ-2 accepts; `merge-without-queue.md` is updated
with that reasoning. **Counter-argument:** "The queue may become attractive soon; deferring builds a
later rush." Rebuttal: the deferred work is wiring an existing function to one more event type; the
design, which is what would be rushed, is decided here. **Selected over building now (untested code
for a disabled path, which the dark-code gate exists to prevent), re-reviewing the queue head (rules
the queue out) and no rule.**

### OQ-6: Independence tier evidence (RFC-0046)

RFC-0046 derives `independenceTier` from leaf-bound evidence. With the record as the
carrier, (a) the tier is copied from the reviewer step unchanged; (b) the tier is
derived by the checker from `issuedBy` and the reviewer harness (for example, a GitHub App
or workflow identity implies at least `separate-principal`); or (c) RFC-0046 is amended to
define tiers over the record's fields.

**Resolution (2026-11-03, full rubric):** **Derived once at Step 8, copied unchanged.**
The shipped RFC-0046 derivation runs at Step 8 and its result is written to `reviewers[].independenceTier`;
the checker reads the field and enforces the required tier without recomputing it. `isolated` is set
only on records the CI clean-room path issues (OQ-7). Industry research: SLSA treats who reviewed as a
platform-asserted property; in-toto verifiers check signatures over claims rather than re-deriving
them; recomputation helps only when the evidence comes from a different principal. **Substantive gaps
surfaced:** the v0.1 sketch used the values `same-session` and `separate-principal`; the shipped enum is
`none | attested | isolated` (`attestation/merkle.ts`), with `attested` derived from a
`SubagentStart` marker, nonce and allowlisted agent type (`attestation/verdict-class.ts`) and
`isolated` credited only to the CI-only key. The sketch is corrected to the shipped values.
**Refinement:** the RFC states that the tier is a pipeline claim, consistent with OQ-8; RFC-0046 is
amended for the carrier only, the derivation is unchanged, and the consumer workflow's
`required-independence-tier` input keeps working. **Counter-argument:** "This is weaker than v6, where
a signed leaf carried the tier." Rebuttal: under OQ-8 forgery by a token holder is outside the trust
claim, and the leaves a checker would recompute from are pushed by the same token holder, so
recomputation adds a second derivation site (P4) without adding a principal. **Selected over checker
inference from `issuedBy`, checker recomputation and dropping tiers.**

### OQ-7: Untrusted PRs (RFC-0043)

The clean-room signer builds a v6 envelope for untrusted PRs. (a) It builds the verdict
record instead, issued by the workflow identity, which naturally satisfies OQ-1 (b) or (d)
for that path only; (b) untrusted PRs keep a separate check that this RFC does not touch;
(c) one record format for both paths, with `issuedBy` distinguishing them.

**Resolution (2026-11-03, full rubric):** **One format, split writer.** The clean-room job
emits the verdict record as an Actions artifact. A separate trusted `workflow_run` workflow, which never
checks out or reads PR content, validates the record's schema, checks that `subject.headSha` is the PR
head and that the review jobs concluded, then pushes `refs/ai-sdlc/verdicts/<headSha>` with
`issuedBy.principal: ci-clean-room` and tier `isolated`. The checker is the same one used for trusted
PRs. Industry research: GitHub's security guidance on "pwn requests" says never to combine a
write-scoped token with untrusted PR content in one job, and to act on an artifact in a separate
`workflow_run`; SLSA separates the build touching untrusted input from the provenance signer.
**Substantive gaps surfaced:** the clean-room job signs v6 with a key written from the stored secret
`AISDLC_SIGNING_KEY_CONTENT` and uses no OIDC; pushing a ref needs `contents: write`, which beside
prompt-injectable AI reviewers would let an injected reviewer push to any unprotected branch.
**Refinement:** the trusted writer is the second sanctioned writer of the verdict namespace (the OQ-1
fence names it); it repurposes `attestation-post.yml`'s slot rather than adding a workflow; the signing
secret is deleted in Phase 3. **Counter-argument:** "The extra hop adds latency and a workflow; let the
clean-room job post its own status." Rebuttal: that gives the checker two verdict paths, the P4
failure this RFC closes, and a poisoned artifact can at worst claim approval for the PR it reviewed,
no more than a forged status. **Selected over the clean-room job pushing the ref itself, a direct
status with no record, and leaving untrusted PRs on v6 (contradicts OQ-3).**

### OQ-8: What the gate must prove, as a written threat model

The review found that the trust claim was never stated in one place. Before Signed Off
the RFC must say which of these the gate guarantees and which it does not: that a
reviewer step ran; that it ran against this head; that the reviewer was a different
principal from the author; that the verdict was not edited after the fact; and that the
record can be verified without GitHub. The answer feeds OQ-1 and OQ-4 and sets the catch
ledger's definition of a catch.

**Resolution (2026-11-03, full rubric):** **Error-resistant, not forgery-resistant.** The gate
guarantees that (1) the pipeline's reviewer step ran and (2) it ran against this exact head (or a head
OQ-2 accepts as a clean replay). (4) "Not edited after the fact" holds as an audit trail: a re-posted
status or re-pushed ref leaves history with its creator. The gate does **not** guarantee (3) that the
reviewer was a different principal from the author, nor (5) verification without GitHub, beyond the
record being readable from git. The threat it defends against is a goal-seeking or mistaken agent,
the 2026-05-20 shape; a deliberately adversarial agent holding the operator token is outside the claim.
Industry research: SLSA's Source Track has provenance issued by the platform and two-party review by
trusted persons at its top level; GitHub and Gerrit get independence from a server-enforced identity;
gittuf ignores approvals signed by the change's own signer. **Substantive gaps surfaced:** the only
recorded incident (2026-05-20) had no check that reviewers ran at all; the hook signed whatever files
were on disk. No adversarial agent act is on record, and AISDLC-568 already concedes v6 proves only
that a transcript exists. **Refinement:** only the pipeline writes a verdict (OQ-1 and OQ-7 name the
two writers); a hook refuses agent sessions any push to `refs/ai-sdlc/verdicts/*` or any status post
with the gate's context; **upgrade trigger:** one forged or out-of-pipeline verdict found by the catch
report (OQ-4b), or a recorded decision granting agents broader autonomy, reopens this question for a
separate-principal issuer (a GitHub App or a CI workflow identity). **Counter-argument:** "A hook fence
is the same thin control the 2026-05-20 agent got past; without a separate principal this rebuilds
v6's weakness." Rebuttal: that agent got past no check, because none existed; here the verdict is a
product of Step 8, not files an agent writes, and forging one means deliberately calling a refused
path, which the hook denies and the report would show. **Selected over forgery-resistant, full
SLSA-style and bare minimum** because the separate principal is a permanent infrastructure cost
against a threat with no recorded instance, and the trigger escalates on evidence.

## Sign-Off

All eight Open Questions resolved on 2026-11-03.

| Role | Owner | Status | Date |
|---|---|---|---|
| Engineering | Dominique Legault | ✅ Signed (all eight OQs walked with the full rubric; error-resistant claim, verdict ref, clean-replay carry-forward) | 2026-11-03 |
| Operator | Dominique Legault | ✅ Signed (hard v6 cut with names kept; tasks filed after landing, not dispatched) | 2026-11-03 |
| Product | | pending | |
| Design | | pending | |

## Revision History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-11-03 | Draft from the 2026-11-03 attestation design review: four v6 design properties, goals against outcomes, proposal shape, eight unresolved OQs. |
| v0.3 | 2026-11-03 | Signed Off by Engineering and Operator; Product and Design pending. |
| v0.2 | 2026-11-03 | All eight OQs resolved with the operator through the decision rubric; Draft to Ready for Review; `requiresDocs: [operator-runbook]`. OQ-8: error-resistant trust claim with a hook fence and an upgrade trigger. OQ-1: `refs/ai-sdlc/verdicts/<headSha>` pushed atomically by Step 11, CI posts the gate result; no GitHub App. OQ-2: clean-replay tree rule in one function, run by the gate; patch-id comparison replaced. OQ-3: hard v6 cut, `cli-attestation verify` and `ai-sdlc/attestation` names kept. OQ-4: leaves in the verdict ref tree; catch ledger derived from status reason codes. OQ-5: merge-queue rule decided, built when the queue returns; direct squash of a behind head covered. OQ-6: tier derived once at Step 8 with shipped values `none / attested / isolated` (sketch corrected). OQ-7: untrusted PRs through an artifact plus a trusted `workflow_run` writer; signing secret deleted. |

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
