# Adopter CI recipe: checking the review verdict in a consumer repo (RFC-0061)

RFC-0061 replaced the signed v6 attestation envelope with a review verdict record that lives outside the branch (`refs/ai-sdlc/verdicts/<headSha>`). The adopter check now reads that record. This page replaces the v6 envelope recipe (AISDLC-566, AISDLC-575, AISDLC-757).

## Hard cut and kept names

**Release note: hard cut.** From the cutover release the v6 envelope is no longer signed or verified (DEC-0284 precedent). There is no dual-read window. An adopter that upgrades the pin gets the verdict check; `cli-attestation verify` given a v6 envelope fails with `attestation-schema-v6-refused`. Envelopes already on your `main` are ignored.

The names are kept for branch-protection compatibility (RFC-0061 OQ-3): the workflow file `consumer-verify-attestation.yml`, its inputs (`pipeline-cli-version`, `required-independence-tier`, `ai-sdlc-ref`), the composite action `verify-attestation-base`, the `cli-attestation` entry point, the exit codes (0 pass, 1 fail) and the `ai-sdlc/attestation` status context. Your required-check configuration and your caller workflow keep working unchanged.

**The pin moves producer and verifier together.** The verdict record is written by the pipeline at the version you run locally (`/ai-sdlc execute`) and read by the verifier at `pipeline-cli-version` and `ai-sdlc-ref`. A producer and a verifier on different sides of the cutover disagree: a v6 producer leaves no record, so the new verifier reports `no-record`, and a new producer with an old verifier finds no envelope. Update the plugin, `ai-sdlc-ref` and `pipeline-cli-version` in the same change.

## Recommended: one-line reusable workflow

The workflow checks the PR's verdict against the **base branch's** trust roots, so a PR cannot edit the gate it is judged by:

```yaml
name: verify-attestation
on:
  pull_request_target: # REQUIRED: the gate definition must come from the base branch
    branches: [main]
permissions:
  contents: read
jobs:
  verify-attestation:
    uses: ai-sdlc-framework/ai-sdlc/.github/workflows/consumer-verify-attestation.yml@<pinned-commit-sha>
    with:
      ai-sdlc-ref: <pinned-commit-sha> # the SAME 40-hex SHA as above
```

Pin the SHA in **both** places: the `uses:` ref pins the workflow, and `ai-sdlc-ref` pins the tooling (action, policy-floor check, docs-only classifier) checked out beside it. `ai-sdlc-ref` is required, has no default, and the job fails closed unless it is a full 40-hex commit SHA. The job also fails first unless the caller is triggered by `pull_request_target`.

Optional inputs: `pipeline-cli-version` (an **exact pin**, `x.y.z`, of the installed `@ai-sdlc/pipeline-cli` / `@ai-sdlc/orchestrator`, default `0.31.0`; no caret or range is applied) and `required-independence-tier` (`none|attested|isolated`). The tier is a floor on your base policy's `requiredTier` and is also passed to the verdict check, which fails with `tier-short` when the record's reviewers sit below it.

**Docs-only exemption set.** Consumers inherit ai-sdlc's docs-only exemption (`scripts/is-docs-only-changeset.mjs` from the pinned tooling): a PR whose every changed path is a root `*.md` (including `CLAUDE.md` and `AGENTS.md`), under `docs/`, `spec/rfcs/`, `backlog/tasks/`, `backlog/completed/` or `.ai-sdlc/_decisions/` skips the check. The changed-path list is the merge-base diff with rename detection off, so renaming a source or workflow file into `docs/` still counts as touching the source path.

What it does, in order: checks out the **base** sha only (`persist-credentials: false`, `contents: read`); fetches the head as git objects without checking it out and fails closed if the fetched sha differs from the event head sha; runs the docs-only classifier, the policy-floor check and `cli-attestation verdict-check` from trusted tooling, never from the PR. The check fetches `refs/ai-sdlc/verdicts/<head>` (or carries an earlier approved record forward when the reviewed diff replays cleanly after a rebase) and exits 0 only on `ok` or `ok-carried:<sha>`. PR values reach scripts only through `env:`. The workflow does not post the `ai-sdlc/attestation` status itself, since it holds `contents: read` only; its job result is the check. To post the status, run `cli-attestation verdict-check --post-status` from a job with `statuses: write`.

