# Security findings as backlog tasks

Open alerts in the three GitHub security tabs (code scanning for CodeQL, Dependabot, and Scorecard, which uploads to code scanning) become backlog tasks, so they enter the same loop as other work (AISDLC-940).

## Flow

`scripts/security-findings-to-tasks.mjs` lists open alerts through the REST API and writes one task per alert under `backlog/tasks/` (label `security-finding`; body carries source, alert number, severity and URL).

- `--dry-run` prints each unfiled alert with severity and the task id it would get.
- Without `--dry-run` it writes the files and opens one filing PR for the batch.
- Idempotent: an alert whose marker `security-alert:<source>:<number>` already appears in any task under `backlog/tasks/` or `backlog/completed/` is skipped.

The `security-findings` job in `.github/workflows/ci.yml` runs nightly (schedule and manual dispatch only, never per PR). It always writes the dry-run listing to the job summary and files tasks only when the repo variable `AI_SDLC_FILE_SECURITY_FINDINGS` is `1`. Dependabot alert reads may need a token with Dependabot alert access beyond the default `GITHUB_TOKEN`.

## Completing a finding

A `security-finding` task moves to `backlog/completed/` in one of two ways:

1. A fix PR: the task references the PR (`prUrl`, or a PR number or URL in `finalSummary` or the body).
2. A dismissal without a code change: add a `dismissal:` frontmatter block.

```yaml
dismissal:
  reason: 'Dev-only dependency, not reachable from shipped code'
  by: 'dominique'
  date: '2026-10-28'
```

`cli-dor-check` fails a completed `security-finding` task that has neither a PR reference nor a `dismissal:` block with all of `reason`, `by` and `date`.
