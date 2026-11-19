# Compliance Audit Export

RFC-0022 adds a per-repository compliance posture file and a command that exports audit evidence. This is separate from the SDK control mapping in [Compliance](compliance.md).

```bash
node pipeline-cli/bin/cli-compliance-audit.mjs --help
```

## Subcommands

| Subcommand | What it does |
|---|---|
| `export` | Collect evidence and bundle it into a `.tar.gz` plus `manifest.json`. |
| `dry-run` | Enumerate the evidence in scope, count entries and estimate bundle size. Writes no files. |
| `validate-manifest <manifest-path>` | Verify the sha256 values of a previously exported bundle's manifest (tamper detection). |

## Options

| Option | Default | Meaning |
|---|---|---|
| `-w, --work-dir` | current directory | Project root. Must contain `.ai-sdlc/compliance.yaml` for a posture-aware export. |
| `-p, --period` | `2026-01-01..2026-12-31` | `YYYY-MM-DD..YYYY-MM-DD` or `YYYY-QN` (for example `2026-Q1`). |
| `-r, --regime` | `all` | Regime id used as the bundle filename label (for example `SOC2-T2`). |
| `-o, --output-dir` | `.` | Where the bundle and `manifest.json` are written. |
| `-f, --format` | `text` | `json` or `text`. |

```bash
node pipeline-cli/bin/cli-compliance-audit.mjs dry-run --period 2026-Q1
node pipeline-cli/bin/cli-compliance-audit.mjs export --regime SOC2-T2 --period 2026-Q1 --output-dir ./audit
node pipeline-cli/bin/cli-compliance-audit.mjs validate-manifest ./audit/manifest.json
```

When `.ai-sdlc/compliance.yaml` exists, it is copied into the bundle as `posture.yaml`.

## `.ai-sdlc/compliance.yaml`

Validated by `spec/schemas/compliance-posture.v1.schema.json`. The top-level properties are `apiVersion`, `kind` (the constant `CompliancePosture`), `metadata` and `spec`; all four are required, and `spec` requires `regimes` and `auditExports`.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: acme
spec:
  regimes:
    - id: SOC2-T2
      controls: [CC6.6, CC8.1]
      auditFrequency: annual
      attestedBy: Acme Legal LLP
      attestedAt: 2026-01-15
  derivedGates:
    auditRetentionDays: 730
    _notes:
      auditRetentionDays: Contractual requirement.
  auditExports:
    - kind: enforcement-events
      format: jsonl
      retentionPolicy: { days: 365, tier: hot }
```

| Key | Meaning |
|---|---|
| `spec.regimes[]` | Declared regimes. An empty array means none declared. Each has `id` (required), `controls`, `auditFrequency` (`annual`, `continuous`, `on-demand`), `attestedBy`, `attestedAt` and `attestedNotes`. The loader refuses a regime with no `attestedBy` or `attestedAt`. |
| `spec.derivedGates` | Operator overrides: `databaseBranchPool` (`shared-with-rls`, `per-shard`), `secretScanStrictness` (`minimal`, `standard`, `strict`), `attestationRequired`, `auditRetentionDays`, `reviewerAuthorityModel` (`open`, `allowlist`, `allowlist+role`). Every overridden field needs a non-empty entry in `_notes`. |
| `spec.auditExports[]` | Bundles `export` produces. Each needs `kind` (`dsse-envelope`, `dor-calibration`, `trusted-reviewers`, `enforcement-events`, `access-control-changes`), `format` (`json`, `jsonl`, `csv`) and `retentionPolicy.days`, with optional `retentionPolicy.tier` (`hot`, `cold`). |

Per RFC-0022. The code reads the file at `pipeline-cli/src/cli/compliance-audit.ts`.
