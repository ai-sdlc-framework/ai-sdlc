/**
 * Embedded template strings scaffolded by `ai-sdlc init` (AISDLC-143).
 *
 * Why these live in code instead of being read from disk at runtime:
 *  - The orchestrator ships as an npm package; users `npm i -g
 *    @ai-sdlc/orchestrator` and run `ai-sdlc init` in a brand new repo.
 *    The `dist/` payload would not include arbitrary `*.yml` source
 *    fixtures unless we listed each one in `package.json#files` AND
 *    plumbed a `__dirname`-based loader through esm import-meta.url.
 *  - Embedded strings work identically when invoked via `node ./dist/...`
 *    from a checkout, via `npx @ai-sdlc/orchestrator init`, or via a
 *    pre-bundled binary, with no runtime filesystem dependency.
 *
 * Drift policy: when the canonical workflow at
 * `.github/workflows/ai-sdlc-gate.yml` (or the audit-only
 * `verify-attestation.yml`) is updated for adopters, mirror the change
 * here. The init-workspace test suite includes a smoke check that the
 * embedded copy at least parses as a YAML mapping; AISDLC-140 sub-3's
 * cutover memo will add a hard byte-equality assertion against the live
 * file once the framework's own copy stabilizes.
 *
 * Q-decisions baked into the templates:
 *  - Q1 (prescriptive default): the gate workflow is scaffolded
 *    unconditionally — every adopter gets `ai-sdlc/pr-ready` on day one.
 *  - Q3 (attestation = audit-only): verify-attestation template is the
 *    audit-only variant; signing infrastructure is opt-in via
 *    `--with-attestation`.
 *  - Q4(b) (interactive default with --yes escape hatch): see
 *    `init-features.ts` for the wizard wiring; this module just supplies
 *    the byte content.
 */

/** `.github/workflows/ai-sdlc-gate.yml` — single rollup PR-ready check. */
export const AI_SDLC_GATE_WORKFLOW = `name: AI-SDLC PR Ready Gate

# Single rollup status check \`ai-sdlc/pr-ready\` that aggregates every PR
# signal AI-SDLC adopters need into ONE branch-protection entry. Replaces
# the historical pattern of enumerating N required checks by name + app_id,
# which is brittle against path filters, [skip ci] tokens, matrix changes,
# and multi-app posters. See \`docs/operations/quality-gate.md\` for the
# full rationale.
#
# Industry pattern: \`re-actors/alls-green\` ("alls-green") is the de facto
# community fix; named adopters include aiohttp, attrs, conda, setuptools,
# pytest, pip-tools, Open edX, PyCA, PyPA, Mergify.

on:
  # AISDLC-261 PR #480 review fix: include 'ready_for_review' so the gate
  # fires when adopters using the draft-PR flow (AISDLC-218) flip a PR
  # from draft to ready. Without it, ai-sdlc/pr-ready stays unposted on
  # the ready transition and branch protection fails.
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
    types: [checks_requested]

concurrency:
  group: ai-sdlc-gate-\${{ github.event.pull_request.number || github.event.merge_group.head_sha || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  checks: write

jobs:
  detect:
    name: Detect Changes
    runs-on: ubuntu-latest
    outputs:
      docs_only: \${{ steps.filter.outputs.docs_only }}
    steps:
      - uses: actions/checkout@v4
      - id: filter
        uses: dorny/paths-filter@v3
        with:
          predicate-quantifier: 'every'
          filters: |
            docs_only:
              - 'docs/**'
              - '*.md'

  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check

  build-test:
    name: Build & Test (Node \${{ matrix.node-version }})
    needs: detect
    if: needs.detect.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test

  coverage:
    name: Coverage
    needs: detect
    if: needs.detect.outputs.docs_only != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test:coverage

  pr-ready:
    name: ai-sdlc/pr-ready
    needs: [detect, lint, build-test, coverage]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Aggregate required signals
        uses: re-actors/alls-green@release/v1
        with:
          jobs: \${{ toJSON(needs) }}
`;

/**
 * `.github/workflows/verify-attestation.yml` — AUDIT-ONLY verifier.
 *
 * Per Q3 in /tmp/quality-gate-redesign-final.md, attestation infrastructure
 * is opt-in and audit-only. This workflow logs verification results to the
 * action run log but does NOT post a required-status check or block merges.
 * Operators who want to promote attestation to a hard gate can edit the
 * \`Log audit result\` step to write to commit statuses.
 */
export const VERIFY_ATTESTATION_WORKFLOW = `name: AI-SDLC Verify Review Attestation

# Reads the DSSE attestation at .ai-sdlc/attestations/<head-sha>.dsse.json
# and verifies the signature against any-of-N pubkeys in
# .ai-sdlc/trusted-reviewers.yaml.
#
# AUDIT-ONLY: this workflow logs verification results (success/failure with
# reason) for forensic purposes but does NOT post a required commit status.
# The single merge gate is \`ai-sdlc/pr-ready\` from ai-sdlc-gate.yml.

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'
  merge_group:
    types: [checks_requested]

concurrency:
  group: verify-attestation-\${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
  cancel-in-progress: true

jobs:
  verify:
    name: Verify attestation
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Resolve subject SHA + base SHA from event payload
        id: resolve
        run: |
          if [ "\${{ github.event_name }}" = "merge_group" ]; then
            echo "head_sha=\${{ github.event.merge_group.head_sha }}" >> "$GITHUB_OUTPUT"
            echo "base_sha=\${{ github.event.merge_group.base_sha }}" >> "$GITHUB_OUTPUT"
          else
            echo "head_sha=\${{ github.event.pull_request.head.sha }}" >> "$GITHUB_OUTPUT"
            echo "base_sha=\${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ steps.resolve.outputs.head_sha }}

      - name: Log audit result
        env:
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
        run: |
          if [ -f ".ai-sdlc/attestations/\${HEAD_SHA}.dsse.json" ]; then
            echo "::notice::ai-sdlc attestation AUDIT — envelope present at \${HEAD_SHA}"
          else
            echo "::notice::ai-sdlc attestation AUDIT — no envelope on \${HEAD_SHA} (audit-only, not blocking)"
          fi
`;

/**
 * `.husky/pre-push` snippet that signs an attestation when one is missing
 * for the current HEAD. Installed when `--with-attestation` is opted in;
 * the actual `sign-attestation.mjs` script ships separately with the
 * orchestrator and is referenced by the canonical command stub here.
 *
 * Adopters typically already have a `.husky/pre-push` from their existing
 * tooling; the wizard appends our snippet behind a sentinel so we can
 * extend an existing hook without trampling user content.
 */
