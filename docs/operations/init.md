# `ai-sdlc init` — adopter guide

**Status:** Active (AISDLC-143; interactive wizard is the default)
**Audience:** New AI-SDLC adopters bootstrapping a repo, plus operators
extending an already-initialized repo with additional features.
**Companion:** `orchestrator/src/cli/commands/init.ts`,
`orchestrator/src/cli/commands/init-features.ts`,
[`docs/operations/quality-gate.md`](./quality-gate.md)

---

## TL;DR

```bash
# Interactive bootstrap (recommended for first-time users):
ai-sdlc init

# Non-interactive bootstrap (CI / scripted setup; accepts every default):
ai-sdlc init --yes

# Bootstrap with explicit feature opt-ins (no prompts asked):
ai-sdlc init --with-dor --with-attestation --with-branch-protection

# Bootstrap with the full GitHub Actions workflow bundle (AISDLC-261):
ai-sdlc init --with-workflows

# Extend an already-initialized repo with one feature (idempotent):
ai-sdlc init --add classifier

# Add the GitHub Actions workflow bundle to a pre-261 repo:
ai-sdlc init --add workflows

# Overwrite existing workflow files with the current templates:
ai-sdlc init --add workflows --force
```

The wizard guides you through five feature toggles (DoR, attestation,
review classifier, branch protection, GitHub Actions workflows) on top of
an always-on baseline. After it runs, you'll see a "next steps" summary
listing the operator actions needed to finish wiring the chosen features.

---

## What the wizard asks

When you run `ai-sdlc init` with no flags, the wizard prompts for five
features in this order. Every prompt defaults to **Yes** — pressing Enter
accepts the prescriptive default ratified in Q1 of the
[quality-gate redesign](./quality-gate.md).

| # | Prompt | If yes, scaffolds |
|---|---|---|
| 1 | "Will this repo use Definition-of-Ready gates?" | `.ai-sdlc/dor-config.yaml`, `.github/workflows/dor-ingress.yml` |
| 2 | "Do you want attestation infrastructure (audit-only)?" | `.ai-sdlc/trusted-reviewers.yaml`, `.ai-sdlc/attestations/.gitkeep`, `.github/workflows/verify-attestation.yml`, `.husky/pre-push` (sign block appended) |
| 3 | "Add review classifier for cost-optimized reviews?" | `.ai-sdlc/review-classifier.yaml` (stub; runtime ships in AISDLC-141) |
| 4 | "Apply recommended branch protection?" | PUT `/repos/{owner}/{repo}/branches/main/protection` via `gh api` (required checks: `ai-sdlc/pr-ready`, `codecov/patch`) |
| 5 | "Scaffold GitHub Actions workflows (gate, review, attestation, auto-merge)?" | `.github/workflows/ai-sdlc-gate.yml`, `.github/workflows/verify-attestation.yml`, `.github/workflows/ai-sdlc-review.yml`, `.github/workflows/auto-enable-auto-merge.yml` (AISDLC-261) |

## Always-scaffolded baseline

Independent of any wizard answer, every run of `ai-sdlc init` writes:

