---
id: RFC-0023
title: Operator TUI — Pipeline Monitoring + Steering Surface
status: Approved
lifecycle: Signed Off
author: dominique@reliablegenius.io
created: 2026-05-03
updated: 2026-05-13
targetSpecVersion: v1alpha1
requires: [RFC-0014, RFC-0015]
requiresDocs: []
---

# RFC-0023: Operator TUI — Pipeline Monitoring + Steering Surface

**Status:** Approved (AISDLC-178 umbrella + all 7 phases 178.1–178.7 + extension 178.4.1 shipped; all 10 OQs resolved via operator walkthrough 2026-05-03)
**Lifecycle:** Signed Off (lifecycle audit 2026-05-13 promoted from Ready for Review; flag default-on follows the same opt-in pattern as RFC-0014 / RFC-0015)
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-03
**Updated:** 2026-05-13
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0014 (dependency graph composition), RFC-0015 (autonomous pipeline orchestrator)

> The bold-status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

## 1. Summary

Now that the autonomous pipeline orchestrator (RFC-0015) is shipping, the operator's role shifts from "actively dispatching work" to "monitoring + unblocking the pipeline." This RFC specifies a terminal-based user interface (TUI) that becomes the operator's canonical surface for that role.

The TUI is **not** a re-implementation of backlog.md's existing kanban board (which already provides issue-state visibility). The TUI is the surface for what the kanban can't show: live pipeline state, PR readiness, dependency topology, blockers (especially human-in-the-loop), pipeline configuration, and operator-throughput analytics.

The framing thesis (per the **Decision Engine** vision): the operator's bottleneck is **decisions**, not commits. The TUI must therefore foreground decisions-pending — open questions, blocked PRs awaiting human input, gates flagged for clarification — over implementation status.

## 2. Motivation

### 2.1 Today's operator workflow is fragmented

To monitor pipeline state today, the operator context-switches across:

- `gh pr list` (open PRs)
- Terminal log tails of `cli-orchestrator start` (live event stream)
- backlog.md kanban (issue state)
- GitHub PR pages (review status, comments, blockers)
- `cli-status` JSON (pipeline run state)
- `cli-deps frontier` (dispatchable tasks)
- `cli-orchestrator status` (queue depth + frontier preview)

Each surface has its own data model, refresh cadence, and visual idiom. There is no single pane that surfaces "what's the pipeline doing right now and what needs my attention." The operator's decision throughput is bottlenecked by surface fragmentation.

### 2.2 Human-in-the-loop blocks stall pipelines indefinitely

The autonomous orchestrator can recover from many failure modes (the 9-mode playbook in RFC-0015 Phase 2), but it cannot recover from "human input required." Examples observed in dogfood:

- DoR Stage B refinement reviewer flags an open question — pipeline pauses until operator answers
- PR review surfaces a critical-severity finding that requires an architectural decision
- External dependency (e.g., upstream GitHub PR not yet merged) blocks dispatch
- Compliance posture change requires operator sign-off

Today, these stalls are invisible until the operator notices (e.g., from a Slack ping, an email digest, or "wait, why hasn't anything moved?"). The TUI must surface human-in-the-loop blockers as the **highest-priority signal**, eclipsing in-flight progress.

### 2.3 Pipeline state has rich semantics already captured but not surfaced

The framework already produces structured signals that a TUI can render:

- `events.jsonl` (RFC-0015 Phase 4 / AISDLC-169.4) — append-only, schema-conformant event stream
- RFC-0014 dependency snapshots — JSONL with effectivePriority + criticalPathLength per task
- `cli-status` artifacts — heartbeat + per-stage state
- DoR comments (issue body marker `<!-- ai-sdlc:dor-comment -->`) — explicit clarification asks

The gap is presentation, not data. The TUI is the assembly layer.

### 2.4 Operator throughput is unmeasured

The framework does not currently capture metrics on operator decision throughput:
- How long does each open question take to resolve?
- Which PRs spend the most time blocked on human input?
- What's the operator's WIP at any moment?
- Which decisions get re-opened (operator changed their mind)?

Without these metrics, operators cannot optimize their own throughput. The TUI is the natural place to capture them (every operator interaction is observable through it).

## 3. Goals

