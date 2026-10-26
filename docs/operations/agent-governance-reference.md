# Agent governance reference (decision authority, scope creep, OQ prohibition, model defaults)

Reference material moved out of `CLAUDE.md` by AISDLC-651.2 to keep the per-turn fixed prefix small. The rules themselves stay in `CLAUDE.md`; this runbook holds the mechanics, incident history and tables.

## Decision authority (AISDLC-703, DEC-0039)

Agents decide by rubric instead of waiting for the operator, and authority comes from the repository, not from a relayed message. Full protocol: [`docs/operations/decision-authority.md`](./decision-authority.md).

A decision record in the catalog on `main`, authored by the planner role, is sufficient authority for classes (a) and (b). A relayed chat message alone is never authority, and the permission-laundering rules are unchanged.

| Class | Criteria | What happens |
|---|---|---|
| (a) decide-and-proceed | Reversible, small blast radius, touches no trust-chain or governance control | Decide by rubric, record with `cli-decisions add` plus `answer`, apply at once |
| (b) timeboxed | Hard to reverse, wide blast radius, or weakens a governance or trust-chain control | Decide by rubric, record with `--timebox` and `--autonomous-fallback`; applied when the timebox lapses without an operator override. Default 10 hours, two 5-hour windows (`timeboxWindowHours: 5` and `timeboxWindowCount: 2` in `.ai-sdlc/decisions-config.yaml`). A weakening option never applies itself when the timebox lapses |
| (c) operator-only | Legal and licensing, money, accounts and credentials, and actions only the operator's identity can perform (merging the release PR, closing or disarming a PR) | Never self-decide. Record it with `cli-decisions escalate`, park only that task, and keep working other eligible tasks |

Derive the class from three questions: can it be undone cheaply, how far does a mistake spread, and does it change a trust-chain or governance control. Examples: a CLAUDE.md edit named by a task (a); dispatching a planner-filed task (a); release timing per DEC-0042 (b, or (a) when the criteria give it); a change that weakens a governance or trust-chain control (b); signing up for a paid service (c). Two worked class (a) cases: (i) tightening a control to match a decision already on `main` (making AISDLC-720 fail closed); (ii) choosing the option that needs no exception to any hook or rule (AISDLC-721 waits for the hook fix, then uses the Edit tool).

**Only a change that loosens a control beyond what a recorded decision already allows is a weakening.** Tightening, or applying what a decision on `main` already permits, is class (a).

**Away rule.** No session opens a blocking question prompt (`AskUserQuestion`) to the operator while the operator is away. Questions go to the planner, which decides (a) and (b) and collects (c).

Only class (c) ever waits on a person, and only for legal, money, credentials or the operator's own identity. Every refusal a rule produces must name a next step the agent can take itself: a sanctioned command, a config key and value, or escalation to the dispatch or planner session.

A decision record authorizes only the action it names. Where a record covers filing or dispatching a task, it overrides the "wait for explicit operator authorization" step of the Scope Creep section above; with no such record, that section stands. A record that is not yet on `main` is not authority: not one in an unmerged PR, and not one added in the same PR as the change that acts on it. `--by` is a claim, not authentication. `cli-decisions operator-digest` shows the PR and merge commit that put each record on main next to its claimed author, and flags an author that is not a recognised planner or operator identity, a record not on main, and any untagged record that names a governance or trust-chain surface.

A decision that weakens a control (removes or loosens a hook, gate, required check, review or attestation requirement, merge restriction or role restriction, or moves a governance default in the permissive direction) is tagged `--governance-change weakening --weakens <option-id>`. `cli-decisions add` also applies the tag itself when the decision's scope, context-ref or body names a governance surface (plugin hooks, the governance resolver and schema defaults, agent-role config and templates, required checks and rulesets, workflow gates, CLAUDE.md rule sections, merge and role restrictions); an author can add the tag but cannot remove an auto-applied one. Its `--autonomous-fallback` must then be a non-weakening option, so a lapsed timebox resolves to "control stays"; `cli-decisions add` refuses otherwise, and the two ways forward are to pick a non-weakening fallback or add the decision with no fallback so it stays open for the planner or dispatch session. Tightening decisions are unaffected.

Guardrails and hooks are never bypassed. When a sanctioned path is missing, file a task for it; do not route around the hook. The operator reviews with `cli-decisions operator-digest` and overrides with the existing `answer` and `extend` commands.


## Subagent Governance — Scope Creep Prevention (AISDLC-308)

