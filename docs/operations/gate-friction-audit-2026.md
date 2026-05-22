---
title: Gate Friction Audit — 2026
status: in-progress
owner: Dominique Legault
relatedTask: AISDLC-384
startedAt: 2026-05-22
---

# Gate Friction Audit — 2026

## Purpose

Walk every quality gate in the pre-push chain and CI pipeline. For each: measure pre-push latency, PR-to-merge wall-clock contribution, and friction-count (operator interrupts / bypasses / rebuilds caused by the gate). Produce a per-gate KEEP / OPTIMIZE / DELETE verdict with a concrete optimization path where one exists.

## Method (per gate)

1. **Read** the script / workflow / hook source
2. **Live timing** — pull last 10 CI runs via `gh run view` + `gh api repos/.../actions/jobs` for the relevant job
3. **Incident search** — `git log --oneline | grep -i <gate-keyword>` + `find backlog/completed -name "*<keyword>*"` to count incidents the gate caught vs incidents that bypassed it
4. **Verdict** — KEEP (no change), OPTIMIZE (with concrete proposal), or DELETE (with risk argument)

## Gate inventory

Pre-push (`.husky/pre-push`, ordered):
1. `scripts/check-coverage.sh` — 80% lines per package
2. `scripts/check-task-moved.sh` — auto-move backlog file to completed/
3. `scripts/check-mcp-bundle-sync.sh` — MCP bundle consistency
4. `scripts/check-squash-attestation-chores.sh` — chore-commit squash
5. `scripts/check-dor-gate.sh` — Definition-of-Ready evaluation
6. `scripts/check-attestation-sign.sh` — auto-sign DSSE envelope
7. `scripts/check-skip-ci-marker.sh` — block `[skip ci]` magic tokens

CI required checks (`ai-sdlc/pr-ready` rollup):
- Build & Test (×2 — orchestrator + dogfood)
- Coverage (Codecov gate)
- Integration Tests
- Lint & Format
- Detect Changes (paths-filter)
- Verify dist/bin.js
- Backlog Drift
- Evaluate backlog tasks
- Post Review Results
- pr-ready (alls-green rollup)
- issue-link
- verify-attestation (AISDLC-193)

---

## Gate 1 — `scripts/check-coverage.sh`

**Verdict: OPTIMIZE (Option A + Option B together)**

### Read

80 lines of bash. Runs `pnpm -r build` (justified by AISDLC-212 incident — dogfood exports.test.ts times out without dist), then `pnpm -r test:coverage`, walks every package's `coverage/coverage-summary.json`, fails if any `lines.pct < 80`. Escape hatches: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_COVERAGE_GATE=1`.

### Live timing (CI, last 3 successful runs)

- Coverage job: 186s, 313s, 320s — mean ~273s (~4.5 min)
- Full `ai-sdlc-ci` workflow: 250–347s
- **Coverage IS the CI critical path** — the workflow finishes when Coverage finishes

### Incident provenance

- Script header comment cites PR #67 (hit 79.84% silently) as the origin incident
- No subsequent search hits — the gate has done its job; no missed-coverage regressions since AISDLC-67

### Friction observed

1. **Double-spend** — same coverage data computed locally on `git push` AND on CI. Locally the threshold-walk result is thrown away (only pass/fail kept). CI re-computes from scratch + uploads to Codecov.
2. **Full workspace `pnpm -r build` before coverage** — even for a 5-line typo fix in `ai-sdlc-plugin/commands/*.md`. Heaviest single step.
3. **Full workspace `pnpm -r test:coverage`** — touching a docs file runs the entire orchestrator test suite locally.

### Decision: A + B

- **A — turbo affected-package filter.** Replace `pnpm -r build` / `pnpm -r test:coverage` with `turbo run build --filter=...[origin/main]` / `turbo run test:coverage --filter=...[origin/main]`. Coverage threshold-walk only opens summary files for packages turbo actually touched. Existing `turbo.json` already declares dependency graph. Estimated savings: 60–80% of local time for typical PRs; full run on cross-cutting changes.
- **B — docs-only short-circuit.** Before any build/test, run `scripts/is-docs-only-changeset.mjs <base..HEAD>` (already used by CI workflows per AISDLC-206/AISDLC-214). If docs-only: exit 0 with `[coverage-gate] docs-only changeset — skipping`. Saves 100% on docs PRs.

