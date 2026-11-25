---
id: RFC-0044
title: Worktree-HEAD Parent-Repo Serialization
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-06-09
updated: 2026-06-09
targetSpecVersion: v1alpha1
assumes: [RFC-0010, RFC-0038, RFC-0039, RFC-0040, RFC-0037, RFC-0041]
requiresDocs: []
---

# RFC-0044: Worktree-HEAD Parent-Repo Serialization

**Status:** Draft
**Lifecycle:** Draft
**Author:** Alexander Kline (Product owner contribution)
**Created:** 2026-06-09
**Updated:** 2026-06-09
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — Dominique Legault
- [ ] Product owner — Alexander Kline

## 1. Summary

When an operator dispatches multiple concurrent agents using `isolation: "worktree"` against the same project root, the parent repo's HEAD can silently swap between sibling agent branches in ways that violate operator-thread isolation. Commits intended for branch `chore/X` land on a sibling agent's branch `feat/Y` because the harness has swapped parent HEAD between the operator's branch-create and commit operations. This silently contaminates in-flight PRs with content from unrelated work.

This RFC proposes a three-option serialization mechanism to prevent this contamination class. The recommended first-pass shipping behavior is **Option C** — an operator concurrency gate that refuses dispatch above a configurable cap. This is the smallest implementation surface, codifies operational discipline already exercised on the motivating adopter project, and requires no git plumbing changes.

## 2. Motivation

### 2.1 The contamination mechanism

The `git worktree` model itself is sound — each worktree has its own HEAD, index, and working tree. The contamination happens at the **harness layer** on top of `git worktree`, specifically when concurrent `isolation: "worktree"` dispatches share a parent-repo HEAD that the harness can swap mid-operation.

Consider this race:

