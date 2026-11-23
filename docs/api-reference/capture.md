# Capture CLI

Emergent-issue capture (RFC-0024). A capture records a finding that surfaces while work is under way, so it is triaged later instead of being lost or silently expanding scope. Two commands ship: `cli-capture` (record, list, triage) and `cli-capture-lifecycle` (timers, archive, config).

Run both from the repository root:

```bash
node pipeline-cli/bin/cli-capture.mjs --help
node pipeline-cli/bin/cli-capture-lifecycle.mjs --help
```

## `cli-capture` subcommands

| Subcommand | What it does |
|---|---|
| `file <finding>` | Record a new draft capture (the primary operator path). Writes to `.ai-sdlc/captures-drafts/` by default. |
| `submit <id>` | Promote a draft to team-shared (`backlog/captures/<id>.md`). |
| `submit-all` | Bulk-promote every draft capture to team-shared. |
| `discard <id>` | Hard-delete a draft. Refuses on submitted captures; use `redact` instead. |
| `list` | List capture records from drafts, submitted and legacy sources. |
| `redact <id>` | Scrub the finding text from a capture while preserving the audit trail. |
| `against-current-pr` | File a draft capture, detecting the current PR from the active git branch. |
| `triage <id>` | Apply a triage decision to a legacy pending capture (`triage=tbd` to a terminal value). |
| `migrate-legacy` | Move legacy JSONL captures from `$ARTIFACTS_DIR/_captures/` to `backlog/captures/`. |
| `parse-pr-comments` | Scan a PR's review comments for `ai-sdlc:capture` markers. Reads JSON from stdin. `--classify` also runs the LLM auto-classifier on un-marked comments. |
| `append-capture-marker` | Append the `<!-- ai-sdlc:capture-id=<id> -->` footer to a PR comment body. Reads `{body, captureId}` JSON from stdin and prints `{body, changed, alreadyLinked}`. Idempotent; it refuses to overwrite a marker with a different id. |
| `lint-file <path>` | Scan a source file for `// ai-sdlc:capture` in-code markers. Non-blocking warnings. |
| `help-triage` | Print the triage rubric table. |

### Options

`file`:

| Option | Meaning |
|---|---|
| `-s, --severity` | `critical`, `major`, `minor`, `suggestion` or `unknown` (default `unknown`). |
| `-t, --triage` | `tbd` (default), `new-issue`, `new-feature-issue`, `scope-extension`, `quick-fix`, `framework-bug`, `not-actionable`. |
| `-c, --context` | Free-text context. |
| `--file-path`, `--line` | Repo-relative path and 1-based line of the finding. |
| `--pr` | PR number the finding came from. |
| `--blocks-issue` | Issue id gated by this finding. |
| `--related-issue` | Adapter-native issue id the capture is filed against. |
| `--json` | Machine-readable input for agents; other flags are ignored. Include `confidence` (0 to 1) for the auto-submit gate. `autoClassify: true` needs `AI_SDLC_CLASSIFIER_INVOKER_MODULE`. |
| `--operator` | Operator email or login (defaults to `$USER` or git `user.email`). |
| `--format` | `json` (default) or `table`. |

Other subcommands: `submit --by`; `discard --reason` (required) and `--by`; `list --triage`, `--pending`, `--source all|drafts|submitted|legacy`, `--format json|table` (default `table`); `redact --reason` (required) and `--by`; `triage --to` (required, a terminal value), `--by`, `--extension-target` (for `scope-extension`); `against-current-pr --finding` (required), `--severity`, `--triage`, `--context`, `--format`; `migrate-legacy --format`; `lint-file --format json|text`.

```bash
node pipeline-cli/bin/cli-capture.mjs file "retry loop swallows 429s" --severity major --file-path src/http.ts --line 42
node pipeline-cli/bin/cli-capture.mjs list --pending
node pipeline-cli/bin/cli-capture.mjs triage <id> --to quick-fix
```

Capture records are validated by `spec/schemas/capture-record.v1.schema.json`.

## `cli-capture-lifecycle` subcommands

| Subcommand | What it does |
|---|---|
| `tick` | Run one lifecycle tick: the expiry checks for draft auto-submit, pending triage, unknown severity, the stale-notification ladder and the rate ceiling. `--format json|table`; `--dry-run` currently previews config and staleness only. |
| `reactivate <id>` | Move an archived capture back to `backlog/captures/`. |
| `list-archived` | List captures in `backlog/captures/archived/`. |
| `show-config` | Print the resolved lifecycle config (framework defaults plus overrides from `.ai-sdlc/capture-config.yaml`). |
| `volume-report` | Report today's submission count per agent role. |

### Scheduling `tick`

The shipped `--help` text says to run `tick` "from orchestrator-tick or cron". `/ai-sdlc orchestrator-tick` is retired (AISDLC-763), and nothing in `pipeline-cli/src/hierarchy`, `pipeline-cli/src/dispatch` or `.github/workflows` calls `cli-capture-lifecycle tick`. The tick therefore never runs on its own. Schedule it yourself, for example with cron:

```bash
0 * * * * cd /path/to/repo && node pipeline-cli/bin/cli-capture-lifecycle.mjs tick
```

## `.ai-sdlc/capture-config.yaml`

Read by `loadCaptureLifecycleConfig` (`pipeline-cli/src/capture/capture-lifecycle.ts`). A missing file or key falls back to the default; a malformed file never throws. Values that are not positive integers fall back to the default. The repository root is `$CAPTURE_REPO_ROOT` or the current directory.

```yaml
capture:
  lifecycle:
    draftAutoSubmitDays: 7
    pendingTriageDays: 14
    unknownSeverityDays: 14
    staleNotificationLadder:
      tuiHighlightDays: 3
      slackDmDays: 7
      emailDigestDays: 14
      autoArchiveDays: 21
    rateCeiling:
      dailyCapPerAgentRole: 50
      perAgentRoleOverrides: {} # role name -> daily cap
```

| Key (under `capture.lifecycle`) | Default | Meaning |
|---|---|---|
| `draftAutoSubmitDays` | 7 | Days before an untouched draft is auto-submitted. |
| `pendingTriageDays` | 14 | Days a capture may stay `triage=tbd`. |
| `unknownSeverityDays` | 14 | Days a capture may keep `severity=unknown`. |
| `staleNotificationLadder.tuiHighlightDays` | 3 | Stale capture is highlighted in the TUI. |
| `staleNotificationLadder.slackDmDays` | 7 | Slack DM. |
| `staleNotificationLadder.emailDigestDays` | 14 | Email digest. |
| `staleNotificationLadder.autoArchiveDays` | 21 | Auto-archive to `backlog/captures/archived/`. |
| `rateCeiling.dailyCapPerAgentRole` | 50 | Daily submission cap per agent role. |
| `rateCeiling.perAgentRoleOverrides` | none | Per-role override of the daily cap. |

`show-config` prints `draftAutoSubmitDays`, `pendingTriageDays`, `unknownSeverityDays`, the four `staleNotificationLadder` keys and `rateCeiling.dailyCapPerAgentRole`.