**Agents must not auto-expand scope beyond the original ask.** The PR #481 audit (2026-05-16) documented the root-cause governance gap: an agent asked to *review the state of RFCs* independently filed follow-up tasks, then dispatched implementation of those tasks within 1.5 hours — ignoring its own written "operator walkthrough required as pre-work" note. See `docs/audits/2026-05-16-pr-481-rfc-0025-subagent-forged-signoff.md` for the full chain.

When a review / audit / read-only task surfaces work that would be useful to do next, the agent MUST:

1. **Present the recommendation** in the review output (PR body, task summary, comment).
2. **Stop.** Wait for explicit operator authorization before:
   - Filing new backlog tasks
   - Opening any PR beyond the original ask
   - Dispatching new subagents for downstream work
3. **Treat "Pre-work required" / "Pre-conditions" / "OQ walkthrough needed" prose as a HARD precondition.** If a task body or referenced RFC flags an unresolved OQ or walkthrough requirement, the agent MUST NOT proceed to dispatch implementation until the operator confirms the precondition is met.

Every scope expansion is a decision that belongs in the [Decision Catalog (RFC-0035)](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md). Surface it there for operator routing — do not self-authorize.

### Reviewer gate (AISDLC-308)

The `code-reviewer` and `test-reviewer` subagents check for scope-creep candidates in every PR: if the PR BOTH (a) implements a "review" or "audit" task AND (b) creates new files under `backlog/tasks/`, it is flagged as **critical** with the message "scope-creep candidate — verify operator authorized task creation."

### Read-only agent constraint (AISDLC-308)

Agents whose role is read-only (exploration, audit, refinement review) MUST NOT use `Write`, `Edit`, task-create MCP tools, or dispatch downstream agents. These constraints are enforced in each agent's frontmatter `disallowedTools` list and are re-stated in the agent body as **Hard rules**.

### Subagent model defaults (AISDLC cost control)

Agent frontmatter pins model by role to prevent session-model bleed (Opus inheritance was the root cause of a 26%-weekly-budget incident on 2026-05-30):

- `developer`, `code-reviewer`, `test-reviewer`, `correctness-reviewer` → **sonnet** (cost-efficient for mechanical tasks)
- `rebase-resolver`, `ci-conflict-resolver`, `refinement-reviewer`, `code-reviewer-codex`, `test-reviewer-codex` → **sonnet**
- `review-executor`, `review-executor-codex` (review probes) → **haiku**
- `security-reviewer` → **opus** (reasoning-heavy; the one role where Opus pays for itself)
- Commands pin too (AISDLC-761): relay/status commands (`version`, `doctor`, `hierarchy`, `cleanup`, `pipeline-status`, `triage`, `import-spec`, `rfc-init`, `init-signing-key`, and the pointers retired by AISDLC-763: `execute-parallel`, `execute-parallel-status`, `execute-parallel-cleanup`, `orchestrator-tick`, `dispatch-worker`) → **haiku**; orchestration/session-driving commands (`execute`, `executor`, `operator-dispatch`, `planner`, `fix-pr`, `review-pr`, `detect-patterns`, `rebase`, `resolve-conflicts`) → **sonnet**.
- No command or agent may carry `model: inherit` or omit `model:`; `ai-sdlc-plugin/commands/model-pins.test.mjs` (`pnpm test:plugin-model-pins-gate`) enforces it.

### Reviewer harness default (AISDLC-1003)

`spec.harness` in `.ai-sdlc/model-routing.yaml` (`codex` or `claude`; a missing key means `codex`) sets which agents review code and tests: `codex` routes to the `-codex` variants, `claude` to the Claude-native `code-reviewer` and `test-reviewer`. Security review and developer dispatch are unaffected. The `AI_SDLC_REVIEWER_HARNESS` env var, when set, wins as a per-run override. Like the rest of the table it is read from the base branch (`origin/main`), so a change applies from the next claim after it lands, with no session relaunch. `review-prepare` records the harness and its source (`env`, `yaml` or `default`) in the round's harness note. This repository sets `harness: claude` while the Codex plan quota is exhausted (until 2026-11-19).

### Automation ladder rung (AISDLC-884)

Every file under `ai-sdlc-plugin/agents/` and `ai-sdlc-plugin/commands/` declares `rung:` (0 to 4) in its frontmatter, the lowest rung of the RFC-0054 automation ladder at which that prompt runs. Rung 3 (Haiku, tightly scoped) also requires a `bounds:` key naming the parameter bounds. `pnpm test:plugin-model-pins-gate` fails naming the file and field when `rung:` is missing or invalid, or a `rung: 3` file lacks `bounds:`. Rung 2 is the RFC-0049 judgment layer (provider chosen by config, Jev by default; see `judgment-layer.md`); no prompt file runs there, so none carries `rung: 2`.

