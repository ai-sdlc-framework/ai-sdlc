# pipeline-backlog.yaml Migration Guide (AISDLC-245.5)

## Background

Prior to AISDLC-245.5, the backlog-workflow configuration (branch naming,
PR title template) lived in `.ai-sdlc/pipeline-backlog.yaml`. Adopter repos
initialized with `ai-sdlc init` received `.ai-sdlc/pipeline.yaml` only —
the `pipeline-backlog.yaml` schema was framework-internal and undocumented.

**Operator decision (2026-05-10):** `pipeline.yaml` is canonical. A new
`spec.backlog` section hosts all backlog-workflow settings. `pipeline-backlog.yaml`
is deprecated and will be removed in the next major release.

## Migration steps (one-time, per repo)

### Step 1 — Add `spec.backlog` to your `.ai-sdlc/pipeline.yaml`

Open `.ai-sdlc/pipeline.yaml` and append the `backlog:` key under `spec`:

```yaml
spec:
  # ... existing spec fields ...

  # NEW: backlog-workflow settings (migrated from pipeline-backlog.yaml)
  backlog:
    branching:
      pattern: 'ai-sdlc/{issueIdLower}-{slug}'
      targetBranch: main
      cleanup: on-merge
    pullRequest:
      titleTemplate: 'feat: {issueTitle} ({issueId})'
      descriptionSections:
        - summary
        - changes
        - closes
      includeProvenance: true
      closeKeyword: References
```

Adjust `pattern` and `titleTemplate` to match what your current
`pipeline-backlog.yaml` has under `branching.pattern` and
`pullRequest.titleTemplate`.

### Step 2 — Remove or archive `pipeline-backlog.yaml`

Once `pipeline.yaml` has the `backlog:` section and you've verified that
`/ai-sdlc execute` computes branch names and PR titles correctly (see
verification below), you can delete `pipeline-backlog.yaml`:

```bash
git rm .ai-sdlc/pipeline-backlog.yaml
git commit -m "chore: remove deprecated pipeline-backlog.yaml (AISDLC-245.5)"
```

Readers (step-02, step-11 in `@ai-sdlc/pipeline-cli`) emit a `[ai-sdlc]
DEPRECATION` warning to stderr whenever they fall back to
`pipeline-backlog.yaml`. The warning disappears once the file is removed.

### Step 3 — Verify

```bash
# Dry-run a branch computation for any open task:
node pipeline-cli/bin/cli-compute-branch.mjs AISDLC-<n> --print-only

# Or run the full test suite:
pnpm build && pnpm test
```

Confirm:
- Branch name matches the pattern from `pipeline.yaml spec.backlog.branching.pattern`
- No `DEPRECATION` warning appears in the output

## Adopters on older plugin versions

If you installed `@ai-sdlc/orchestrator` before AISDLC-245.5 and your repo
has `pipeline-backlog.yaml` but NO `backlog:` section in `pipeline.yaml`,
all existing slash commands continue to work via the fallback shim (with a
deprecation warning). Migrate at your earliest convenience — the shim will
be removed in the next major release.

## Removal timeline

| Release | Action |
|---------|--------|
| Current | `pipeline-backlog.yaml` deprecated; readers fall back with warning |
| Next major | `pipeline-backlog.yaml` fallback code removed |

To track removal, subscribe to the issue AISDLC-245.5 in the backlog.