**Trust claim.** The check is error-resistant, not forgery-resistant: it proves the pipeline's reviewer step ran against this head, not that the reviewer was a different principal from the author. See [`attestation-reference.md`](attestation-reference.md) for the claim in full and the upgrade trigger.

If you cannot use `workflow_call` (for example you need extra steps in the same job), use the composite action `ai-sdlc-framework/ai-sdlc/.github/actions/verify-attestation-base@<sha>` after your own base-sha checkout; it takes the same inputs plus `base-sha`, `head-sha`, `head-repository`, `github-token` and the optional `repository` and `pull-request`.

## Trust boundary

The checker decides whether **untrusted PR content** is trusted, so the code it runs must not come from that content. Install the runtime in a directory outside the checkout (the workflow does, under `$RUNNER_TEMP`), never from the PR's own `package.json` or lockfile, and never run a script from the head. The verdict record itself is data in a ref that only the pipeline writes (Step 11, or the split CI writer for untrusted PRs); a hook refuses agent sessions any push to `refs/ai-sdlc/verdicts/*`.

## Prerequisites

1. Node 22 on the CI runner. No Claude Code plugin required.
2. `@ai-sdlc/orchestrator` and `@ai-sdlc/pipeline-cli` installed at an exact version, outside the PR checkout.
3. Your pipeline pushes verdict refs to the repository the check reads (`/ai-sdlc execute` Step 11).

## Fallback: hand-written GitHub Actions job

```yaml
name: verify-attestation

on:
  pull_request_target:
    branches: [main]

permissions:
  contents: read

jobs:
  verify-attestation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 0 # the clean-replay rule walks history

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Install the TRUSTED runtime outside the checked-out repo.
      - name: Install trusted verifier runtime
        run: |
          home="$RUNNER_TEMP/ai-sdlc-verifier"
          mkdir -p "$home" && cd "$home"
          npm init -y >/dev/null
          npm install --no-save --save-exact --ignore-scripts '@ai-sdlc/orchestrator@0.31.0' '@ai-sdlc/pipeline-cli@0.31.0'
          echo "AI_SDLC_VERIFIER_HOME=$home" >> "$GITHUB_ENV"

      - name: Check the review verdict
        env:
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          node "$AI_SDLC_VERIFIER_HOME/node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs" verdict-check \
            --head "$HEAD_SHA" --base "$BASE_SHA" --repository "$REPOSITORY" --pull-request "$PR_NUMBER"
        # Exit 0 on ok or ok-carried, 1 otherwise. The first stdout token is the reason code.
```

This hand-written job must run under `pull_request_target` with the base sha checked out; under `pull_request` a PR can edit its own gate. It does not fetch the head objects the clean-replay carry-forward needs, so add the head fetch from `consumer-verify-attestation.yml` if you rely on carry-forward after rebases.

## What `cli-attestation verdict-check` does

1. Fetches `refs/ai-sdlc/verdicts/<head>` from `origin` and reads `record.json`.
2. Checks the record's subject against the head, the coverage rule against the changed paths, and the independence tier against `--required-tier`.
3. When there is no record for this head, looks for an earlier approved record of the same PR and carries it forward only if the reviewed diff replays cleanly onto the current base.
4. Prints `<code> <detail>` and exits 0 on `ok` or `ok-carried:<sha>`, 1 otherwise. Codes: `no-record`, `subject-mismatch`, `coverage-short`, `replay-dirty`, `tier-short`.

## Local dry run

```bash
node pipeline-cli/bin/cli-attestation.mjs verdict-check \
  --head "$(git rev-parse HEAD)" \
  --base "$(git merge-base origin/main HEAD)" \
  --repository <org>/<repo>
```