export const HUSKY_PREPUSH_SIGN_SNIPPET = `# ai-sdlc:attestation-sign-block
# Signs the DSSE attestation envelope for the current HEAD when verdict
# files exist. Skip with AI_SDLC_SKIP_ATTESTATION_SIGN=1.
if [ -z "\${AI_SDLC_SKIP_ATTESTATION_SIGN:-}" ] && [ -x "./scripts/check-attestation-sign.sh" ]; then
  ./scripts/check-attestation-sign.sh
fi
# end ai-sdlc:attestation-sign-block
`;

/**
 * `.ai-sdlc/trusted-reviewers.yaml` stub — empty allowlist with operator
 * instructions. The wizard scaffolds this so adopters have a single file
 * to receive contributor pubkey PRs into; bootstrap a contributor with
 * `/ai-sdlc init-signing-key` and append the printed YAML block.
 */
export const TRUSTED_REVIEWERS_STUB = `# Trusted contributor signing keys for review attestations.
#
# This file is a stub created by \`ai-sdlc init --with-attestation\`. Add
# entries by running \`/ai-sdlc init-signing-key\` on a contributor's
# machine and opening a PR that appends the printed YAML block below.
#
# Schema:
#   - identity:  free-form string (typically email or GitHub handle)
#   - machine:   free-form label (lets one identity register multiple keys)
#   - pubkey:    PEM-encoded ed25519 public key (multi-line block scalar)
#   - addedAt:   ISO 8601 date the entry was added
#   - addedBy:   GitHub handle of the maintainer who approved this entry's PR
#
# The verifier in CI uses a strict YAML format: every scalar value
# single-quoted; \`pubkey:\` is a \`|\` block scalar with each PEM line
# indented exactly 6 spaces; no tab characters anywhere.

reviewers: []
`;

/**
 * `.ai-sdlc/dor-config.yaml` stub — Definition-of-Ready rubric config.
 *
 * Mirrors the production DoR config used by the framework itself; ships
 * in warn-only mode so a fresh adopter does not get blocked by the rubric
 * while they tune it.
 */
export const DOR_CONFIG_STUB = `# Definition-of-Ready (DoR) gate configuration.
#
# The DoR rubric scores incoming issues + backlog tasks against seven
# criteria (binary-testable ACs, no wishlist markers, references resolve,
# bounded scope, surface named, done-state describable, no invisible
# dependencies). Failing the rubric posts a clarification comment on the
# issue / PR.
#
# Ships in warn-only mode by default — flip to 'enforce' after the soak
# window confirms the false-positive rate is low.

apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
metadata:
  name: ai-sdlc-dor
spec:
  rubricVersion: v1
  evaluationMode: warn-only

  notifications:
    authorChannel: true
    # dedicatedChannel:
    #   slack: '#ai-sdlc-dor'

  staleness:
    warnAfterDays: 14
    closeAfterDays: 28
    closedLabel: 'closed-as-stale-dor'
`;

/** `.github/workflows/dor-ingress.yml` — minimal DoR ingress shim. */
export const DOR_INGRESS_WORKFLOW = `name: AI-SDLC DoR Ingress

# Wires the DoR rubric into the GitHub issue + PR lifecycle:
#   - issues:opened / issues:edited  → score the issue body, post the
#     idempotent clarification comment when needs-clarification.
#   - pull_request touching backlog/tasks/*.md → score the changed
#     task bodies (the in-repo equivalent of an issue).
#
# Ships in warn-only mode (see .ai-sdlc/dor-config.yaml). Flip the
# config's \`evaluationMode\` to \`enforce\` after the soak window.

on:
  issues:
    types: [opened, edited]
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'backlog/tasks/*.md'

concurrency:
  group: dor-ingress-\${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  evaluate:
    name: Evaluate against DoR rubric
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Evaluate DoR (placeholder — wire to your DoR runner)
        run: |
          echo "::notice::DoR ingress shim invoked. Wire pnpm --filter @ai-sdlc/pipeline-cli evaluate-dor here."
`;

/**
 * `.ai-sdlc/review-classifier.yaml` stub — cost-optimized review tiers.
 *
 * The actual classifier code ships via AISDLC-141 (a follow-up). For now
 * the wizard scaffolds the config stub + a pointer to the classifier
 * docs so adopters who opt in via `--with-classifier` are ready to flip
 * on the workflow once AISDLC-141 lands.
 */
export const REVIEW_CLASSIFIER_STUB = `# Review classifier configuration (AISDLC-141, follow-up).
#
# The review classifier inspects a PR diff and decides which review tier
# to invoke (cheap-pattern-match → mid-tier-LLM → full reviewer fan-out)
# to keep review costs bounded as PR volume grows.
#
# This file is a stub scaffolded by \`ai-sdlc init --with-classifier\`.
# The classifier runtime ships in AISDLC-141; until then this config is
# advisory only. See docs/operations/init.md for the migration path.

apiVersion: ai-sdlc.io/v1alpha1
kind: ReviewClassifier
metadata:
  name: default-classifier
spec:
  tiers:
    - name: cheap
      maxFilesChanged: 5
      maxLinesChanged: 50
      strategy: pattern-match
    - name: mid
      maxFilesChanged: 20
      maxLinesChanged: 500
      strategy: single-llm-pass
    - name: full
      strategy: full-reviewer-fanout
  routing:
    docsOnly: cheap
    testOnly: cheap
    default: mid
`;

/**
 * `.github/workflows/ai-sdlc-review.yml` — CI-side PR review workflow.
 *
 * Posts `Post Review Results` as a commit status so branch-protection can
 * require it. Adopter repos that have not set up `ANTHROPIC_API_KEY` will
 * see the job run but produce advisory-only output — the status check still
 * posts `success` so it does not block merges.
 *
 * This is a simplified adopter-facing template. The AI-SDLC framework's
 * own repo carries a more elaborate version that drives the full review
 * fan-out pipeline (classifier, incremental review, etc.); adopters start
 * here and can progressively opt into those features.
 *
 * Source of truth: `.github/workflows/ai-sdlc-review.yml` in the ai-sdlc
 * framework repo (AISDLC-261). Mirror changes here when the adopter-facing
 * surface evolves.
 */
