---
id: RFC-0011
title: Definition-of-Ready Gate for Pipeline Admission
status: Implemented
lifecycle: Implemented
author: dominique@reliablegenius.io
created: 2026-04-30
updated: 2026-05-13
targetSpecVersion: v1alpha1
# Conceptual / strategic + future-feature RFC. Phase 1 (AISDLC-115.1) ships
# only the schemas + status enum. Per-surface tutorials/api docs land with
# the agent rollout in later phases — see spec/rfcs/README.md operator notes.
requiresDocs: []
---

# RFC-0011: Definition-of-Ready Gate for Pipeline Admission

**Status:** Implemented (AISDLC-115 umbrella + all 9 phases 115.1–115.9 shipped; `evaluationMode: enforce` live in dogfood since 2026-05-03)
**Lifecycle:** Implemented (lifecycle audit 2026-05-13 promoted from Signed Off)
**Author:** dominique@reliablegenius.io (with Claude assist)
**Created:** 2026-04-30
**Updated:** 2026-05-13
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [x] Engineering owner — dominique@reliablegenius.io (2026-04-30)
- [x] Product owner — Alexander Kline (2026-05-04)
- [x] Operator owner — dominique@reliablegenius.io (2026-04-30)

## Revision History

| Version | Date | Author | Notes |
|---|---|---|---|
| v1 | 2026-04-30 | dominique | Initial draft |
| v2 | 2026-04-30 | dominique | Deterministic-first evaluation order (Section 4.4), test corpus + 3-tier eval harness (Section 5.6), Phase 2 split into 2a/2b |
| v3 | 2026-04-30 | dominique | All 10 open questions resolved (Section 13). Library-function-with-shims architecture (Section 5.0-5.2), pluggable resolver registry, dual-fanout notifications, two-stage staleness, three-tier confidence gating, grandfather-on-rubric-revision. Sign-off complete. |
| v4 | 2026-05-03 | dominique | Promoted from warn-only to enforce in dogfood project on 2026-05-03 via operator-override path (per `docs/operations/dor-promotion.md`). Hybrid promotion model documented in AISDLC-161; corpus-rigorous path unblocks once data accumulates. AISDLC-115.9 ships the one-line `evaluationMode` flip in `.ai-sdlc/dor-config.yaml`. |

## Table of Contents