| Rung | Files |
|---|---|
| 3 (Haiku, with `bounds:`) | every `model: haiku` file: `review-executor`, `review-executor-codex`, and the commands `version`, `doctor`, `init`, `hierarchy`, `cleanup`, `pipeline-status`, `triage`, `import-spec`, `rfc-init`, `init-signing-key`, `memory-dream`, `execute-parallel`, `execute-parallel-status`, `execute-parallel-cleanup`, `orchestrator-tick`, `dispatch-worker` (the last five are retired stubs) |
| 4 (strong model, plan/execute/synthesize) | every `model: sonnet` or `model: opus` file: all other agents (`developer`, the reviewers, `review-planner`, `review-synthesizer`, `rebase-resolver`, `ci-conflict-resolver`, `refinement-reviewer`) and commands (`execute`, `executor`, `operator-dispatch`, `planner`, `fix-pr`, `review-pr`, `detect-patterns`, `rebase`, `resolve-conflicts`) |

### Per-PR, per-rung spend report (AISDLC-885)

This change ships the ledger and its readers only. A model call is appended with `cli-kpi record-spend` (or `recordSpendEvent`) to `.ai-sdlc/kpi/spend.jsonl` as `{prNumber|taskId, rung, agent, model, inputTokens, outputTokens, calls, state, outcome, linkedTo}`. `rung` defaults to the `rung:` frontmatter of `--agent` (AISDLC-884). `outcome` (rung 2 and 3 only) is `answered`, `below-floor` or `escalated`; a rung-3 call recorded after an `escalated` rung-2 call on the same PR is linked to it through `linkedTo`.

- `cli-kpi spend --pr <n>` shows per-call detail, spend by rung and by agent, developer round as its own line. `cli-kpi spend --since <date> [--json]` adds the distribution (median, p90, max) of total, rung-4 and developer-round tokens per PR.
- The operator digest ends with "Spend since last digest": totals by rung and the five most expensive PRs; `--mark` resets the window.
- v1 is report only. No cap, refusal or throttle exists anywhere.

Wiring status: no pipeline stage calls `record-spend` yet, so the report is empty until the developer round, reviewers, judgment layer and staged review are wired to it (follow-up work, not part of this change). Callers record spend by invoking `cli-kpi record-spend` after each call.

Phase 3 rule (target, not built): a per-PR token budget, where rung-4 spend beyond the budget requires a logged rung-3 failure for the same typed question. The fields it needs are all in the report: `rung` and `agent` (rung-4 tokens per PR), `outcome` plus `linkedTo` (the logged rung-3 and rung-2 outcomes per typed question), `state` (budget by PR stage) and the per-PR distribution that sets the budget from data.

On dispatch paths (`/ai-sdlc execute`, `/ai-sdlc executor`), code-review and test-review SHOULD be routed to the `-codex` variants (`code-reviewer-codex` / `test-reviewer-codex`) by default — Codex plan billing is zero Claude usage. Security review stays on the Claude-native `security-reviewer` at opus. Mechanical work (sign, reconcile, rebase) MUST NOT be wrapped in subagents.

## Subagent Governance — OQ-resolution prohibition (AISDLC-298)

**Dev subagents MUST NOT resolve RFC Open Questions inline during implementation.**

AISDLC-271 / RFC-0031 shipped with all 5 OQs resolved by the dev subagent during a single development iteration — framework-level architectural decisions made without operator walkthrough or cross-pillar review. This is explicitly prohibited.

### What counts as inline OQ resolution

Any addition of a `**Resolution:**` (or `RESOLVED:` / `✅ RESOLVED`) marker to an RFC `## Open Questions` section by a developer subagent during task implementation. This includes:

- Picking an implementation approach and writing the rationale directly into the RFC
- Removing or replacing an OQ bullet with a concluded design decision
- Writing code that implicitly resolves an OQ without documenting the escalation

### Required behavior: escalate, do not resolve

When a dev subagent encounters an open question that blocks or constrains implementation:

1. **Stop and escalate** — do not pick an approach and resolve the OQ inline
2. **Return `prUrl: null` with a `notes` field** explaining which OQ in which RFC is blocking and what options exist
3. **Do not write Resolution markers** into RFC bodies — that is exclusively the operator's role after a walkthrough

If an OQ is genuinely non-blocking (implementation can proceed without resolving it), proceed with a documented assumption in the PR body — not a Resolution marker in the RFC.