1. Dispatch A creates branch `feat/A` and sets parent HEAD to `feat/A`
2. Dispatch B creates branch `feat/B` and sets parent HEAD to `feat/B` (swapping A's HEAD)
3. Dispatch A commits its work — but parent HEAD is now `feat/B`, so the commit lands on `feat/B`
4. PR for `feat/B` now contains content from `feat/A`; PR for `feat/A` is missing its commit

This race is not theoretical. Empirical observation on a documented adopter project (week of 2026-05-19 through 2026-05-20):
- PR contamination occurred reliably at N >= 4 concurrent `isolation: "worktree"` agents
- Recovery required `git push --force-with-lease` + cherry-pick across affected branches
- Manual `gh pr diff <#> --name-only` cross-check was the only reliable detection mechanism

### 2.2 Why this is a framework concern

The framework's autonomous-dispatch value proposition (RFC-0010 worktree pooling + RFC-0015 autonomous orchestrator + RFC-0041 conductor/worker) is contingent on operator-thread isolation holding. Without it:

- Any unmonitored `/loop` context becomes a silent failure surface
- Recovery is manual and requires cross-PR diff inspection
- The failure is invisible until a reviewer notices wrong-branch content in a PR

The contamination class is invisible to the operator during dispatch. Codifying the safety contract is an Engineering-pillar responsibility that the Product authority surfaces because the failure mode is adoption-blocking.

### 2.3 Failure frequency and detection

| Metric | Observation |
|--------|-------------|
| Contamination onset | N >= 4 concurrent dispatches against same parent |
| Detection method | Manual `gh pr diff <#> --name-only` cross-check |
| False-negative rate | High — contamination is silent (no error thrown) |
| Recovery complexity | Medium — `git push --force-with-lease` + cherry-pick per affected branch |
| Recovery time | 15-45 minutes per incident (operator manual effort) |

## 3. Goals and Non-Goals

### Goals

- Prevent silent parent-HEAD-swap contamination under concurrent `isolation: "worktree"` dispatch
- Codify the safety contract as a framework-level normative requirement
- Ship Option C (concurrency gate) as the first-pass implementation surface
- Document Options A and B as future evolution paths for adopters who need N > cap concurrent dispatches
- Compose with the RFC-0038 §10 adopter-extension family (Option C is expressible as an `OrchestratorPlugin.beforeRun` hook)

### Non-Goals

- Eliminating the underlying harness-layer parent-HEAD-swap race itself (Options A/B are paths toward that fix; not in scope for first-pass)
- Cross-machine contamination (this RFC is single-machine, single-repo-root)
- Auto-detecting which adopters need which option
- Implementation of Options A or B (documented as future direction; first-pass is Option C only)

## 4. Background: The Three Options

This section documents all three serialization options. The recommended first-pass shipping behavior is Option C.

### 4.1 Option A — Parent-repo HEAD lock around worktree-create operations

**Mechanism:** Hold a `flock`-style exclusive lock on `.git/HEAD` during the brief critical section where the harness creates the worktree branch and commits the initial state. Releases the lock once the worktree is in a self-consistent state (HEAD, index, and working tree all on the new branch with no parent dependencies).

**Advantages:**
- Eliminates the race at the source — no HEAD swap is possible during the locked window
- Transparent to the operator — no concurrency cap to configure or tune
- Enables arbitrarily high N (the lock serializes only the creation critical section, not the full dispatch duration)

**Disadvantages:**
- Requires changes to git plumbing integration — the harness must wrap worktree-create operations with a cross-process lock primitive
- `flock` semantics on macOS and Windows differ; cross-platform implementation is non-trivial
- Stale-lock recovery (process crash during locked window) requires a timeout + cleanup protocol

**Severity:** Low implementation surface for the lock itself; medium for cross-platform correctness and stale-lock recovery.

**Detection of failure:** A failed lock acquisition surfaces as an explicit error (lock timeout or contention), not a silent contamination — this is strictly better than the current race.

### 4.2 Option B — Detach parent HEAD during any concurrent worktree dispatch

**Mechanism:** When the harness detects that two or more `isolation: "worktree"` dispatches are in flight against the same parent, it places the parent repo in detached HEAD state. Subsequent commits unambiguously fail with a clear error (`HEAD is now detached`) rather than silently landing on the wrong branch.

**Advantages:**
- No new lock primitive needed — `git checkout --detach HEAD` is a standard plumbing operation
- Failure is explicit, not silent — a detached-HEAD commit attempt produces an error the harness can catch and route to the operator

**Disadvantages:**
- Behavioral change for operators who use the parent repo's working tree for ad-hoc commits while dispatches are in flight (this is the Pattern C anti-pattern, but some adopters rely on it)
- Detached HEAD state can be confusing for operators unfamiliar with the pattern
- Recovery from an interrupted dispatch (process crash during detached-HEAD window) requires `git checkout <branch>` to re-attach

**Severity:** Medium — the behavioral change is visible to operators who interact with the parent working tree during dispatch.

**Detection of failure:** Explicit error on commit attempt rather than silent contamination — better than current state.

### 4.3 Option C — Operator concurrency gate (recommended first-pass)

**Mechanism:** The harness refuses to start a new `isolation: "worktree"` dispatch if the number of in-flight dispatches against the same parent root meets or exceeds a configurable cap. Default cap: 3 (contamination-safe per the empirical N >= 4 observation).

**Advantages:**
- Smallest implementation surface — a pre-dispatch check against a counter in `.ai-sdlc/dispatch/` (or equivalent) with no git plumbing changes
- Codifies operational discipline already exercised on the motivating adopter project (manual cap-3 enforcement)
- Compatible with the RFC-0038 §10 subprocess-plugin path — an adopter can ship Option C as an `OrchestratorPlugin.beforeRun` hook before the framework ships it natively
- No behavioral change for adopters with N <= 3 concurrent dispatches (the common case)

**Disadvantages:**
- Does not eliminate the race — it reduces contamination probability by keeping N below the empirically observed threshold, but a sufficiently unlucky race at N = 3 is theoretically possible
- Adopters with legitimate N > 3 parallelism requirements must either increase the cap (accepting risk) or wait for Options A/B

**Severity:** Low — the gate is a soft constraint that operators can tune, not a protocol change.

**Default cap rationale:** The empirical contamination-onset threshold is N >= 4. Setting the default cap at 3 gives one unit of headroom below the observed onset. The cap SHOULD be configurable per-operator via `.ai-sdlc/pipeline.yaml` (see §5.2).

## 5. Proposed Mechanism (Option C)

### 5.1 Concurrency gate behavior

The harness MUST check the in-flight dispatch count before starting any new `isolation: "worktree"` dispatch:

1. Read the current count of in-flight dispatches against the same parent root from the Dispatch Board (`.ai-sdlc/dispatch/inflight/` per RFC-0041, or equivalent)
2. If `count >= cap`, refuse the dispatch with a clear operator-facing error:

```
[ai-sdlc] Concurrency gate: refusing dispatch — {count} worktree dispatches already
in flight against {parent-root}. Default cap is {cap}. Increase
worktree.concurrencyCap in .ai-sdlc/pipeline.yaml or wait for an in-flight
dispatch to complete before starting another.
```

3. If `count < cap`, proceed with dispatch. Increment the in-flight count atomically (the Dispatch Board already provides this via the manifest write protocol in RFC-0041).

### 5.2 Configuration

`.ai-sdlc/pipeline.yaml` extended:

```yaml
worktree:
  concurrencyCap: 3          # default; set to 0 to disable the gate entirely
  concurrencyGateEnabled: true  # default true; false disables the gate (equivalent to cap: 0)
```

| Field | Default | Semantics |
|-------|---------|-----------|
| `concurrencyCap` | `3` | Maximum number of concurrent `isolation: "worktree"` dispatches |
| `concurrencyGateEnabled` | `true` | When `false`, disables the gate entirely (adopter accepts contamination risk) |

Setting `concurrencyCap: 0` or `concurrencyGateEnabled: false` disables the gate. Adopters who disable the gate SHOULD document the decision in `.ai-sdlc/pipeline.yaml` comments and accept responsibility for manual contamination prevention (e.g., monitoring `gh pr diff` cross-checks).

### 5.3 Gate bypass escape hatch

An operator-level override is available for emergency scenarios (e.g., a long-running dispatch is blocking a time-sensitive hotfix):

```bash
AI_SDLC_SKIP_WORKTREE_CONCURRENCY_GATE=1 /ai-sdlc execute <task-id>
```

Bypass uses MUST be documented in the PR body. The bypass is logged to the Dispatch Board event log.

## 6. Composition with RFC-0010

RFC-0010 defines the `isolation: "worktree"` execution model, the worktree pool lifecycle, and the harness-adapter contract. RFC-0044 layers on top of RFC-0010 without modifying the RFC-0010 contract:

- RFC-0010's `HarnessAdapter` is unchanged — the concurrency gate fires BEFORE `HarnessAdapter.createWorktree` is called
- RFC-0010's pool lifecycle (acquire, release, evict) is unchanged — the gate is a pre-acquisition check, not a pool-internal change
- RFC-0010's `isolation: "process"` and `isolation: "none"` modes are unaffected — the gate applies only to `isolation: "worktree"`

The two RFCs are **orthogonal layers**: RFC-0010 defines the worktree execution model; RFC-0044 defines the concurrency safety constraint on top of that model.

## 7. Composition with the Adopter-Extension RFC Family

RFC-0044 composes naturally with the RFC-0037 / RFC-0038 / RFC-0039 / RFC-0040 adopter-extension family:

**Option C as an `OrchestratorPlugin.beforeRun` hook (RFC-0038 §10):** An adopter who needs Option C before the framework ships it natively can implement it as a subprocess-plugin reviewer (RFC-0038 §10). The plugin reads the in-flight dispatch count from the Dispatch Board, compares to the cap, and throws from `beforeRun` if the cap is exceeded. This is exactly the throw-to-block semantics documented in RFC-0038 §10.2.

The adopter-side reference implementation (34-test hermetic shell-script gate) implements this pattern and can serve as the basis for a future framework-native Option C.

**Forbidden-list composition (RFC-0039 §10.4):** Adopters who combine the concurrency gate with a forbidden-list merge policy (RFC-0039 §10.4) can register both plugins. They are compositionally independent — the concurrency gate fires `beforeRun` (pre-dispatch); the forbidden-list gate fires `afterRun` (post-pipeline).

**Option A and Option B future evolution:** When Options A or B are eventually implemented, they will compose with the RFC-0010 `HarnessAdapter` contract at the worktree-create layer. RFC-0039's stage-hook model and RFC-0038's reviewer-registration model are not affected by Options A or B — they operate at a higher level than the HEAD-lock / detach mechanism.

## 8. Alternatives Considered

### 8.1 Option A as first-pass

Option A eliminates the race at the source and enables arbitrarily high N. It is the "right" long-term solution. However, the cross-platform `flock` implementation and stale-lock recovery protocol are non-trivial. Option C delivers the safety property needed today with a fraction of the implementation cost.

### 8.2 Option B as first-pass

Option B is simpler than Option A (no lock primitive) and makes failures explicit. However, it changes the observable behavior of the parent working tree, which breaks operator workflows that involve ad-hoc commits during dispatch. Option C avoids this behavioral change.

### 8.3 Documentation-only (no gate)

Documenting the N >= 4 threshold without enforcing it places the entire burden on operators. The contamination is silent — operators have no signal that they are approaching the threshold. Documentation-only is insufficient for a framework that targets autonomous / unmonitored dispatch contexts.

### 8.4 Process-isolation upgrade

Escalating all worktree dispatches to full process isolation (each dispatch in a separate subprocess with its own git env) eliminates the shared-parent race entirely. This is architecturally sound but requires migrating the RFC-0010 `isolation: "worktree"` model and has a higher implementation cost than Option C.

## 9. Backward Compatibility

Option C is fully backward-compatible for adopters with N <= 3 concurrent dispatches (the common case). The gate introduces a new refusal error for N >= 4, which is a new behavior but does not change the behavior of dispatches that succeed.

Adopters with N > 3 requirements can increase `concurrencyCap` in `.ai-sdlc/pipeline.yaml`. The cap is documented; adopters who raise it accept contamination risk above the empirical threshold.

Options A and B (future) will require harness changes and may involve behavioral changes to the parent working tree. They are out of scope for this RFC and will be specified in follow-up RFCs or amendments.

## 10. Implementation Plan

- [ ] Extend `executePipeline` (or equivalent harness entry point) with a pre-dispatch concurrency check
- [ ] Read in-flight count from the Dispatch Board (RFC-0041 `.ai-sdlc/dispatch/inflight/` manifests)
- [ ] Implement `concurrencyCap` + `concurrencyGateEnabled` configuration fields in `.ai-sdlc/pipeline.yaml` schema
- [ ] Implement `AI_SDLC_SKIP_WORKTREE_CONCURRENCY_GATE=1` bypass with audit logging
- [ ] Hermetic tests: happy path (N < cap), gate-refuse (N >= cap), cap-config override, bypass env-var, disabled gate
- [ ] Operator runbook: what to do when gate fires, how to tune the cap, how to enable bypass

## 11. Open Questions

1. **Default cap value**: the empirically observed contamination-onset threshold is N >= 4, motivating a default cap of 3. Is 3 the right default, or should the framework default to a more conservative cap (e.g., 2) or a more permissive one (e.g., 4)? What is the right source of evidence for calibrating this?

2. **Gate-bypass escape hatch design**: `AI_SDLC_SKIP_WORKTREE_CONCURRENCY_GATE=1` is the proposed escape hatch. Should the bypass also be available as a per-dispatch flag on the `executePipeline` API (for programmatic callers)? Should bypass events be surfaced in `events.jsonl` with `OrchestratorWorktreeConcurrencyGateBypassed` event type?

3. **Future evolution to Options A + B**: should this RFC define a forward-compatibility contract that makes it easy to replace Option C with Options A or B later (e.g., a `worktree.concurrencyStrategy: 'gate' | 'head-lock' | 'detach'` enum in pipeline.yaml)? Or is it premature to define the enum before Options A/B have concrete specs?

4. **Multi-host extension (out of scope, flagged)**: the contamination problem described in this RFC is single-machine, single-repo-root. In multi-host dispatch contexts (multiple operator machines sharing a remote origin), a different class of race exists at the remote-push layer. This RFC explicitly excludes cross-machine contamination. The OQ is flagged so it is not forgotten — a future RFC should address the multi-host case if autonomous multi-machine dispatch becomes a supported pattern.

## 12. References

- RFC-0010: Parallel Execution and Worktree Pooling — the worktree execution model this RFC layers on
- RFC-0015: Autonomous Pipeline Orchestrator — the dispatch context in which this RFC's contamination class surfaces
- RFC-0037: Adopter Project Context Inheritance
- RFC-0038: Adopter-Defined Reviewer Extension Point (§10 subprocess-plugin path composes with Option C)
- RFC-0039: Adopter-Defined Pipeline Gate Extension (§10 in-process plugin path composes with Option C)
- RFC-0040: PPA Triage Diagnostic and Human Curve Signal Sources
- RFC-0041: Conductor / Worker Process Architecture — the Dispatch Board protocol this RFC reads in-flight counts from
- `orchestrator/src/plugin.ts` — `OrchestratorPlugin` interface
- `orchestrator/src/cost-governance.ts` — canonical `OrchestratorPlugin` implementation pattern
- GitHub issue #732 — adopter empirical motivation, adopter-side reference implementation (34-test hermetic shell-script gate)