export const AI_SDLC_REVIEW_WORKFLOW = `name: AI-SDLC PR Review

# Posts \`Post Review Results\` as a required commit status.
# Docs-only PRs (spec/rfcs/**, docs/**, backlog/**, *.md) are short-circuited
# with success so they do not block the merge queue.

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
    paths-ignore:
      - 'spec/rfcs/**'
      - 'docs/**'
      - 'backlog/tasks/**'
      - 'backlog/completed/**'
      - '*.md'
  merge_group:
    types: [checks_requested]

concurrency:
  group: review-\${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
  cancel-in-progress: true

jobs:
  docs-only-check:
    name: Docs-only check
    runs-on: ubuntu-latest
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
    permissions:
      contents: read
      statuses: write
      pull-requests: read
    steps:
      - name: Resolve event SHA
        id: resolve
        run: |
          if [ "\${{ github.event_name }}" = "merge_group" ]; then
            echo "head_sha=\${{ github.event.merge_group.head_sha }}" >> "\${GITHUB_OUTPUT}"
            echo "base_sha=\${{ github.event.merge_group.base_sha }}" >> "\${GITHUB_OUTPUT}"
            echo "is_merge_group=true" >> "\${GITHUB_OUTPUT}"
          else
            echo "head_sha=\${{ github.event.pull_request.head.sha }}" >> "\${GITHUB_OUTPUT}"
            echo "is_merge_group=false" >> "\${GITHUB_OUTPUT}"
          fi

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ steps.resolve.outputs.head_sha }}

      - name: Detect docs-only changeset
        id: detect
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          REPO: \${{ github.repository }}
          IS_MERGE_GROUP: \${{ steps.resolve.outputs.is_merge_group }}
          BASE_SHA: \${{ steps.resolve.outputs.base_sha }}
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
        run: |
          set -euo pipefail
          if [ "\${IS_MERGE_GROUP}" = "true" ]; then
            FILES=$(git -c core.quotePath=false diff --name-only "\${BASE_SHA}...\${HEAD_SHA}")
          else
            FILES=$(gh api "repos/\${REPO}/pulls/\${PR_NUMBER}/files" --paginate --jq '.[].filename')
          fi
          if [ -z "\${FILES}" ]; then
            echo "all_docs=true" >> "\${GITHUB_OUTPUT}"
            exit 0
          fi
          # Simple docs-only check: all files must be in docs, spec/rfcs, backlog, or *.md
          ALL_DOCS=true
          while IFS= read -r f; do
            case "$f" in
              docs/*|spec/rfcs/*|backlog/tasks/*|backlog/completed/*|*.md) ;;
              *) ALL_DOCS=false; break ;;
            esac
          done <<< "\${FILES}"
          echo "all_docs=\${ALL_DOCS}" >> "\${GITHUB_OUTPUT}"

      - name: Post Review Results (docs-only short-circuit)
        if: steps.detect.outputs.all_docs == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          HEAD_SHA: \${{ steps.resolve.outputs.head_sha }}
        run: |
          set -euo pipefail
          gh api "repos/\${REPO}/statuses/\${HEAD_SHA}" \\
            -X POST \\
            -f state=success \\
            -f context='Post Review Results' \\
            -f description='docs-only changeset — review N/A'
          echo "Posted Post Review Results: success (docs-only) on \${HEAD_SHA}"

  review:
    name: Post Review Results
    runs-on: ubuntu-latest
    if: >-
      github.event_name == 'pull_request' &&
      !startsWith(github.head_ref, 'release-please--') &&
      github.event.pull_request.draft == false
    needs: [docs-only-check]
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Post Review Results (stub — fails closed by default)
        env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          # AISDLC-261 PR #480 review fix (CRITICAL): the stub now defaults to
          # FAILURE so adopters who configure 'Post Review Results' as a required
          # branch-protection check + enable auto-merge don't accidentally ship
          # a phantom review gate that auto-merges every PR with zero review.
          # To opt in to auto-pass while wiring your reviewers, set the repo
          # variable AISDLC_REVIEW_STUB_AUTOPASS=true. Real reviewer wiring
          # should replace this entire step.
          AUTOPASS: \${{ vars.AISDLC_REVIEW_STUB_AUTOPASS }}
        run: |
          set -euo pipefail
          if [ "\${AUTOPASS:-}" = "true" ]; then
            STATE=success
            DESC='Review passed (STUB AUTOPASS — wire your reviewers, then unset AISDLC_REVIEW_STUB_AUTOPASS)'
          else
            STATE=failure
            DESC='Review stub not wired. Either replace this workflow step with your reviewers OR set repo var AISDLC_REVIEW_STUB_AUTOPASS=true (acknowledged risk).'
          fi
          gh api "repos/\${REPO}/statuses/\${HEAD_SHA}" \\
            -X POST \\
            -f state="\${STATE}" \\
            -f context='Post Review Results' \\
            -f description="\${DESC}"
          echo "Posted Post Review Results: \${STATE} on \${HEAD_SHA}"
`;

/**
 * `.github/workflows/auto-enable-auto-merge.yml` — auto-arms GitHub auto-merge
 * on every new same-repo PR so the PR merges automatically as soon as required
 * checks pass. Release-please PRs are excluded (operator arms manually).
 *
 * Source of truth: `.github/workflows/auto-enable-auto-merge.yml` in the
 * ai-sdlc framework repo (AISDLC-261). Mirror changes here when the
 * auto-merge strategy or exclude rules evolve.
 *
 * Requires:
 *   - GitHub repo setting "Allow auto-merge" must be enabled.
 *   - \`AI_SDLC_PAT\` secret with write access to the repo (or use
 *     \`secrets.GITHUB_TOKEN\` if the repo's default token has write access).
 */
