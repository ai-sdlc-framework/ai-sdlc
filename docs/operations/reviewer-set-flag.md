# Reviewer set flag: 3 → 2 opt-in (AISDLC-617)

> **TL;DR:** The default reviewer set is UNCHANGED — three reviewers (code, test, security) run separately, exactly as before. Set `AI_SDLC_REVIEWER_SET=code-test-merged` (or `.ai-sdlc/review-config.yaml`'s `reviewerSet: code-test-merged`) to opt into an experimental two-reviewer set (`correctness-reviewer` + `security-reviewer`) for A/B comparison against the AISDLC-616 findings ledger. **Do not flip this default until the ledger shows the merged reviewer catches the same correctness blockers the two separate reviewers did.**

## Why 3 → 2, not 3 → 1

From the operator reviewer-cost investigation (2026-09-14):

- **Code and test reviewers share a domain** (correctness): logic errors, edge cases, and whether tests cover them are naturally reviewed together. Folding them into one prompt has low domain-conflict risk.
- **Security is a distinct reasoning mode** and is the ONLY role with retained evidence of unique, critical catches (e.g. AISDLC-501: a fail-open degradation giving an untrusted PR a green gate + valid signed attestation with zero sandbox / zero approval — a trust-chain CRITICAL a general correctness reviewer would not frame). Folding security into a combined reviewer risks attention dilution on exactly the highest-severity class. **Keep it separate, on Opus.**
- **Cost reality**: a combined reviewer is not 1/3 the cost — it needs a longer multi-domain prompt and emits one long transcript; realistic saving from 3→2 is ~30-40% of reviewer tokens, not ~66%. The per-role model split (code/test on Sonnet, security on Opus — PR #327) already makes security the expensive role you'd least want to touch, so merging the two cheap Sonnet roles is the low-risk cut.

## What ships in this task

- A new agent, `ai-sdlc-plugin/agents/correctness-reviewer.md` — merges the `code-reviewer` and `test-reviewer` remits (bugs/logic AND test coverage/quality) into one Sonnet-pinned reviewer. Same JSON verdict envelope (`{approved, findings, summary}`) as every other reviewer, so aggregation and the AISDLC-616 findings ledger are unaffected.
- A reviewer-set resolver, `pipeline-cli/src/steps/reviewer-set.ts` (`resolveReviewerSetMode()` / `resolveReviewerSet()`), consulted by `07-build-review-prompts.ts` (Tier 2 pipeline) and by the `/ai-sdlc execute` + `/ai-sdlc orchestrator-tick` skill bodies (Tier 1).
- `pipeline-cli/src/orchestrator/reconcile.ts`'s `RunReconcileOptions.reviewers` — an explicit override for the reviewer set the reconcile sub-tick emits leaves + signs for. Defaults to `RECONCILE_REVIEWERS` (three); pass `RECONCILE_REVIEWERS_MERGED` (or the CLI's `--reviewers correctness-reviewer,security-reviewer`) to reconcile the opt-in set.
- Aggregation (`pipeline_step_8_aggregate_verdicts`) and the reviews ledger (`reviews-ledger.ts` / `reviews-analysis.ts`) already accept an arbitrary reviewer count — no hardcoded `3` anywhere in the accepting path. `normalizeReviewerRole('correctness-reviewer')` maps to the new `'correctness'` ledger role, additive to the existing `code`/`test`/`security` roles.

## Enabling the opt-in set

**Per-invocation (A/B testing, no repo changes):**

```bash
AI_SDLC_REVIEWER_SET=code-test-merged /ai-sdlc execute AISDLC-NNN
```

**Repo-wide (adopter opt-in):** create `.ai-sdlc/review-config.yaml`:

```yaml
reviewerSet: code-test-merged
```

The env var always takes precedence over the config file, so an operator can force either mode ad hoc without editing the repo.

**Default (no action needed):** omit both — the three-reviewer set runs exactly as it did before AISDLC-617.

## What runs in each mode

| Mode | Reviewers | Model | Codex variant available? |
|---|---|---|---|
| `three` (default) | `code-reviewer`, `test-reviewer`, `security-reviewer` | sonnet, sonnet, opus | code/test yes (`-codex` variants); security no |
| `code-test-merged` (opt-in) | `correctness-reviewer`, `security-reviewer` | sonnet, opus | no (correctness-reviewer is claude-native only) |

Security is byte-for-byte unchanged in both modes — same agent, same model, same harness, same threat-model prompt.

## Ledger-gated default change (do NOT skip this)

This task intentionally does **not** flip the default. AISDLC-616 instruments first-pass reviewer findings into an append-only ledger (`.ai-sdlc/reviews/<task-id>.jsonl`). Before making `code-test-merged` the default:

1. Run a meaningful sample of PRs with `reviewerSet: code-test-merged` enabled.
2. Compare the `correctness` role's block rate / sole-blocker rate (via `cli-reviews analyze`, see `pipeline-cli/src/attestation/reviews-analysis.ts`) against the historical `code` + `test` combined coverage.
3. Confirm the merged reviewer is not silently dropping a class of finding the two separate reviewers used to catch (e.g. compare cross-reviewer overlap patterns pre/post).
4. Only then file a follow-up task to flip the default — with the ledger data cited as evidence in that task's Context section.

## Programmatic access

```typescript
import { resolveReviewerSet, resolveReviewerSetMode } from '@ai-sdlc/pipeline-cli';

resolveReviewerSetMode({ workDir: process.cwd() });
// → 'three' (default) | 'code-test-merged' (opt-in)

resolveReviewerSet({ workDir: process.cwd() });
// → ['code-reviewer', 'test-reviewer', 'security-reviewer']   (default)
// → ['correctness-reviewer', 'security-reviewer']             (opt-in)
```

See also: `docs/operations/reviewer-dispatch-defaults.md` (Codex vs. Claude-native harness routing — orthogonal to the reviewer-SET flag; both flags compose).
