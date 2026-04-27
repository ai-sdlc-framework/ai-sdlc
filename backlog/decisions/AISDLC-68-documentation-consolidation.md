# Decision: Documentation consolidation across `ai-sdlc/docs` and `ai-sdlc-io/content/docs`

- **Status:** Accepted
- **Date:** 2026-04-27
- **Task:** AISDLC-68
- **Decision-makers:** AI-SDLC maintainers
- **Related:** RFC-0006 (drift example that surfaced the problem), AISDLC-69 (drift detector)

## Context

Two parallel documentation trees existed:

| Tree | Format | Role | Owner |
|---|---|---|---|
| `ai-sdlc/docs/` | `.md` | Source colocated with code | This repo |
| `ai-sdlc-io/content/docs/` | `.mdx` | Published Fumadocs site | Sibling repo |
| `ai-sdlc-io/content/spec/` | `.mdx` | Published RFCs and spec | Sibling repo |

Both trees mirror each other structurally but with no automated sync. RFC-0006 shipped only on the published side and was never written into the source tree, demonstrating the drift risk in the most concrete way: a published RFC with no source-of-truth equivalent.

A diff at the time of this decision showed:

- **34 source files** vs **45 published files** — the published tree had 11 extra documents (orphaned MDX with no source equivalent), including 5 API reference pages and 3 tutorials introduced by recent RFCs (PPA Triad, OpenShell, Review Calibration).
- The published tree also carries Fumadocs scaffolding (`meta.json`, synthesized `index.mdx`) that has no source-tree analog.
- Editors had no signal which tree was authoritative; both got edited directly, by different humans and agents, in different PRs.

Without a single source of truth and an automated sync, the trees would continue to drift and the drift would always be discovered late (during a "we shipped a feature, where are the docs" audit).

## Options considered

### Option 1 — Single source of truth + build-time conversion (CHOSEN)

`ai-sdlc/docs/` is canonical. A small Node script (`scripts/docs-sync.mjs`) converts `.md` → `.mdx` with frontmatter and writes the result into `ai-sdlc-io/content/docs/`. A divergence checker (`scripts/check-docs-sync.mjs`) runs the conversion to a temp directory and diffs against the published tree; CI fails the build if the trees diverge.

**Pros:**
- Documentation lives next to the code it documents, so PRs that change behavior naturally update docs in the same change.
- Conversion is small (~150 lines) and well-defined: read frontmatter, normalize H1 → `title`, rewrite `.md` links to `.mdx`, rename `README.md` to `index.mdx`.
- Editors only ever edit `.md` files. The `.mdx` tree becomes a build artifact, not a source.
- The published site keeps its Fumadocs ergonomics (frontmatter, navigation `meta.json`, synthesized index pages) without polluting the source.
- Drift detection is deterministic — run sync to a temp dir and `diff -r`. No fuzzy matching required.

**Cons:**
- The sibling repo PR is still a separate human action (we don't auto-push). Acceptable: the orchestrator already opens parallel sibling-repo PRs from the dogfood pipeline.
- `meta.json` and synthesized `index.mdx` files in the published tree must be preserved or generated, since they have no `.md` equivalent. We chose to **preserve** them (the sync script does not touch `meta.json` and treats `index.mdx` as a synthesized navigation page derived from the section's `README.md`).

### Option 2 — Single tree, format-agnostic (REJECTED)

Move all docs into `ai-sdlc-io/content/` and replace `ai-sdlc/docs/` with a deprecation marker pointing to the sibling repo.

**Pros:** Truly one tree, one format.

**Cons:**
- Documentation no longer lives next to the code it documents. PRs that change runtime behavior would need a cross-repo PR for docs, slowing iteration.
- Would force every code-touching contributor to clone two repos.
- Loses the offline-readable `.md` story for users who read source on GitHub.

Rejected primarily for the colocation argument: docs that drift from code are the originating problem; moving them further from code would make that worse, not better.

### Option 3 — Status quo + manual discipline (REJECTED)

Leave both trees, document the convention, hope humans follow it.

**Cons:** Already failed. RFC-0006 is the proof-of-failure example.

## Decision

**Option 1.** `ai-sdlc/docs/` is the single source of truth. `ai-sdlc-io/content/docs/` is generated and committed (kept in git so the published site has a deterministic build, but never edited by hand).

## Mechanism

Three artifacts implement this decision:

1. **`scripts/docs-sync.mjs`** — converts `docs/**/*.md` to `ai-sdlc-io/content/docs/**/*.mdx`, adding `title` frontmatter (extracted from H1), rewriting intra-doc `.md` links to `.mdx`, and renaming `README.md` → `index.mdx`. Preserves Fumadocs `meta.json` and synthesized `index.mdx` pages already present in the published tree (they are not overwritten and not deleted).
2. **`scripts/check-docs-sync.mjs`** — runs the conversion against a temporary directory and diffs the result against the published tree. Exits non-zero on divergence with a human-readable report. Wired into `pnpm test` via the new `docs:check` script so local + CI catches drift the same way.
3. **Reverse-migration of orphaned MDX** — files that existed only in the published tree (5 API-reference pages, 3 tutorials, RFC-0006-related docs) are written back to source as `.md` so the source tree is truly canonical going forward.

## Out of scope (deliberately)

- **Spec tree (`spec/` ↔ `content/spec/`)** is NOT consolidated by this work. The two-step task description called the spec tree "managed independently, NOT synced." That stays true. A follow-up task can apply the same mechanism to the spec tree if desired.
- **Workflow file** (`.github/workflows/docs-sync-check.yml`) cannot be created by the agent (blocked-paths hook). The PR description recommends a human add it as a one-line job that runs `pnpm docs:check`.
- **Writing missing docs** is out of scope. We move existing content; we don't author new content.

## Operator runbook check

`docs/operations/operator-runbook.md` is verified to publish correctly through the new mechanism: running `pnpm docs:sync` produces `ai-sdlc-io/content/docs/operations/operator-runbook.mdx` byte-identical to the existing published version (modulo title-frontmatter normalization).

## Follow-up

- AISDLC-69 (the drift detector) becomes simpler: it can call `pnpm docs:check` directly instead of re-implementing diffing.
- A future PR should apply the same pattern to `spec/` ↔ `content/spec/` if maintainers want spec drift caught the same way.
- A future PR should add the GitHub Actions workflow to invoke `pnpm docs:check` on every PR.
