# AISDLC-570 — opt-a feasibility investigation: binding the attestation leaf to the reviewer subagent's own harness-captured transcript

**Status:** Investigation complete. NOT implemented. No schema/verifier code changed by this doc's author. This is pre-work per the task's "Pre-work required" gate; the trust-model decision below is escalated to the operator (Decision Catalog, see bottom) rather than resolved inline (AISDLC-298).

**Related:** [[aisdlc-568]] (verdictClass, DEC-0012 opt-b, shipped), `DEC-0012` (Decision Catalog), RFC-0042 (Merkle-transcript attestation), `pipeline-cli/src/attestation/verdict-class.ts`.

---

## 1. Feasibility confirmation — Claude Code

**Confirmed on this machine, live data.** Every Claude Code subagent invocation (via the `Agent`/`Task` tool) writes a harness-captured, append-only execution transcript to a deterministic path:

```
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.meta.json
```

Verified directly under this session's own project slug (`-Users-dominique-Documents-dev-ai-sdlc`, session `998e4dd8-27fa-4018-adff-58605b7431bd`) — 316 agent transcript files exist from historical `/ai-sdlc execute` runs on this machine, including two from this very PR's session (`code-reviewer` on AISDLC-567). Sample `.meta.json`:

```json
{"agentType":"ai-sdlc:security-reviewer","description":"Security review AISDLC-555","toolUseId":"toolu_01TjFKmMG52UxfvUWd6bfRcG","spawnDepth":1}
```

