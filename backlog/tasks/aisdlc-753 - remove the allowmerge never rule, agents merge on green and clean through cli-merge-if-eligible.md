---
id: AISDLC-753
title: >-
  Remove the allowMerge never rule: agents merge on green + CLEAN through cli-merge-if-eligible
status: To Do
assignee: []
created_date: '2026-10-07'
labels:
  - governance
  - pipeline-cli
  - plugin
  - docs
dependencies: []
references:
  - .ai-sdlc/agent-role.yaml
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/release-merge.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - pipeline-cli/src/decisions/governance-fallback.ts
  - ai-sdlc-plugin/hooks/lib/governance-resolver.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/scripts/render-governance-hard-rules.test.mjs
  - spec/schemas/agent-role.schema.json
  - sdk-go/core/schemas/agent-role.schema.json
  - reference/src/core/generated-schemas.ts
  - orchestrator/src/runners/claude-code-sdk.ts
  - orchestrator/src/cli/commands/doctor-checks.test.ts
  - docs/api-reference/governance.md
  - docs/operations/decision-authority.md
  - docs/operations/operator-runbook.md
  - docs/operations/ci-conflict-resolver.md
  - spec/rfcs/RFC-0048-per-repo-configurable-governance.md
  - CLAUDE.md
  - AGENTS.md
  - README.md
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/rebase.md
  - ai-sdlc-plugin/commands/review-pr.md
  - ai-sdlc-plugin/commands/fix-pr.md
  - ai-sdlc-plugin/commands/resolve-conflicts.md
  - ai-sdlc-plugin/commands/execute-parallel.md
  - ai-sdlc-plugin/commands/execute-parallel-cleanup.md
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/agents/rebase-resolver.md
  - ai-sdlc-plugin/agents/ci-conflict-resolver.md
  - ai-sdlc-plugin/agents/refinement-reviewer.md
  - .claude/memory/feedback_never_merge_prs.md
  - .claude/memory/feedback_workflow_edit_rule_scope.md
  - .claude/memory/MEMORY.md
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-07 the operator ruled: "I never said there was a never merge rule. Agents merge all the time. We have rules around merging like green and clean, but a hard rule of agents never merge isn't true." The `allowMerge: never` default (RFC-0048, AISDLC-601/602/603) and the CLAUDE.md line "Never merge PRs — only humans merge" were never an operator decision. They have refused every agent arm and merge attempt in this repository for months, including `cli-merge-if-eligible --arm` on the planner's own filing PRs, because `.ai-sdlc/agent-role.yaml` carries no `governance.allowMerge` key and the default is `never`.

The rule that does exist, and stays, is the deterministic gate in `cli-merge-if-eligible`: all required checks green, `mergeStateStatus == CLEAN`, trusted source kind (`backlog` or verified `release`), same-repo, base `main`, author on `mergeAuthors` (or `releaseAuthors` for the release PR), matching backlog task, head commit pinned. Remove the never rule everywhere and leave that gate as the only merge policy.

Changes, in dependency order:

1. **Policy model.** Delete the `allowMerge` key and the `never | onGreenClean` enum from `spec/schemas/agent-role.schema.json`, `sdk-go/core/schemas/agent-role.schema.json` and the regenerated `reference/src/core/generated-schemas.ts`. Delete the `preset: operator-trusted` sugar whose only expansion was `allowMerge: onGreenClean` (keep `preset: strict` accepted as a no-op). Delete `allowReleaseMerge`: with no `never` there is nothing narrower to grant; the release path is governed by `releaseAuthors` (explicit `[]` disables it) exactly as today. A legacy `allowMerge:`, `allowReleaseMerge:` or `preset: operator-trusted` key in an adopter file is accepted and ignored with one deprecation line from the resolver and the CLI, never an error. Adopters who want no agent merges set `mergeAuthors: []` (already fail-closed: absent or empty means nobody).
2. **Resolver and CLI.** In `ai-sdlc-plugin/hooks/lib/governance-resolver.js` drop `allowMerge` from `STRICT_DEFAULTS`, the parser and the resolved type; replace `STRICT_MERGE_TEXT` / `ONGREENCLEAN_MERGE_TEXT` with one hard-rule sentence: merges and auto-merge arming go through `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog [--arm]`, which merges once green + CLEAN + trusted; the raw `gh` merge subcommand (every form, `--auto` included) and the API/curl merge routes stay blocked by `enforce-blocked-actions.js` because they skip that gate, not because humans must merge. In `pipeline-cli/src/governance/merge-if-eligible.ts` remove `AllowMerge`, the `allowMerge` field in the policy, the preset expansion and the refusal "governance policy allowMerge=... refusing all agent-initiated merges"; eligibility is the remaining checks. In `release-merge.ts` remove the enablement check on `allowMerge`/`allowReleaseMerge` and its next-step text. Update `pipeline-cli/src/decisions/governance-fallback.ts` and `orchestrator/src/runners/claude-code-sdk.ts` where they narrate the humans-only rule. Update the hook comments in `enforce-blocked-actions.js` that say the raw command is denied "under every allowMerge value" to say it is denied because the helper is the gate.
3. **This repository's grant.** Add to `.ai-sdlc/agent-role.yaml` under `spec.governance`: `mergeAuthors: [deefactorial]` (the identity every agent PR is authored and pushed as; verified on PRs #1250, #1251, #1254). Leave `releaseAuthors` as it is today.
4. **Prose.** Replace "Never merge PRs — only humans merge" and every "only humans merge" / "requires a human to merge" / "human to click merge" sentence in CLAUDE.md (lines 24 and the release paragraph near line 445), AGENTS.md, README.md, `docs/api-reference/governance.md` (the `allowMerge: never` example block, the preset bullet, the sections on enablement, the "under the default allowMerge: never it is refused" sentence), `docs/operations/decision-authority.md`, `operator-runbook.md`, `ci-conflict-resolver.md`, the plugin command bodies (`execute.md` rule 1 and the "Never runs ..." bullet near line 2037, `rebase.md`, `review-pr.md`, `fix-pr.md`, `resolve-conflicts.md`, `execute-parallel.md`, `execute-parallel-cleanup.md`), the agent bodies (`developer.md`, `rebase-resolver.md`, `ci-conflict-resolver.md`, `refinement-reviewer.md`) and the in-repo memory files (`.claude/memory/feedback_never_merge_prs.md` is deleted, its index line in `.claude/memory/MEMORY.md` removed, `feedback_workflow_edit_rule_scope.md` corrected) with the one rule: merge through `cli-merge-if-eligible` once green + CLEAN + trusted; never run the raw merge command. Add a short "Superseded 2026-10-07" note at the top of the RFC-0048 section that introduced `allowMerge` rather than rewriting the RFC. Do not touch `backlog/completed/*` or CHANGELOG history.
5. **Tests.** Update every test that pins the `never` default or the refusal text: `pipeline-cli/src/cli/merge-if-eligible.test.ts`, `pipeline-cli/src/governance/merge-if-eligible.test.ts`, `release-merge.test.ts`, `ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs`, `governance-lease.test.mjs`, `enforce-blocked-actions.test.mjs`, `subagent-start.test.mjs`, `session-start.test.mjs`, `scripts/render-governance-hard-rules.test.mjs`, `hooks/lib/role-tool-policy.test.mjs`, `reference/src/core/validation.test.ts`, `orchestrator/src/cli/commands/doctor-checks.test.ts`, `commands/rebase.test.mjs`, `commands/resolve-conflicts.test.mjs`, `agents/rebase-resolver.test.mjs`. Add tests that a legacy `allowMerge: never` key is ignored with the deprecation line and that `mergeAuthors: []` still refuses every merge. The raw-command block tests in `enforce-blocked-actions.test.mjs` stay green unchanged.
6. **Verification in the dogfood repo.** After the PR lands, `node pipeline-cli/bin/cli-merge-if-eligible.mjs <open filing PR> --source-kind backlog --dry-run` from the main checkout reports eligible on a green + CLEAN PR authored by deefactorial, and `--arm` arms it. Record the command and its output in the PR body.

The `.ai-sdlc/agent-role.yaml` edit is an internal change by the operator's own fleet; the external-PR config-block rule does not apply (operator ruling 2026-10-04).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `grep -rn allowMerge` outside `backlog/completed`, CHANGELOGs and the RFC-0048 superseded note returns nothing; `grep -rn "only humans merge"` and "human to merge" return nothing outside those same histories.
- [ ] `cli-merge-if-eligible <pr> --source-kind backlog --dry-run` on a green + CLEAN same-repo PR authored by a `mergeAuthors` login reports eligible with no `allowMerge` grant present; with `mergeAuthors: []` it refuses; a legacy `allowMerge: never` key is ignored with a deprecation line.
- [ ] Session-start and subagent-start hard rules render the single merge rule (helper on green + CLEAN; raw command blocked because it skips the gate) and no humans-only sentence.
- [ ] `.ai-sdlc/agent-role.yaml` carries `mergeAuthors: [deefactorial]`; the release path behaves as before.
- [ ] CLAUDE.md, AGENTS.md, README.md, the governance reference and every plugin command and agent body named above state the single rule; the in-repo never-merge memory is deleted.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.