1. **Single-pane operator surface** for pipeline + PR + dependency + blocker state
2. **Foreground decisions-pending** above implementation progress
3. **Read-mostly, write-rarely** — config edits go through validated YAML writes; status changes go through the existing CLIs (don't invent new write paths)
4. **No duplication of backlog.md kanban** — link out via `gh browse` for issue boards
5. **Operator analytics surface** — throughput metrics visible from day one
6. **Compose with existing artifacts** — read events.jsonl, dep snapshots, cli-status JSON; do not invent a new state store
7. **Run anywhere the framework runs** — no GUI dependency, terminal-only

## 4. Non-goals

1. **Not a kanban board** — backlog.md already does this for issues
2. **Not a replacement for the GitHub PR UI** — the TUI summarizes PR state and links out for code review
3. **Not a write surface for backlog tasks** — task creation/edit goes through the MCP tools
4. **Not a real-time tail of every event** — terminal width prevents firehose; the TUI summarizes + filters
5. **Not a remote dashboard** — the operator runs it locally against their workspace; multi-user concurrent observation is out of scope (covered by `dashboard/` in the future)

## 5. User personas

This RFC focuses on **the operator** — the role defined in `project_team_roles.md` as "AI-SDLC Operator," typically held alongside an engineering or product role. The operator:

- Has authority to merge PRs (humans-only per project memory)
- Can resolve open questions on backlog tasks
- Can promote feature flags
- Owns pipeline configuration (`.ai-sdlc/*.yaml`)
- Is responsible for keeping the pipeline unblocked

A future iteration may extend the TUI for adopter operators (different access patterns, multi-tenant), but v1 targets the single-operator-single-workspace case.

## 6. High-level architecture

### 6.1 Process model

The TUI is a single foreground process: `cli-tui` (or `ai-sdlc tui`) that the operator runs in a terminal session. It:

- Reads from local artifact files (events.jsonl, dep snapshots, `.ai-sdlc/` config, `backlog/` task files)
- Shells out to `gh` for PR state (cached with TTL)
- Polls `cli-orchestrator status` for live frontier (cached with TTL)
- Renders to terminal via [Ink](https://github.com/vadimdemedes/ink) (React-for-CLI, ESM-friendly, matches the codebase's TS conventions)
- Exits cleanly on Ctrl+C

The TUI is **stateless** — all data sources are external. Restart loses no operator state.

### 6.2 Data sources

| Source | Refresh strategy | Used by panes |
|---|---|---|
| `events.jsonl` (date-rotated) | Tail + replay last N events | Live activity feed, recent failure modes |
| `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl` | Re-read on demand (dep graph view) | Dependency graph, critical-path view |
| `gh pr list --json ...` | Cache 60s, refresh on demand | PR pane |
| `gh issue view <id> --json comments` | Cache 60s, refresh on demand | DoR clarification surfacing |
| `cli-status` / `cli-orchestrator status` | Poll 10s | Live tick state, queue depth |
| `backlog/tasks/`, `backlog/completed/` | Re-read on demand (filesystem watch optional) | Pipeline journey overview |
| `.ai-sdlc/*.yaml` | Re-read on edit; validate via reference schema | Config pane |

The TUI never writes to these sources directly except via well-defined CLIs (e.g., `task_edit` MCP for task changes — invoked through the operator's main Claude Code session, not the TUI process itself).

### 6.3 Render boundary

The TUI lives in its own workspace package: `pipeline-cli/src/tui/` with binary at `pipeline-cli/bin/cli-tui.mjs`. Rationale:

- Same package as the orchestrator → shares types (`OrchestratorEvent`, `DependencyNode`, etc.) without re-export gymnastics
- Reuses existing `cli-status` / `cli-orchestrator` query logic via direct imports
- Builds + ships in the same npm publish cycle

Alternative considered: separate `@ai-sdlc/tui` package. Rejected for now to avoid premature package proliferation; can split later if it grows beyond ~5k LOC.

## 7. Pane layout (initial proposal)

The TUI starts in **Overview Mode** (default), a five-pane layout:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ai-sdlc tui — Operator Pipeline Monitor                       [q] quit    │
├───────────────────────────────┬───────────────────────────────────────────┤
│                               │                                           │
│  🛑 BLOCKERS (3)              │  📦 PRs IN FLIGHT (5)                     │
│  ─────────────────────────    │  ─────────────────────────────────────    │
│                               │                                           │
│  AISDLC-178  needs-clarif     │  #234  rfc/0023-tui  CI ✓ approved        │
│    "what about config write?" │     ready-to-merge                        │
│  PR #232  unaddressed-major   │  #233  fix/156      CI ⏳ in-progress     │
│    security:auth-cookies      │  #232  feat/175     review CHANGES        │
│  AISDLC-115.8  soak-window    │     ⚠ unaddressed major (auth-cookies)    │
│    until 2026-05-10           │  #231  chore/aisdlc-70  merged 2h ago     │
│                               │  #229  docs/runbook  human review pending │
│                               │                                           │
├───────────────────────────────┼───────────────────────────────────────────┤
│                               │                                           │
│  🛤️ CRITICAL PATH (frontier)  │  📊 LAST 24H                              │
│  ─────────────────────────    │  ─────────────────────────────────────    │
│                               │                                           │
│  AISDLC-174  effPri:2  cpl:0  │  Dispatched:  4    Merged:  3             │
│    DorConfig schema register  │  Failed:      1    Quarantined:  0        │
│  AISDLC-171  effPri:2  cpl:0  │  Operator decisions resolved:  6           │
│    HC composite design pillar │  Avg time-to-decision:        47 min      │
│  AISDLC-172  effPri:2  cpl:0  │  Time blocked on operator:    12% of WIP  │
│    Admit-confidence ceiling   │                                           │
│                               │                                           │
├───────────────────────────────┴───────────────────────────────────────────┤
│  📡 EVENTS (live tail)                                                    │
│  ─────────────────────────────────────────────────────────────────────    │
│  16:42:03  PrMerged          #231 chore/aisdlc-70                         │
│  16:38:15  ReviewerApproved  #234 rfc/0023-tui (test-reviewer)            │
│  16:35:02  DispatchSkipped   AISDLC-70 (orphan-parent-needs-closure)      │
│  16:33:48  TickStart         tick=42 frontier=8 maxConcurrent=1           │
└───────────────────────────────────────────────────────────────────────────┘
   [b] blockers  [p] PRs  [d] deps  [c] config  [a] analytics  [/] search
```

### 7.1 Blockers pane (top-left, default focus)

**Highest priority pane.** Lists every actionable item the operator must touch:

- Tasks in `Needs Clarification` status (DoR Stage B questions)
- PRs with unaddressed `CHANGES_REQUESTED` reviews (critical/major findings)
- Tasks awaiting external dependency resolution (`externalDependencies:` frontmatter, RFC-0015 Phase 3)
- Soak-window timers (e.g., AISDLC-115.8) with countdown + "ready when"
- Operator manual-override decisions pending

Each row clickable (Enter) → opens a detail view with the specific question/finding + context + action shortcuts.

### 7.2 PRs pane (top-right)

Compact summary of every open PR:

- PR number, branch, title (truncated)
- CI status (✓ green, ⏳ in-progress, ✗ red)
- Review state (approved / changes-requested / pending / no-reviews-yet)
- Merge state (clean / behind / dirty / blocked-by-required-check)
- "Next step" annotation: `awaiting-ci`, `ready-to-merge`, `awaiting-human`, `awaiting-rebase`
- **Chain indicator** (AISDLC-178.4.1): `🔗 N/M` when the PR is part of a serial merge chain (PR `N` of `M`); empty for singletons.
- **Unblocks count** (AISDLC-178.4.1): `unblocks N` — transitive count of downstream PRs blocked on this one.

Color-coded by urgency.

**Sort order** — default is **critical-path** (AISDLC-178.4.1):

```
prCriticalPathLength DESC → unblockCount DESC → effPri DESC → age (createdAt) ASC
```

Head-of-chain PRs surface first so the operator merges in dependency-respecting order and avoids rebase storms. The `s` keystroke cycles between three modes:

- `critical-path` (default) — merge sequence per the formula above.
- `recency` — `updatedAt` DESC; useful when the operator wants to see "what just changed."
- `ci-status` — legacy "operator-attention" bucket sort (blocked-on-human → changes-requested → awaiting-rebase → in-progress → ready-to-merge), preserved for back-compat.

PR dependencies powering critical-path are derived from three sources, in this order (deduped, weakest signal does not override stronger):

1. **Task dependencies via 1:1 task↔PR mapping** — branch-name task token (`AISDLC-NNN[.M[.K]]`) is looked up in the latest RFC-0014 dep snapshot; every dep ID that maps to another open PR contributes an upstream edge.
2. **Operator-declared `depends-on:#N` markers** — labels (`depends-on:#247`, also `depends-on-#N` and `depends-on: N` variants) and inline body markers (`Depends-on: #247`).
3. **Git branch ancestry** (optional, off by default in the render path) — pluggable hook so a future revision can wire `git merge-base --is-ancestor` once the perf budget is understood.

The longer-term home for auto-rebase trigger semantics, depends-on label conventions, and multi-repo PR ordering is **RFC-0034 (PR Merge Critical-Path Ordering)** — reserved (no file yet) per the registry. The minimum derivation needed for sort + chain indicator + chain-tree detail view ships under AISDLC-178.4.1.

Pressing Enter on a row opens a detail view with full title/body, review history, **and an ASCII chain tree** (upstream PRs above, downstream below — mirrors the §7.3 task dep-tree rendering).

### 7.3 Critical path pane (bottom-left)

Renders RFC-0014 dependency snapshot's frontier sorted by effectivePriority + criticalPathLength. Shows the next ~5–10 tasks the orchestrator would dispatch.

For each task: ID, title, effPri, CPL, "blast-radius" (downstream count from RFC-0014 Phase 3 / AISDLC-167.3).

Pressing Enter on a row opens a detail view with full dependency tree (parents + children) rendered as ASCII tree.

### 7.4 Analytics pane (bottom-right)

Operator-throughput metrics, computed from events.jsonl + task lifecycle data:

- Last 24h: dispatched / merged / failed / quarantined counts
- Operator decisions resolved (count of `Needs Clarification` → other status transitions)
- Avg time-to-decision (clarification posted → operator response)
- % WIP currently blocked on operator (vs. blocked on automation, blocked on external)

Future extensions: per-decision drill-down, week-over-week trends, decision-quality indicators (re-opened decisions = signal of premature resolution).

### 7.5 Events pane (bottom, full-width)

Live tail of `events.jsonl`. Filtered to operator-relevant event types (DispatchStarted, PrMerged, ReviewerApproved, ReviewerChangesRequested, OrchestratorRollback, OrchestratorWorkQuarantined, OrchestratorOrphanParent, etc.).

Scrollable history with `j`/`k`. `/` opens search. New events highlight briefly.

### 7.6 Mode switching

Footer key bindings switch the entire screen to a focused mode:

- `b` — Blockers full-screen (every actionable item, sortable, with detail panes)
- `p` — PRs full-screen (every open PR, with diff preview, review history)
- `d` — Dependency graph full-screen (ASCII tree rendering of full dep graph)
- `c` — Configuration browser (`.ai-sdlc/*.yaml` files, syntax-highlighted, validation errors highlighted; edit launches `$EDITOR`)
- `a` — Analytics full-screen (drill-down on each metric)

`q` quits, `?` shows help, `r` refreshes all data sources.

## 8. Decision-pending surfacing (centerpiece)

The framework's Decision Engine framing makes "decisions-pending" the operator's primary signal. The TUI gives this a first-class pane (Blockers) and a first-class metric (operator-throughput).

A "decision-pending" item is anything matching:

| Source | Matcher | Example |
|---|---|---|
| Backlog task | `status: Needs Clarification` (RFC-0011 Phase 4) | "What about config write paths?" |
| Backlog task | `<!-- ai-sdlc:dor-comment -->` marker in body, no operator response | DoR refinement reviewer asked Q |
| Open PR | Review with `state: CHANGES_REQUESTED`, not dismissed, no follow-up commit since | Reviewer flagged auth issue |
| Open PR | Conversation comment with no resolution + addressed: false | Open thread |
| Task with `externalDependencies:` | Any external dep status != resolved | npm package not yet published |
| Manual override | `cli-deps log-override` recent + matching task still open | Operator chose alternate dispatch |
| Soak window | RFC-0011 / RFC-0014 / RFC-0015 promotion windows | "Wait until 2026-05-10" |

Each decision surfaces with:
- **What's blocked** (task ID, PR number)
- **What's needed** (the question, the finding, the dep)
- **Cost of waiting** (effPri inheritance, downstream blast radius)
- **One-keystroke action** (open task in editor, open PR in browser via `gh browse`)

## 9. Configuration editing surface

Read-only browse + external-editor handoff for `.ai-sdlc/*.yaml`:

- TUI lists every YAML file under `.ai-sdlc/`
- Selecting a file shows it syntax-highlighted with validation errors annotated (using `@ai-sdlc/reference` validator)
- `e` launches `$EDITOR` (vim/nvim/code/etc.) on the file
- On editor exit, TUI re-validates + surfaces errors before saving

This pattern (browse + external editor) avoids reimplementing a YAML editor in Ink and keeps operator's existing editor configuration intact.

## 10. Analytics — operator throughput metrics

A new artifact directory `$ARTIFACTS_DIR/_operator/` accumulates operator interaction events (separate from `events.jsonl` which is pipeline-side):

- `decisions.jsonl` — every `Needs Clarification` → other-status transition with timestamp deltas
- `pr-decisions.jsonl` — every PR review action by the operator (merge, dismiss, comment) with elapsed time from "operator-attention-required" state
- `interactions.jsonl` — TUI navigation events (which panes opened, which items drilled into) for usability analysis (anonymized; opt-in via `AI_SDLC_TUI_TELEMETRY=on`)

These artifacts power:
- Time-to-decision distributions
- WIP-blocked-on-operator tracking
- "Where is the operator the bottleneck?" dashboard

Future RFC may extend this to a SaaS-level dashboard (cross-operator comparisons, team-level metrics). For now, single-operator local-only.

## 11. Backlog.md kanban integration

The TUI does NOT embed a kanban view. From any task row, `b` keystroke opens the backlog.md web kanban filtered to that task via `gh browse <kanban-url>?task=<id>`. Operator's browser handles the kanban UX.

If backlog.md ships native deep-link support, the TUI's URL construction is one-liner; if not, a follow-up RFC on backlog.md may add it.

## 12. Failure modes + observability

The TUI itself emits events to a separate `$ARTIFACTS_DIR/_tui/events.jsonl` for self-observability:

- `TuiStarted` (with version, terminal size)
- `TuiPaneOpened` (mode + pane name)
- `TuiActionTaken` (e.g., refresh, search, drill-down)
- `TuiDataSourceFailed` (e.g., gh CLI not installed, snapshot file missing)
- `TuiCrashed` (exception payload)

These are useful for the framework maintainers to understand TUI usage patterns + reliability.

The TUI MUST gracefully degrade when data sources are unavailable:
- No `events.jsonl` → "Live event tail unavailable" banner; other panes still work
- No dependency snapshot → "Critical path unavailable; run `cli-deps snapshot` to populate"
- `gh` not installed → PR pane shows install instructions
- No `.ai-sdlc/` directory → "No pipeline configured; init via `/ai-sdlc init`"

## 13. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 — Skeleton | `cli-tui` binary, Ink scaffold, Overview Mode with 5 placeholder panes, Ctrl+C exit | 3–5 days |
| 2 — Data sources | events.jsonl tail, gh PR cache, dep-snapshot reader, cli-status poller, backlog file walker | 1 week |
| 3 — Blockers pane | Decision-pending detection logic, sort by urgency, drill-down detail view | 1 week |
| 4 — PRs pane + Critical path pane | Full implementations replacing placeholders | 1 week |
| 5 — Mode switching + Config browser | `b`/`p`/`d`/`c`/`a` mode keys, external-editor handoff | 4–5 days |
| 6 — Analytics pane + operator metrics | `_operator/decisions.jsonl` writer hook into MCP task transitions, basic charts | 1 week |
| 7 — Soak + corpus aggregator + promotion | Operator dogfood for 1–2 weeks, capture pain points, hybrid promotion runbook | 2 weeks soak + 3 days runbook |

Total: ~6–8 weeks wall-clock, parallelizable phases 3 + 4 + 5.

## 14. Feature flag

`AI_SDLC_TUI=experimental` (mirroring the RFC-0015 pattern). When unset, `cli-tui` exits with a "not enabled" message + pointer to the promotion runbook. Promoted to default-on after Phase 7.

## 15. Resolved questions

All 10 open questions resolved during operator walkthrough on 2026-05-03. Resolutions are normative — implementation MUST follow.

### OQ-1 — Render boundary → **Ink**

Three options considered: Ink (React-for-CLI, ESM), blessed (lower-level imperative), custom minimal renderer. **Resolution:** Ink. Component model matches the §7 pane layout; ESM-native and matches codebase TS conventions; actively maintained (vs blessed, last release 2018); operator-contributor friendly (React skills transfer). The transitive-deps cost is bounded (~15 deps, immaterial against the orchestrator's existing tree). Custom renderer is a non-starter — months of work on the wrong problem.

### OQ-2 — Configuration editing flow → **external `$EDITOR` handoff**

Three options considered: external editor handoff, in-TUI form editor, read-only viewer + GitHub PR. **Resolution:** external editor handoff. Matches operator instinct (`git commit`, `crontab -e`). Validation runs at save via `@ai-sdlc/reference` validator on editor exit; invalid → inline error + offer `e` to re-edit. Avoids scope explosion (no per-field form components). Audit trail preserved through standard git/PR/branch protection. The form-builder path is months of work for marginal value over the operator's own editor.

### OQ-3 — Analytics surface scope → **both, operator-throughput primary**

Three options considered: per-operator only, pipeline only, both. **Resolution:** both, with operator-throughput as the primary (top-of-pane) section. The Decision Engine framing (VISION.md §3) names the operator's bottleneck as decisions; the Analytics pane MUST surface that throughput first. Pipeline metrics remain present (operators need framework-health visibility) but rendered below operator metrics with a clear visual divider. Composes with RFC-0025 framework-quality metrics in the pipeline-throughput section.

### OQ-4 — Decision-pending detection → **heuristic with override markers**

Three options considered: opt-in marker only, pure heuristic, hybrid. **Resolution:** heuristic detection with override markers (`<!-- ai-sdlc:not-a-decision -->` to suppress; `<!-- ai-sdlc:urgent-decision -->` to escalate). False negatives (missed decisions) are worse than false positives (one extra row to dismiss). The structured signals are already there: RFC-0011 `Needs Clarification`, RFC-0024 `triage: tbd`, GitHub `state: CHANGES_REQUESTED`, unresolved review threads. Detection rules in §8.

### OQ-5 — Backlog.md kanban integration → **link out only**

Two options considered: link out via `gh browse` / `open`, vs embed terminal-rendered kanban. **Resolution:** link out only. Backlog.md kanban is excellent for what it does; recreating it in terminal trades a working web UI for a degraded copy. Operator interactions at the kanban (drag-drop, multi-select, bulk-edit) are genuinely better in browser. The TUI's job is what backlog.md DOESN'T show (per §1). Implementation: macOS `open <url>`, Linux `xdg-open`, fallback `pbcopy`/`xclip`. Assumes backlog.md exposes deep-link query params (file backlog.md feature request if not — separate concern).

### OQ-6 — Polling vs filesystem watch → **polling v1; watch deferred to v2**

Two options considered: TTL-based polling, filesystem watch (`chokidar`/`fs.watch`). **Resolution:** polling for v1 (predictable cost, no update-storm risk during git/build operations, simple cross-platform). Filesystem watch deferred to v2 — pure data-layer optimization that can ship later without UI changes if operator-evidence-driven. Polling cadences in §6.2; manual refresh via `r` keystroke covers immediate-feedback cases.

### OQ-7 — Multi-workspace support → **single-workspace v1**

Two options considered: single-workspace, multi-workspace. **Resolution:** single-workspace v1. Multi-workspace solves a problem nobody currently has (today's operators work on one ai-sdlc project at a time). Operators managing multiple workspaces can use `tmux`/`zellij` panes — idiomatic for terminal users, costs us nothing. Multi-workspace as separate RFC if/when demand emerges (3+ adopters reporting need). Behavior contract: TUI walks up from cwd to find ai-sdlc workspace markers (`backlog/` + `.ai-sdlc/`); `--workspace <path>` overrides; clear error if launched outside any workspace.

### OQ-8 — Telemetry default → **opt-OUT (local-only data)**

Two options considered: opt-in vs opt-out. **Resolution:** opt-OUT for local TUI events written to `_tui/events.jsonl` on the operator's own filesystem. Critical distinction from project's general "opt-in for analytics" stance: the data here is local-only (operator owns the file, can `rm` anytime). Self-observability is load-bearing for framework's quality contract (RFC-0025) — opt-in defaults would empty the dataset. Disclosure shown at TUI startup: "Self-observability events writing to `<path>` — disable with `AI_SDLC_TUI_TELEMETRY=off`". **Hard line preserved:** if TUI events EVER ship offsite (future SaaS dashboard, framework-maintainer rollups), that becomes opt-IN with explicit consent.

### OQ-9 — Empty-state framing → **affirming**

Two options considered: neutral vs explicit Decision Engine affirmation. **Resolution:** affirming, understated. Empty-state copy: `✓ No decisions pending — pipeline self-driving`. Reinforces VISION.md §3 operator-as-decision-steward framing at every touchpoint. Operator can override empty-state copy via `.ai-sdlc/tui-config.yaml` if a different tone fits their team.

### OQ-10 — Failure-mode visibility ratio → **aggregate by mode with drill-down**

Two options considered: every failure event vs aggregate by mode. **Resolution:** aggregate by mode with `d` drill-down. A recovered failure is the framework upholding its quality contract (RFC-0025) — surfacing each one with equal weight to "operator decision required" inverts the urgency. Patterns matter more than incidents. Aggregate row format: `⚠ 9 failures recovered [push-race: 3, verify-fail: 4, rebase-conflict: 2] · d to drill`. **Auto-escalation rule:** if the same mode fires >5 times in an hour, the aggregate auto-promotes from Events pane summary to Blockers pane high-urgency entry — that pattern signals a real regression worth operator attention.

## 16. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ✅ Signed v0.2 (Engineering + Operator) | 2026-05-03 |
| Alexander Kline | Product Lead | ✅ Signed v0.2 | 2026-05-04 |

Lifecycle: Ready for Review → Signed Off (after Product Lead signs).

### Product Authority review

**Endorse, no PPA composition concerns** — TUI is a pure observability surface that consumes PPA output (pillar breakdown, burn-down, drift events, DoR verdicts) without influencing scoring.

The "Decision Engine" framing — operator's bottleneck is decisions, not commits — aligns with PPA HC composite prominence (Override + consensus + decision + design + product-authority). Foregrounding decisions-pending over implementation status is the right inversion.

**Recommended TUI surfacings** (Product-side prioritization):

1. **Healthy/unhealthy/ambiguous drift classification** prominently per shard — operators must see at a glance whether drift is the system working (healthy → DID revision proposal incoming) or failing (unhealthy → admission tightening recommendation). When RFC-0031 (Calibration-Driven DID Revision Proposal) lands, surface pending proposals as decision-pending blockers.
2. **Burst-spend requests** as decision-pending blockers with countdown timer — when RFC-0032 (Cost-Governance Seam) lands, BurstSpendRequest events are 4-hour-decision-required by definition; the TUI is the surface where this lands.
3. **Governance-report cadence** — when RFC-0033 (Governance Reporting Layer) lands, surface "weekly report due" / "quarterly audit-prep due" as ambient-not-blocking signals.
4. **Demand cluster top-N** — when RFC-0030 (Signal Ingestion Pipeline) lands, the top 5 demand clusters by D1 contribution become operator-facing context for why the queue looks the way it does.

These are forward-looking surface integrations; this RFC's v0.2 spec is approved as-is.

Position grounded in RFC-0029 Principle 5 (governance by composition; TUI consumes, doesn't influence).

## 17. References

- [RFC-0014 — Dependency Graph Composition](RFC-0014-dependency-graph-composition.md) — source of dep snapshot data
- [RFC-0015 — Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — events.jsonl, frontier semantics
- [RFC-0011 — Definition-of-Ready Gate](RFC-0011-definition-of-ready-gate.md) — `Needs Clarification` status, DoR comment marker
- [`project_decision_engine_vision.md`](../../) (auto-memory) — framework's organizing thesis
- [`project_operator_tui_vision.md`](../../) (auto-memory) — TUI requirements derivation
- [Ink](https://github.com/vadimdemedes/ink) — React-for-CLI rendering library

## 18. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-03 | dominique@reliablegenius.io | Initial draft seed; 10 open questions |
| v0.2 | 2026-05-03 | dominique@reliablegenius.io | All 10 OQs resolved via operator walkthrough. Lifecycle: Draft → Ready for Review. Engineering + Operator signed; awaiting Product Lead. |
