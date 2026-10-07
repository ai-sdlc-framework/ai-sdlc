# Review policy — attestation-based review

**Status:** in force (DEC-0065, operator decision of 2026-10-06). This page is the
citable statement of how code review works in AI-SDLC and in repositories that adopt
it. It is written so the OpenSSF Best Practices questionnaire can link to it.

## Policy in one paragraph

`main` requires **0 human approving reviews**. The review signal is a **signed
three-reviewer attestation** (code, test, security) that the `verify-attestation.yml`
workflow verifies and that feeds the single required rollup check `ai-sdlc/pr-ready`
(with `Backlog Drift`). A change cannot reach `main` without that rollup passing. A
human can always review, request changes or override (see "Human override").

## What counts as a review

A review is counted only when all of these hold:

1. **Three reviewers ran**: `code-reviewer`, `test-reviewer` and `security-reviewer`,
   each as its own subagent run against the exact diff being merged.
2. **Cross-harness independence**: the reviewer harness must differ from the harness that
   implemented the change where the independence policy requires it (a Claude-implemented
   change is not reviewed by Claude as code or test reviewer). See
   [`independence-policy.md`](independence-policy.md) and
   [`cross-harness-review.md`](cross-harness-review.md).
3. **Each verdict is a transcript leaf** (see below), bound to the diff and to the
   reviewer run that produced it.
4. **The signed envelope covers the PR's code state.** Docs-only PRs skip the
   attestation workflows and need no envelope.

A coordinator agent self-writing a verdict does not count: a leaf not bound to a real
reviewer run is recorded as `self-authored` and is not credited as independent.

## Nonce-bound reviewer transcripts

Before a reviewer runs, the coordinator embeds a per-diff **nonce** in the reviewer's
prompt. When the leaf is emitted (`cli-attestation.mjs emit-leaf --nonce ...`), the
harness transcript of that reviewer run must contain the same nonce. That proves the run
reviewed this diff and not another one. The leaf records the hash of that harness
transcript (`harnessTranscriptHash`). Leaves are appended to
`.ai-sdlc/transcript-leaves.jsonl`; the transcripts live under
`.ai-sdlc/transcript-leaves/`. Details: [`independence-policy.md`](independence-policy.md).

## The v6 envelope

The signer (`ai-sdlc-plugin/scripts/sign-attestation.mjs`) builds an RFC-6962 Merkle
tree over the transcript leaves, signs the root with the operator's key and writes a
DSSE envelope to `.ai-sdlc/attestations/<patch-id>.v6.dsse.json` (plus a per-SHA
compatibility copy). The envelope name is content-addressed by `git patch-id`, so a
conflict-free rebase does not invalidate it. The verifier checks the Merkle proof, the
root signature against the keys in `.ai-sdlc/trusted-reviewers.yaml`, and that the
envelope binds to the PR's code state. Any source byte changed after signing fails
verification. Honest scope: this proves a real review ran against the exact code state
by a process with repo access; it does not by itself prove reviewer identity.

When the envelope verifies on a `pull_request_target` run, the workflow also posts an
APPROVE review from the Actions token so GitHub and Scorecard see "reviewed" (see
[`quality-gate.md`](quality-gate.md)). It never approves an invalid or fork PR.

## How an adopter verifies an envelope

From a checkout of the PR head, with a trusted copy of the verifier installed outside the
checkout (see [`adopter-attestation-verify-ci.md`](adopter-attestation-verify-ci.md) for
the full CI recipe and the trust boundary):

```bash
node <verifier-home>/node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs verify \
  --head <head-sha> --base <base-sha>
```

Exit code `0` is `status=valid`, `1` is `status=invalid`, `2` means no trusted runtime
could be resolved (fail closed). Inside this repository the same check is
`node ai-sdlc-plugin/scripts/verify-attestation.mjs`. Failures are explained in
[`attestation-troubleshooting.md`](attestation-troubleshooting.md). Run `ai-sdlc doctor`
to see whether a repository has the keyring, workflow and branch protection in place.

## Human override

The attestation is a required signal, not a replacement for people:

- A maintainer can review any PR and request changes; unaddressed changes-requested
  blocks merge.
- Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`; when it permits
  an agent to merge, the only path is `cli-merge-if-eligible`, which requires green checks
  and a CLEAN merge state. The release-please rolling PR lands only on an explicit
  operator instruction.
- A maintainer can hold, close or revert any PR, and can raise `main`'s required approvals
  at any time. Emergency gate bypass is operator-only and documented in
  [`emergency-bypass.md`](emergency-bypass.md); every use is recorded in the PR body.
- Decisions that weaken a control are recorded in the decision catalog and reviewed by
  the operator ([`decision-authority.md`](decision-authority.md)).