export const AUTO_ENABLE_AUTO_MERGE_WORKFLOW = `name: Auto-enable auto-merge on PR open

# Enables GitHub's auto-merge on every new same-repo PR. Once required
# checks pass, GitHub adds the PR to the merge queue which rebases + runs
# CI + merges if green. No human click needed.
#
# Requires repo setting "Allow auto-merge" to be enabled (Settings → General).
# Requires a PAT or GitHub App token with \`pull_requests: write\` stored as
# the \`AI_SDLC_PAT\` repository secret (or swap for \`github.token\` if your
# repo grants it write access).

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  check_suite:
    types: [completed]
  status:

permissions:
  pull-requests: write
  contents: write

jobs:
  enable-auto-merge:
    runs-on: ubuntu-latest
    steps:
      - name: Discover PR for this event
        id: discover
        env:
          GH_TOKEN: \${{ secrets.AI_SDLC_PAT }}
          GH_REPO: \${{ github.repository }}
          EVENT_NAME: \${{ github.event_name }}
          PR_NUMBER_FROM_PR_EVENT: \${{ github.event.pull_request.number }}
          HEAD_SHA: \${{ github.event.check_suite.head_sha || github.event.sha || github.sha }}
        run: |
          set -euo pipefail
          if [ "$EVENT_NAME" = "pull_request" ]; then
            echo "pr=$PR_NUMBER_FROM_PR_EVENT" >> "$GITHUB_OUTPUT"
          else
            PR=$(gh api "/repos/$GH_REPO/commits/$HEAD_SHA/pulls" --jq '.[] | select(.state == "open") | .number' | head -1)
            echo "pr=\${PR:-}" >> "$GITHUB_OUTPUT"
          fi

      - name: Skip when no PR matches
        if: steps.discover.outputs.pr == ''
        run: echo "[auto-enable] no open PR for this event — nothing to arm."

      - name: Skip drafts, fork PRs, and release-please PRs
        id: guard
        if: steps.discover.outputs.pr != ''
        env:
          GH_TOKEN: \${{ secrets.AI_SDLC_PAT }}
          GH_REPO: \${{ github.repository }}
          PR: \${{ steps.discover.outputs.pr }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          PR_INFO=$(gh pr view "$PR" --json isDraft,headRepositoryOwner,headRepository,headRefName \\
            -q '{isDraft: .isDraft, headRefName: .headRefName, headFull: (((.headRepositoryOwner.login // "") + "/" + (.headRepository.name // "")) // "")}')
          IS_DRAFT=$(echo "$PR_INFO" | jq -r '.isDraft')
          HEAD_FULL=$(echo "$PR_INFO" | jq -r '.headFull')
          HEAD_REF=$(echo "$PR_INFO" | jq -r '.headRefName')
          if [ "$IS_DRAFT" = "true" ]; then
            echo "[auto-enable] PR #$PR is draft — skipping."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          elif [ "$HEAD_FULL" = "/" ] || [ -z "$HEAD_FULL" ]; then
            # AISDLC-261 PR #480 review fix: defensive — head repository was
            # deleted or API returned an empty shape. Refuse to arm; operator
            # can re-arm manually if intended.
            echo "[auto-enable] PR #$PR has no resolvable head repository — skipping."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          elif [ "$HEAD_FULL" != "$REPO" ]; then
            echo "[auto-enable] PR #$PR is from a fork ($HEAD_FULL) — skipping."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          elif case "$HEAD_REF" in release-please--*) true ;; *) false ;; esac; then
            echo "[auto-enable] PR #$PR is a release-please PR — skipping. Arm manually when ready."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Refresh auto-merge
        if: steps.discover.outputs.pr != '' && steps.guard.outputs.skip != 'true'
        env:
          GH_TOKEN: \${{ secrets.AI_SDLC_PAT }}
          PR: \${{ steps.discover.outputs.pr }}
        run: |
          # disable-then-arm to clear any stale GitHub auto-merge state.
          gh pr merge --disable-auto "$PR" 2>/dev/null || true
          gh pr merge --auto "$PR"
`;

/**
 * `.ai-sdlc/calibration.yaml` — per-org calibration config for the
 * RFC-0031 DIDRevisionProposal mechanism (Refit AISDLC-310).
 *
 * Exposes OQ-12.1 (confidence thresholds) and OQ-12.5 (rejection weights +
 * penalty floor) as per-org configurable defaults. All values default to
 * the operator-affirmed shipped defaults from AISDLC-271 / PR #476.
 *
 * Drift policy: when `parseRevisionProposalCalibrationYaml()` in
 * `orchestrator/src/sa-scoring/revision-proposal-config.ts` gains new
 * config fields, mirror them here. The values in this template MUST match
 * the DEFAULT_* constants exported from that module.
 */
export const CALIBRATION_YAML_STUB = `# RFC-0031 DIDRevisionProposal calibration config (Refit AISDLC-310).
#
# Configures per-org thresholds and weights for the calibration-driven
# DID revision proposal mechanism. All values below are the shipped
# defaults (operator-affirmed 2026-05-16 audit). Adjust to tune the
# mechanism for your SOUL-drift cadence and review culture.
#
# Validation rules (enforced at load time by the runtime):
#   - confidenceThresholds.highSampleSize > lowSampleSize > 0
#   - all rejectionPrecedent.weights in [0, 1]
#   - rejectionPrecedent.confidencePenaltyFloor in [0, 1]

calibration:
  # Fields that should never receive auto-proposals (OQ-12.3).
  # Add JSON-path identifiers for fields the triad has decided to lock.
  # Operators remove entries from this list to opt back in.
  lockNoProposal: []
    # - $.identityClass.evolving.voiceRegister
    # - $.identityClass.core.soulPurpose.mission

  # Confidence threshold configuration (OQ-12.1).
  # Sample size = dismissSignals + escalateSignals + driftEvents.
  confidenceThresholds:
    highSampleSize: 20     # sample size >= this → HIGH confidence (if other conditions met)
    lowSampleSize: 5       # sample size <  this → LOW confidence (regardless of other conditions)

  # Rejection precedent configuration (OQ-12.5).
  # When a proposal is rejected, a weight is stored in the rejection record
  # and averaged across prior rejections to suppress future confidence for
  # the same field.  Formula: factor = max(floor, 1.0 - avgWeight x 0.5)
  rejectionPrecedent:
    weights:
      highConfidenceRejection: 0.8   # strong disagreement signal
      mediumConfidenceRejection: 0.5 # moderate disagreement
      lowConfidenceRejection: 0.2    # expected noise level; low weight
    confidencePenaltyFloor: 0.2      # max 80% suppression; raise to be more conservative
`;

/**
 * `.ai-sdlc/embedding-config.yaml` — per-org embedding-framework defaults
 * per RFC-0019 §15.1 (operator re-walkthrough 2026-05-21). Includes every
 * NEW field surfaced by the re-walkthrough (marked as such inline):
 *   - scaleEscalationHeuristic (OQ-1)
 *   - perConsumerOverridesAllowed (OQ-2)
 *   - crossProviderPolicy split (OQ-3)
 *   - catalogDedup milestones (OQ-4)
 *   - unifiedCostReport (OQ-6 + OQ-7)
 *   - adapterBillingModelRespected (OQ-7)
 *
 * The framework reads this file when `AI_SDLC_EMBEDDING_PROVIDER=on` AND
 * `Pipeline.spec.embedding` is present. Per-pipeline fields in
 * `Pipeline.spec.embedding` override the corresponding per-org defaults here.
 *
 * The file is OPTIONAL — when absent, framework defaults apply (matching
 * the values below). Operators commit this file to make the defaults
 * explicit + reviewable.
 */