| Path | Purpose |
|---|---|
| `.ai-sdlc/pipeline.yaml` | Default pipeline definition (org/repo substituted from `git remote get-url origin`) |
| `.ai-sdlc/agent-role.yaml` | Default agent-role policy (configurable via `--role coding\|research\|meta`) |
| `.ai-sdlc/quality-gate.yaml` | Default quality-gate config |
| `.ai-sdlc/autonomy-policy.yaml` | Default autonomy-policy config |
| `.github/workflows/ai-sdlc-gate.yml` | The single rollup `ai-sdlc/pr-ready` PR-ready gate (Q1 prescriptive default) |
| `CLAUDE.md` | Recommendation pointer block (idempotent — won't duplicate if you already have one) |

## Flag reference

| Flag | Behavior |
|---|---|
| `--yes` / `-y` | Accept ALL defaults; no prompts. Required for CI/scripted bootstrap. |
| `--with-dor` | Scaffold DoR without prompting (other features still prompted unless `--yes` is also set). |
| `--with-attestation` | Scaffold attestation infra without prompting. |
| `--with-classifier` | Scaffold classifier config stub without prompting. |
| `--with-branch-protection` | Apply branch protection without prompting (requires `gh` on PATH). |
| `--with-workflows` | Scaffold the full GitHub Actions workflow bundle (gate, review, attestation, auto-merge) without prompting (AISDLC-261). |
| `--with-signal-ingestion` | Scaffold the RFC-0030 signal-ingestion config stub at `.ai-sdlc/signal-ingestion.yaml` (AISDLC-348). Disabled by default; opt in via `AI_SDLC_SIGNAL_INGESTION` during the soak window. |
| `--force` | Overwrite existing workflow files. Only applies to `.github/workflows/` files — non-workflow files are always skipped for safety. Use with `--with-workflows` or `--add workflows` (AISDLC-261). |
| `--add <feature>` | Extend an already-initialized repo with a single feature. `<feature>` is one of `dor`, `attestation`, `classifier`, `branch-protection`, `workflows`, `signal-ingestion`. Idempotent — files that already exist are left untouched (except with `--force` for `workflows`). The baseline scaffold is NOT re-written in `--add` mode. |
| `--dry-run` | Print what would happen without writing files. For branch protection this prints the JSON body of the `gh api` request. |
| `--skip-mcp` | Skip MCP server auto-configuration (Claude Code, Cursor, etc.). |
| `--cursor` | Force-install Cursor MCP config even if Cursor isn't detected on this machine. |
| `--role <tier>` | Agent-role tool tier: `coding` (default), `research` (adds WebFetch + WebSearch), `meta` (adds Task + Skill). |
| `-d, --dir <path>` | Config directory name (default `.ai-sdlc`). |

## Idempotency guarantees

Re-running `ai-sdlc init` on an already-initialized repo is safe:

- **Existing files are skipped.** Each scaffolded path is checked for
  existence before writing; the wizard logs `skip <path> (already exists)`
  and moves on.
- **Append-once for shared files.** `.husky/pre-push` and `CLAUDE.md` are
  appended to (not overwritten) and use sentinel markers
  (`# ai-sdlc:attestation-sign-block`, `<!-- ai-sdlc:recommendation-pointer -->`)
  so re-running the wizard never duplicates content.
- **Branch protection is a PUT.** GitHub's API treats `PUT
  branches/{branch}/protection` as upsert — re-applying the recommended
  rule overwrites with the same payload.

This is what makes `--add <feature>` safe to run after an initial
bootstrap: you can opt into a feature later without worrying about
clobbering the original install.

## Recommended bootstrap sequences

### First-time setup, interactive

```bash
cd my-new-repo
git init                          # required for org/repo detection
git remote add origin git@github.com:my-org/my-new-repo.git
ai-sdlc init                      # walk the wizard
git add .ai-sdlc .github .husky CLAUDE.md
git commit -m "chore: bootstrap AI-SDLC config"
```

### First-time setup, non-interactive (CI / Terraform / scripts)

```bash
ai-sdlc init --yes --skip-mcp
git add .ai-sdlc .github .husky CLAUDE.md
git commit -m "chore: bootstrap AI-SDLC config"
```

### Adopting attestation later

```bash
ai-sdlc init --add attestation
# Then:
/ai-sdlc init-signing-key            # one-time: generate your key
# open a PR appending the printed YAML block to .ai-sdlc/trusted-reviewers.yaml
```

### Adopting branch protection later (with a dry-run preview)

```bash
ai-sdlc init --add branch-protection --dry-run    # see the JSON body
ai-sdlc init --add branch-protection              # actually apply
```

### Adding the GitHub Actions workflow bundle to a pre-261 repo (AISDLC-261)

If you initialized before AISDLC-261 shipped and don't have the full
workflow bundle in `.github/workflows/`, run:

```bash
# Dry-run first to see what would be written:
ai-sdlc init --add workflows --dry-run

# Write the 4 workflow files (skips any that already exist):
ai-sdlc init --add workflows

# Overwrite ALL 4 workflow files with the current templates:
ai-sdlc init --add workflows --force
```

The four files written:

| File | Purpose |
|---|---|
| `.github/workflows/ai-sdlc-gate.yml` | Single rollup `ai-sdlc/pr-ready` check |
| `.github/workflows/verify-attestation.yml` | DSSE attestation verifier (audit-only) |
| `.github/workflows/ai-sdlc-review.yml` | PR review status poster (stub — wire your reviewers) |
| `.github/workflows/auto-enable-auto-merge.yml` | Arms auto-merge on every same-repo PR |

After scaffolding:
1. Enable "Allow auto-merge" in GitHub Settings → General.
2. Add an `AI_SDLC_PAT` repository secret with write access (used by `auto-enable-auto-merge.yml`).
3. Commit and push the 4 workflow files.

## Verifying the install

```bash
ai-sdlc health    # validates config files + reports drift
```

## Troubleshooting

### "gh repo view failed"

Branch-protection apply requires `gh` authenticated against the target
repo. Run `gh auth login` and re-run with `ai-sdlc init --add
branch-protection`.

### "no git origin remote detected"

`pipeline.yaml` will use the literal `your-org` placeholder. Add a remote
with `git remote add origin <url>` and re-run `ai-sdlc init` (existing
files will be skipped; you'll need to either delete `pipeline.yaml` to
trigger a re-write or manually substitute the placeholder).

### Wizard hangs

You're running in a non-TTY environment (CI, container, redirected
stdin). Pass `--yes` (or any combination of `--with-X` flags that
covers the prompts) to bypass interactive input.

### Want to skip a feature later?

Delete the scaffolded files. The features are file-presence-driven —
remove `.ai-sdlc/dor-config.yaml` + `.github/workflows/dor-ingress.yml`
to disable DoR; remove `.github/workflows/verify-attestation.yml` to
disable attestation verification; etc.

## Design notes

- **Q1 (prescriptive default).** The baseline gate workflow is
  scaffolded UNCONDITIONALLY because every adopter benefits from the
  single rollup `ai-sdlc/pr-ready` check. There's no `--without-gate`
  flag — operators who want to opt out can delete the file.
- **Q3 (attestation = audit-only).** The scaffolded
  `verify-attestation.yml` is the audit-only variant. It logs verification
  results to the workflow run log but does NOT post a required commit
  status. Promoting attestation to a hard gate is an explicit operator
  action documented in [`quality-gate.md`](./quality-gate.md).
- **Q4(b) (interactive default + `--yes` escape hatch).** The wizard is
  the default to give first-time adopters a guided bootstrap; `--yes`
  exists for CI/scripted use. `--with-X` flags are for operators who
  know exactly which features they want without the wizard preamble.
- **Adopter-first design.** Per the
  [`feedback_design_for_adopters_first`](#) memory, the framework
  defaults must work in a brand-new repo with no prior configuration —
  hence the always-on baseline + idempotent re-runs.

## See also

- [`docs/operations/quality-gate.md`](./quality-gate.md) — the
  `ai-sdlc/pr-ready` rollup architecture this init scaffolds.
- [`docs/operations/operator-runbook.md`](./operator-runbook.md) — day-2
  operations for AI-SDLC repos.
- The `init-features.ts` source — for adopters extending the wizard
  with custom features (the `FeatureTemplateSet` interface is the
  extension point).
