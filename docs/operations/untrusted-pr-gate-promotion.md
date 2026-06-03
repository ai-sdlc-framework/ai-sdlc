# Promotion Runbook — Untrusted PR Gate (RFC-0043)

**Document type:** Operational runbook
**Status:** Current
**Spec version:** v1alpha1
**RFC reference:** [RFC-0043](../../spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md)
**Pattern reference:** [RFC-0014](../../spec/rfcs/RFC-0014-feature-flag-lifecycle.md), [RFC-0015](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md) opt-in→default-on promotion pattern

---

## Overview

This runbook describes how to promote the `AI_SDLC_UNTRUSTED_PR_GATE` feature flag from **opt-in** (current state) to **default-on** for new AI-SDLC installations. Promotion follows the same corpus-driven evidence pattern used by `AI_SDLC_DEPS_COMPOSITION` (AISDLC-410) and `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (AISDLC-411).

**Current state:** Opt-in (`AI_SDLC_UNTRUSTED_PR_GATE` defaults to `off`).
**Target state:** Default-on (the flag defaults to `on` for new installations; existing installations must explicitly set `off` to preserve the off behavior).

---

## Promotion Criteria

Promotion requires **all** of the following evidence, accumulated via InternalAdopter validation:

### 1. Corpus-driven evidence (required)

After the soak period, collect corpus signals from the Decision Catalog events log and the `ai-sdlc/untrusted-pr-gate` status history. There is no automated `corpus aggregate` subcommand in `cli-ucvg.mjs` at v1alpha1 — aggregation is a manual or operator-scripted step.

The `cli-ucvg.mjs` CLI implements exactly these subcommands: `classify`, `ast-gate`, `sandbox-run`, `review-degraded`, `clean-room-sign`, `local-review`. A `corpus aggregate` subcommand is not shipped; corpus aggregation uses the Decision Catalog events log directly:

```bash
# Review the Decision Catalog events for UCVG-related entries:
node pipeline-cli/bin/cli-decisions.mjs list --scope ucvg

# Review the GitHub status history for the gate:
gh api repos/{owner}/{repo}/commits/{sha}/statuses \
  | jq '[.[] | select(.context == "ai-sdlc/untrusted-pr-gate")]'
```

**Minimum thresholds:**

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| `total_prs_processed` | ≥ 50 | Sufficient volume for statistical confidence |
| `stage1_false_positive_rate` | < 1% | Stage 1 incorrectly blocking legitimate PRs |
| `stage4_signer_rejection_rate` | < 0.5% | Clean-room signer rejecting valid reports |
| `degradation_rate` | < 5% | PRs where sandbox was unavailable |
| `prompt_injection_detection_precision` | ≥ 90% | Injection findings that were real attacks |
| `soak_duration_days` | ≥ 30 | Minimum soak window for confidence |

### 2. Zero regressions on the existing trusted-PR path

The trusted-PR path (existing `/ai-sdlc execute` + attestation flow) must show zero regressions during the soak period. Check:

```bash
# Run the full test suite
pnpm build && pnpm test && pnpm lint

# Verify no trusted-PR attestations were invalidated
node scripts/verify-attestation.mjs --all
```

### 3. Operator authorization

The promotion decision requires explicit operator authorization. File a Decision via the RFC-0035 catalog:

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "AI_SDLC_UNTRUSTED_PR_GATE default-on promotion" \
  --scope "ucvg" \
  --option "promote:Soak evidence meets all thresholds; operator authorizes default-on" \
  --option "defer:Evidence not yet sufficient; extend soak window"
```

Do not proceed to the flag flip until the operator resolves the Decision as `promote`.

---

## Promotion Procedure

Once all criteria are met and the operator has authorized promotion:

### Step 1: Flip the default in the flag parser

The feature flag is read in the workflow as:

```yaml
GATE_FLAG: ${{ vars.AI_SDLC_UNTRUSTED_PR_GATE || 'off' }}
```

To flip the default to `on`, change the fallback value:

```yaml
GATE_FLAG: ${{ vars.AI_SDLC_UNTRUSTED_PR_GATE || 'on' }}
```

This means:
- Repos with no `AI_SDLC_UNTRUSTED_PR_GATE` variable set → flag is `on` (default-on).
- Repos with `AI_SDLC_UNTRUSTED_PR_GATE=off` → flag is `off` (explicit opt-out).
- Repos with `AI_SDLC_UNTRUSTED_PR_GATE=1` → flag is `on` (explicit opt-in, redundant after promotion).