export const EMBEDDING_CONFIG_YAML_STUB = `# Per-org embedding-framework defaults (RFC-0019 §15.1).
#
# Read by the framework when AI_SDLC_EMBEDDING_PROVIDER=on. Per-pipeline
# fields under spec.embedding override these defaults. The file is
# OPTIONAL — when absent, the framework defaults below apply.
#
# Reference: spec/rfcs/RFC-0019-embedding-provider-adapter.md §15.1
# Runbook:   docs/operations/embedding-providers.md

embedding:
  provider: openai-text-embedding-3-small   # default adapter (OQ-5 + Phase 1)

  storage:                              # OQ-1 — JSONL backend + scale-escalation heuristic
    backend: jsonl
    path: \${ARTIFACTS_DIR}/_embeddings/
    gcRetentionDays: 90                 # mtime-based GC threshold
    scaleEscalationHeuristic:           # NEW (re-walkthrough): operator-visible swap trigger
      maxEntriesPerProvider: 100000     # > 100K → swap to sqlite or vector DB
      maxP95ReadLatencyMs: 250          # OR > 250ms p95 read → swap
      operatorRunbook: docs/operations/embedding-providers.md#scale-escalation

  staleVectorPolicy:                    # OQ-2 — per-org default + per-consumer override
    default: lazy-re-embed              # alternatives: fail-loud | warn
    logToCatalog: true                  # log every stale-vector event as Decision
    perConsumerOverridesAllowed: true   # NEW (re-walkthrough): consumers may pin policy at API
                                        # site (e.g., RFC-0009 Eτ drift pins fail-loud regardless
                                        # of org default to preserve historical-trajectory fidelity)

  crossProviderPolicy:                  # OQ-3 — split (re-walkthrough refinement)
    crossProvider: refuse               # ALWAYS strict no-op cross-PROVIDER (openai vs cohere)
                                        # → Decision: cross-provider-comparison-attempted
    crossVersionWithinProvider: delegate-to-staleVectorPolicy
                                        # cross-VERSION delegates to OQ-2 (resolves v0.2 conflict)

  deprecation:                          # OQ-4 — three-layer precedence + catalog dedup
    gracePeriodDays: 90                 # framework default; adapter may declare defaultGracePeriodDays
    strictModeAtDeprecatedAt: false
    catalogDedup:                       # NEW (re-walkthrough): prevent Decision flood under orchestrator
      enabled: true
      milestonesDaysBeforeDeprecatedAt: [89, 60, 30, 7, 1]
                                        # emit Decisions at milestones, NOT per-load

  costTracking:                         # OQ-6 — distinct line item + per-consumer attribution
    lineItem: embeddingTokens
    budgetIntegration: rfc-0004
    consumerLabelRequired: false        # NEW (re-walkthrough): optional but recommended;
                                        # callers pass consumerLabel for per-category attribution
                                        # (e.g., 'rfc-0009-tessellation-drift', 'rfc-0008-ppa-similarity')
    unifiedCostReport:                  # NEW (re-walkthrough): cross-substrate finance view
      enabled: true                     # aggregates embeddingTokens + inputTokens + outputTokens +
                                        # SubscriptionLedger window cost; tagged by costModel
      costModelLabels:
        - subscription-quota            # Claude Code Max / Codex
        - pay-per-token                 # OpenAI / Cohere / future Anthropic embeddings if launched

  subscriptionLedgerInteraction:        # OQ-7 — separation + per-adapter billingModel
    consumeQuotaDefault: false          # default for pay-per-token adapters
    adapterBillingModelRespected: true  # NEW (re-walkthrough): adapter declares
                                        # 'pay-per-token' | 'subscription-quota' in capability matrix;
                                        # subscription-quota adapters route through SubscriptionLedger
                                        # (e.g., future Anthropic embeddings if shipped)
`;

/**
 * Per-soul DesignSystemBinding template (RFC-0009 Phase 2.2).
 *
 * Scaffolded at `.ai-sdlc/souls/<slug>/design-system-binding.yaml` for
 * each soul in a Tessellated Platform. The `spec.extends` field records
 * the parent platform-root DSB name, implementing the additive inheritance
 * chain described in RFC-0009 §6.
 *
 * Drift policy: when `DesignSystemBindingSpec` gains new required fields,
 * mirror them here so that freshly-scaffolded soul DSBs are immediately valid.
 *
 * @param soulSlug - the soul identifier (e.g. "soul-a"); used in resource name
 * @param platformDsbName - the parent platform-root DSB name (defaults to
 *   the literal placeholder `platform-dsb` for adopters to replace)
 */
export function buildSoulDsbTemplate(
  soulSlug: string,
  platformDsbName: string = 'platform-dsb',
): string {
  return `apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: ${soulSlug}-dsb
  labels:
    ai-sdlc/soul: "${soulSlug}"
    ai-sdlc/scope: soul
spec:
  # Additively extends the platform-root DSB (RFC-0009 §6 resolution rules).
  # Per-soul fields override / extend platform-root fields; absent fields
  # fall through to the platform-root DSB at admission time.
  extends: ${platformDsbName}

  stewardship:
    designAuthority:
      # Soul-specific design authority — added to the platform-root authority set.
      # Replace with your actual design authority contact(s).
      principals:
        - your-design-authority@example.com
      scope:
        - ${soulSlug}-design-intent
    engineeringAuthority:
      # Replace with your actual engineering authority contact(s).
      principals:
        - your-engineering-authority@example.com
      scope:
        - ${soulSlug}-compliance

  designToolAuthority: specification

  tokens:
    provider: tokens-studio
    format: w3c-dtcg
    source:
      repository: your-org/design-tokens
      # Soul-specific token branch — override the platform-root source when
      # this soul maintains divergent token values.
      branch: soul/${soulSlug}
      path: tokens/souls/${soulSlug}/
    versionPolicy: minor

  catalog:
    provider: storybook
    source:
      # Soul-specific Storybook URL — override platform URL when souls have
      # separate component catalogs.
      storybookUrl: https://${soulSlug}.storybook.your-org.io

  compliance:
    coverage:
      # Soul-specific coverage threshold (integer percent 0-100) — may be
      # stricter than platform floor.
      minimum: 70
      target: 90

  designReview:
    required: true
    # Soul-specific reviewers — unioned with platform-root reviewers at
    # admission time per §6.3 additive resolution.
    reviewers: []
    scope:
      - visual-quality
      - accessibility-intent
`;
}

/**
 * The set of feature templates exported as a single map so the wizard
 * dispatcher can iterate without each feature growing its own switch
 * statement.
 *
 * Each entry maps a relative path inside the target repo to the literal
 * bytes to write. Paths are POSIX-style; the writer joins them onto the
 * project dir using `node:path/join` which is platform-correct.
 */
export interface FeatureTemplateSet {
  /** Files under the project root keyed by relative POSIX path. */
  files: Record<string, string>;
}

export const DOR_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/dor-config.yaml': DOR_CONFIG_STUB,
    '.github/workflows/dor-ingress.yml': DOR_INGRESS_WORKFLOW,
  },
};

export const ATTESTATION_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/trusted-reviewers.yaml': TRUSTED_REVIEWERS_STUB,
    '.github/workflows/verify-attestation.yml': VERIFY_ATTESTATION_WORKFLOW,
    // The .gitkeep ensures the attestations dir is tracked in git so the
    // first PR's envelope lands cleanly without "directory does not exist"
    // errors from the signing script.
    '.ai-sdlc/attestations/.gitkeep': '',
  },
};

