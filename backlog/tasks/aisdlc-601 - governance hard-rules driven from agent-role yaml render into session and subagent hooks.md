---
id: AISDLC-601
title: >-
  Governance hard-rules: single per-repo source of truth in agent-role.yaml, rendered into session-start + subagent-start (defaults strict)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - plugin
  - governance
  - agent-role
  - adopter
  - hooks
dependencies: []
references:
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/subagent-start.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - .ai-sdlc/agent-role.yaml
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Triage 2026-09-07 (local-trades adopter, plugin 0.19.0).** The plugin injects a
FIXED set of governance hard rules ("NEVER merge PRs. Only humans merge.", "NEVER
force push.", "NEVER close issues or PRs.", …) into every session
(`session-start.js`) and every subagent (`subagent-start.js`), verbatim, regardless
of the consumer repo's own policy. An adopter cannot change these without patching
the framework — which the framework itself tells adopters not to do — so the
injected rule can directly contradict a policy the repo's operator deliberately
chose.

**The mechanism already half-exists:** `.ai-sdlc/agent-role.yaml` already carries
per-repo `spec.blockedActions` / `spec.blockedPaths`, and all three hooks
(`session-start.js`, `subagent-start.js`, `enforce-blocked-actions.js`) already read
it. But the injected hard-rule *prose* is hard-coded string constants that don't
derive from that policy — so the narration and the enforcement have drifted apart
(e.g. the prose says "never merge PRs" while `blockedActions: git merge*` doesn't
even match `gh pr merge`).

**Chosen fix direction (operator, 2026-09-07): Option 1 — one per-repo policy source
of truth, rendered into every governance surface, defaults strict.** This task owns
the source-of-truth schema + resolver + the two HOOK render surfaces. AISDLC-602
owns the execute-command render surfaces + reconciling `enforce-blocked-actions.js`.

## Scope
- Extend `.ai-sdlc/agent-role.yaml` schema with a `spec.governance` (or `hardRules`)
  section enumerating the canonical hard rules (merge / force-push / close-pr-issue /
  branch-delete / git-reset-hard / ci-skip-tokens / edit-.ai-sdlc) with STRICT
  defaults. Absent/omitted section ⇒ current strict behavior (existing adopters
  unchanged, byte-for-byte where practical).
- Add a small resolver (shared, testable) that merges the repo's declared governance
  with the strict defaults into a resolved policy object.
- Render the injected hard-rule text in BOTH `session-start.js` and
  `subagent-start.js` FROM the resolved policy, not string constants. A repo that
  sets e.g. `governance.allowMerge: onGreenClean` (or removes the merge rule) sees
  the softened/removed rule in the injected banner; a repo that sets nothing sees the
  current strict text.
- **Trust/authorization constraint (load-bearing):** the governance policy is only
  honored from the repo's own trusted `.ai-sdlc/agent-role.yaml` on the base branch —
  NEVER from PR-modified config supplied by an untrusted contributor (RFC-0043
  sandbox path). A relaxation must not be settable by the party being governed. Verify
  how the hooks resolve the config path and preserve this boundary (default to
  base-branch/operator-filesystem config; do not read PR-tree overrides for
  untrusted PRs).
- Hermetic tests: strict-by-default banner when section absent; softened banner when
  a rule is relaxed; rule-removed case; malformed governance section fails closed to
  strict.

## Acceptance Criteria
- [ ] `agent-role.yaml` supports a `governance`/`hardRules` section with strict
  defaults; omitting it reproduces today's injected hard-rule text.
- [ ] `session-start.js` and `subagent-start.js` render the hard-rule block from the
  resolved policy (no hard-coded rule strings for the configurable rules).
- [ ] A repo that opts into `allowMerge: onGreenClean` (or removes the merge rule)
  sees that reflected in BOTH injected banners; a repo with no governance section is
  unchanged.
- [ ] Untrusted-source config cannot relax a hard rule (policy resolved only from the
  trusted base-branch/operator config, never PR-modified config).
- [ ] Malformed/unknown governance keys fail CLOSED to strict.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass (hooks use
  `node --test`).
<!-- SECTION:DESCRIPTION:END -->

## Notes
Composes with [[AISDLC-602]] (execute-command render + `enforce-blocked-actions.js`
reconciliation). Guardrail the fix must preserve: merge-on-green must still be
expressible as "green + CLEAN" gated on the repo's actual CI checks (verify-attestation,
migration-mutation-gate, etc.) — configurable, not unguarded. NOTE: this touches the
trust-chain guardrails (never-merge/never-force-push are load-bearing); if the operator
prefers, the design (schema shape, trust boundary, preset layer) can be resolved via an
RFC/OQ walkthrough before implementation rather than settled in-task.
