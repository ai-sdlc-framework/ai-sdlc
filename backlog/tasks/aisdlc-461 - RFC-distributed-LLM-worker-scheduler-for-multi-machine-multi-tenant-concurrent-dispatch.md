---
id: AISDLC-461
title: >-
  RFC: distributed LLM-worker scheduler for multi-machine multi-tenant
  concurrent dispatch
status: To Do
assignee: []
created_date: '2026-05-28 18:22'
updated_date: '2026-05-28 20:42'
labels:
  - rfc-draft
  - architecture
  - scheduler
  - infrastructure
  - subscription-billing
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-05-28 during an architectural step-back triggered by repeated failed attempts to autonomous-dispatch via the existing orchestrator-tick + cli-orchestrator paths. The operator's vision (paraphrased from their own words):

1. **Observability** — operator needs real-time visibility into issue development across all in-flight work.
2. **Subscription billing primary** — pipeline runs inside CC sessions; API tokens are overflow.
3. **Multi-dimensional concurrency** — N CC sessions per laptop (resource-aware: CPU/mem/disk), N laptops per human, N humans per org, N VMs, N GitHub Codespaces; mixed billing tiers.
4. **Resource monitoring** — per-host telemetry feeds admission decisions; don't dispatch when laptop is under pressure.
5. **Subscription burndown optimization** — per-user weekly quota tracking + burn-rate projection + pacing; target ~full quota utilization by end-of-week-window so paid capacity isn't wasted.
6. **Advanced scheduling** — task→worker assignment respects affinity (reviewer subagents on operator's session for escalation; long dev tasks on idle capacity), fair-share across users, cost-aware bidding.

The existing 3 patterns (X v2 in-session, Y cli-orchestrator subprocess, Z N sibling sessions) are all single-machine + lifecycle-coupled. None addresses (3)-(6).

## Industry comparison

| System | Lesson |
|---|---|
| Kubernetes pod scheduler | Worker registry, declarative resource model, eviction on pressure |
| HashiCorp Nomad | Multi-region, multi-cloud, heterogeneous scheduler; gossip-based discovery |
| Slurm (HPC) | Per-user fair-share + backfill — directly maps to subscription-burn optimization |
| AWS Batch / Karpenter | Cost-aware scheduling — maps to mixed sub/API billing |
| Sidekiq Enterprise / Celery | Distributed task queues, multi-worker multi-host |
| GitHub Actions self-hosted runners | Pull-based worker registration, label-based routing |

## Component sketch

- **Scheduler service** (hosted: Cloudflare Worker? small VM? D1/Postgres queue): task queue, worker registry, placement engine (affinity + resource-fit + burn-pacing), subscription ledger, observability API
- **Worker** (CC session + resource agent): pulls tasks, reports capacity, executes Step 0-13 pipeline
- **Operator CLI / TUI**: submit work, query state, view burn rates + ETAs

## Open Questions for the RFC walkthrough

1. Queue substrate (managed vs self-hosted, latency requirements)
2. Worker registration protocol (pull vs push, long-poll vs SSE)
3. Per-user subscription quota source (Anthropic billing API access? Operator-config? Inferred from token usage?)
4. Placement policy (capacity-fit vs fair-share-with-backfill; affinity rules)
5. Resource telemetry agent (separate process vs piggybacked on Worker)
6. Multi-tenant isolation (one queue per org? per user? shared with priority classes?)
7. Failure model (re-queue on worker death? cap on retries? operator-only re-dispatch?)
8. Observability surface (extend cli-tui? web dashboard? both?)
9. Backward compatibility (existing Dispatch Board as offline fallback?)
10. Cost-pool routing (sub-near-full → API workers; API budget low → throttle; what's the policy?)

## Phasing

Suggested 4-phase plan when this RFC is drafted:

- **Phase 1**: single-host worker pool with capacity awareness (host telemetry agent + admission filter)
- **Phase 2**: multi-host queue substrate (hosted queue + pull-based worker registration)
- **Phase 3**: subscription-burn pacer (per-user ledger + projection + adaptive throttling)
- **Phase 4**: observability surface (TUI/dashboard with real-time in-flight view)

## Why this task exists

The architectural conversation was deferred during a long session about why orchestrator-tick was not dispatching. The operator explicitly asked "make a note of the RFC for now so we do not forget it." This task is the persistent record so the conversation can resume when the operator is ready to walk through the OQs.

## Pre-work required

Operator walkthrough of the 10 OQs using the decision-rubric skill. Do NOT dispatch implementation work before OQs are resolved. Treat this as Draft-status RFC scaffolding only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RFC drafted as spec/rfcs/RFC-NNNN-distributed-llm-worker-scheduler.md (number assigned from registry)
- [ ] #2 Lifecycle: Draft
- [ ] #3 All 10 OQs listed in the Open Questions section, unresolved
- [ ] #4 Component diagram included
- [ ] #5 Industry comparison table included
- [ ] #6 4-phase plan outlined (per-phase task breakdown deferred until sign-off)
- [ ] #7 Operator walkthrough scheduled via decision-rubric per OQ (do NOT batch)
- [ ] #8 Sign-off + Ready-for-Review only after all 10 OQs resolved
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
**OQ-1 reframe (operator insight 2026-05-28):** The original OQ-1 framing ("managed vs self-hosted queue substrate") is too narrow. Operator surfaced a deeper question: **state of an issue belongs WITH the issue, inside the ticket-system adapter, not in a separate scheduler-local queue**. This way state is shared across all participants (multiple devs, multiple machines) by construction. The scheduler must be **agnostic to the ticket-system adapter layer**.

New framing for OQ-1: **What's the `IssueStateAdapter` contract, and which trackers does v1 support?**

Ticket-system landscape:
- **Backlog.md** (today's default) — single-file local format; collapses under multi-machine concurrent writes; not a candidate for distributed v1 state-of-truth.
- **GitHub Issues** — OSS-friendly; structured state via labels + Projects v2 custom fields + comments; widely available; limited custom-field richness.
- **JIRA** — enterprise standard; rich custom fields + workflows; heavy + workflow-burdensome.
- **Linear** — lean; GraphQL + custom fields + webhooks; well-suited to distributed updates; free tier limited to small teams.
- **fizzy.do** — free OSS kanban; less mature; worth evaluating for adopter accessibility.

v1 IssueStateAdapter responsibilities (write):
- `setStatus(issueId, status, currentStep, lastHeartbeat)`
- `attachWorkResult(issueId, prUrl, commitSha)`
- `claimByWorker(issueId, workerId)` — atomic claim to prevent double-dispatch
- `releaseClaim(issueId)` — on worker death

v1 IssueStateAdapter responsibilities (read):
- `listClaimedByWorker(workerId)`
- `listUnclaimedReady()` — frontier for distributed workers
- `getStatus(issueId)`

**Implication for substrate choice (the old OQ-1):** if state lives in the ticket system, the scheduler may NOT need its own queue substrate at all — just an optional local cache for performance. D1/Postgres/Redis become secondary (or unnecessary). The ticket adapter IS the substrate.

**Next step:** Re-run the OQ-1 rubric with this expanded framing after AISDLC-462 ships. Treat the original OQ-1 (substrate choice) as resolved-by-reframing (no longer the deciding question) and let the new OQ-1 (adapter contract + tracker support) drive the design.

**Cross-reference:** This insight also affects OQ-2 (worker registration protocol) — workers may register by claiming issues in the tracker, not by registering with a separate scheduler. And OQ-6 (multi-tenant isolation) — the tracker's own project/workspace boundaries become the isolation primitive.

**Scope correction (operator-confirmed 2026-05-28):** This RFC's implementation belongs in the **enterprise tier** (`ai-sdlc-enterprise` sibling repo), not OSS. The distributed scheduler concerns — multi-tenant SaaS, regional sharding, cross-machine coordination, subscription burn pacing — are enterprise-only.

Canonical RFC home: `ai-sdlc-enterprise/backlog/drafts/draft-1 - RFC-distributed-LLM-worker-scheduler-...md` (assigned `DRAFT-1` in enterprise registry).

OSS scope (this repo) is bounded to:
- Layer 1 adapter CONTRACT only (`IssueStateAdapter` interface defined in OSS so adopters can implement it)
- Backlog.md adapter (already exists)
- Single-machine Layer 3 worker (AISDLC-462 tmux wrapper — already shipping in PR #764)
- NO Layer 2 cache (works up to small-team scale by talking to tracker directly)

Enterprise scope (`ai-sdlc-enterprise`):
- Adapters for Jira / Linear / GH Issues / ServiceNow / ADO
- Full Layer 2 cache (D1 / Postgres / Redis tiers)
- Multi-machine fleet registry
- Subscription burn pacer (per-user weekly quota tracking)
- Regional sharding
- Observability dashboard

This AISDLC-461 task is RECLASSIFIED as the OSS-side companion. Its narrow remit going forward:
1. Define + ship the `IssueStateAdapter` TypeScript interface in the OSS repo
2. Ship the Backlog.md reference implementation (validates the contract)
3. Document the OSS / Enterprise boundary in spec/rfcs/ so adopters know which tier they need

The full 14-OQ walkthrough + 3-layer architecture + implementation plan lives in the enterprise task (DRAFT-1).

**Cross-repo references:**
- Enterprise task: `ai-sdlc-enterprise/backlog/drafts/draft-1`
- OSS dependency (this repo): AISDLC-462 (tmux N-pane wrapper — becomes the personal-tier worker spawn mechanism)
- OSS dependency (this repo): AISDLC-463 (Decision Catalog as unified AskUserQuestion router — needed for cross-cutting observability)

**OQ walkthrough status:** deferred to a future session per operator decision. When resumed, work happens in the enterprise repo against DRAFT-1, not against this OSS task.
<!-- SECTION:NOTES:END -->