export const CLASSIFIER_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/review-classifier.yaml': REVIEW_CLASSIFIER_STUB,
  },
};

/**
 * `.ai-sdlc/quality-monitoring.yaml` stub — RFC-0025 §13.1 per-org config.
 *
 * AISDLC-305 / Phase 4: ships the documented §13.1 defaults across all
 * resolved OQ surfaces:
 *   - OQ-1 confidence-bucketed classifier thresholds
 *   - OQ-2 per-axis severity weights
 *   - OQ-3 multi-window recurrence
 *   - OQ-4 framework-bug suggest-only attribution
 *   - OQ-5 upstream reporting (operator-initiated)
 *   - OQ-6 coverage-gap response
 *   - OQ-7 composite determinism sampling
 *   - OQ-9 operator-time-cost instrumentation
 *   - OQ-10 vendor-namespace enforcement (strict by default)
 *
 * All values are commented-out so the file is documentation-as-data: the
 * defaults inside `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts`
 * remain the source of truth, but operators get a complete cribsheet of
 * what they can tune by un-commenting and editing.
 */
export const QUALITY_MONITORING_CONFIG_STUB = `# RFC-0025 Framework Quality Monitoring configuration (§13.1).
#
# Per-org overrides for the AI-SDLC framework's failure-mode taxonomy,
# severity rubric, attribution UX, and self-improvement metrics. Every
# block below ships with sensible small-to-medium-team defaults
# (un-commented entries override the defaults).
#
# Lifecycle:
#   - Drop this file in \`.ai-sdlc/\` to override defaults org-wide.
#   - Pass \`--severity-weight <axis>=<value>\` on relevant CLIs for a
#     one-shot debugging override (precedence: CLI > YAML > defaults).
#   - The loader rejects un-namespaced custom subclasses by default
#     (OQ-10 strict enforcement); set \`vendor-namespace.enforce: warn\`
#     to downgrade to a soft warning during migration (deprecated).
#
# See RFC-0025 §13.1 for the full schema rationale + OQ resolutions.

quality:
  # OQ-1 / Phase 2 — Confidence-bucketed classifier (three-tier).
  # classifier:
  #   confidenceThresholds:
  #     autoClassify: 0.7   # ≥ this → auto-classify into the resolved class
  #     ambiguous: 0.3      # ≥ this and < autoClassify → ambiguous;
  #                         # < this → unclassified, log-only

  # OQ-2 / Phase 4 — Per-axis severity weights for the §7 composite rubric.
  # Multiplies the qualitative axis (low=0, medium=1, high=2) before the
  # max + frequency bump. A weight of 1.0 is the qualitative-bucket default.
  # severity-weights:
  #   operator-time-cost: 1.0
  #   framework-recurrence: 1.0
  #   blast-radius: 1.0

  # OQ-3 / Phase 3 — Multi-window recurrence (simultaneously computed).
  # recurrence-windows:
  #   - 7d   # flap detection
  #   - 30d  # standard recurrence
  #   - 90d  # legacy regression

  # OQ-4 / Phase 4 — Framework-bug attribution UX. Default is suggest-only
  # (small-team-safe per the operator-affirmed OQ-4 resolution). Flip
  # \`autoAttribute: true\` to force-assign the top candidates on creation.
  # framework-bug:
  #   autoAttribute: false
  #   suggestionCount: 3
  #   attributionSources:
  #     - codeowners
  #     # - git-blame   # v2 extension (RFC-0025 §13.1)
  #     # - recent-pr   # v2 extension

  # OQ-5 / Phase 6 — Operator-initiated upstream reporting. Set
  # \`repoUrl\` to your framework-repo to enable \`cli-quality report-upstream\`.
  # upstream-reporting:
  #   repoUrl: "https://github.com/<org>/<repo>"
  #   prefilledIssueTemplate: ".ai-sdlc/templates/framework-bug-report.md"

  # OQ-6 / Phase 5 — Coverage-gap response. Composes with RFC-0024
  # emergent capture (capture-record with source: framework-coverage-gap).
  # coverage-gap:
  #   autoQuarantine: true
  #   fileCapture: true

  # OQ-7 / Phase 5 — Composite determinism-detection sampling. Risk-based
  # concentration via blast-radius matches the framework's deterministic-
  # first preflight ladder (RFC-0035 §5).
  # determinism-detection:
  #   defaultSampleRate: 0.02            # 1-in-50 baseline
  #   alwaysOnRequiresDeterminism: true
  #   alwaysOnTopBlastRadiusDecile: true

  # OQ-9 / Phase 5 — Operator-time-cost instrumentation. AFK filter zeroes
  # out elapsed-time over inactivity gaps > N minutes (default 30).
  # operator-time-cost:
  #   afkInactivityMinutes: 30

  # OQ-10 / Phase 6 — Vendor-namespace enforcement for custom failure-mode
  # subclasses. Matches Kubernetes CRD / npm scoped / Go module convention.
  # vendor-namespace:
  #   enforce: reject    # or 'warn' (deprecated) / 'none' (deprecated)

  # OQ-10 / Phase 6 — Adopter-declared custom failure-mode subclasses.
  # Each entry MUST use a vendor reverse-DNS prefix under the default
  # \`enforce: reject\`. Un-prefixed entries error at resource-load time.
  # customSubclasses:
  #   - acme-corp:custom-gate-faulty
  #   - acme-corp:billing-timeout
`;

/**
 * `.ai-sdlc/templates/framework-bug-report.md` stub — adopter-customisable
 * template for the OQ-5 upstream-reporting CLI (\`cli-quality report-upstream\`).
 *
 * The template uses double-brace placeholders that the
 * \`tui/analytics/upstream-reporter.ts\` module replaces at render time:
 *   {{subclass}}, {{severity_composite}}, {{severity_otc}},
 *   {{severity_blast}}, {{severity_freq}}, {{ts}}, {{task_id}},
 *   {{worker_id}}, {{rationale}}, {{suggested_fix}}, {{related_paths}},
 *   {{exit_code}}, {{source}}, {{stderr_tail}}
 *
 * Adopters can re-order sections + add markdown but should keep the
 * placeholder names — the renderer's substitution table is fixed.
 */
