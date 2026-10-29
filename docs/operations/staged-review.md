# Staged Review Runbook

> **RFC:** [`RFC-0052`](../../spec/rfcs/RFC-0052-staged-review-pipeline.md) (Staged Review Pipeline). Related: [`reviewer-dispatch-defaults.md`](reviewer-dispatch-defaults.md), [`cross-harness-review.md`](cross-harness-review.md), [`reviewer-set-flag.md`](reviewer-set-flag.md), [`staged-review-structural-provider.md`](staged-review-structural-provider.md).

The staged set is a third reviewer set, `staged`, beside `three` and `code-test-merged`. It assigns each kind of review work to the cheapest thing that can do it: code decides facts, the judgment layer ranks risk, the strongest model plans and synthesizes, and cheaper models read and run. The verdict envelope, aggregation, attestation and iteration loop are unchanged. The staged set is available for trusted `backlog` work only; every other source kind falls back to `three`.

## Contents

1. [The six stages](#the-six-stages)
2. [The baseline checklist](#the-baseline-checklist)
3. [Plan and evidence schemas](#plan-and-evidence-schemas)
4. [Configuration](#configuration)
5. [Routing cells and default models](#routing-cells-and-default-models)
6. [Running the staged review](#running-the-staged-review)
7. [Shadow comparison](#shadow-comparison)
8. [Replay](#replay)
9. [The two switches](#the-two-switches)
10. [Attestation leaves per stage](#attestation-leaves-per-stage)
11. [Troubleshooting](#troubleshooting)

## The six stages

```
diff -> 0 deterministic -> 1 structural -> 2 judgment -> 3 plan -> 4 execute -> 5 synthesize -> verdict
         (code)             (code)         (judgments)   (strong)   (cheap, parallel)  (strong)
```

| Stage | Runs on | May | May not |
|---|---|---|---|
| 0 deterministic | code | compute diff statistics, file classes, whether changed source has a changed test, secret-pattern hits, manifest and workflow changes, the task's acceptance criteria and the developer's build, test, lint and coverage results | call a model |
| 1 structural | code | attach changed symbols, callers and callees, exercising tests and patch-coverage lines to each hunk (see [`staged-review-structural-provider.md`](staged-review-structural-provider.md)) | call a model |
| 2 judgment | judgment layer | score each hunk for risk, mark authentication, state, concurrency, input and error handling, screen the diff for injection, estimate acceptance-criteria coverage; abstentions are marked `unjudged` and treated as high risk | write findings |
| 3 plan | `review-planner` | add probes, reorder probes | remove a baseline probe, leave a high-risk hunk unprobed, run tools |
| 4 execute | `review-executor` (or `review-executor-codex`) | read committed files, trace callers, run allowlisted commands, compare revisions, return evidence | edit, push, run Bash, read files outside the plan's targets, choose its own model |
| 5 synthesize | `review-synthesizer` | judge the evidence against the code, test and security remits, write the verdict envelope | invent a finding: a finding with no evidence reference is dropped before aggregation and logged |

A plan whose coverage leaves a high-risk hunk unprobed is rejected and re-requested once, then replaced by a code-built plan that probes every such hunk with the baseline `read` probe.

## The baseline checklist

Built by code from the risk map and versioned (`BASELINE_CHECKLIST_VERSION`). A plan built against another version is rejected. The planner cannot remove or alter these probes:

- Every changed source file: read the hunks in context and the file's changed tests, or record that no test changed.
- Every hunk at or above `staged.riskThreshold`: a `read` probe on the hunk and a `trace` probe on its callers.
- Security, regardless of ranking: any hunk marked for authentication, authorization, input handling, secrets, shell or path handling, dependency manifests or workflows gets the security probe set (injection, authentication and authorization, secrets, path traversal, server-side request forgery, unsafe deserialization).
- Tests: a `run` probe for the test runner over the changed test files, and a `compare` probe between the acceptance criteria and the test names and assertions.
- Acceptance criteria: one `compare` probe per criterion the coverage judgment marked likely uncovered.
- Scope: a `search` probe for files changed outside the task's declared references.

## Plan and evidence schemas

| Schema | File | Top-level fields |
|---|---|---|
| Risk map | `spec/schemas/review-risk-map.v1.schema.json` | `schemaVersion`, `stats`, `flags`, `changedFiles`, `hunks`, `criteria`, `acCoverage`, `injectionScreen`, `routing` |
| Plan | `spec/schemas/review-plan.v1.schema.json` | `schemaVersion`, `baselineVersion`, `probes` |
| Evidence | `spec/schemas/review-evidence.v1.schema.json` | `schemaVersion`, `budget`, `totalBytes`, `entries` |

A plan probe has `id`, `type` (`read`, `trace`, `run`, `compare` or `search`), `target`, `question`, `covers` (the hunks it covers) and an optional `baseline` flag. An evidence entry has `probeId`, `status`, `harness`, `model`, `observations`, `excerpts` (file and line), `commands` (with exit status), `answer`, `evidenceBytes` and, when applicable, `truncated`, `refusals` and `skippedReason`. A verdict finding gains one additive field, `evidence`, naming the probe ids and excerpts it rests on.

## Configuration

Staged keys live in `.ai-sdlc/review-config.yaml`, read from the **base branch** (`git show origin/main:.ai-sdlc/review-config.yaml`), never from the pull request's own checkout. A pull request cannot widen the allowlist or relax a limit it is reviewed under. A missing or malformed value takes its default; a malformed allowlist falls back to the default allowlist, never a broader one.

```yaml
reviewerSet: staged # three | code-test-merged | staged
staged:
  executorCommandAllowlist: ['pnpm test', 'pnpm lint', 'pnpm typecheck']
  riskThreshold: 0.5
  maxProbes: 40
  maxTargetBytes: 32000
  evidenceBudgetBytes: 200000
```

| Key | Default | Range | Meaning |
|---|---|---|---|
| `reviewerSet` | `three` | `three`, `code-test-merged`, `staged` | The reviewer set. `AI_SDLC_REVIEWER_SET` overrides it per invocation. |
| `staged.executorCommandAllowlist` | `pnpm test`, `pnpm lint`, `pnpm typecheck` | up to 20 entries, no shell metacharacters or quotes | The only commands a `run` probe may use. The allowlist pins the command string, not what it executes: `pnpm test` runs the scripts in the pull request's own checkout, which is acceptable only because the staged set is limited to trusted work. |
| `staged.riskThreshold` | `0.5` | 0 to 1 | Hunks at or above are high risk and get the read and trace probes. |
| `staged.maxProbes` | `40` | 1 to 200 | Cap on probes in a plan. |
| `staged.maxTargetBytes` | `32000` | | Total serialized size of probe targets. |
| `staged.evidenceBudgetBytes` | `200000` | | Total evidence the executors may return; over-budget evidence is truncated with an explicit marker. |

Executors run on the Codex harness only when the Codex bridge (`CODEX_SPAWN_AGENT_BIN`) declares that it denies file access outside the probe's targets; otherwise a probe that needs file tools is refused there and runs on Claude.

## Routing cells and default models

| Cell | Stage | Default model (`.ai-sdlc/model-routing.yaml`) |
|---|---|---|
| `review-planner` | 3 plan | `opus` |
| `review-executor` | 4 execute | `haiku` |
| `review-executor-codex` | 4 execute on Codex | `haiku` |
| `review-synthesizer` | 5 synthesize | `opus` |

RFC-0052 names `fable` for planning and synthesis where it is available. The cells are measured and routed like any other role through the model-routing proposal route (RFC-0050), so a change to a model is a reviewed routing-table change, not an edit in the agent file.

## Running the staged review

`/ai-sdlc execute` drives the staged review in Step 7 through `cli-staged-review`. You only run it by hand to debug. Every subcommand prints one JSON object, and each phase takes the `--seal` the previous phase printed.

```bash
node pipeline-cli/bin/cli-staged-review.mjs prepare --task-id <TASK-ID> --source-kind backlog
node pipeline-cli/bin/cli-staged-review.mjs status --task-id <TASK-ID>
```

Phases in order: `prepare` (risk map, baseline, planner prompt), the planner agent, `plan` (validate, one retry, then the code-built plan), `execute` (probes, evidence), `synth-prompt`, the synthesizer agent, `finalize` (validate, ground, write the verdict and leaf manifest). When the staged review cannot review a change, `prepare` or `finalize` answers `ok: false` with `fallbackSet: "three"` and the reasons, and the existing reviewer set runs. The same record is kept in `<artifacts>/_staged-review/<task-id>/dispatch.json`.

## Shadow comparison

During the comparison the existing gating set keeps deciding the pull request. The staged review runs beside it on every trusted PR, with all three remits, and the standalone Opus `security-reviewer` keeps running. Staged leaves write a `staged` row to the reviews ledger with `gating: false`, so it is logged and compared but never aggregated into the gate.

Enable it by setting `reviewerSet: staged` for a trusted repository, merged to the base branch as above. The staged pass is advisory and never replaces the standard reviewers.

Read the comparison:

```bash
node pipeline-cli/bin/cli-reviews.mjs compare
node pipeline-cli/bin/cli-reviews.mjs compare --bar
node pipeline-cli/bin/cli-reviews.mjs compare --json
node pipeline-cli/bin/cli-reviews.mjs compare --no-events
```

For each review cycle the report lists findings only the staged set raised, findings only a gating reviewer raised, and agreed findings (matched on normalized title). The security comparison is its own section: staged findings against the standalone `security-reviewer`'s on the same PR.

**Flagged cases** are listed first. A case is flagged when either side raised a critical or major finding the other side did not raise at all. Each flagged case also emits a `ReviewComparisonFlagged` event unless `--no-events` is given. Work a flagged case by opening the PR, reading the finding that only one side raised, and deciding whether it was a real defect:

- Real defect only the staged set found: the staged set earns recall; note it for the switch decision.
- Real defect only a gating reviewer found: the staged set missed it; check the evidence bundle for the probe that should have covered it, and the plan for the hunk's rank.
- Not a defect: the raising side lost precision on that case.

`--bar` reports the relax-bar status: compared PRs against 50, and act-band precision against 0.95, for all cases and separately for cases that have a standalone security row. The act band is the cases where the staged set blocked; a staged block counts as precise when the gating side also blocked that case.

## Replay

Replay runs the known-defect and clean corpus, built from the reviews ledger, through the staged set and compares each case with the gating set's recorded outcome, so the record is not limited to PRs that happen to arrive. It writes nothing to the reviews ledger, leaves, verdicts or attestations.

```bash
node pipeline-cli/bin/cli-usage.mjs replay-corpus build
node pipeline-cli/bin/cli-usage.mjs replay --set staged --model opus --max-items 50 --max-units 200000 --dry-run
```

Drop `--dry-run` and add `--confirm-spend` to spend. `--set` cannot be combined with `--role` or `--reference-model`. The results file is named `set-staged-<runId>.json` and is not read by `route propose`.

## The two switches

Retiring a reviewer is a relax-class change under RFC-0049 and RFC-0050. It promotes only on the corpus path, with no override path.

1. **Code and test reviewers retire.** Bar: at least 50 compared PRs and act-band precision of at least 95 percent (`cli-reviews compare --bar`), with the flagged cases reviewed and the replay run. Then the staged verdict and the Opus security verdict become the gates, and the repository records `reviewerSet: staged` on its base branch citing the evidence file, through the proposal and approval route RFC-0050 defines.
2. **Security reviewer retires.** A second, separate switch with its own evidence: the staged pipeline's security recall must be at least equal to the standalone reviewer's on the same items (the security section of the comparison and the `--bar` security line). The operator chooses the winner. Until then the standalone `security-reviewer` stays.

## Attestation leaves per stage

Each stage that runs a model produces a transcript and a leaf, emitted with `cli-attestation emit-leaf --reviewer staged-review --stage <stage>`:

| Stage value | Leaves | Findings and verdict |
|---|---|---|
| `plan` | one for the planner | zero findings, `verdictApproved: false` |
| `execute` | one per probe that ran a model (refused or skipped probes have none) | zero findings, `verdictApproved: false` |
| `synthesize` | one for the synthesizer | carries the verdict |

The `stage` field is additive and optional. Independence tiers are computed per leaf, and the set's tier is the weakest leaf. The reviews ledger records one `staged` row per review, taken from the synthesizer leaf.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `prepare` answers `ok: false`, reason `untrusted-source`, `fallbackSet: "three"` | The work is not trusted `backlog` work | Expected. Untrusted work keeps the existing sets. |
| Reason `task-unreadable` | The task file or its acceptance criteria could not be read | Fix the task file; the existing set reviews meanwhile. |
| Reason `diff-unavailable` or `revisions-unresolved` | The diff against `--base-ref` could not be read | `git fetch origin main`, or pass `--base-ref` or `--diff-file`. |
| Reason `unreviewable-input` or `no-safe-plan` | The planner output was unusable twice | Inspect `dispatch.json` rejections; the existing set reviews. |
| Reason `insufficient-evidence` | Probes were refused or returned too little | Check `refusals` in the evidence; for `run-not-trusted` confirm the run is a trusted run. |
| Reason `invalid-verdict` | The synthesizer output failed validation or every finding lacked evidence | Inspect the rejections in `dispatch.json`. |
| A seal mismatch falls back to `three` | Run state under `_staged-review/<task-id>/` changed after it was written | Start again from `prepare`; do not edit run files. |
| A `run` probe is refused | The command is not in `staged.executorCommandAllowlist` as committed on the base branch | Land the allowlist change on main first. |
| `reviewerSet: staged` has no effect | Set only in the PR branch, or source kind not trusted | It must be committed on the base branch; the log line `[reviewer-set] ... falling back to 'three'` names the reason. |
| `cli-reviews compare` shows no cases | No `staged` ledger rows beside gating rows for the same cycle | Confirm `.ai-sdlc/reviews/` holds `staged` rows; pass `--repo-root` for other checkouts. |
| Executor probes refuse on Codex | The Codex bridge does not declare file-scope enforcement | The probe runs on Claude instead; see `cross-harness-review.md`. |
