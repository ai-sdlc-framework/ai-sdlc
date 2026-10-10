# Reviewer set: two by default, three for trust-chain paths (AISDLC-617, AISDLC-722)

> **TL;DR:** Since AISDLC-722 (DEC-0055, operator-approved 2026-10-04) a pull request whose diff touches **no trust-chain path** is reviewed by **two** agents: `correctness-reviewer` (the merged code + test remit) and `security-reviewer`. A diff that touches **any** trust-chain path, or a repository configured with `reviewerSet: three`, gets the full **three**: `code-reviewer`, `test-reviewer`, `security-reviewer`. The set is derived from the diff by one deterministic classifier, and the CI verifier **re-derives it from the same diff** and rejects an attestation whose reviewer leaves do not cover it.

## Velocity impact

Most pull requests drop one agent run (the second of the code/test pair). Measured against the pre-change three-reviewer fan-out: one Sonnet reviewer run saved per non-trust-chain PR, roughly 30-40% of reviewer tokens on those PRs (a merged reviewer needs a longer prompt, so the saving is not one third). Trust-chain PRs are unchanged. Security stays a separate Opus run in both sets.

## How the set is chosen

| Diff | Set | Reviewers |
|---|---|---|
| touches no trust-chain path | `two` | `correctness-reviewer`, `security-reviewer` |
| touches at least one trust-chain path | `three` | `code-reviewer`, `test-reviewer`, `security-reviewer` |
| repository sets `reviewerSet: three` | `three` | as above |
| diff unreadable, empty, or no merge-base | `three` | fail closed |

The trust-chain list is `TRUST_CHAIN_PATH_PREFIXES` (plus a small pattern list) in [`pipeline-cli/attestation-core/review-scope-core.mjs`](../../pipeline-cli/attestation-core/review-scope-core.mjs), the same list the correctness-only reduction below uses. It covers plugin hooks and the plugin registration (`ai-sdlc-plugin/.claude-plugin/**`), the harness settings (`.claude/settings*.json`, `.claude/hooks/**`), the governance resolver and `spec/schemas/agent-role.schema.json`, attestation and signing code (`pipeline-cli/src/attestation/**`, `pipeline-cli/attestation-core/**`, `scripts/*attestation*`, `scripts/is-docs-only-changeset.mjs`, the attestation CLI and its bin shim, the signing scripts), the push gates (`.husky/**`, `scripts/pre-push-fixups.sh`, `scripts/check-task-moved.sh`, `scripts/check-dark-code-on-push.sh`), merge and release path code, lease and governance-fallback code, the generated schemas, reviewer routing (`reviewer-set*.ts`, `07-build-review-prompts.ts`, `orchestrator/reconcile.ts`), every plugin command body, agent definition and script (`ai-sdlc-plugin/**`), reviewer and review-executor agent definitions, `CLAUDE.md`, every `.ai-sdlc/**` config file and everything under `.github/`. Review outputs that every reviewed PR carries (`.ai-sdlc/attestations/`, `.ai-sdlc/transcript-leaves*`, `.ai-sdlc/reviews/`, `.ai-sdlc/_audit/`) and the decision log (`.ai-sdlc/_decisions/**`, docs-equivalent data since AISDLC-723) are exempt: a decision record is authority only once it is on `main`, and the PR that adds it is reviewed like any other.

Matching is case-insensitive (a case-insensitive checkout addresses the same file under another spelling). Changed paths are read with `git diff-tree --name-only -z` so a non-ASCII filename is never C-quoted; any path that still starts with a double quote or contains a control character fails closed to the three-reviewer set.

**One module, two importers.** The pipeline (`steps/reviewer-set.ts`, the signer, the reconcile path) and the CI verifier (`verify-core.mjs`) both import `review-scope-core.mjs`. `pipeline-cli/src/attestation/reviewer-set-coverage.test.ts` fails if either side stops importing it or grows its own copy of the list. Adding a path tightens review; removing one loosens it and is itself a trust-chain change (the file is in its own list, under `pipeline-cli/attestation-core/`).

## Where the choice is made

- `/ai-sdlc execute` (Step 7a-pre) calls `cli-attestation reviewer-set`, which prints `{set, reviewers, reason, triggeringPaths}` and fails closed to three.
- The headless runner (`executePipeline`, Step 7 `buildReviewPrompts`) calls `selectReviewerSet()`; the choice is logged to stderr as `[reviewer-set] ... trust-chain paths: ...`.
- The reconcile path (`runReconcile`) derives the set from the worktree diff when `RunReconcileOptions.reviewers` is not given; an explicit `--reviewers` list still wins.
- The judgment layer (`review.reviewer-set`) can never narrow a diff the classifier sent to three.

## How the CI verifier enforces it