### Step 2: Update the feature flag documentation

Update `CLAUDE.md` to reflect the new default:

```markdown
- **`AI_SDLC_UNTRUSTED_PR_GATE`** (RFC-0043): gates the UCVG pipeline. **On by default since AISDLC-NNN (YYYY-MM-DD, operator authorization).** Opt out via `AI_SDLC_UNTRUSTED_PR_GATE=off` (or `0`/`false`/`no`, case-insensitive).
```

### Step 3: Update the init scaffold

Update `docs/operations/init.md` and any `init` scaffold templates to reflect that UCVG is now on by default for new installations. Add a note that existing installations without OpenShell should set `AI_SDLC_UNTRUSTED_PR_GATE=off` to avoid fail-closed degradation.

### Step 4: Update the RFC-0043 status

Update `spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md` frontmatter to reflect the promotion:

```yaml
lifecycle: Implemented
```

### Step 5: Commit and PR

```bash
git add \
  .github/workflows/untrusted-pr-gate.yml \
  CLAUDE.md \
  docs/operations/init.md \
  spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md

git commit -m "feat: promote AI_SDLC_UNTRUSTED_PR_GATE to default-on (AISDLC-NNN)

Corpus soak evidence met all promotion thresholds. Operator authorized
via Decision Catalog. Flag fallback changed from 'off' to 'on'.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Rollback Procedure

If promotion causes unexpected regressions:

### Immediate rollback (repository variable)

Set the repository variable `AI_SDLC_UNTRUSTED_PR_GATE` to `off` in GitHub settings. This takes effect immediately for all new PR events without a code change.

### Full rollback (revert the workflow change)

Revert the flag-default flip in `.github/workflows/untrusted-pr-gate.yml`:

```yaml
# Revert to:
GATE_FLAG: ${{ vars.AI_SDLC_UNTRUSTED_PR_GATE || 'off' }}
```

Open and merge a hotfix PR with this revert.

---

## Opt-Out Path for Existing Adopters

After promotion, adopters who are not ready for UCVG can opt out:

```
Settings → Secrets and variables → Actions → Variables
Name: AI_SDLC_UNTRUSTED_PR_GATE
Value: off
```

Adopters should opt out when:
- They have no external contributors (UCVG provides no benefit).
- Their CI runner does not have Docker/OpenShell available.
- They are on `reviewerAuthorityModel: open` (UCVG does not engage anyway, but setting `off` makes intent explicit).

---

## Monitoring During Soak

During the 30-day soak window before promotion, monitor:

1. **`ai-sdlc/untrusted-pr-gate` status counts** in your GitHub repository. Track the ratio of `success` to `failure` statuses.

2. **Decision Catalog events** — watch for elevated rates of `untrusted-pr-resource-exhausted` or `untrusted-pr-gate-degraded-mode` events.

3. **False-positive reports** from contributors who were incorrectly blocked. These should be rare (<1% of Stage 1 evaluations); frequent false positives indicate a misconfigured `allowedMutationGlobs` list.

4. **Signing-key isolation incidents** — any signer rejection due to `sentinelFound` is a critical security signal. Investigate immediately.

---

## Decision-Catalog Integration

The promotion decision is tracked in the RFC-0035 Decision Catalog. The operator MUST file a Decision before proceeding to the flag flip. This ensures:

- The promotion is operator-authorized (not autonomous).
- The evidence is recorded in the audit trail.
- The Decision links the corpus data to the authorization.

The UCVG promotion Decision follows the same process as the `AI_SDLC_DEPS_COMPOSITION` promotion (AISDLC-410) and `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` promotion (AISDLC-411).

---

## See Also

- [Operator Runbook — UCVG](untrusted-contributor-pr-verification.md)
- [API Reference — RFC-0043 UCVG](../api-reference/rfc-0043-ucvg.md)
- [RFC-0043 §Migration Path](../../spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md#migration-path)
- [RFC-0014 — Feature Flag Lifecycle](../../spec/rfcs/RFC-0014-feature-flag-lifecycle.md)
- [RFC-0015 — Autonomous Pipeline Orchestrator](../../spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md)
- [deps-composition promotion runbook](deps-composition-promotion.md) (comparable pattern)
- [orchestrator promotion runbook](orchestrator-promotion.md) (comparable pattern)