Sample first line of the `.jsonl` (the subagent's literal system/user prompt as the harness saw it):

```json
{"parentUuid":null,"isSidechain":true,"promptId":"...","agentId":"af6a44137a9ef1395","type":"user","message":{"role":"user","content":"Code review PR #982 (AISDLC-567) in worktree ... Review the diff: `git ... diff origin/main...HEAD`. ... Report your standard JSON verdict envelope ... Write it to `.../verdicts/per-reviewer/code-review.json`"},...}
```

Key structural facts:

- The `.jsonl` filename (`agent-<agentId>`) matches the `agentId` field embedded in every line of the file's content — self-consistent, not just a naming convention the coordinator could exploit.
- The `.meta.json` sidecar carries `agentType` (which named subagent definition was invoked, e.g. `ai-sdlc:code-reviewer`), written by the harness at spawn time, *before* the subagent's own turn begins.
- The full prompt (including the diff/head-sha reference the orchestrating command embedded in its `Task` call), every tool call, every tool result, and the subagent's final assistant turn are all captured — this is a strictly richer artifact than the Bash-written `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl` file the reviewer agent bodies write today.

### How `emit-leaf` currently locates its transcript, and what would change

`pipeline-cli/src/cli/attestation.ts`'s `emit-leaf` subcommand takes an explicit `--transcript-path` CLI flag (validated only for "resolves inside `<repo-root>/.ai-sdlc/`"), reads that file, and SHA-256-hashes its bytes into the leaf's `transcriptHash`. The caller (the slash-command body / orchestrator reconcile step) is the one who decides what path to pass — today it's always the reviewer agent's own Bash-written `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl`.

To bind to the harness transcript instead, `emit-leaf` would need a **new resolution mode** that does NOT trust an operator/coordinator-supplied path at all, and instead derives it:

1. Resolve `<project-slug>` deterministically from `repoRoot` (Claude Code's slug derivation is a straightforward path-to-slug transform — confirmed working today via the two live example directories: `-Users-dominique-Documents-dev-ai-sdlc` for the parent Pattern-C repo).
2. Resolve `<session-id>` — this is the **live blocker for a clean derivation**: the session ID is not currently threaded through to `cli-attestation.mjs`. It would need to come from an env var the harness sets (none currently observed — `CLAUDE_SESSION_ID` is not exported into subprocess env on this machine as tested) or be looked up as "most-recently-modified session dir under the project slug," which is a heuristic, not a hard guarantee under concurrent sessions (see AISDLC-216's own multi-worktree note about "most-recently-modified wins" being a known race).
3. Resolve `<agent-id>` — **this part already has a clean, existing hook.** `verdict-class.ts`'s `determineVerdictClass()` already reads `.ai-sdlc/subagent-sessions/<agent-id>.json` markers written by `subagent-start.js`, and that marker's filename/`agentId` field is populated straight from the `SubagentStart` hook's stdin `agent_id` field — **which is the exact same ID used in `agent-<agent-id>.jsonl`** (confirmed: this session's transcript files under `subagents/` use the identical ID format/values recorded in `agentType`/description metadata for known reviewer runs). Opt-a's path resolution can reuse this marker as the agent-id source, instead of (or in addition to) its current sole use as a same/near-in-time existence check.

**On the task's `AISDLC-572 adds agentType too` premise:** verified this does **not exist yet** in this codebase. `subagent-start.js`'s stdin payload only carries `agent_id` (see `subagent-start.test.mjs`); there is no `AISDLC-572` task file in `backlog/` (searched `backlog/tasks/` and `backlog/completed/` — no match). This investigation proceeds on the current, shipped `agent_id`-only marker. If/when `agentType` binding lands, it strengthens step 3 above (cross-check `agentType` against the expected reviewer name) but is not a hard prerequisite for opt-a's core mechanism — the harness transcript's own `.meta.json` already carries `agentType` independent of any marker enhancement.

**Verdict: Claude Code — FEASIBLE**, with one real gap to close before implementation: **deterministic session-id resolution inside `cli-attestation.mjs`** (today only agent-id resolution is straightforward via the existing marker). This is mechanical (thread an env var or accept the "most-recent session dir" heuristic with an explicit disclosed race window), not an architectural blocker — but it is new plumbing, not a trivial change to `emit-leaf`'s existing flag surface, hence still routed through this design-then-decide gate rather than implemented inline.

---

## 2. Forgery analysis — what opt-a actually proves and what it still doesn't

The coordinator process runs as the **same OS user, same machine** as any spawned subagent — there is no OS-level sandboxing between them. "Unforgeable" in this context can only mean: *the coordinator cannot cheaply FABRICATE a plausible full multi-turn harness transcript without actually paying for and executing a real LLM call through the `Agent`/`Task` tool.* It does NOT mean the coordinator is cryptographically prevented from reading, copying, or otherwise touching the file once it exists (same UID; file mode `0600` confirmed on live samples, owned by the invoking user, not protected from that same user's other processes).

Enumerated residual attacks and what does/doesn't close each:

| # | Attack | Closed by opt-a? | Mechanism / residual gap |
|---|---|---|---|
| **a** | Copy a real *developer* subagent's transcript, relabel/bind it as a *reviewer's* leaf. | **Partially closed.** | The `.meta.json` sidecar's `agentType` field (`ai-sdlc:developer` vs `ai-sdlc:code-reviewer`) is written by the harness from the `subagent_type` parameter the *coordinator itself* passed to the `Agent`/`Task` tool call — so this field, while harness-written, is not independent of coordinator intent (the coordinator picked which agent type to invoke, same as it always could). What IS closed: the coordinator can no longer claim "code-reviewer ran" while pointing at an actual developer-subagent transcript body, because the transcript's own first-line prompt content (captured verbatim by the harness) will read as the developer's task, not a review request — a structural content mismatch a verifier can grep for (e.g. does the transcript's initial prompt reference the reviewer's expected verdict-envelope contract / the specific diff being reviewed). This requires the verifier to do content inspection, not just presence-of-file checking — a new verification surface, not free.
| **b** | Replay an old reviewer transcript from a *different diff/commit*. | **Not closed by opt-a alone; needs new binding.** | Today's `generateNonce(headSha)` (RFC-0042 §Nonce binding) is generated by `emit-leaf` **after** the reviewer subagent has already finished and its transcript is complete — the nonce is never seen by the subagent, so it cannot appear inside the harness transcript. Binding requires a **new pre-review nonce injection**: the orchestrating command must embed a nonce (or the literal head-SHA) into the `Task` tool prompt it sends the reviewer, and `emit-leaf`'s new verification step must confirm that exact string appears somewhere in the harness transcript's captured prompt content before accepting the leaf. Without this, a coordinator can freely present a genuine-but-stale transcript (real subagent, real review, wrong commit) as current.
| **c** | Point `emit-leaf` at an attacker/coordinator-controlled path (masquerading as the harness directory). | **Closed, if resolution is non-parameterized.** | Per §1, opt-a's design must NOT accept an operator-supplied `--transcript-path` for this mode at all — the path must be *derived* entirely from `(repoRoot, agent-id-from-marker, session-id)` inside `emit-leaf` itself, with a hard-coded prefix check that the resolved path is inside `~/.claude/projects/**/subagents/` (never inside the repo's own `.ai-sdlc/`). This closes (c) by construction as long as the derivation logic itself isn't parameterized by anything the coordinator's invocation of `emit-leaf` controls.
| **d** (not in the task's own enumeration, but surfaced during this investigation) | Coordinator legitimately spawns a real reviewer subagent via `Agent`/`Task`, but crafts a prompt engineered to guarantee an `approved: true` verdict regardless of the actual diff (prompt injection / instructing the subagent to rubber-stamp). | **Not closed by opt-a, and not closeable by any transcript-binding mechanism.** | This is the correctly-out-of-scope case: opt-a proves *a real subagent executed*, not that its judgment was independent of coordinator intent. This is the same honest-limits boundary the `## Review attestations` section of `CLAUDE.md` already states for the whole v6 model ("does NOT by itself prove reviewer identity or independence from the coordinator that also makes the ship decision"). Worth stating explicitly here so opt-a isn't oversold in RFC-0042/whitepaper updates.

**Plain statement of what opt-a proves and doesn't:**

- **Proves:** a real, harness-dispatched subagent invocation (an actual `Agent`/`Task` tool call, not a coordinator-authored Bash script) produced the reviewed transcript — closing the specific gap opt-b's `verdictClass` heuristic left open ("a sufficiently determined coordinator with Bash/Write access could fabricate a marker file directly").
- **Does not prove:** that the subagent's judgment was free of coordinator-engineered prompt bias (attack d); that the reviewed diff was the CURRENT one, unless a new pre-review nonce-injection binding (attack b) is also built; reviewer *identity* beyond the `agentType` string the coordinator itself selected at spawn time (attack a, partially mitigated via content-shape checking, not eliminated).

---

## 3. Cross-harness investigation — Codex, Copilot

### Codex CLI — a per-subagent transcript artifact DOES exist (unexpected positive finding)

Live evidence on this machine, `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<thread-id>.jsonl`. Sample `session_meta` payload from a historical rollout file:

```json
{"type":"session_meta","payload":{"id":"019df961-...-3de686cfc432","cwd":"/Users/dominique/Documents/dev/ai-sdlc","originator":"codex-tui","cli_version":"0.128.0",
  "source":{"subagent":{"thread_spawn":{"parent_thread_id":"019df92d-...-779aec8d0c01","depth":1,"agent_nickname":"Hume","agent_role":"default"}}}, ...}}
```

Codex CLI has its own thread-spawn / subagent primitive, and each child thread gets its own rollout file at a path keyed by the child thread's own ID — structurally analogous to Claude Code's `agent-<id>.jsonl`, with an explicit `parent_thread_id` back-link.

**BUT** — this framework's actual "Codex reviewer" (`ai-sdlc-plugin/agents/code-reviewer-codex.md`) is architecturally different from what this finding might suggest: it is a **Claude Code subagent** that shells out to `codex exec` as a **top-level Bash-invoked subprocess** (`codex exec -s read-only ...`), not a Codex-native `thread_spawn`. Its own harness transcript (the Claude-side `agent-<id>.jsonl` for the `code-reviewer-codex` agentType) is fully feasible per §1. Whether that *specific* `codex exec` invocation ALSO produces a discoverable, deterministic Codex-side rollout file that emit-leaf could additionally bind to is plausible (Codex CLI does write a rollout file for `codex exec` runs, non-interactively, at the same `~/.codex/sessions/...` path format) but was not verified end-to-end in this investigation (no live `codex exec -s read-only` invocation was run to confirm the exact `session_meta.source` shape for a `codex exec` subprocess call vs. an interactive `codex-tui` thread-spawn — plausibly different `originator`/`source` fields). **Documented as: Claude-side harness transcript for `code-reviewer-codex` — feasible (same mechanism as any other Claude subagent, §1). The additional/optional double-binding to Codex CLI's own rollout log for the delegated `codex exec` call — plausible but unverified; treat as a stretch goal, not a blocker.**

For the CI/headless-dispatch case (`--spawner codex`, Codex bridge dispatching a Codex-native run with no wrapping Claude subagent at all) — no live sample was available to inspect on this machine. Per the task's own framing, document as **unknown/not verified for the bare `--spawner codex` path; assume no signal until independently confirmed** (fail-safe: falls back to opt-b's heuristic, i.e. `self-authored`, never silently upgraded).

### GitHub Copilot CLI — no evidence of a subagent-transcript artifact

`~/.copilot/logs/*.log` on this machine contain only process-level server logs (`Starting CLI in server mode (stdio)`, `Starting CLI in stdio mode (Rust JSON-RPC engine)`) — no session/thread transcript content, and no evidence in the logs of a subagent/delegate/spawn concept (`grep -i "subagent\|sub-agent\|delegate\|spawn"` returned zero matches). This framework's Copilot spawner (`docs/operations/copilot-spawner.md`) integrates via a thin JSON-line bridge protocol (`CopilotHarnessAdapter`) that the operator supplies — the bridge script itself, not the framework, would need to expose any transcript capture, and no such capture convention currently exists in this repo's Copilot integration.

**Verdict: Copilot — INFEASIBLE / no signal found.** Per the task's own acceptance-criteria framing (AC-3: "Where no signal exists: documented explicitly, `verdictClass` semantics for that harness unchanged"), Copilot-reviewed leaves would remain governed exclusively by opt-b's existing `verdictClass` heuristic (same-machine marker matching) — not silently upgraded to any stronger claim.

### Summary table

| Harness | Per-subagent harness transcript artifact | Deterministic path? | opt-a feasible? |
|---|---|---|---|
| Claude Code (native reviewers: `code-reviewer`, `test-reviewer`, `security-reviewer`) | Yes — `agent-<id>.jsonl` + `.meta.json` | Yes, modulo session-id plumbing gap (§1) | **Yes** |
| Codex (`code-reviewer-codex`, `test-reviewer-codex` — Claude subagent shelling to `codex exec`) | Yes, for the Claude-side wrapper transcript (same mechanism as native Claude reviewers) | Yes (same as above) | **Yes**, for the Claude-side binding. Double-binding to Codex's own rollout log: plausible, unverified, non-blocking stretch |
| Codex (bare `--spawner codex`, no Claude wrapper) | Unknown — not verified in this investigation | Unknown | **Not verified — treat as no-signal until confirmed** |
| Copilot (`--spawner copilot`, bridge script) | No evidence found | N/A | **Infeasible / no signal — opt-b heuristic only** |

---

## 4. Concrete design proposal (for operator approval — NOT self-decided)

All of the following are presented as **options**, not decisions. Per AISDLC-298/CLAUDE.md governance, no `**Resolution:**` marker is written anywhere, and no code implementing any of these has been written.

### 4.1 What gets hashed into the leaf

**Option 1 (recommended): additive field, not a replacement.** Add a new `harnessTranscriptHash` field alongside the existing `transcriptHash` on `TranscriptLeaf`. Keep `transcriptHash` bound to the existing Bash-written `.ai-sdlc/transcripts/<task>/<reviewer>.jsonl` (unchanged — needed for legacy envelope verification, per OQ-7's "retain v3/v4/v5 read-only" precedent, and because the Bash-written file remains the *source* the reviewer's summary/verdict text is drawn from). `harnessTranscriptHash` is `null`/absent when no harness signal exists for the dispatching harness (Copilot, unverified bare-Codex path) — never silently defaulted to anything that looks like a pass.
  - *Counter-argument:* two hash fields is schema surface the verifier must reason about in combination (what does it mean if one is present and the other is absent/mismatched?), and every future harness needs its own presence/absence semantics documented.

**Option 2: replace `transcriptHash`'s *source* for Claude Code leaves only, keep the field name.** Where a harness transcript is resolvable, hash that file instead of the Bash-written one; fall back to the Bash-written file's hash where no harness signal exists (with `verdictClass` already tracking the strength distinction). Simpler schema (no new field), but conflates two different provenance guarantees under one field name — a verifier reading an old v6 envelope and a new one can't tell which kind of hash it's looking at without also consulting `verdictClass`/a version marker.
  - *Counter-argument:* silently changes the meaning of an existing field is exactly the kind of ambiguity RFC-0042's "honest limits" documentation discipline (see the `CLAUDE.md` v6 section) has been careful to avoid elsewhere (e.g. `verdictClass`'s explicit weakest-link semantics).

**Recommendation: Option 1** (additive field) — consistent with how `verdictClass` itself was added additively in AISDLC-568 without touching `transcriptHash`'s existing meaning.

### 4.2 How the leaf binds to *this* diff/commit (closing attack b, §2)

**Option A (recommended): pre-review nonce injection.** The orchestrating command generates the nonce (or reuses the existing per-PR headSha-derived nonce, generated *before* dispatching reviewers instead of after) and embeds it as a literal string in the `Task`/`Agent` tool prompt sent to each reviewer subagent (e.g. appended as `[[nonce: <hex>]]` in the review request). `emit-leaf`'s new verification step great-searches the resolved harness transcript's first user-turn content for that exact literal string before accepting the leaf as harness-bound; a transcript missing it is rejected (fails the same way a missing marker fails opt-b — fail-safe, never over-claim).
  - *Counter-argument:* changes the reviewer dispatch flow (every reviewer agent body / orchestrator call site must be updated to embed the nonce), a bigger footprint than a pure `emit-leaf`-side change.

**Option B: bind to the literal head-SHA already present in the diff command.** Every reviewer prompt already contains `git diff origin/main...HEAD` or similar with the literal headSha baked in by the caller (confirmed in the live transcript sample in §1 — "Review the diff: `git -C ... diff origin/main...HEAD`" — though note that's a *ref expression*, not the resolved SHA itself, so this needs the caller to interpolate the resolved SHA into the prompt, not just pass `HEAD`). Slightly less invasive than Option A (no new nonce plumbing, reuses the existing "which diff to review" instruction the prompt already carries) but weaker: reusing a real headSha across two different (but coincidentally-fixed) PR states is a much narrower attack window than nonce reuse, but not zero if the caller doesn't also interpolate the literal resolved SHA rather than a ref.
  - *Counter-argument:* less rigorous than a fresh nonce; only closes the replay window if callers are disciplined about always interpolating a resolved SHA, not a movable ref — an easy thing for a future refactor to silently regress.

**Recommendation: Option A**, with the caveat that it's the larger of the two changes in scope and should be scoped as a lockstep change with `emit-leaf`'s harness-path derivation, not bolted on separately.

### 4.3 Session-id resolution (closing the §1 plumbing gap)

**Option i (recommended): pass session-id explicitly from the orchestrating command.** The slash-command body / orchestrator reconcile step already knows (or can capture) its own session context at dispatch time; thread it through as an explicit `--claude-session-id` flag to `emit-leaf`, validated the same way `--head-sha` already is (defense-in-depth against injection). This is the most correct approach but requires the orchestrating command to have a reliable source for its own session ID — needs confirming what (if any) env var Claude Code exposes to its own slash-command execution context (not verified in this investigation — the two live samples inspected were session directory *names*, i.e. externally observable, not confirmed as available to the running session via an env var it could read and pass down).

**Option ii: heuristic — most-recently-modified session directory under the resolved project slug.** Mirrors the existing Pattern-C `.active-task` sentinel "most-recent wins" precedent (AISDLC-216) explicitly, with the same disclosed race window under concurrent sessions. Zero new plumbing, but inherits a known race class this codebase has already flagged elsewhere as an accepted, documented limitation — not a new one.

**Recommendation: attempt Option i first** (try to find a reliable env var / mechanism); if none exists, fall back to Option ii with the race window explicitly documented in the same style as AISDLC-216's disclosure, not silently accepted.

### 4.4 Backward compatibility with existing v6 envelopes

No existing field changes meaning (per §4.1's Option 1 recommendation) — legacy envelopes without `harnessTranscriptHash` verify exactly as today. The verifier (`verifyV6Envelope`) would gain an *optional* additional check: IF a leaf declares `harnessTranscriptHash`, verify it against the (re-derivable, at verify time, from the same repo + patch-id + reviewer identity) expected path — but note the harness transcript is **local-disk-only, non-portable, and typically gone by CI verification time** (a fresh CI runner has no `~/.claude/projects/` at all). This means `harnessTranscriptHash`, if adopted, can only be **meaningfully verified at sign time** (by the operator's own machine, immediately after the reviewer ran, before the transcript is GC'd) — not independently re-derived by a CI verifier days later. This is a materially different trust model from the rest of v6's Merkle-proof design (which is built precisely so CI *can* independently re-verify without any local-machine-only artifact). **This is the single biggest architectural question this investigation surfaces and is the crux of what should be escalated, not resolved here.**

### 4.5 Composition with AISDLC-572 (agentType binding — not yet shipped)

Since AISDLC-572 doesn't exist in this codebase yet (confirmed absent, §1), there is nothing to compose with today. If/when it ships (adding `agentType` to the `SubagentStart` marker), it strengthens attack (a)'s mitigation (§2) by giving the marker itself an independently-harness-written `agentType` claim to cross-check against the transcript's own `.meta.json` `agentType` — belt-and-suspenders, not a prerequisite.

---

## The escalated decision

**This is the fork the operator needs to resolve, not the dev subagent:** §4.4's finding — that `harnessTranscriptHash` can only be verified at SIGN TIME on the operator's own machine, not independently re-derived by a CI verifier later — is a genuine trust-model departure from the rest of RFC-0042's Merkle-proof design. Three live options:

1. **Sign-time-only verification, informational field.** `harnessTranscriptHash` is checked once at sign time (raising confidence for the signing operator in the moment) but is NOT part of what CI/a downstream verifier can re-check — effectively a stronger *signing-time* gate, weaker *audit-time* guarantee than the rest of v6. Simplest to build; smallest actual security uplift over opt-b, since a compromised/adversarial *operator* machine at sign time could still fabricate everything opt-a is meant to prevent (opt-a specifically targets an adversarial *coordinator*, which is a distinct actor from an adversarial *operator* — worth being precise about which threat model this closes).
2. **Retain the harness transcript file itself as a committed artifact** (e.g. copy/append it into `.ai-sdlc/transcript-leaves/` or a sibling directory, git-committed) so a downstream verifier CAN independently re-check `harnessTranscriptHash` against real bytes, at the cost of committing potentially large, security-sensitive-content-bearing transcript files into the repo (full reviewer prompts, tool outputs, possibly diff contents) — a real repo-hygiene and possibly-secrets-exposure tradeoff RFC-0042's existing design deliberately avoided (transcripts are `.gitignore`d today, 90-day local retention per RFC-0042 OQ-1).
3. **Defer opt-a for CI-verifiable coverage; ship as an operator-local-only spot-check tool instead** (e.g. `cli-attestation verify-harness-transcript <patch-id>` — an on-demand operator command, not part of the automated v6 pipeline) — smaller footprint, doesn't touch the schema/verifier at all, gives the operator a manual escalation path for high-stakes PRs without the commit-transcripts tradeoff of option 2.

This document does not recommend one of these three — each has a materially different cost/tradeoff and the choice affects RFC-0042's core "CI can independently verify" design property. Filed to the Decision Catalog (see below) for operator routing.