`runVerifier` calls `enforceReviewScope`, which recomputes the changed paths from `git diff <merge-base>..<head>` and reads `.ai-sdlc/review-config.yaml` from the **base commit**, then calls the same `requiredReviewerKind` classifier. It then requires that the **Merkle-proven on-disk leaves** (not the envelope's own summary) cover the set: the three set needs code, test and security reviewers (`-codex` variants satisfy code and test; security has no codex variant); the two set needs security plus a correctness reviewer (or code and test, so a three-reviewer attestation always covers a two-reviewer requirement). The verifier **never reads** the `reviewScope` record the signer writes into the envelope; that field is for auditors only, because a self-asserted claim is forgeable.

A rejected attestation reports, for example: `v6: reviewer set incomplete: the diff requires the three-reviewer set (trust-chain-path: ai-sdlc-plugin/hooks/x.js) but the attestation lacks code-reviewer, test-reviewer`. Fix: run the full three-reviewer set on the current head and re-sign.

The legacy v3/v4/v5 verifier path is unchanged (it already requires all three roles).

## Opting out (always three)

Add to `.ai-sdlc/review-config.yaml` on the base branch:

```yaml
reviewerSet: three
```

or set `AI_SDLC_REVIEWER_SET=three` for one run. The config is read from `origin/main` (`git show`) and never from the pull request's own checkout, so a PR cannot change its own review depth; the verifier reads it from the PR's base commit. With nothing configured the diff-derived default applies. If the verifier cannot read the base config for any reason other than the file being absent (shallow clone, absent base commit), it fails closed to three. The legacy value `reviewerSet: code-test-merged` (and `auto`) now means the same as "nothing configured": the classifier already picks two whenever it is safe, and it can no longer narrow a trust-chain diff.

## What the attestation records

The v6 envelope carries `reviewScope.{requiredSet, reason, triggeringPaths}`, derived by the signer from the same diff. It is audit-only. `cli-attestation inspect-v6` shows it; the verifier ignores it.

## Comparison window

For the first 20 pull requests, or one week from the first logged one, each PR's reviewer-set outcome is appended to `$ARTIFACTS_DIR/reviewer-set-comparison.jsonl` (`steps/reviewer-set-comparison.ts`). A PR for which both sets' verdicts were collected carries a `shadow` entry, and a disagreement on approval is flagged. `cli-attestation reviewer-set-window` prints the summary for the decision digest. The log never blocks a pull request. The staged-review comparison machinery (RFC-0052) is not on main, so this is the simple log of disagreements.

## What runs in each set

| Set | Reviewers | Model | Codex variant? |
|---|---|---|---|
| `three` | `code-reviewer`, `test-reviewer`, `security-reviewer` | sonnet, sonnet, opus | code/test yes; security no |
| `two` | `correctness-reviewer`, `security-reviewer` | sonnet, opus | no |

Security is byte-for-byte the same agent in both sets.

## Programmatic access

`classifyReviewerSet({ changedPaths, requireThree })` in `pipeline-cli/src/steps/reviewer-set.ts` returns `{ set, reviewers, reason, triggeringPaths }`; `requiredReviewerKind(paths, opts)` in `review-scope-core.mjs` is the underlying classifier and also returns `correctness-only`. From a shell: `node pipeline-cli/bin/cli-attestation.mjs reviewer-set --repo-root <worktree>`.

## Correctness-only review for test-only and docs-adjacent diffs (AISDLC-723, DEC-0055)

A diff whose every changed path is a test, fixture or snapshot (`*.test.*`, `*.spec.*`, `__tests__/**`, `**/fixtures/**`, `**/__snapshots__/**`), or whose every changed path is Markdown or covered by `scripts/is-docs-only-changeset.mjs`, runs the **correctness reviewer alone**: the security reviewer (opus) is not spawned. Classification is path-based only; a comment-only change is never inferred, and a mixed source-and-test diff is never downgraded.

The full set is forced when the diff contains any of: a trust-chain path (`.github/`, `.husky/`, `.ai-sdlc/` except decision and envelope data, `ai-sdlc-plugin/` including its Markdown prompts, the agent-instruction directories `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, any `CLAUDE.md`, `AGENTS.md` or `SKILL.md` at any depth, `pipeline-cli/attestation-core/`, `pipeline-cli/src/attestation/`, the attestation scripts), a workflow file, anything under hooks, a test or fixture whose path names attestation, signing, verification, trust, hook, security, governance, auth merge, eligibility, reviewer, gate, guard, role, dor, pre-push, allow, deny, bypass or similar code (a file that changes a security test's expectations), or any path that is neither a test nor docs.

**Where it is enforced.**

- Signer side: `reduceForReviewScope()` in `pipeline-cli/src/steps/reviewer-set.ts`, called by `07-build-review-prompts.ts`. An explicit `reviewers` override is left alone.
- CI verifier: `enforceReviewScope()` in `pipeline-cli/attestation-core/verify-core.mjs` re-derives the classification from `git diff <merge-base>..<head>` and requires the reviewer names of the on-disk (Merkle-proved) leaves, which must equal the envelope's copies and carry no duplicate `leafIndex`, to satisfy it (correctness review, plus the security review when the diff is `full`). It never reads the classification from the envelope. If the diff cannot be listed it fails closed to `full`; a git error reading the base config other than a missing path fails closed to `securityReview: always`. Paths are lowercased and NFC-normalised before matching.
- Both use one classifier, `pipeline-cli/attestation-core/review-scope-core.mjs`. Its `TRUST_CHAIN_PATH_PREFIXES` is the one trust-chain list; the two-reviewer default (AISDLC-722) imports it rather than defining another.
- The envelope records `reviewScope` (`classification`, `securityAlways`, `requiredSet`, `reason`, `triggeringPaths`, `appliedReviewers`) for audit. It is informational only.

**Keep security review on everything (adopters).** Commit this to `.ai-sdlc/review-config.yaml` on your base branch:

```yaml
securityReview: always
```

The file is read from the base ref (`git show origin/main:.ai-sdlc/review-config.yaml` on the signer, the PR base SHA in CI), never from the PR's own checkout, so a pull request cannot switch the reduction on for itself. With `securityReview: always` the verifier requires a security reviewer on every diff.

See also: `docs/operations/reviewer-dispatch-defaults.md` (Codex vs. Claude-native routing, orthogonal to the reviewer set). The changelog entry for the changed default is produced by release-please from the commit message.

## The staged set (`reviewerSet: staged`)

A third, opt-in set selected the same way as `code-test-merged` (the `AI_SDLC_REVIEWER_SET` env var, or `reviewerSet: staged` in `.ai-sdlc/review-config.yaml` **as committed on the base ref**, never the working tree). It is accepted only for `backlog` work; a request from any other source kind (a `gh-issue` run, say) falls back to `three` and logs the reason. The default is unchanged.

It replaces the code and test reviewers with one pipeline (design: RFC-0052): a risk map built from the diff, a plan written by the strongest model, probes run by cheaper read-only executors, and one verdict written by the strongest model from the evidence. The standalone `security-reviewer` still runs beside it, so the two can be compared on the same change. Step 8 aggregates the staged set's one verdict beside the security verdict by the same blocking rules as any other set.

**Where it runs.** The staged pipeline is driven by `/ai-sdlc execute` (Step 7a-staged) through `cli-staged-review`. The Tier 2 library path (`buildReviewPrompts`) and `/ai-sdlc orchestrator-tick` do not run it: with `staged` configured they review with the `three` set, never with the security reviewer alone.

**Fail closed.** If the change cannot be reviewed by the staged set (an unsafe file name, an unreadable diff, a plan that cannot be made safe, a verdict that does not validate), the staged review does not run and the three-reviewer set handles the change. The reasons are kept in the dispatch record, `cli-staged-review status --task-id <id>`, and in the PR body.

**Attestation.** One transcript leaf is written per planner, per probe that ran a model, and per synthesizer, all with `reviewerName: staged-review` and an additive `stage` (`plan`, `execute`, `synthesize`). Plan and execute leaves carry zero findings and `verdictApproved: false` by construction; only the synthesize leaf carries the verdict. Leaves without a `stage` verify exactly as before, and `stage` is never written as null or empty. Independence tiers are computed per leaf and the set's tier is the weakest leaf's, so a probe run outside an attested harness shows up as such. The reviews ledger gains the role `staged`, taken from the synthesize leaf, and `cli-reviews analyze` reports it under that role without changing any other role's counts.

**Probe adapters.** Probes run through production adapters (`ClaudeProbeSpawner`, `CodexProbeSpawner`) that enforce the file scope themselves rather than relying on a tool list: a probe with file tools runs in a throwaway directory holding fresh copies of exactly its allowed paths as committed at HEAD, with the harness's file tools confined to that directory. A gitignored `.env`, an untracked file, a symlink or an uncommitted edit is simply not there. Each adapter declares per harness what it enforces (`enforcesFileScope`, `honoursEmptyToolList`); a harness that does not declare `true` gets no probe with file tools, and a probe with no tools stays on the Claude harness unless the Codex bridge declares it honours an empty tool list. The Codex bridge is the operator's own script, so it declares nothing by default: set `CODEX_SPAWN_AGENT_CAPABILITIES` to a comma list of `file-scope` and `empty-tool-list` only if the bridge really does both. Run probes execute the repository's own scripts and run only for trusted `backlog` work.

The Claude adapter starts `claude --print` with `--restricted`, `--permission-mode dontAsk` and `--permission-prompts none`, so it needs a Claude Code CLI that has those flags; on an older CLI every probe fails and the staged verdict reports the hunks as uncovered rather than approving them.