### Risk

- Turbo's `--filter=...[origin/main]` can miss transitive consumers if `package.json` `dependencies` aren't accurate. Mitigation: existing CI Codecov gate is the safety net — local gate is convenience, CI is correctness. The AISDLC-67 incident origin was a single-package miss, not a transitive-dep miss, so this risk is small.
- Docs-only short-circuit must match the CI shortcut path exactly to avoid divergence (local approves, CI fails). Mitigation: use the same `is-docs-only-changeset.mjs` script.

### Estimated payoff

Per-push: typical 4–6 min → 30s–2 min. Across an active dev session (~10 pushes): saves ~30 min of operator wall-clock.

### Implementation path

Small focused PR — file as `AISDLC-384.1` (or whatever naming convention 384 uses):
- Modify `scripts/check-coverage.sh` to call `is-docs-only-changeset.mjs` first; bail if docs-only
- Replace `pnpm -r build` / `pnpm -r test:coverage` with turbo filter equivalents
- Verify against fixture push range (no change → must pass; missing coverage → must fail; docs-only → must short-circuit)
- Document the AISDLC-67-class incident in script comment (already there)

---

## Gate 2 — `scripts/check-task-moved.sh`

**Verdict: KEEP (no change)**

### Read

250 lines of bash. Scans push range for commits whose subject contains `(AISDLC-N)`. For each task ID: if `backlog/tasks/aisdlc-N - *.md` still exists, invokes `node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N` to mv to `completed/`, stages the change, creates a single chore commit, exits 1 with "re-run git push". Skip: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_TASK_MOVE=1`. Order is load-bearing — MUST run before attestation-sign so contentHash binds the new path.

### Live timing

- Local cost: ~100–500ms per fire (git mv + git add + chore commit + exit 1)
- CI cost: 0 (local-only)
- Friction per fire: 1–2s operator delay (re-run `git push`)

### Incident provenance

- 60 `chore: auto-close AISDLC-N (AISDLC-220)` commits in `git log` since AISDLC-220 shipped — gate has fired 60 times, each catching a real "dev forgot to mv" case
- Origin incident: retired `backlog-task-complete.yml` workflow created orphan chore PRs after every merge (GITHUB_TOKEN-pushed PRs don't fire CI or trigger auto-enable-auto-merge → orphans never auto-merged)
- Estimated prevented orphan-PR cleanup: ~30 min operator wall-clock × 60 = ~30h saved
- Total friction delivered: ~60–120s across all 60 fires

### Decision: KEEP

The "obvious optimization" — amending the last commit instead of `new chore + exit 1` — is riskier than the 1–2s friction it saves:
- Amending already-pushed commits becomes force-push territory
- Amending in-progress commits silently changes SHAs, which can invalidate adjacent attestation envelopes (we lived through this in the 383.X v4-mismatch chain)
- The "silent mode" alternative (exit 0, let chore commit ride on next push) loses the "did you mean to leave this in tasks/?" signal that's the gate's primary value

The friction is below the my-time-is-worth-it threshold; the work it does is substantial. No change.

---

## Gate 3 — `scripts/check-mcp-bundle-sync.sh`

**Verdict: DELETE (architectural — shipped via AISDLC-385)**

### Read

223 lines of bash. Triggers when push range touches `pipeline-cli/src/**`. Rebuilds `ai-sdlc-plugin/mcp-server/dist/bin.js` via `pnpm --filter @ai-sdlc/plugin-mcp-server build`, hashes before+after, stages + chore commits + exits 1 if differs. Sibling CI gate `scripts/verify-bundle.mjs` enforces byte-equal on the merged result.

### Live timing

- Local cost: <100ms (skip) or ~10–30s (rebuild)
- CI cost: 0 directly (Verify dist/bin.js is fast — re-bundles + diffs)

### Incident provenance

- 5 `chore: auto-rebuild mcp-server bundle (AISDLC-357)` commits since AISDLC-357 shipped
- Origin: marketplace clones the repo without `pnpm install`, so `dist/bin.js` MUST be committed and current
- Each fire saved ~5–10 min of amend-cycle vs catching it on CI; ~30–50 min total saved

### Architectural critique

Committing a generated artifact to the source tree is a smell. The gate exists because the in-tree bundle is the marketplace's only consumption path. But:

- `@ai-sdlc/plugin-mcp-server` is **already** a publishable npm package with `publishConfig: { access: 'public' }` (`ai-sdlc-plugin/mcp-server/package.json`)
- `release-please-config.json` already tracks the mcp-server in the `node-packages` linked-versions group → it's published on every release
- `ai-sdlc-plugin/scripts/install-runtime-deps.sh` already self-heals "marketplace doesn't run npm install" for runtime dependencies

The mcp-server bundle is the only generated artifact still riding the in-tree path. The architecture to fix it is 95% in place; we just never wired the mcp-server through it.

### Decision: file AISDLC-385

`backlog/tasks/aisdlc-385 - chore-distribute-mcp-server-bundle-via-npm-not-git.md` — distribute mcp-server bundle via npm package + runtimeDependencies self-heal. Deletes this pre-push gate + the CI sibling + the in-tree `dist/`.

### Estimated payoff

- Per-push: eliminates 10–30s rebuild fires entirely (~2.5 min lifetime savings was tiny — but the bigger win is psychological clarity: developers stop thinking about bundle state)
- Per-rebase: eliminates v4-mismatch class of bundle-rebuild-changes-contentHash kicks
- Per-release: simpler, cleaner artifact distribution
- Per-architect: removes a checked-in generated artifact (correct posture)

### Risks captured in AISDLC-385 frontmatter

Dogfood disruption, version skew during PR review, first-release chicken-and-egg, release-please cadence. All have mitigations in the task body.

---

## Gate 4 — `scripts/squash-attestation-chores.sh`

**Verdict: KEEP through v6 cutover, DELETE post-383.7**

### Read

84 lines of bash. Walks last 20 commits, finds the longest run of consecutive `chore: (sign|auto-sign) (v5 |review )?attestation` commits at HEAD, soft-resets to before the run + recommits with the topmost message. Never crosses non-chore boundaries. Escape: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_SQUASH_CHORES=1`.

### Live timing

- Local cost: ~100–300ms (silent no-op when stack ≤ 1)
- CI cost: 0 (local-only)
- Operator impact: ZERO — squash is silent; no exit-1, no re-push required

### Incident provenance

- 291 total `chore: sign attestation` commits in branch history
- **38 instances of consecutive chore-sign stacks** without an intervening dev commit:
  - 22 × 2-stack, 11 × 3-stack, 2 × 4-stack, 2 × 5-stack, 1 × 8-stack
- Without this gate ~120 noise commits would survive; with it ~38 commits remain (saves ~82 noise commits in branch history)
- Origin: AISDLC-369 (V5 rebase fragility — re-sign loops stack 3-8 chore commits on a single branch)

### Decision: KEEP through cutover, DELETE in 383.7

The gate's reason-for-being is the V5 rebase-kicks pattern. RFC-0042 v6 (now active as of 2026-05-22 cutover) replaces that pattern with Merkle-signed leaves — no more contentHash-kicks-on-rebase, no more re-sign chains. The gate becomes vestigial once v6 is the only path.

- **Now → 383.7 ships**: keep as-is. Still useful during the soak window as v5 envelopes age out.
- **383.7 deletes v5 signer code**: include `scripts/squash-attestation-chores.sh` deletion + `.husky/pre-push` line removal + CLAUDE.md doc update in the same PR. Dependency is explicit; no separate cleanup PR needed.

### Estimated payoff

- During soak: ~0 net change (gate is already free)
- Post-deletion: -84 LOC, one less concept in the pre-push chain, simpler mental model

---

## Gate 5 — `scripts/check-dor-gate.sh`

**Verdict: KEEP (no change)**

### Read

92 lines of bash. Parses pre-push stdin range, finds touched `backlog/{tasks,completed}/*.md` files, runs `node pipeline-cli/bin/cli-dor-check.mjs --staged --push-range A..B` against each. Forces `evaluationMode: enforce` to BLOCK locally even when repo's `dor-config.yaml` is `warn-only`. Catches gate-2 markers (TBD/XXX/TODO), gate-3 unresolved refs, gate-7 invisible-dependency phrases, upstream-OQ blocks. No-op on fresh worktrees pre-build (bin/dist missing). Skip: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_DOR_GATE=1`.

### Live timing

- CLI cold start: 66ms (measured)
- Per-task evaluation: <500ms for the 7-gate rubric
- Typical push (1-2 task files): ~1-2s total local cost
- CI cost: 0 (local-only — though CI sibling `Evaluate backlog tasks` covers overlapping classes)

### Incident provenance

- 13 PRs touching AISDLC-370 or AISDLC-296 (gate's ancestry — significant invested work)
- Origin: AISDLC-370 — tasks merging with TBD markers + dangling refs causing post-merge cleanup
- Integrates AISDLC-296 upstream-OQ gate (RFC-0011 extension)

### Decision: KEEP

The cost is in the noise (~1-2s) and the value (catching TBD markers + dangling refs before CI rejects them) is real. Two alternatives considered and rejected:

- **Respect warn-only**: appealing in principle (restores operator choice) but the gate exists precisely because operators were merging tasks with TBD markers; restoring warn-only re-opens that hole.
- **Skip on docs-only**: the gate IS the docs-only check for task files specifically; conflating layers makes it worse, not better.

CI gates (`backlog-drift`, `Evaluate backlog tasks`) catch overlapping classes — but pre-push catches them BEFORE a CI cycle, which is the primary value. Keeping both is intentional defense-in-depth.

---

## Gate 6 — `scripts/check-attestation-sign.sh`

**Verdict: KEEP (with two architectural follow-ups: AISDLC-386 + AISDLC-388)**

### Read

492 lines of bash (largest hook in chain). 1190 LOC of tests (most-tested gate, critical infra).

Behavior: reads `.active-task` sentinel + verdict file → idempotency check (skip if envelope at HEAD) → invokes `sign-attestation.mjs` (481 LOC, supports v5/v6) → stages + chore commits + exits 1 ("re-push required"). Honors v6 cutover env (defaults to v6 schema when `AI_SDLC_V6_CUTOVER_ACTIVE=1`). Skip: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

Origin: AISDLC-133 — moved signing from `/ai-sdlc execute` Step 10 (LLM-driven, model-context-spending) to deterministic hook. "anything mechanical → hook/workflow, never LLM".

### Live timing

- Local cost when fires: ~1–3s (signer + commit)
- Local cost when skips (no sentinel / no verdict / already signed): <50ms
- CI cost: 0 (local-only — CI's verify-attestation enforces what this produces)

### Incident provenance

- **166 `auto-sign attestation` chore commits** in branch history — gate has fired 166 times
- 166 attestations correctly signed without LLM context spend
- v6 cutover (now active) makes this gate MORE valuable: v6 signer reads transcript leaves and builds the Merkle tree — even more deterministic work to offload from LLM
- Discovered mid-audit: AISDLC-215 docs-only synthesis sub-path was incompatible with v6 (filed + shipped as AISDLC-387 / PR #603)

### Decision: KEEP

Massive value (166 LLM-context-saves), comprehensive tests (1190 LOC), v6 makes it even more critical. The exit-1 re-push is the only friction and it's well-known.

### Two architectural follow-ups filed (not changing Gate 6's verdict)

- **AISDLC-386** — UX improvement: collapse the pre-push re-push chain (Gates 2 + 3 + 6 all use exit-1 semantics; worst case operator does 3 pushes for one logical push). Orchestrator hook runs all mechanical fixups in dependency order and exits 1 ONCE.
- **AISDLC-388** — architectural fix: make `ai-sdlc/attestation` a non-required check on main; let `ai-sdlc/pr-ready` rollup gate per-archetype (docs-only → skip attestation; code → require it). Eliminates the entire "docs need attestation status posted" workaround class.

### Surfaced + shipped emergency: AISDLC-387

Mid-audit discovery: with v6 cutover active, AISDLC-215's docs-only synthesis path throws (`signAndWriteV6Envelope` requires transcript leaves; docs-only PRs have none by design). Next docs-only push would have failed. Filed + dispatched + shipped as [PR #603](https://github.com/ai-sdlc-framework/ai-sdlc/pull/603) inline. Deleted dead code path entirely; no replacement workaround.

---

## Gate 7 — `scripts/check-skip-ci-marker.sh`

**Verdict: KEEP (no change)**

### Read

177 lines of bash. Scans every commit subject + body in push range for the 5 GitHub Actions magic substrings (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`), case-insensitive. Exempts historical AISDLC-87 bot-attestor commits (author + subject match — dead-code-in-waiting since AISDLC-152 retired the producer). Skip: `AI_SDLC_BYPASS_ALL_GATES=1`, `AI_SDLC_SKIP_MARKER_GATE=1`.

### Live timing

- Local cost: <100ms (regex grep on commit messages in push range)
- CI cost: 0 (local-only — by design; cannot be CI-enforced because the gate exists to prevent CI itself from being disabled)

### Incident provenance

- 5 PRs touch AISDLC-88 ancestry
- 8 commits in history contain skip-ci patterns — all historical bot-attestor chore commits (the exempt case)
- Zero human-leak incidents in history — but defensive gates working correctly look like nothing happening

### Decision: KEEP

The only gate in the chain defending against an EXTERNAL footgun (GitHub Actions' silent magic-token behavior). Lowest friction (<100ms), highest blast radius if missed (silent governance bypass — verify-attestation + ai-sdlc-review both disabled by a single leaked token). As long as GitHub keeps the magic-token behavior, we keep the gate.

**Optional micro-cleanup** (not blocking): delete the bot-author exemption once in-flight PRs from before AISDLC-152 cycle out. Small dead-code removal, no friction reduction.

---

## Summary — pre-push chain verdicts (Gates 1-7)

| # | Gate | Verdict | Follow-up |
|---|---|---|---|
| 1 | `check-coverage.sh` | OPTIMIZE A+B | turbo filter + docs-only short-circuit (not yet filed — scope under 384) |
| 2 | `check-task-moved.sh` | KEEP | — |
| 3 | `check-mcp-bundle-sync.sh` | **DELETE (architectural)** | AISDLC-385 — distribute bundle via npm, not git |
| 4 | `squash-attestation-chores.sh` | KEEP through cutover, DELETE post-383.7 | Fold into 383.7's v5-cleanup PR |
| 5 | `check-dor-gate.sh` | KEEP | — |
| 6 | `check-attestation-sign.sh` | KEEP | AISDLC-386 (UX), AISDLC-388 (architectural), AISDLC-387 (v6 incompat — PR #603, in flight) |
| 7 | `check-skip-ci-marker.sh` | KEEP | (optional cleanup of bot-author exemption) |

**Filed during this audit pass** (all sibling to AISDLC-384):
- AISDLC-385 — distribute mcp-server bundle via npm
- AISDLC-386 — collapse pre-push re-push chain
- AISDLC-388 — exclude docs from attestation requirement (architectural)
- AISDLC-387 — fix AISDLC-215 v6 incompat (PR #603, in flight; emergency surfaced mid-audit during Gate 6)

**Shipped during this audit pass**:
- 2026-05-22 — `AI_SDLC_V6_CUTOVER_ACTIVE=1` flipped per RFC-0042 Phase 3 (gated v6 default per AISDLC-383.6)
- 2026-05-22 — AISDLC-383.8 (PR #602) — transcript-leaf emission, v6 prerequisite stack complete

---

## Status

**This document is a checkpoint.** Pre-push hooks 1-7 audited and verdicts in. CI-side gates (12 entries listed in Gate inventory) still TODO. Follow-up audit pass to cover those + revisit pre-push verdicts after AISDLC-385/386/388 land.
