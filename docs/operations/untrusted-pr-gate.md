# Untrusted-Contributor PR Verification Gate — Operator Runbook

**RFC-0043 Phase 1**

This runbook covers the Stage 0 (trust classifier) and Stage 1 (AST gate)
components of the Untrusted-Contributor Verification Gate (UCVG).

## Overview

The UCVG provides a zero-trust verification path for PRs from untrusted
contributors. Phase 1 delivers the two deterministic, LLM-free gates that
run before any expensive processing.

## Stage 0 — Trust Classifier

### Configuration

Trust classification is driven by `.ai-sdlc/trusted-reviewers.yaml` (the
`allowlist.authors` block). This file is the ONLY runtime source of trust
truth. **No live GitHub API queries are made on the classification critical
path.**

```yaml
# .ai-sdlc/trusted-reviewers.yaml
allowlist:
  authors:
    - login: github-handle
      name: Human Name
      addedAt: '2026-06-02'
      addedBy: approving-maintainer
```

### Adding a trusted author

1. Open a PR adding an entry to `allowlist.authors`.
2. A maintainer with write+ permission reviews + merges.
3. After merge, the trust classifier classifies the author as TRUSTED.

### RFC-0022 composition

The `reviewerAuthorityModel` from `.ai-sdlc/compliance.yaml` controls
UCVG engagement:

| Model           | UCVG behavior                                      |
|-----------------|---------------------------------------------------|
| `open` (default)| Everyone trusted; UCVG opt-in only                |
| `allowlist`     | Only allowlisted authors trusted; UCVG default-on |
| `allowlist+role`| Only allowlisted authors trusted; UCVG default-on |

When no `.ai-sdlc/compliance.yaml` exists, the default model is `open`
(everyone trusted; UCVG opt-in only).

### Drift detection

The `.github/workflows/trusted-reviewers-drift.yml` workflow runs weekly
(Mondays at 09:00 UTC) to compare the static allowlist against GitHub
repo permissions. When drift is detected, it emits a
`trusted-reviewers-file-drift-detected` Decision via the RFC-0035 G0
Decision Catalog for operator action.

**Drift is informational — it does NOT change classifications.**
The static file remains authoritative. Drift signals that an operator
review is needed.

To trigger a manual drift check:
```bash
gh workflow run trusted-reviewers-drift.yml
```

## Stage 1 — AST Gate

### Boundary principle

> Stage 1 patterns must have **<1% false-positive rate** AND provide
> **cheap-deterministic-value over downstream LLM/sandbox detection**.
>
> Sophisticated detection (entropy-based secret scanning, CVE correlation,
> AST semantic analysis) delegates to RFC-0022 `secretScanStrictness` +
> adopter-integrated SAST (Snyk / Semgrep / CodeQL / etc.).

This boundary prevents Stage 1 from becoming a de-facto malware scanner
the framework must maintain. New heuristics are accepted only when:
1. False-positive rate < 1% (verified with real PR corpus)
2. The detection is cheaper/faster than waiting for the LLM/sandbox

### Configuration

The gate reads `.ai-sdlc/untrusted-pr-gate.yaml`. When absent, the
RFC-0043 §Stage 1 defaults apply:

```yaml
# .ai-sdlc/untrusted-pr-gate.yaml (adopter-configurable)
protectedPaths:
  - '.github/**'               # CI/CD config — RCE-via-workflow vector
  - '**/package.json'          # lifecycle-script + dependency injection
  - 'pnpm-lock.yaml'
  - 'package-lock.json'
  - 'yarn.lock'
  - '.ai-sdlc/**'              # agent roles, gate config, attestation policy
  - 'ai-sdlc-plugin/agents/**' # reviewer/dev prompt definitions
  - '**/*.github/workflows/**' # nested workflow configs
allowedMutationGlobs:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.jsx'
  - '**/*.md'                  # docs-only untrusted PRs are low-risk
contentHeuristics:
  packageJsonLifecycleScripts: abort  # preinstall/postinstall/prepare added → abort
  newGithubActionUses: abort          # any new `uses:` reference → abort
```

**Deny wins.** A protected-path match takes priority over an
allowed-mutation match. A file must match `allowedMutationGlobs` AND
NOT match `protectedPaths` to pass.

### Abort behavior (AC#8)

When Stage 1 aborts a PR:

1. `UntrustedPrBlockedByProtectedPath` event is emitted to
   `.ai-sdlc/enforcement/*.jsonl`.
2. The `needs-maintainer-review` label is applied to the PR.
3. A comment naming the offending paths is posted to the PR.
4. The pipeline stops — no sandbox spin-up, no LLM cost.

### Requesting a new content heuristic

To request a new Stage 1 content heuristic, open a Decision via
the RFC-0035 Decision Catalog:

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "stage-1-content-heuristic-addition-request" \
  --scope "security" \
  --option "add-pattern:<pattern-description>" \
  --body "Pattern: <description>. False-positive rate: <rate>. Value over downstream detection: <reason>."
```

Heuristics auto-promote when ≥2 distinct adopter requests are filed
for the same pattern AND the false-positive criterion (<1%) is confirmed.

## Troubleshooting

### "My PR was blocked but I'm a trusted author"

1. Check that your GitHub login is in `.ai-sdlc/trusted-reviewers.yaml`
   under `allowlist.authors`.
2. Check the `reviewerAuthorityModel` in `.ai-sdlc/compliance.yaml`.
   If it's `open`, everyone is trusted — this shouldn't happen.
3. Check whether the PR is from a forked repo (`isFork: true` in the
   event log). Fork PRs are always untrusted unless the author is in
   the allowlist.

### "The drift workflow says my allowlist is stale"

Review the Decision Catalog for a `trusted-reviewers-file-drift-detected`
entry:

```bash
node pipeline-cli/bin/cli-decisions.mjs list
```

Options:
1. Add missing authors to the `allowlist.authors` block.
2. Remove stale entries from the allowlist.
3. No action if the divergence is intentional (allowlist is more
   restrictive than GitHub permissions — this is acceptable and
   documented in OQ-1 resolution).

## References

- RFC-0043: Untrusted-Contributor PR Verification
- RFC-0022: Compliance Posture + Audit Surface (`reviewerAuthorityModel`)
- RFC-0035: Decision Catalog and Operator Decision Routing
- `.ai-sdlc/trusted-reviewers.yaml` — signing keys + author allowlist
- `.ai-sdlc/untrusted-pr-gate.yaml` — Stage 1 gate configuration
- `.github/workflows/trusted-reviewers-drift.yml` — drift detection
- `pipeline-cli/src/pipeline/trust-classifier.ts` — Stage 0 implementation
- `pipeline-cli/src/pipeline/ast-gate.ts` — Stage 1 implementation