1. [Summary](#1-summary)
2. [Motivation](#2-motivation)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [The Definition-of-Ready Rubric](#4-the-definition-of-ready-rubric)
5. [The DoR Reviewer Agent](#5-the-dor-reviewer-agent)
6. [The Clarification Loop](#6-the-clarification-loop)
7. [Pipeline Integration](#7-pipeline-integration)
8. [Metrics and Observability](#8-metrics-and-observability)
9. [Schema Changes](#9-schema-changes)
10. [Backward Compatibility](#10-backward-compatibility)
11. [Alternatives Considered](#11-alternatives-considered)
12. [Implementation Plan](#12-implementation-plan)
13. [Open Questions](#13-open-questions)
14. [References](#14-references)

---

## 1. Summary

Today, every issue admitted to the AI-SDLC pipeline is implicitly assumed to be *executable as written* — i.e., that its acceptance criteria are testable, its scope is bounded, its references resolve, and its done-state is describable. That assumption holds because every issue today is authored by an engineer who thinks in pipeline-executable units. The assumption breaks the moment non-engineers (product managers, support, customers via Forge) start authoring issues directly.

This RFC introduces a **Definition-of-Ready (DoR) gate** between issue creation and PPA admission. The gate is a new agent that scores every issue against a fixed seven-point rubric and either:

1. **Admits** the issue to PPA triage (issue is execution-ready), or
2. **Returns** the issue to its author with a structured list of clarifying questions (issue is not yet ready)

The gate applies **uniformly to all issues** regardless of author role — engineering issues pass through the same rubric as PM issues. This is a load-bearing design choice (Section 4.2) — uniform application is what makes the rubric defensible and what protects engineering authors from self-certification bias.

The gate is conceptually a **Definition-of-Ready** check, distinct from PPA's **prioritization** check (RFC-0008). Both gates are required; they evaluate orthogonal axes. PPA answers *should we do this?*; DoR answers *is this issue actionable as written?* An issue can be high-priority and unready (block on DoR), or low-priority and crisply-defined (block on PPA). Composing them in series gives the pipeline well-formed work that matches strategic intent.

## 2. Motivation

### 2.1 The current quality assumption

Every issue executed through `/ai-sdlc execute` today was authored by an engineer with sufficient context to:

- Write acceptance criteria as binary pass/fail tests
- Resolve references to specific files, PRs, and prior decisions
- Bound scope to a single coherent deliverable
- Describe the done-state from a user-visible perspective
- Surface dependencies on other tracked work

This holds because dominique (the sole author) writes issues with engineering rigor by reflex. The pipeline was designed with that rigor as a precondition — the developer subagent assumes "the AC is testable," the reviewer agents assume "scope is bounded," and the orchestrator assumes "references resolve."

The pipeline produces correct-looking output even when these preconditions don't hold. That's the dangerous part. A vague issue ("make search faster") will produce code, tests, and a PR — but the code may target the wrong search, the tests may verify the wrong constraint, and the PR may ship a regression that meets a hallucinated AC. The reviewers won't catch it because the AC they're scoring against is the same vague AC the developer wrote against.

### 2.2 The PM-authored issue gap

The Forge product, when it ships, will let product managers (and eventually customers) author issues directly. The canonical scenario:

> **Alex (PM) writes:** "Make search faster"
>
> **Pipeline today:** PPA scores it (high adoption signal — users complain about search). Triage admits it. Developer subagent picks `/api/search` (the most-touched path), writes a query plan caching layer, ships a PR. Reviewers approve — the code is well-tested and the AC ("search is faster") is technically met.
>
> **Reality:** Alex meant the *customer site search bar*, not the API. The PR ships, customer search is unchanged, and the change introduces a 5% latency regression in the API. Three weeks later a postmortem reveals the issue was admitted with no question asked.

The failure mode is **invisible at every gate** the pipeline currently has:

- PPA scored it correctly — it *is* high-priority work.
- Triage admitted it correctly — the score crossed the threshold.
- Developer wrote correct code for the AC as interpreted.
- Reviewers approved correct code for the AC as written.
- Merge gate passed — no conflicts.

Every individual gate did its job. The issue was a defect at admission, and there was no gate looking for that class of defect.

### 2.3 Why this is not a PPA concern

PPA (RFC-0008) is a **prioritization** algorithm — it scores issues on the Pillar / Probability / Adoption triad to answer *should we work on this?* It says nothing about whether the issue is *actionable as written*. A high-PPA issue can be unactionable (vague, ambiguous, missing dependencies) and a low-PPA issue can be crisp.

Conflating the two would be an architectural mistake:

- **PPA failure remediation:** deprioritize, defer, or kill the issue.
- **DoR failure remediation:** ask the author for clarification; the issue may still be high-priority.

Different signals, different remediations. They must be separate gates, evaluated in series.

The natural order is **DoR first, PPA second**:

- DoR is *cheap* (one agent pass, one clarification round on average) and **bounded** (the rubric is fixed).
- PPA is *expensive* (composite scoring across the triad, calibrated against historical adoption signals).
- Running PPA on an unready issue burns scoring effort on something that will need re-scoring after clarification anyway.

### 2.4 Why uniform application matters

A naïve design would carve out exceptions: "DoR applies to PM-authored issues; engineering-authored issues pass through." This is wrong for four reasons:

1. **Self-certification is the worst form of certification.** Engineers writing issues for themselves under deadline pressure produce the same vague ACs PMs do. The rubric exists to catch the *issue's* quality, not the *author's* role.
2. **Two-tier gates create gaming surfaces.** If DoR can be bypassed by claiming "engineering," every author will claim engineering. The rubric stops being useful within one quarter.
3. **The gate teaches.** Engineering authors who pass through DoR routinely get a free reinforcement loop on what "ready" means. PM authors who pass through DoR for the first time learn the framework by doing. Removing engineering from the loop removes the most common training dataset.
4. **It's not punitive.** A well-formed engineering issue passes DoR in <5 seconds with zero questions. The gate has effectively zero cost for high-quality authors and proportionate cost for low-quality issues. That's the design intent.

The rubric is the same. The author's identity is metadata, not a switch.

## 3. Goals and Non-Goals

### 3.1 Goals

- **G1.** Block ambiguous, unbounded, or unverifiable issues from reaching the developer subagent.
- **G2.** Surface clarifying questions to the issue author through a low-friction comment loop (Slack, GitHub Issue comments, Forge UI — wherever the author works).
- **G3.** Apply the DoR rubric uniformly to all authors regardless of role.
- **G4.** Compose cleanly with PPA: DoR is a precondition for PPA scoring, not a competitor.
- **G5.** Provide observable per-author quality signals that make pattern problems visible without making any individual feel judged.
- **G6.** Make the rubric machine-decidable: every check should be replicable by a human reading the same issue and arriving at the same verdict.
- **G7.** Be forgiving: well-formed issues pass on the first try with no friction. The gate is invisible when the work is good.

### 3.2 Non-Goals

- **N1.** Score issue priority, value, or impact. (PPA owns that.)
- **N2.** Decide whether an issue is the right thing to build. (PPA + product judgment own that.)
- **N3.** Verify that an issue's ACs are *correct* (i.e., that meeting them produces the right outcome). (Out of scope; that's a product-quality concern, not a definition-of-ready concern.)
- **N4.** Replace human triage. The DoR agent is one signal in a multi-signal admission flow.
- **N5.** Auto-edit issues. The agent suggests; the author edits. Auto-rewriting an author's issue is a trust violation.
- **N6.** Catch malicious or spam issues. (Different threat model; covered by separate moderation gates.)

## 4. The Definition-of-Ready Rubric

### 4.1 Seven gates

The rubric is fixed at **seven gates**. Each gate is a single boolean check; the issue passes the rubric only when all seven pass. Adding gates over time is allowed via RFC amendment; removing them requires a new RFC.

| # | Gate | Pass condition | Common failure |
|---|---|---|---|
| 1 | **Acceptance criteria are binary-testable** | Each AC can be expressed as a pass/fail check that a human or automation could evaluate in under 5 minutes | "Improves UX," "feels faster," "is more reliable" |
| 2 | **No unresolved markers in the body** | Body contains no instances of `TBD`, `???`, `not sure`, `we'll figure out`, `decide later`, `up to the dev`, or equivalents | Author left placeholders meaning to fill in later |
| 3 | **Named-thing references resolve** | Every named file, PR, issue, system, person, or external resource either links out or is unambiguous in context | "Like the dashboard PR" with no link; "the new auth flow" with no PR or RFC reference |
| 4 | **Scope is bounded** | The deliverable can be described in one sentence and fits within one PR's reasonable diff size | "Make the system observable" (10 PRs of work); "Refactor X *and* add Y *and* migrate Z" |
| 5 | **Affected surface is named** | The issue names which file path, route, system component, user surface, or workload is being changed | "Slow query" with no DB / table / workload named; "fix the dashboard" with no specific dashboard |
| 6 | **Done-state is describable** | The issue answers "when this ships, the user (or operator, or downstream system) can ___" in one sentence | Issue describes a problem but no end state |
| 7 | **No invisible dependencies** | All prerequisite work is either complete OR linked to an existing tracked issue | "Once auth is rewritten" with no tracked auth-rewrite task |

### 4.2 Why this set

The seven gates were chosen because each catches a *distinct* failure mode that has been observed in real engineering and PM-authored issues across the broader industry. The set is intentionally small to avoid:

- **Rubric inflation.** A 30-point rubric becomes a checklist agents and humans pencil-whip.
- **Overlap.** Each gate covers a different defect; failing any one is sufficient to block.
- **Subjectivity.** Each gate has a binary check that two humans (or an agent and a human) can independently arrive at without negotiation.

Gates 1, 4, and 6 are about **structural completeness**. Gates 2 and 5 are about **specificity**. Gates 3 and 7 are about **referential closure**.

### 4.3 Severity model

Each gate failure is one of two severities:

- **Block.** The issue cannot be admitted. Author must clarify; the gate runs again on resubmission.
- **Warn.** The issue is admissible but flagged. The agent posts the warning as a non-blocking note; PPA scoring proceeds.

The default for every gate is **Block**. The author of the rubric (per release of the rubric, via RFC amendment) may demote a specific gate to **Warn** if operational data shows it's catching too many false positives. The current rubric ships with all seven gates as **Block**. This is conservative; demotions are RFC amendments based on observed false-positive rate.

Severity is a property of the *gate*, not the issue. The agent does not exercise judgment on whether a particular gate failure is severe enough to block — it follows the rubric's declared severity for each gate.

### 4.4 Deterministic-first evaluation order

Each gate is implemented in **two stages**, run in series:

- **Stage A — Deterministic checks (run first, no LLM):** regex / pattern matching, link and file-path validation (HEAD requests, `gh api`), structural validation (presence of required sections, AC count bounds), reference resolution.
- **Stage B — LLM checks (run only if Stage A passes):** semantic evaluation of testability, scope, done-state describability. The agent is given a fixed schema and asked one binary yes/no per gate — not free-form judgment.

Per-gate breakdown:

| Gate | Stage A (deterministic) | Stage B (LLM, only if A passes) |
|---|---|---|
| 1: AC testable | AC count ≥ 1 ≤ 20; AC non-empty | "Each AC is binary-testable" yes/no |
| 2: No markers | Regex: `\b(TBD\|TODO\|XXX\|FIXME\|\?\?\?)\b`, "not sure", "we'll figure out", etc. | (none — gate is fully deterministic) |
| 3: References resolve | Extract markdown links → HEAD check; extract `#NN` → `gh issue view`; extract `RFC-NNNN` → file existence | "Are bare references unambiguous in context?" yes/no |
| 4: Scope bounded | (none — fully semantic) | "Does this fit one reasonable PR?" yes/no |
| 5: Surface named | Regex for presence of file paths, route patterns, system identifiers, named components | "Is the surface specific enough?" yes/no |
| 6: Done-state | (none — fully semantic) | "Is the user-visible end state describable?" yes/no |
| 7: No invisible deps | Regex for dep phrases ("requires", "depends on", "after X ships"); for each match, check linked issue exists | "Are there unstated structural assumptions?" yes/no |

**Stage A is always run**, never skipped, never gated behind a flag. **Stage B runs only when Stage A passes** — failing Stage A short-circuits the verdict to `needs-clarification` with deterministic findings (no LLM call).

Effect on cost, latency, and consistency:

- **Issues that fail Stage A** (~40-60% of unready issues based on industry rubric data) never reach the LLM. Verdict in <100ms, $0 incremental cost, fully reproducible.
- **Issues that pass Stage A and Stage B clean** complete in ~30s end-to-end with one cached LLM call (~$0.001-0.005).
- **Issues that fail at Stage B** complete in ~30s with the LLM-generated clarification questions.

This is the **deterministic-first principle**: cheap, repeatable, unambiguous checks first; LLM only for what genuinely requires semantic understanding. Every gate that *can* be deterministic *is* deterministic. Stage B exists for the gates where regex would either let too much through or false-positive on too much (Gates 1, 4, 6 are fully Stage B; Gates 3, 5, 7 are hybrid).

### 4.5 What the rubric is not

The rubric is **not**:

- A measure of issue importance, urgency, value, or impact (those are PPA inputs).
- A measure of authoring effort or quality of writing (a terse, well-formed issue passes; a verbose, vague one fails).
- A judgment of the author. Per Section 7.4, per-author metrics exist for pattern detection, not for performance review.
- A guarantee that the work is the right work. Even a perfectly DoR-passing issue can describe the wrong feature.

## 5. The DoR Reviewer — Library Function + Invocation Contexts

The rubric is implemented as a **single library function** with a stable input/output contract, called from multiple ingress points. The "where does it run" question is answered by the ingress, not by the rubric — the rubric itself is the same code regardless of how it's invoked.

### 5.0 Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Ingress points (one shim each)                          │
├──────────────────────────────────────────────────────────┤
│  • GitHub Action       (.github/workflows/dor-gate.yml)  │
│    triggered on issues:opened / issues:edited            │
│                                                          │
│  • Claude Code subagent (refinement-reviewer)            │
│    invoked from /ai-sdlc execute when a backlog task is  │
│    created via mcp__backlog__task_create                 │
│                                                          │
│  • Future: Forge UI / Slack / customer portal — each     │
│    just adds a shim that calls evaluateIssue()           │
├──────────────────────────────────────────────────────────┤
│  Library function: evaluateIssue(IssueInput) → Verdict   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Stage A — deterministic (regex / link / structure) │  │
│  │  pure functions, no I/O except link HEAD checks     │  │
│  └─────────────────────┬──────────────────────────────┘  │
│                        ↓ if Stage A passes               │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Stage B — LLM via harness adapter (RFC-0010 §13)  │  │
│  │  Default harness = claude-code, fallback = codex   │  │
│  │  In subagent context: runs as refinement-reviewer  │  │
│  │  In GitHub Action context: runs via `claude` CLI   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 5.1 The library function

A single TypeScript module exports the rubric implementation:

```typescript
// orchestrator/src/dor/evaluate.ts (new)

export interface IssueInput {
  source: 'github' | 'backlog' | 'forge' | 'slack';
  id: string;                  // e.g. AISDLC-N or gh#NN
  title: string;
  body: string;
  authorIdentity: string;      // for metric attribution only — NOT a rubric input
  references?: string[];       // markdown links + bare refs to follow
  rubricVersion?: string;      // defaults to current
}

export interface RefinementVerdict {
  issueId: string;
  rubricVersion: string;
  verdict: 'ready' | 'needs-clarification';
  perGate: Array<{
    gate: number;
    name: string;
    pass: boolean;
    severity: 'block' | 'warn';
    finding?: string;
  }>;
  questions: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}

export async function evaluateIssue(
  input: IssueInput,
  opts?: { harness?: 'claude-code' | 'codex'; skipStageB?: boolean }
): Promise<RefinementVerdict>;
```

The function is harness-agnostic in its interface but uses the harness adapter framework (RFC-0010 §13) internally to run Stage B. Callers pass the issue input; they get back a structured verdict. No I/O for posting comments / updating statuses — that's the ingress shim's responsibility.

### 5.2 Ingress shims

Each ingress point is a thin wrapper around `evaluateIssue()`:

**GitHub Action shim (`.github/workflows/dor-gate.yml`):**
- Triggered on `issues:opened`, `issues:edited`, `pull_request:opened` for `backlog/tasks/*.md` changes
- Reads issue body via `gh issue view`
- Calls `evaluateIssue({ source: 'github', ... })`
- Posts comment via `gh issue comment` if `verdict === 'needs-clarification'`
- Sets issue label `status:needs-clarification` (the GitHub representation of the new status)

**Claude Code subagent shim (`refinement-reviewer` plugin agent):**
- Spawned from `/ai-sdlc execute` when a new backlog task is created in-session
- Reads task file directly (no `gh` required)
- Calls `evaluateIssue({ source: 'backlog', ... })`
- Posts comment by appending to the task file's `## Clarifications Requested` section
- Updates task status via `mcp__backlog__task_edit`

**Future shims** (Slack, Forge, customer portal) follow the same pattern: read input → call `evaluateIssue()` → post output.

The shims share a common testing harness — fixture issue → expected verdict → assert match. Adding a new ingress doesn't require re-implementing the rubric; it just requires implementing the shim's I/O.

### 5.3 The Claude Code subagent (one of the ingress contexts)

The plugin agent type `refinement-reviewer` is the Claude Code subagent ingress. Its frontmatter:

```yaml
---
name: refinement-reviewer
description: Scores an issue against the seven-point Definition-of-Ready rubric. Returns a verdict + per-gate findings + clarification questions. Read-only.
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__backlog__task_view
disallowedTools:
  - Edit
  - Write
  - AgentTool
model: inherit
harness: claude-code
---
```

The agent is **read-only**. It never modifies the issue. It returns a structured verdict; the orchestration layer applies the verdict (status changes, comment posting, author notification).

### 5.2 Inputs

- The issue body (full markdown, including ACs)
- The issue's references / linked-issues / linked-PRs (followed one hop deep)
- Author identity (used only for metric attribution and for choosing the response channel — not as a rubric input)
- Configurable rubric reference (for future rubric versions)

### 5.3 Outputs

A `RefinementVerdict` JSON:

```json
{
  "issueId": "AISDLC-N",
  "rubricVersion": "v1",
  "verdict": "ready" | "needs-clarification",
  "perGate": [
    {
      "gate": 1,
      "name": "Acceptance criteria are binary-testable",
      "pass": false,
      "severity": "block",
      "finding": "AC #2 ('improves search performance') is not binary-testable — define a target metric (e.g., p95 latency) and threshold."
    }
  ],
  "questions": [
    "Which search surface? The customer-facing site search, the admin search, or the public API?",
    "What's the current p95 latency and what target are we shooting for?",
    "Are there infra constraints (e.g., no new services, fixed budget)?"
  ],
  "summary": "Issue blocked on Gates 1 (AC not testable) and 5 (affected surface unnamed). 3 clarifying questions posted to author.",
  "confidence": "high" | "medium" | "low"
}
```

### 5.4 Tool grants and harness

- The agent runs read-only — it has `Read`, `Grep`, `Glob`, `Bash` (for `gh issue view` and similar), and `mcp__backlog__task_view`.
- It explicitly disallows `Edit`, `Write`, and `AgentTool` (no recursive subagent spawning).
- Harness defaults to `claude-code` for v1; can be ported to other harnesses (Codex, etc.) via the harness adapter framework (RFC-0010 §13). The agent's behavior is harness-agnostic — it scores against text and references.

### 5.5 Confidence and calibration

The agent emits a `confidence` field (`high` | `medium` | `low`) per verdict. Confidence interacts with the loop in Section 6:

- **High confidence + ready** → admit immediately.
- **High confidence + needs-clarification** → post the questions.
- **Medium confidence + either** → post the verdict but flag for human reviewer spot-check.
- **Low confidence** → escalate to a human triager; do not auto-act.

A calibration log writes every verdict to `$ARTIFACTS_DIR/_dor/calibration.jsonl` with the agent's verdict, the eventual outcome (did the human override? did the issue ship cleanly? did it cause a postmortem?), and the per-gate findings. This dataset is the basis for future rubric revisions and severity demotions (Section 4.3).

### 5.6 Test corpus and evaluation harness

Every rubric change — agent prompt, regex pattern, severity demotion, new gate — requires a regression pass against a fixed test corpus. This is the deterministic-first principle applied to the *rubric itself*, not just to individual issue evaluations.

**Corpus location:** `spec/dor-corpus/`

**Structure:**

```
spec/dor-corpus/
  ready/                      # issues that should pass DoR
    *.md                      # 30+ fixtures
  needs-clarification/        # issues that should fail on a specific gate
    gate-1-untestable-ac/
    gate-2-markers/
    gate-3-broken-references/
    gate-4-unbounded-scope/
    gate-5-no-surface/
    gate-6-no-done-state/
    gate-7-invisible-deps/
  edge-cases/                 # auto-pass shortcuts, escalation triggers, severity-warn scenarios
```

Each fixture is a complete issue body in markdown plus a sidecar `<fixture>.expected.json` with the expected verdict and per-gate findings.

**Initial corpus (Phase 2 ship):**

- 30 ready (drawn from real well-formed issues in the project history)
- 5 fixtures per blocking gate (35 total) drawn from real defects
- 10 edge cases

**Three-tier evaluation against the corpus:**

1. **Stage A correctness — 100% required.** Every deterministic check must produce the labeled verdict. Stage A is regression-tight; any Stage A regression is a hard CI failure. This is what makes deterministic-first powerful: the regex side is provably correct against the corpus on every change.
2. **Stage B match — ≥ 90% required.** Allows for non-determinism within calibrated bounds (the LLM may phrase findings differently, may have low-but-acceptable variance on borderline cases). Below 90% blocks the rubric change.
3. **End-to-end verdict match — ≥ 95% required.** Combined Stage A + Stage B verdict matches the labeled verdict for at least 95% of fixtures.

These thresholds are CI gates — a rubric change that drops below them cannot ship.

**Shadow-mode evaluation before promotion:**

Before flipping a rubric version from candidate to active in production, run the new rubric against the last 4 weeks of real issues in shadow (non-blocking, no comments posted). Compare verdicts to the current production rubric. **Disagreement rate < 5%** before promoting. Disagreements are reviewed individually; each is either:

- A genuine improvement (new rubric correctly catches what old missed) → fixture added to corpus
- A genuine regression (new rubric incorrectly fails what old passed) → rubric change reverted or refined
- A wash (both verdicts defensible) → no action

**Corpus growth (continuous):**

- Every `dor-bypass` override (Section 7.4) gets reviewed weekly. Validated false positives → added to `ready/`. Validated true positives that the maintainer overrode anyway → added to `needs-clarification/<gate>/`.
- Every issue that passed DoR but caused a postmortem on shipping → reverse-engineer the missing rubric check; if the rubric should have caught it, add the fixture and either fix the gate or file a new-gate RFC.
- Every weekly false-positive review session adds 1-3 fixtures.

The corpus is the rubric's regression suite. As the corpus grows, the rubric's confidence grows with it. After 6 months of active calibration, the corpus should cover the full distribution of issue shapes the project sees in practice.

## 6. The Clarification Loop

### 6.1 New issue status: `Needs Clarification`

A new status value `Needs Clarification` is added to the backlog and GitHub issue lifecycle:

```
Draft → Needs Clarification ⇄ To Do → In Progress → Done
                ↑
        DoR gate places issue here when verdict is needs-clarification
```

`Needs Clarification` is a **terminal-for-now** state — issues do not advance from it automatically. The author resumes the issue by editing the body to address the clarifications, then reopens DoR review (manually via `/ai-sdlc dor-recheck <issue>` or automatically on next issue edit).

### 6.2 Comment thread protocol

When the agent verdict is `needs-clarification`, the orchestration layer posts a comment in the author's native channel:

- **GitHub Issue:** comment on the issue with the questions, formatted as a checklist.
- **Backlog Task:** comment in the task file under a `## Clarifications Requested` section.
- **Forge / Slack thread:** Slack message in the original thread where the issue was authored.

The comment is **idempotent**. If the issue is re-checked and the same gates fail, the comment is updated rather than duplicated. A `<!-- ai-sdlc:dor-comment -->` HTML marker is used to identify the agent's prior comment.

The comment format:

```markdown
<!-- ai-sdlc:dor-comment -->

## Issue not yet ready for execution

I checked this issue against the [Definition-of-Ready rubric](https://docs.ai-sdlc.io/rfc/0011) and it's blocked on the following gates:

### Gate 1 — Acceptance criteria are binary-testable
AC #2 ("improves search performance") is not binary-testable. Define a target metric (e.g., p95 latency) and threshold.

### Gate 5 — Affected surface is named
"Search" is ambiguous. Name the specific surface: customer-facing site search bar, admin search, or public API.

### Clarifying questions
- [ ] Which search surface?
- [ ] What's the current p95 latency and what target are we shooting for?
- [ ] Are there infra constraints?

Edit the issue to address these, then comment `/dor-recheck` (or just edit and wait — I'll re-check on the next edit).
```

### 6.3 Author attribution and escalation

Every verdict is attributed to the issue author for metric tracking (Section 8). If an issue cycles through `Needs Clarification` more than **3 times** without passing, the orchestration layer escalates by tagging a human triager (configurable per project). This catches:

- Rubric false positives (the issue is genuinely fine but the agent keeps failing it).
- Authors who don't engage with the loop (issue stays in Needs Clarification indefinitely).
- Cases where the author and the agent are talking past each other.

Escalation is a **soft handoff** — the human triager reads the agent's findings and the author's responses, then either:

- Approves the issue manually (overrides the gate; logged for calibration),
- Closes the issue as not actionable,
- Splits it into multiple issues each of which can pass DoR independently,
- Or works with the author directly to resolve.

### 6.4 Auto-pass shortcut for trivial issues

A small set of issue types pass DoR with zero gate evaluation, because the rubric doesn't apply:

- **Dependency bumps** detected by issue title pattern (`bump <pkg> from X to Y`) and automation source (Dependabot, renovate-bot)
- **Generated CI failure issues** from automated reporters where the AC is "fix the failing test"
- **Doc typo fixes** with a body diff under 50 lines

The shortcut is conservative — when in doubt, run the rubric. The shortcut is documented per project and editable in `.ai-sdlc/dor-config.yaml`.

## 7. Pipeline Integration

### 7.1 Admission flow with the DoR gate

Updated pipeline:

```
Issue created (Draft)
  ↓
[DoR gate]
  ↓ ready                    ↓ needs-clarification
[PPA triage]                [post questions to author]
  ↓ admit                    [status: Needs Clarification]
[Plan]                       (loop until ready or escalation)
  ↓
[Develop]
  ↓
[Review]
  ↓
[Merge]
```

The DoR gate runs:

- **On issue creation** — for new issues
- **On `/ai-sdlc dor-recheck`** — manually triggered by the author after edits
- **On issue body edit** — automatically (debounced 60 seconds) for issues currently in `Needs Clarification`

It does **not** run on:

- Issues already in `In Progress` or `Done` (too late — pipeline has consumed them)
- Issues in `Draft` (author hasn't published them for review yet)

### 7.2 Composition with PPA

DoR runs **before** PPA. Rationale:

- DoR is fast (one agent pass, ~30s with cache).
- PPA is expensive (composite scoring + historical lookups).
- DoR-failing issues will need re-scoring after clarification anyway.

PPA is amended (RFC-0008 §amendment forthcoming) to refuse to score issues whose status is not `To Do` (i.e., that have not passed DoR). This makes the gate impossible to bypass by manually invoking PPA.

### 7.3 Composition with `/ai-sdlc execute`

`/ai-sdlc execute <task-id>` is amended to **refuse to execute** issues whose status is `Needs Clarification` or `Draft`. Today the command refuses `Done` and `Draft`; the change adds `Needs Clarification` to the refusal set.

The refusal message names the offending gates:

```
Refused: AISDLC-92 is in Needs Clarification (blocks: Gate 1, Gate 5).
Address the questions in the issue thread, then re-run.
```

This catches the operator who tries to skip the loop ("just run the issue, the AC is good enough"). The pipeline's contract is that issues entering execution have passed DoR.

### 7.4 What happens when DoR is bypassed

A configurable per-project escape hatch exists for **maintainers only** (gated by trusted-reviewer role from RFC-0009). A maintainer can apply a `dor-bypass` label to an issue, which:

- Sets DoR verdict to `ready (manual override by <maintainer>)`,
- Logs the override in `_dor/calibration.jsonl` with reason text required,
- Allows the pipeline to advance.

This exists for legitimate cases (the rubric has a false positive that's blocking urgent work) but is logged and counted in metrics. A high override rate per maintainer is a signal that either the rubric needs revision or the maintainer is gaming the gate.

## 8. Metrics and Observability

The DoR gate produces several observability surfaces.

### 8.1 Per-author pass rate

Tracked: `dor_pass_rate{author=<id>}` — the fraction of an author's issues that pass DoR on first submission.

This is a **diagnostic signal**, not a performance metric. A low pass rate identifies authors who would benefit from coaching on issue-writing rigor. Per Section 4.4, the metric is not surfaced for individual performance review — it surfaces *patterns*. The escalation in Section 6.3 covers the per-issue case.

### 8.2 Common-clarification themes

Tracked: per-gate failure rate aggregated weekly. If Gate 5 (affected-surface-named) is failing 60% of issues from a particular team, the team's onboarding doc may be unclear about what counts as "naming the surface."

This is the most operationally useful metric — it surfaces whole-team patterns and informs targeted documentation and tooling improvements.

### 8.3 Time-to-ready

Tracked: median + p95 of (issue created → DoR verdict ready). Long times indicate the loop is friction-heavy and authors are dropping issues midway.

Target: median < 1 hour for issues that need at most one clarification round. p95 < 24 hours.

### 8.4 False-positive monitoring

Tracked: `dor_overrides_per_week` and `dor_pass_after_n_rounds{n}` distribution. If issues commonly take 4+ rounds to pass, the rubric is too strict (or the agent is too aggressive). If override count climbs week-over-week, ditto.

Threshold for action: any single gate with override rate > 10% over 4 weeks triggers an RFC amendment to demote that gate to **Warn** or revise the check.

## 9. Schema Changes

### 9.1 Issue / task status enum

Add `Needs Clarification` to the status enum:

```yaml
# spec/schemas/task.schema.json
properties:
  status:
    enum: ["Draft", "Needs Clarification", "To Do", "In Progress", "Done"]
```

Both Backlog tasks and GitHub Issues use this status set. GitHub Issues represent it as a label (`status:needs-clarification`); Backlog tasks store it in frontmatter.

### 9.2 New `RefinementVerdict` schema

```yaml
# spec/schemas/refinement-verdict.schema.json
$schema: 'https://json-schema.org/draft/2020-12/schema'
$id: 'https://ai-sdlc.io/schemas/refinement-verdict.v1.schema.json'
type: object
required: [issueId, rubricVersion, verdict, perGate, summary, confidence]
properties:
  issueId: { type: 'string' }
  rubricVersion: { type: 'string', enum: ['v1'] }
  verdict: { type: 'string', enum: ['ready', 'needs-clarification'] }
  perGate:
    type: array
    items:
      type: object
      required: [gate, name, pass, severity]
      properties:
        gate: { type: 'integer', minimum: 1, maximum: 7 }
        name: { type: 'string' }
        pass: { type: 'boolean' }
        severity: { type: 'string', enum: ['block', 'warn'] }
        finding: { type: 'string' }
  questions: { type: 'array', items: { type: 'string' } }
  summary: { type: 'string', maxLength: 500 }
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
```

### 9.3 New per-project config

```yaml
# .ai-sdlc/dor-config.yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
spec:
  rubricVersion: v1
  autoPassRules:
    - kind: dependency-bump
      titlePattern: '^bump\s+\S+\s+from\s+'
      sources: ['dependabot[bot]', 'renovate[bot]']
    - kind: generated-ci-failure
      sources: ['github-actions[bot]']
    - kind: doc-typo
      titlePattern: '^(fix|docs):\s+typo'
      maxBodyDiffLines: 50
  escalation:
    maxRoundsBeforeHumanTriage: 3
    triageRouters:
      - github-team: '@ai-sdlc-framework/triage'
  bypassRequiresRole: maintainer
```

## 10. Backward Compatibility

This is **additive** for the issue lifecycle — adds a new status, but does not remove or rename existing statuses. Existing issues in `Draft` / `To Do` / `In Progress` / `Done` continue to behave identically.

The DoR gate runs only on new issues and on existing issues with status `Draft` (when published) or explicit `/ai-sdlc dor-recheck`. Issues already in flight (`In Progress`) bypass DoR entirely — the pipeline has already consumed them. This avoids retroactively blocking work that was admitted under the old rules.

`/ai-sdlc execute` adds `Needs Clarification` to its refusal set. This is a behavioral change — operators who try to execute a needs-clarification issue will see a refusal where they previously could not. The refusal message names the gate(s) blocking, so the path forward is clear.

A feature flag `AI_SDLC_DOR_GATE=disabled | warn-only | enforce` controls rollout:

- **disabled** (default during ramp): gate runs but does not block; logs verdicts to calibration log only.
- **warn-only**: gate posts comments with findings but does not move issues to `Needs Clarification`. Useful for learning the rubric's false-positive rate before enforcement.
- **enforce** (target steady state): full gate behavior as specified.

The flag is per-project. Projects can soak in `warn-only` for 2-4 weeks before flipping to `enforce`.

## 11. Alternatives Considered

### 11.1 Bake DoR into PPA's scoring

**Rejected.** PPA scores prioritization. DoR scores actionability. Conflating them creates a single composite score that doesn't tell you which axis failed (and therefore what to do about it). PPA failures are remediated by deprioritizing; DoR failures are remediated by clarifying. They need separate gates.

### 11.2 Lint-style check (regex-only, no agent)

**Rejected.** Regex catches a subset (Gate 2 — markers; some of Gate 5 — surface naming) but cannot evaluate Gates 1 (testability), 4 (scope), 6 (done-state), or 7 (dependencies) without semantic understanding. A regex-only approach would either pass too many issues (most of them) or false-positive on too many (regex for "vague language" is unbuildable).

A hybrid is possible: regex for the cheap gates, agent for the semantic gates. The implementation may use this as an optimization (skip the agent call entirely if regex catches a hard failure) but the *rubric* is unified — seven gates, one verdict.

### 11.3 Author-role-gated rubric (engineers exempt)

**Rejected.** Section 4.2 spells out the four reasons. Briefly: self-certification fails, two-tier creates gaming, the gate teaches, and well-formed issues pay zero cost.

### 11.4 Synchronous DoR in `/ai-sdlc execute`

**Rejected.** `/ai-sdlc execute` should refuse needs-clarification issues, but should not *run* the DoR gate inline — by the time someone is trying to execute, the gate should have run already at issue creation. Running DoR inside execute would couple the two flows in a way that complicates the parallel-execution architecture (RFC-0010) and adds latency to every execute call. DoR is an admission-time concern, not an execution-time concern.

### 11.5 Auto-rewrite ambiguous issues

**Rejected** for v1. Auto-rewriting an author's issue is a trust violation — the author wrote what they wrote, and the agent overriding their words breaks the loop where the author *learns* what good looks like. The agent suggests; the author edits. Future RFC could revisit auto-rewrite for trivial cases (e.g., adding `[needs-named-surface]` label) but not for body content.

### 11.6 Run DoR after PPA instead of before

**Rejected.** Section 7.2 — DoR is cheap, PPA is expensive. Running PPA on unready issues burns scoring effort that gets invalidated on clarification.

## 12. Implementation Plan

Sequential phases. Each phase ships behind feature flag `AI_SDLC_DOR_GATE` per Section 10.

| Phase | Wall-clock | Components | Acceptance |
|---|---|---|---|
| **Phase 1: Schema + status** | 1 wk | Add `Needs Clarification` to task/issue status enums; add `dor-config.yaml` schema; add `refinement-verdict` schema | Schemas validate; existing tooling still works |
| **Phase 2a: Deterministic Stage A + corpus** | 1 wk | Regex/link-check/structural validation modules per Section 4.4; initial test corpus at `spec/dor-corpus/` (30 ready + 35 needs-clarification + 10 edge cases); CI gate enforcing 100% Stage A correctness | Stage A produces correct verdict on 100% of corpus fixtures; runs in <100ms per issue; ships standalone (Stage B not yet built — issues passing Stage A are admitted as `ready` until Phase 2b) |
| **Phase 2b: Refinement-reviewer agent (Stage B)** | 1-2 wk | New plugin agent at `ai-sdlc-plugin/agents/refinement-reviewer.md`; binary-yes/no prompts per Stage B gate; structured verdict output combining Stage A + Stage B | Agent achieves ≥90% Stage B match and ≥95% end-to-end match against corpus; calibration log writes; shadow-mode eval against last 4 weeks of real issues shows <5% disagreement vs Stage-A-only baseline |
| **Phase 3: Orchestration + comment loop** | 1 wk | Hook into issue-creation events (GitHub webhook, Backlog file watcher); status transitions; idempotent comment posting | E2E test: vague test issue → comment posted → author edits → re-check → ready |
| **Phase 4: PPA composition + execute refusal** | 0.5 wk | Amend PPA to skip `Needs Clarification`; amend `/ai-sdlc execute` to refuse `Needs Clarification`; refusal messages | Existing tests pass; new tests cover the refusal paths |
| **Phase 5: Metrics + observability** | 1 wk | Calibration log writer; per-author/per-gate aggregation; Slack digest entry | Metrics queryable; first weekly digest renders |
| **Phase 6: Bypass mechanism + escalation** | 0.5 wk | Maintainer-only `dor-bypass` label handler; 3-round escalation to human triager | Bypass logs override reason; escalation tags configured router |
| **Phase 7: Soak + tune** | 2-4 wk | Run in `warn-only` mode against real issue stream; collect false-positive data; tune agent prompt and rubric severity | False-positive rate < 10% per gate before flipping to `enforce` |
| **Phase 8: Enforce** | — | Flip flag to `enforce` in the dogfood project | Pipeline rejects needs-clarification issues; metrics dashboard live |

Total wall-clock: ~6-9 weeks depending on Phase 7 soak duration.

## 13. Open Questions

These need decisions before Phase 2 ships:

1. **Q1: Where does the agent run?** ✅ **RESOLVED (2026-04-30)** — wrong question. The rubric is implemented as a single library function `evaluateIssue()` (Section 5.1) called from multiple ingress shims (Section 5.2). v1 ships with two shims: GitHub Action (for `issues:opened`/`edited` and PR-touching `backlog/tasks/*.md`) and Claude Code subagent (`refinement-reviewer`, invoked from `/ai-sdlc execute` when a backlog task is created in-session). Future ingress channels (Forge UI / Slack / customer portal) just add a shim — the rubric library is unchanged. Aligns with the existing IssueTracker abstraction pattern in the codebase. Aligns with RFC-0010 §13 harness adapters for the Stage B LLM call.
2. **Q2: How does the agent pull cross-references for Gate 3?** ✅ **RESOLVED (2026-04-30)** — pluggable resolver registry. The rubric calls `resolveReference(ref)` which dispatches to a registered resolver based on the reference's shape: `#NN` → github-issue resolver, `LINEAR-1234` → linear-issue resolver, `RFC-NNNN` → file-existence resolver, `https://...` → URL HEAD resolver, `AISDLC-NN` → backlog file-existence resolver, etc. v1 ships with 3 resolvers (github-issue, file-existence, URL-HEAD) covering ~95% of references in our current corpus. Adding Linear / Forge later is one new resolver, no rubric change. Same pattern as RFC-0010 §13 harness adapters and the existing IssueTracker abstraction — separate *what to look up* from *how to look it up*.
3. **Q3: What happens to existing issues in `Draft` when the gate ships?** ✅ **RESOLVED (2026-04-30)** — re-check on next status change. DoR runs when an issue transitions out of `Draft` for the first time after the gate ships. Issues already in `To Do`/`In Progress`/`Done` are grandfathered. The natural moment to evaluate an issue is when it enters the pipeline (`Draft` → `To Do`). Pre-existing `Draft` issues weren't going through the pipeline at the time they were written; they only matter when an author decides to publish them — and at that moment, they should pass the same gate as new issues. In-flight work is left alone because applying DoR retroactively serves no purpose; the work already happened. Matches feature-flag rollout convention: new behavior applies at the next decision point, not retroactively.
4. **Q4: Should the agent's confidence score affect blocking behavior?** ✅ **RESOLVED (2026-04-30)** — three tiers. **High** → act on verdict directly (admit-or-block). **Medium** → act on verdict AND silently flag for the weekly calibration spot-check (data feeds rubric tuning per Section 7.4). **Low** → don't auto-act; escalate to human triager via the same path as Section 6.3's 3-round escalation. Refusing to act on medium would create a flood of escalations and defeat the gate's automation value, since medium is the bulk of real-world verdicts. The spot-check flag gives the calibration loop the data it needs without burdening the human in real time. Composes naturally with the bypass mechanism (Section 7.4): if a maintainer routinely overrides medium-confidence blocks, that's a signal the rubric is too aggressive at medium for this project.
5. **Q5: Where do clarification questions get posted?** ✅ **RESOLVED (2026-04-30)** — per-project `dor-config.yaml`, with the option to post to BOTH the author's native channel AND a dedicated centralized channel simultaneously (not a choice between the two). Defaults: author-channel ON, dedicated channel OFF. Teams that want centralized triage opt in by setting `dor-config.yaml`'s `notifications.dedicatedChannel` to a Slack/GitHub-team/etc. address — clarification posts then go to BOTH places at once. Discoverability + centralization without forcing a choice. Schema:

```yaml
# .ai-sdlc/dor-config.yaml
notifications:
  authorChannel: true     # default true — comment goes to where the issue was authored
  dedicatedChannel:       # optional, default null
    slack: '#ai-sdlc-dor'
    github_team: '@ai-sdlc-framework/triage'
```

Each ingress shim (Section 5.2) is responsible for fanning out to all enabled channels. The rubric library function returns the verdict; the shim decides where to post. Idempotency markers (the `<!-- ai-sdlc:dor-comment -->` HTML comment per Section 6.2) are scoped per channel so re-checks update the right comment in each.
6. **Q6: How long until issues in `Needs Clarification` are auto-closed as stale?** ✅ **RESOLVED (2026-04-30)** — two-stage warn-then-close, both thresholds configurable. **Default behavior**: at 14 days of no author activity, post a "this issue is stale, will auto-close in 14 days" warning to the same channel(s) as the original clarification (per Q5's dual-fanout). At 28 days, auto-close with a `closed-as-stale-dor` label so it's discoverable in queries. **Per-project override** via `dor-config.yaml`:

```yaml
# .ai-sdlc/dor-config.yaml
staleness:
  warnAfterDays: 14      # default 14 — first nudge to author
  closeAfterDays: 28     # default 28 — auto-close (must be > warnAfterDays)
  closedLabel: 'closed-as-stale-dor'  # label applied on close
```

Pattern matches GitHub's stale-bot conventions so authors familiar with that mechanism aren't surprised. Conservative defaults avoid most "got distracted" false positives. The warning posts via the same channel(s) as the original clarification (Q5 dual-fanout), so the author sees it where they last engaged.
7. **Q7: Should DoR support multi-language issues?** ✅ **RESOLVED (2026-04-30)** — defer to v2. v1 ships English-only with the limitation documented in the project README and `dor-config.yaml` schema docs. Today's authors are English-speaking; there's no current demand. The first real non-English use case will tell us which design (auto-detect-language-and-respond-in-kind vs per-project locale config) to actually build — speculating now would lock in a choice without team input. v1 calibration corpus already needs significant work (Section 5.6); adding multi-language doubles that effort for zero current users. Composes with the project's overall "ship deterministic core, evolve from real use" pattern (also chosen for Q1, Q2, Q4 — pluggable architectures so future expansion doesn't require re-litigating the core).
8. **Q8: Rubric versioning — when we revise the rubric, how do existing issues respond?** ✅ **RESOLVED (2026-04-30)** — grandfather already-passed, re-check `Needs Clarification`. Issues at `Ready` status (or already advanced into `To Do`/`In Progress`/`Done`) keep their original rubric-version verdict. Issues currently in `Needs Clarification` get re-evaluated against the new rubric on next agent run (since their authors are actively engaged and should see current rules). The rubric's purpose is to evaluate issues entering the pipeline, not to retroactively police shipped work — grandfathering respects that boundary. Edge case: a rubric change that adds a new gate catching a defect class that was previously invisible MAY warrant a one-off backfill task to re-evaluate already-passed issues — handled case-by-case, not as standing policy. Composes with the calibration corpus (Section 5.6) — every rubric change goes through corpus testing + shadow-mode eval before promotion, so disagreement rate against old rubric is bounded BEFORE we ship a new version.
9. **Q9: Does DoR apply to RFCs themselves?** ✅ **RESOLVED (2026-04-30)** — out of scope for v1, defer to future work. The DoR rubric is built for *pipeline-executable* issues; RFCs are *strategic-decision* documents with a fundamentally different shape (multi-stakeholder sign-off, intentionally-evolving drafts, unbounded scope by design, open questions as a load-bearing section). The 7 gates were chosen for issues that get developer-implemented; applying them to design discussions is a category error (every gate would either false-positive or be irrelevant). Today's RFC process (template + sign-off) is working — no active quality issues to solve. If RFCs ever need a quality gate, it should be a separate template-based check filed as its own RFC, not a v2 of this RFC. Composes with the project's "ship deterministic core, evolve from real use" pattern.
10. **Q10: Cost per check?** Stage A is $0. With Sonnet 4.6 + cache, Stage B is ~$0.001-0.005 per LLM call. Per Section 4.4 industry data, ~40-60% of unready issues fail at Stage A (no LLM call), and well-formed issues pass Stage A but still incur one Stage B call. At 100 issues/week per project, total LLM cost is ~$0.05-$0.30/week — negligible. The deterministic-first split also makes this number bounded: cost scales with issue volume, not with rubric complexity. Confirm during Phase 2b.

## 14. References

- RFC-0001 — RFC template
- RFC-0008 — PPA Triad Integration (the prioritization gate)
- RFC-0009 — Trusted reviewer role (for `dor-bypass` permission)
- RFC-0010 — Parallel execution and worktree pooling (provides the harness adapter framework that `refinement-reviewer` plugs into)
- `ai-sdlc-plugin/agents/refinement-reviewer.md` (new, Phase 2)
- `.ai-sdlc/dor-config.yaml` (new, Phase 1)
- `spec/schemas/refinement-verdict.v1.schema.json` (new, Phase 1)
- Definition of Ready in agile literature: https://www.agilealliance.org/glossary/definition-of-ready/
- Original conversation with @dominique establishing the need (2026-04-30)
