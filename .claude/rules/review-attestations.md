---
paths:
  - ".ai-sdlc/attestations/**"
  - "pipeline-cli/src/attestation/**"
  - "scripts/verify-attestation.mjs"
  - "scripts/check-attestation-sign.sh"
---

# Review attestations

- **Required for code PRs.** `/ai-sdlc execute` runs three reviewers and writes a DSSE envelope `.ai-sdlc/attestations/<patch-id>.v6.dsse.json`. The `attestation-gate` job of `ai-sdlc-gate.yml` posts `ai-sdlc/attestation`, which feeds the `ai-sdlc/pr-ready` rollup; branch protection requires only `ai-sdlc/pr-ready`. Docs-only PRs skip it.
- **v6 is the default schema** (RFC-0042): Merkle tree over `.ai-sdlc/transcript-leaves.jsonl` (`cli-attestation.mjs emit-leaf`). Opt out with `--schema-version v5` or `AI_SDLC_V5_LEGACY=1`.
- **Lockstep (AISDLC-618):** `PATCH_ID_EXCLUSIONS` (`pipeline-cli/src/attestation/patch-id.ts`) has THREE copies that change together: `ATTESTATION_PATH_EXCLUSIONS` in `scripts/verify-attestation.mjs` and `PATCH_ID_EXCLUSIONS_FALLBACK` in `scripts/check-attestation-sign.sh`. Never add source, tests, configs or RFCs to `CONTENTHASH_SHARED_CHURN_FILES`.
- A v6 envelope proves a real review ran against the exact code, not reviewer independence (AISDLC-568).
- Algorithms, rebase relaxations, history: [`docs/operations/attestation-reference.md`](docs/operations/attestation-reference.md), [`docs/operations/attestation-troubleshooting.md`](docs/operations/attestation-troubleshooting.md).
- `ai-sdlc-review.yml` (`Analyze PR`, `Post Review Results`) is the CI review tier for UNTRUSTED PRs only (fork, non-collaborator, or a bot such as Dependabot; AISDLC-824); trusted PRs never enter it.
