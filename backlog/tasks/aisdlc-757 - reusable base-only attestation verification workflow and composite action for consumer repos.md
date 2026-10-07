---
id: AISDLC-757
title: >-
  Reusable base-only attestation verification workflow and composite action for consumer repos
status: To Do
assignee: []
created_date: '2026-10-07'
labels:
  - attestation
  - consumer-ci
  - rfc-0046
dependencies: []
references:
  - pipeline-cli/src/cli/attestation.ts
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/adopter-attestation-verify-ci.md
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Context. Consumer repos (local-trades, ReliableGenius/local-trades) hand-write the CI job that verifies review attestations, because ai-sdlc ships only the CLI (`cli-attestation verify` and `cli-attestation independence-policy`) and a docs recipe, with no `workflow_call` workflow and no composite action. Each consumer repeats the same security-sensitive plumbing and gets it wrong in the same way: the job ran under `on: pull_request`, so the PR head could edit the gate it was judged by. local-trades PR #869 (LT-735) fixed this with a separate `pull_request_target` workflow, `verify-attestation-base.yml`. Nothing in it is local-trades specific, and it is the reference design for this task. Owner direction from 2026-09-04 (LT-539 to LT-541): framework fixes belong upstream, not in consumer forks.

Reference design to port (from local-trades #869). Check out the BASE sha only, with persist-credentials false and `contents: read`. Fetch head objects without checking them out, and fail closed when the fetched sha differs from the event head sha. Copy only the envelope and the transcript leaves from head, as untrusted data, through a base-branch script that refuses symlinks and path escapes. Keep the trust root (`.ai-sdlc/trusted-reviewers.yaml` and the policy files) from base. Run the classifier, `cli-attestation verify` and `cli-attestation independence-policy` as base copies. Pass PR values only through `env:`. The tamper cases that must go red are: an edited gate step on head, a forged exempt classifier, NODE_OPTIONS injected via GITHUB_ENV, and a replaced gate script.

Scope:

1. Add a reusable workflow `.github/workflows/consumer-verify-attestation.yml` with `on: workflow_call`, taking inputs for the pipeline-cli version floor and the required independence tier, callable by a consumer in one `uses:` line.
2. Add a composite action under `.github/actions/verify-attestation-base/` for consumers who cannot use workflow_call.
3. Add hermetic workflow tests under `.github/workflows/__tests__/`, following the existing pattern there.
4. Update `docs/operations/adopter-attestation-verify-ci.md` to make the reusable workflow the primary recipe and the hand-written job the fallback.
5. Add a note that `independence-policy` is the consumer-CI entrypoint for independence enforcement, with no stdout parsing of `verify`.

Sequencing: none; AISDLC-612 (docs for requiredTier) is related but independent.

Out of scope: AISDLC-701 leaf-to-role binding hardening stays separate.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: A consumer workflow of a single `uses:` line verifies a PR's envelope against base-branch trust roots.
- [ ] AC-2: The four tamper cases (edited gate step on head, forged exempt classifier, NODE_OPTIONS injected via GITHUB_ENV, replaced gate script) fail the gate in the hermetic tests.
- [ ] AC-3: The independence tier is enforced through `cli-attestation independence-policy` with the consumer's `.ai-sdlc/independence-policy.yaml`, with no bespoke script.
- [ ] AC-4: The adopter docs page shows the one-line recipe first.
- [ ] AC-5: `pnpm test` workflow YAML tests pass.
<!-- AC:END -->
