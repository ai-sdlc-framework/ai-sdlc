# CLAUDE.md reference: decision authority and subagent governance

This page holds the detailed text moved out of `CLAUDE.md` (AISDLC-742) to cut the per-call context floor. The operative rules stay in `CLAUDE.md`; the explanation, incident history and implementation detail live here, essentially verbatim. Section headings below are the original `CLAUDE.md` headings.

## Decision authority (AISDLC-703, DEC-0039)

Agents decide by rubric instead of waiting for the operator, and authority comes from the repository, not from a relayed message. Full protocol: [`docs/operations/decision-authority.md`](decision-authority.md).

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

## Code Style

- TypeScript strict, ESM. Prettier + ESLint. No premature abstractions — three similar lines beat one wrong abstraction.

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

- `developer`, `code-reviewer`, `test-reviewer` → **sonnet** (cost-efficient for mechanical tasks)
- `security-reviewer` → **opus** (reasoning-heavy; the one role where Opus pays for itself)

On dispatch paths (`/ai-sdlc execute`, `/ai-sdlc orchestrator-tick`), code-review and test-review SHOULD be routed to the `-codex` variants (`code-reviewer-codex` / `test-reviewer-codex`) by default — Codex plan billing is zero Claude usage. Security review stays on the Claude-native `security-reviewer` at opus. Mechanical work (sign, reconcile, rebase) MUST NOT be wrapped in subagents.

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