### RFC-0035 Decision Catalog (default-ON since AISDLC-392)

The mechanism for architectural / OQ-style decision routing is the [Decision Catalog (RFC-0035)](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md). OQs project into the catalog as `Decision` records, routed to the appropriate actor (Engineering / Product / Operator), resolved asynchronously with full audit trail.

**Feature flag `AI_SDLC_DECISION_CATALOG` is default-ON (AISDLC-392, 2026-05-22).** File decisions with:

```bash
node pipeline-cli/bin/cli-decisions.mjs add --summary "<one-line>" --scope <area> --option "<id>:<description>"
node pipeline-cli/bin/cli-decisions.mjs list
```

To opt out: set `AI_SDLC_DECISION_CATALOG=off` (or `0`/`false`/`no`/`disabled`).

Dev subagents that hit an OQ-class architectural question during implementation should still escalate by returning `prUrl: null` per the protocol above. The Decision Catalog is for OPERATOR-side decision routing, not a license for dev subagents to resolve OQs in code.

### Reviewer gate (AISDLC-298)

The `code-reviewer` and `test-reviewer` subagents check for inline OQ resolutions in every PR diff. A new `**Resolution:**` marker added by a developer in an RFC's `## Open Questions` section is a **critical** finding that blocks approval.

## Where "never do X" rules are enforced (AISDLC-1014, DEC-0267)

Operator decision, five steps. (1) Requirement questioned: "a local hook must refuse the raw landing, close and force-push commands"; the outcome it protects is enforced on the server. (2) Delete: the command-text matcher in `enforce-blocked-actions.js` (the `blockedActions` patterns, raw merge, API merge and stash checks). (3) Simplify: one source for the rule, the line in `lib/prompt-rules.js`; one enforcement point, the server. (4) Accelerate: no refusals on JSON field names, paths, echo strings or heredoc bodies. (5) Automate: nothing new.

The controls that hold: branch protection on `main` (no direct push, no force push, required `ai-sdlc/pr-ready`), the `ai-sdlc/pr-ready` rollup, and `cli-merge-if-eligible`. The hook still enforces `blockedPaths` for untrusted runs and the lease-push guard (`allowForcePush` modes). Session and subagent hard rules no longer list a "Blocked actions" line, and the plugin hooks no longer read `blockedActions` from `agent-role.yaml`. This is a governance weakening recorded as DEC-0267, compensated by the server-side controls above.

## Five-step production algorithm (operator rule, 2026-10-10)

Every fix, prevention task, governance rule and process change is worked in this order, and its write-up names the steps (DEC-0090):

1. **Make the requirements less dumb.** Every requirement carries the name of the person or decision that set it; question it, especially when it came from a smart person or an old incident.
2. **Delete the part or process.** Delete first. If you are not adding back 10% of what you deleted, you did not delete enough.
3. **Simplify or optimise.** Only after step 2. Never optimise something that should not exist.
4. **Accelerate cycle time.** Only after steps 1 to 3.
5. **Automate.** Last, never first.

A task that fixes a failure or adds a rule opens its Fix with a "Five-step review (requirements first)" paragraph: the requirement questioned and who set it, what is deleted, then what is simplified, accelerated or automated. A deletion that loosens a governance control is a class (b) decision for the operator. Velocity impact: positive by construction; the rule removes work before it adds any. Origin: the 2026-10-10 PR-drain review (AISDLC-797..803), where 5 of 7 failure families traced to requirements that should not have existed.

## Project structure, cross-harness review and testing (moved from the governance skill, AISDLC-1067)

- `orchestrator/` core pipeline logic; `reference/` framework reference implementation; `dogfood/` CLI scripts that invoke the orchestrator; `.ai-sdlc/` pipeline configuration (agents cannot modify it); `.claude/` Claude Code hooks, commands and skills; `.github/workflows/` refused only when `.ai-sdlc/agent-role.yaml` lists it under `blockedPaths`; `spec/schemas/` JSON schemas.
- Cross-harness review: `code-reviewer` and `test-reviewer` (claude-code, default), `code-reviewer-codex` and `test-reviewer-codex` (codex). All return the same `{ approved, findings, summary }` envelope. `security-reviewer` stays on Claude. Runbook: `docs/operations/cross-harness-review.md`.
- Testing: Vitest for orchestrator and reference; 90 percent patch coverage in CI; `pnpm test` from the root, `pnpm --filter @ai-sdlc/orchestrator test` for one package. Use `/fix-pr <number>` to gather and fix PR issues.