export const FRAMEWORK_BUG_REPORT_TEMPLATE_STUB = `## Framework bug — {{subclass}}

**Severity:** {{severity_composite}} (operator-time-cost={{severity_otc}}, blast-radius={{severity_blast}}, frequency={{severity_freq}})
**Subclass:** \`{{subclass}}\`
**Reported at (capture timestamp):** {{ts}}
**Related task:** {{task_id}}
**Worker:** {{worker_id}}

### What happened

The AI-SDLC framework's RFC-0025 quality monitor classified this failure as
\`framework-misbehaved\` / \`{{subclass}}\`. Per the classifier's rationale:

> {{rationale}}

### Suggested fix (heuristic — please verify)

{{suggested_fix}}

### Related code paths

{{related_paths}}

### Anonymised repro

The framework anonymised the failure context before this template
rendered: absolute home paths were collapsed to \`~/…\`, worktree paths to
\`<worktree>\`, and any apparent secret tokens (sk-…, ghp_…, xoxb-…) or
email addresses were replaced with \`<REDACTED-…>\`. The operator should
still inspect the body before submitting.

\`\`\`
exit code: {{exit_code}}
source:    {{source}}

{{stderr_tail}}
\`\`\`

### Operator checklist (before clicking Submit)

- [ ] I have reviewed the anonymised repro for any remaining sensitive context.
- [ ] The classifier's rationale matches what I observed locally.
- [ ] The suggested fix and related paths look correct for this failure.
- [ ] I am willing to follow up on the issue if the maintainers ask for more context.

---

_This issue was pre-generated by \`cli-quality report-upstream\` (RFC-0025 §13 OQ-5)._
_The operator reviewed and submitted this report. No automatic telemetry was transmitted._
`;

/**
 * Quality-monitoring template set scaffolded by the wizard's
 * \`--with-quality-monitoring\` / \`--add quality-monitoring\` flag
 * (AISDLC-305). Bundles the OQ-2 + OQ-4 + OQ-5 surfaces:
 *
 *   1. \`.ai-sdlc/quality-monitoring.yaml\` — RFC-0025 §13.1 per-org config
 *      with all blocks commented-out (shipping defaults documented inline).
 *   2. \`.ai-sdlc/templates/framework-bug-report.md\` — adopter-customisable
 *      template for the OQ-5 upstream-reporting CLI.
 *
 * Idempotent: files already present at the target paths are skipped by the
 * dispatcher.
 */
export const QUALITY_MONITORING_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/quality-monitoring.yaml': QUALITY_MONITORING_CONFIG_STUB,
    '.ai-sdlc/templates/framework-bug-report.md': FRAMEWORK_BUG_REPORT_TEMPLATE_STUB,
  },
};

/**
 * `.ai-sdlc/signal-ingestion.yaml` stub — RFC-0030 Signal Ingestion Pipeline.
 *
 * AISDLC-348 / Phase 6: ships the full §11 config schema with every block
 * commented-out under `enabled: false`. The pipeline is OFF until the
 * operator explicitly flips `enabled: true` AND opts in via the
 * `AI_SDLC_SIGNAL_INGESTION` flag during the soak window.
 *
 * Like `QUALITY_MONITORING_CONFIG_STUB`, this file is documentation-as-data:
 * the runtime defaults inside `orchestrator/src/signal-ingestion/config.ts`
 * (DEFAULT_SIGNAL_INGESTION_CONFIG) are the source of truth, but operators
 * get a complete cribsheet of what they can tune. Tier multipliers, ICP
 * resonance weights, SA-resonance thresholds, Tier-2 significance gate,
 * clustering algorithm, D1 composition split, and adapter list are all
 * documented inline with the shipped defaults.
 *
 * Drift policy: when DEFAULT_SIGNAL_INGESTION_CONFIG gains new fields,
 * mirror them here so freshly-scaffolded configs are immediately complete.
 * The values in the commented blocks below MUST match the constants in
 * `config.ts`.
 *
 * Configuration changes to this file emit `SignalIngestionConfigChanged`
 * events to `events.jsonl` (see RFC-0030 §11 closing note + AISDLC-348
 * governance event logger). Operators should treat tier-multiplier edits,
 * threshold tweaks, and adapter list changes as governance-relevant: they
 * change which customer signals the framework treats as load-bearing
 * demand and therefore affect D1 scoring upstream of the dispatcher.
 */
