---
name: rfc-init
description: Scaffold a new adopter RFC from the framework template (RFC-0036 Phase 2 / AISDLC-327).
argument-hint: <slug> [--title <title>] [--author <name>] [--rfc-dir <path>] [--force]
allowed-tools:
  - Read
  - Bash
model: inherit
---

Scaffold a new adopter RFC from the canonical `framework-rfc.md`
template. Writes to `<adopter-repo>/rfcs/<slug>.md` by default; honours
`.ai-sdlc/adopter-authoring.yaml`'s `rfc-scaffold.rfcDir` override per
RFC-0036 OQ-4, and respects an explicit `--rfc-dir` flag override.

## Per RFC-0036 OQ-5 + OQ-12 (resolved 2026-05-16)

- **One template — `framework-rfc.md`.** Variants (architecture /
  product-decision / retrospective) are a future Decision in the
  Catalog if adopter demand justifies the split. Cognitive load <
  flexibility for v1.
- **Dual surface.** This slash command and the underlying `ai-sdlc rfc
  init` CLI ship together — both shell out to the same
  `pipeline-cli/bin/cli-rfc.mjs init` entry point, so there is one
  source of truth for slug validation, path resolution, and template
  rendering.

## Phase scope (Phase 2 of RFC-0036)

- ✓ `init <slug>` CLI + slash command
- ✓ Single `framework-rfc.md` template
- ✓ Default path `<adopter-repo>/rfcs/<slug>.md` + `adopter-authoring.yaml` override
- ✓ Tutorial walkthrough (`docs/tutorials/11-authoring-adopter-rfc.md`)
- ✗ Decision Catalog cross-linking (Phase 9 / AISDLC-334 — already shipped via `cli-rfc index`)
- ✗ RFC variants (deferred — future Decision in the catalog)

## Usage

```bash
node pipeline-cli/bin/cli-rfc.mjs init <slug> [--title <title>] [--author <name>] [--rfc-dir <path>] [--force] [--template <path>] [--format <text|json>]
```

`$ARGUMENTS` is the slug + any flags. Slug rules: lowercase
alphanumeric + hyphens, no leading/trailing hyphens, no path
separators, max 80 chars.

```bash
ARGS="${ARGUMENTS:-}"
if [[ -z "$ARGS" ]]; then
  echo "Usage: /ai-sdlc rfc-init <slug> [--title <title>] [--author <name>] [--rfc-dir <path>] [--force]"
  exit 1
fi

# Pass the operator's args straight through. The CLI handles slug
# validation, conflict detection, and template materialisation.
node pipeline-cli/bin/cli-rfc.mjs init $ARGS
```

## Output

- **Success (text mode):** absolute destination path + resolved
  `rfcDir`, `rfcDirSource`, `template`, `slug`, `title`, `createdAt`,
  and a three-step "next steps" reminder.
- **Success (`--format json`):** structured envelope with `ok: true`,
  the resolved fields above, plus `created: true`.
- **Failure:** non-zero exit + a single stderr line explaining the
  blocker (invalid slug, existing destination without `--force`,
  missing template). The CLI does NOT partial-write — the file is
  either fully materialised or untouched.

## Notes

- The template ships with `@ai-sdlc/pipeline-cli` at
  `pipeline-cli/templates/framework-rfc.md`. The CLI resolves it
  relative to its own bundle, so the slash command works in any
  install that includes the pipeline-cli runtime dependency.
- Per-org config: `.ai-sdlc/adopter-authoring.yaml`'s `rfc-scaffold.rfcDir`
  key. Default `rfcs/`; multi-repo adopters override (e.g.
  `../company-rfcs/`).
- The scaffold is **opt-in** and **non-prescriptive** (RFC-0036 §7.3) —
  nothing in the framework forces strategic adopter work through this
  template. The lightweight shape is intentional; the adopter team
  evolves it as their process matures.
- For cross-referencing existing adopter RFCs against the
  RFC-0035 Decision Catalog, see the sibling `cli-rfc index` command
  (Phase 9 / AISDLC-334).
