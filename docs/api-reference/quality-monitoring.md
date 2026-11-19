# Quality Monitoring

RFC-0025 adds failure-mode classification, severity scoring and upstream bug reporting. One command, `cli-quality`, and one per-repository file, `.ai-sdlc/quality-monitoring.yaml`, ship with it. `ai-sdlc init` writes a stub of the file.

```bash
node pipeline-cli/bin/cli-quality.mjs --help
```

## Subcommands

| Subcommand | What it does |
|---|---|
| `report-upstream <bug-id>` | Render a pre-filled GitHub issue for an upstream framework-bug capture. |
| `severity-weights` | Resolve the per-axis severity-weight overrides. |

`report-upstream` options: `--work-dir` (project root, default cwd), `--artifacts-dir` (default `$ARTIFACTS_DIR` or `./artifacts`), `--template` (issue body template path), `--print` (print the URL and body instead of opening the browser, default false), `--format json|text` (for `--print`).

`severity-weights` options: `--severity-weight <axis>=<value>` (repeatable, one-shot override; axes `operator-time-cost`, `framework-recurrence`, `blast-radius`, kebab or camelCase), `--work-dir`, `--format json|text` (default `text`).

```bash
node pipeline-cli/bin/cli-quality.mjs severity-weights --severity-weight blast-radius=1.5
node pipeline-cli/bin/cli-quality.mjs report-upstream <bug-id> --print
```

## `.ai-sdlc/quality-monitoring.yaml`

Read by `loadQualityMonitoringConfig` (`pipeline-cli/src/tui/analytics/quality-monitoring-config.ts`). A missing or unreadable file yields the defaults. The parser is line-based and ignores unknown keys. All keys sit under `quality:`.

```yaml
quality:
  classifier:
    confidenceThresholds:
      autoClassify: 0.7
      ambiguous: 0.3
  recurrence-windows: [7d, 30d, 90d] # written as a block list
  upstream-reporting:
    repoUrl: ""
    prefilledIssueTemplate: .ai-sdlc/templates/framework-bug-report.md
  coverage-gap:
    autoQuarantine: true
    fileCapture: true
  determinism-detection:
    defaultSampleRate: 0.02
    alwaysOnRequiresDeterminism: true
    alwaysOnTopBlastRadiusDecile: true
  operator-time-cost:
    afkInactivityMinutes: 30
  severity-weights:
    operator-time-cost: 1.0
    framework-recurrence: 1.0
    blast-radius: 1.0
  framework-bug:
    autoAttribute: false
    attributionSources: [codeowners] # written as a block list
    suggestionCount: 3
  vendor-namespace:
    enforce: reject
  customSubclasses: []
```

| Key | Default | Meaning |
|---|---|---|
| `classifier.confidenceThresholds.autoClassify` | 0.7 | Confidence at or above this auto-classifies. |
| `classifier.confidenceThresholds.ambiguous` | 0.3 | At or above this (and below `autoClassify`) is ambiguous; below is unclassified and only logged. Values are clamped to 0..1 and swapped if reversed. |
| `recurrence-windows` | `7d`, `30d`, `90d` | Recurrence windows computed together; each matches `\d+d`. |
| `upstream-reporting.repoUrl` | empty | Upstream repo URL; empty disables `report-upstream`. |
| `upstream-reporting.prefilledIssueTemplate` | `.ai-sdlc/templates/framework-bug-report.md` | Issue body template. |
| `coverage-gap.autoQuarantine` | true | Quarantine the dispatch on an uncatalogued failure mode. |
| `coverage-gap.fileCapture` | true | File an RFC-0024 capture for it. |
| `determinism-detection.defaultSampleRate` | 0.02 | Fraction of dispatches sampled. |
| `determinism-detection.alwaysOnRequiresDeterminism` | true | Always sample tasks marked `requires-determinism: true`. |
| `determinism-detection.alwaysOnTopBlastRadiusDecile` | true | Always sample the top blast-radius decile. |
| `operator-time-cost.afkInactivityMinutes` | 30 | Gaps longer than this inside a blocked span are not counted. |
| `severity-weights.operator-time-cost`, `.framework-recurrence`, `.blast-radius` | 1.0 | Axis multipliers (kebab or camelCase). Negative or non-finite values fall back to 1.0. |
| `framework-bug.autoAttribute` | false | Write the top candidates to `assignee:` instead of only suggesting them. |
| `framework-bug.attributionSources` | `codeowners` | Ordered attribution backends; only `codeowners` is implemented. |
| `framework-bug.suggestionCount` | 3 | Candidates surfaced; values below 1 become 1. |
| `vendor-namespace.enforce` | `reject` | `reject`, `warn` or `none` (the last two are deprecated). |
| `customSubclasses` | empty | Custom failure-mode subclasses; under `reject` an un-namespaced entry raises `QualityMonitoringConfigError` at load. |

Per RFC-0025.