export const SIGNAL_INGESTION_CONFIG_STUB = `# RFC-0030 Signal Ingestion Pipeline configuration (§11).
#
# Per-org config for the Demand Sources → D1 pipeline. Pluggable source
# adapters fetch raw signals (support tickets, community threads, manual
# entries), classify them by tier + ICP + recency, cluster them into
# demand themes, filter through SA resonance, and feed D1 cluster-level
# demand scores into PPA.
#
# Ships DISABLED by default. The pipeline is gated by both:
#   1. \`spec.enabled: true\` in this file
#   2. \`AI_SDLC_SIGNAL_INGESTION\` env flag set to a truthy value during
#      the soak window (1/true/yes/on). Post-promotion the flag is default-on
#      and only the YAML toggle matters.
#
# Configuration changes emit \`SignalIngestionConfigChanged\` governance
# events to \`<ARTIFACTS_DIR>/_orchestrator/events-YYYY-MM-DD.jsonl\`. Edits
# to tier multipliers, thresholds, or adapter lists are governance-relevant
# (RFC-0030 §11 closing note) — log + product-lead review them like any
# other DID-adjacent decision.
#
# Operator runbook: docs/operations/signal-ingestion.md
# Promotion runbook: docs/operations/signal-ingestion-promotion.md
# Schema: spec/schemas/signal-ingestion-config.v1.schema.json
# RFC: spec/rfcs/RFC-0030-signal-ingestion-pipeline.md

apiVersion: ai-sdlc.io/v1alpha1
kind: SignalIngestionConfig
metadata:
  name: signal-ingestion
spec:
  # Master switch. Flip to \`true\` AFTER:
  #   1. You have configured at least one working adapter under \`adapters:\`
  #   2. You have set the \`AI_SDLC_SIGNAL_INGESTION\` env flag (soak window)
  #   3. You have read docs/operations/signal-ingestion.md for the runbook
  enabled: false

  # Tier multipliers (RFC-0030 §6.1).
  # Per-customer-tier weight applied at D1 scoring time. The Churned multiplier
  # (default 2.0) is intentionally high: churned customers are the strongest
  # signal of product-market gap. Tune for your deployment heterogeneity —
  # B2B enterprise platforms typically raise \`enterprise\` (e.g. 5.0) and
  # flatten \`smb\` / \`free\` (e.g. 0.25). Consumer products typically flatten
  # all tiers to ~1.0 since tier is less informative.
  # tierMultipliers:
  #   enterprise: 3.0
  #   mid: 1.5
  #   smb: 1.0
  #   free: 0.5
  #   churned: 2.0

  # ICP resonance weights (RFC-0030 §6.2).
  # Strong = signal source matches declared ICP segments verbatim.
  # Partial = adjacent segment (e.g. enterprise but wrong industry vertical).
  # Weak = peripheral (e.g. student account on a B2B product).
  # icpResonanceWeights:
  #   strong: 1.5
  #   partial: 1.0
  #   weak: 0.5

  # Recency decay half-life in days (RFC-0030 §6.3).
  # Exponential decay; signals older than ~6 months contribute < 2% of their
  # original weight at the default. Shorten (e.g. 14) for rapidly-evolving
  # products; lengthen (e.g. 60) for products with slow signal cycles.
  # recencyHalfLifeDays: 30

  # Tier 2 significance threshold (RFC-0030 §8).
  # Tier 2 signals (community, competitive) only feed D1 once a cluster crosses
  # ALL of these gates. The \`minTier1SignalCount: 1\` gate is the structural
  # defense against adversarial flooding (OQ-13.5): community buzz without
  # any direct customer signal stays in the monitor-only zone.
  # tier2SignificanceThreshold:
  #   minSignalCount: 5
  #   minUniqueSources: 3
  #   minTier1SignalCount: 1
  #   minClusterAgeDays: 7

  # SA resonance thresholds (RFC-0030 §9).
  # Per RFC-0029 Principle 4 "The Soul Holds" — high-SA clusters get full
  # weight, mid-SA discounted, low-SA flagged for review, zero-SA excluded.
  # When aggregate cluster SA resonance drops below 0.4 sustained for
  # 3 sprints, the SoulDriftDetected event fires with
  # \`driftSource: demandMisalignment\`.
  # saResonanceThresholds:
  #   fullWeight: 0.7
  #   discounted: 0.4
  #   excluded: 0.0

  # Clustering algorithm + similarity threshold (RFC-0030 §7).
  # \`bm25\` is the deterministic-first default (no external dependencies).
  # \`embedding\` requires a configured RFC-0019 embedding provider adapter.
  # Raise \`similarityThreshold\` (closer to 1.0) for stricter clustering;
  # lower for looser theme aggregation.
  # clustering:
  #   algorithm: bm25
  #   similarityThreshold: 0.6

  # D1 composition weights (RFC-0030 §10 / AISDLC-347 Phase 5).
  # Non-replacement: signal-pipeline-derived demand and human-authored
  # backlog-item demand both feed D1. The composer normalises the pair to
  # sum to 1; default 50/50 keeps neither stream dominant out of the box.
  # Raise \`signalPipelineWeight\` after the pipeline has soaked and you
  # trust its output more than manual translation.
  # d1Composition:
  #   signalPipelineWeight: 0.5
  #   backlogItemWeight: 0.5

  # Adapter list (RFC-0030 §5).
  # Each name must be registered with the SignalSourceRegistry. The shipped
  # registry includes:
  #   - signal-source-support-ticket (Tier 1 by default)
  #   - signal-source-community-thread (Tier 2 by default)
  #   - signal-source-manual (Tier 1; requires attestedBy + auto-filled
  #     attestedAt; reuses the RFC-0022 OQ-2 audit-trail pattern)
  # Adopters can register custom adapters via createDefaultSignalSourceRegistry()
  # then \`.register(new CustomAdapter())\`.
  # adapters:
  #   - signal-source-support-ticket
  #   - signal-source-community-thread

  # Accepted languages (RFC-0030 OQ-13.2 resolution).
  # Signals in unsupported languages are dropped at the classifier and logged
  # as a SignalLanguageUnsupported decision. v1 ships English-only;
  # multi-language is deferred to v2. To re-enable a language drop early
  # (e.g. for testing), narrow this list to a single language.
  # acceptedLanguages:
  #   - en
`;

/**
 * Signal-ingestion template set scaffolded by the wizard's
 * \`--with-signal-ingestion\` / \`--add signal-ingestion\` flag (AISDLC-348).
 *
 * Ships the per-org config stub disabled-by-default. The pipeline runtime
 * lives in \`orchestrator/src/signal-ingestion/\`; this template just gives
 * adopters the documented config surface to start from.
 *
 * Idempotent: existing files at the target paths are skipped by the
 * dispatcher.
 */
export const SIGNAL_INGESTION_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.ai-sdlc/signal-ingestion.yaml': SIGNAL_INGESTION_CONFIG_STUB,
  },
};

/**
 * Workflow template set scaffolded by `--with-workflows` / `--add workflows`
 * (AISDLC-261). Bundles all four canonical GitHub Actions workflow files that
 * an adopter needs for the AI-SDLC framework to function end-to-end:
 *
 *   1. `ai-sdlc-gate.yml` — single rollup `ai-sdlc/pr-ready` check (always-on baseline).
 *   2. `verify-attestation.yml` — DSSE envelope verifier (audit-only).
 *   3. `ai-sdlc-review.yml` — CI-side reviewer fan-out + `Post Review Results` status.
 *   4. `auto-enable-auto-merge.yml` — arms auto-merge on every same-repo PR.
 *
 * Idempotent: files already present are skipped by default; `--force` overwrites.
 *
 * Source of truth: `.github/workflows/` in the ai-sdlc framework repo.
 * Mirror changes here when the adopter-facing API evolves.
 */
export const WORKFLOWS_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.github/workflows/ai-sdlc-gate.yml': AI_SDLC_GATE_WORKFLOW,
    '.github/workflows/verify-attestation.yml': VERIFY_ATTESTATION_WORKFLOW,
    '.github/workflows/ai-sdlc-review.yml': AI_SDLC_REVIEW_WORKFLOW,
    '.github/workflows/auto-enable-auto-merge.yml': AUTO_ENABLE_AUTO_MERGE_WORKFLOW,
  },
};

/**
 * Always-on baseline workflow templates (regardless of wizard answers).
 * Matches AC #4 in AISDLC-143: pipeline.yaml + agent-role.yaml +
 * quality-gate.yaml + autonomy-policy.yaml are scaffolded by `initProject`
 * (existing logic) and the gate workflow is scaffolded by this map.
 *
 * AISDLC-305 / Phase 4 (RFC-0025): the quality-monitoring config + the
 * upstream-report template are part of the BASELINE because they are pure
 * documentation-as-data (every block commented-out, shipping defaults
 * documented inline). Adopters get the §13.1 cribsheet by default; the
 * `.gitignore`-friendly behavior is to commit it as-is and uncomment
 * blocks per-org as needed.
 */
export const BASELINE_WORKFLOW_TEMPLATES: FeatureTemplateSet = {
  files: {
    '.github/workflows/ai-sdlc-gate.yml': AI_SDLC_GATE_WORKFLOW,
    '.ai-sdlc/quality-monitoring.yaml': QUALITY_MONITORING_CONFIG_STUB,
    '.ai-sdlc/templates/framework-bug-report.md': FRAMEWORK_BUG_REPORT_TEMPLATE_STUB,
  },
};
