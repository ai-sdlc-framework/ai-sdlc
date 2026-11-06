---
paths:
  - "pipeline-cli/src/attestation/**"
---

# Review attestations

- **The merge gate reads the review verdict (RFC-0061).** `/ai-sdlc execute` records reviewer verdicts outside the branch and `cli-attestation verdict-check` feeds the `ai-sdlc/pr-ready` rollup. No attestation file, transcript leaf or Merkle tree is committed; `.ai-sdlc/attestations/` and `.ai-sdlc/transcript-leaves/` are gone.
- **v6 is refused** (RFC-0061 phase 3, DEC-0284): a v6 envelope given to `cli-attestation verify` fails with `attestation-schema-v6-refused`. There is no signer, verifier or patch-id code.
- Never add source, tests, configs or RFCs to `CONTENTHASH_SHARED_CHURN_FILES`.
- Algorithms, rebase relaxations, history: [`docs/operations/attestation-reference.md`](docs/operations/attestation-reference.md), [`docs/operations/attestation-troubleshooting.md`](docs/operations/attestation-troubleshooting.md).
- `ai-sdlc-review.yml` (`Analyze PR`, `Post Review Results`) is the CI review tier for UNTRUSTED PRs only (fork, non-collaborator, or a bot such as Dependabot; AISDLC-824); trusted PRs never enter it.
