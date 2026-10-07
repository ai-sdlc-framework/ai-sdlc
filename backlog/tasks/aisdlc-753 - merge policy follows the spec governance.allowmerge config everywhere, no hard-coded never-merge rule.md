---
id: AISDLC-753
title: >-
  Merge policy follows the spec governance.allowMerge config everywhere; no hard-coded never-merge rule
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
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-07 the operator ruled: "I never said there was a never merge rule. Agents merge all the time. We have rules around merging like green and clean, but a hard rule of agents never merge isn't true." And, on the fix: "It should be a configurable option in the spec, but we have too many places where it's hard coded. It should follow from the spec design configuration, not be completely deleted."

So `governance.allowMerge: never | onGreenClean` stays in the AgentRole spec (RFC-0048) as the one configurable knob, with the deterministic gate in `cli-merge-if-eligible` (green, `mergeStateStatus == CLEAN`, trusted source kind, same repo, base `main`, author on `mergeAuthors` or `releaseAuthors`, matching task, pinned head) as what `onGreenClean` means. What goes away is every place that hard-codes the `never` outcome as prose, policy or behaviour instead of reading the resolved configuration. Today this repository's `.ai-sdlc/agent-role.yaml` carries no `allowMerge` key, so the schema default applied, and on top of that CLAUDE.md, README.md, the governance docs, nine plugin command bodies, four agent bodies and the hook render text all state "Never merge PRs, only humans merge" unconditionally, so even a repo that grants `onGreenClean` is told by its prompts that it may not merge.

Changes:

1. **This repository's configuration.** Add to `.ai-sdlc/agent-role.yaml` under `spec.governance`: `allowMerge: onGreenClean` and `mergeAuthors: [deefactorial]` (the identity every agent PR is authored and pushed as; verified on PRs #1250, #1251, #1254). Leave `releaseAuthors` and `allowReleaseMerge` as they are. The external-PR config-block rule does not apply to the operator's own fleet (ruling 2026-10-04).

2. **One source of truth for the rendered rule.** The merge hard-rule text that session-start, subagent-start and `render-governance-hard-rules` emit must be derived from the resolved policy only, in `ai-sdlc-plugin/hooks/lib/governance-resolver.js`: under `onGreenClean` it says merges and auto-merge arming go through `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog [--arm]` once green + CLEAN + trusted; under `never` it says this repository's configuration forbids agent merges and names the key to change. In both cases the raw `gh` merge subcommand (every form, `--auto` included) and the API/curl merge routes stay blocked by `enforce-blocked-actions.js` because they skip the gate. Fix the resolver comments that describe `never` as the right answer rather than one configured value; fix the `enforce-blocked-actions.js` comments the same way. Keep the schema default as the spec states it; do not change the default in this task (a default change is its own decision).

3. **No hard-coded merge prohibition in prompts and docs.** Replace "Never merge PRs — only humans merge" and every "only humans merge" / "requires a human to merge" / "human to click merge" sentence with one sentence that defers to the configuration: "Merging follows `governance.allowMerge` in `.ai-sdlc/agent-role.yaml`, rendered into the session hard rules; when it permits merging, the only path is `cli-merge-if-eligible`; never run the raw merge command." Files: CLAUDE.md (line 24 and the release paragraph near line 445), README.md, `docs/api-reference/governance.md` (keep the `allowMerge` reference, remove the "only humans merge" comment and rewrite the sentences that present `never` as the rule rather than a value), `docs/operations/decision-authority.md`, `operator-runbook.md`, `ci-conflict-resolver.md`, `ai-sdlc-plugin/commands/execute.md` (rule 1 and the "Never runs ..." bullet near line 2037), `rebase.md`, `review-pr.md`, `fix-pr.md`, `resolve-conflicts.md`, `execute-parallel.md`, `execute-parallel-cleanup.md`, `ai-sdlc-plugin/agents/developer.md`, `rebase-resolver.md`, `ci-conflict-resolver.md`, `refinement-reviewer.md`, `pipeline-cli/src/decisions/governance-fallback.ts`, `orchestrator/src/runners/claude-code-sdk.ts`. Add a short "Clarified 2026-10-07" note to the RFC-0048 section: `never` is a configurable value, not a project rule. Do not touch `backlog/completed/*` or CHANGELOG history. (AGENTS.md and the `.claude/memory/*` notes are untracked local files in the dogfood checkout, not in git; the planner corrects those by hand.)

4. **CLI and release path.** `pipeline-cli/src/governance/merge-if-eligible.ts` and `release-merge.ts` already read the resolved policy; keep their behaviour. Reword the refusal under `never` from "refusing all agent-initiated merges (strict default requires a human to click merge ...)" to "this repository's governance.allowMerge is never; set onGreenClean in .ai-sdlc/agent-role.yaml to permit agent merges", so the message names the configuration, not a rule.

5. **Tests.** Update the tests that pin the old wording: `ai-sdlc-plugin/hooks/lib/governance-resolver.test.mjs`, `subagent-start.test.mjs`, `session-start.test.mjs`, `scripts/render-governance-hard-rules.test.mjs`, `pipeline-cli/src/cli/merge-if-eligible.test.ts`, `pipeline-cli/src/governance/merge-if-eligible.test.ts`, `release-merge.test.ts`, `commands/rebase.test.mjs`, `commands/resolve-conflicts.test.mjs`, `agents/rebase-resolver.test.mjs`. Add a test that the rendered hard rule under `onGreenClean` contains the helper command and no humans-only sentence, and that under `never` it names the key. Add a grep-style test (or extend `render-governance-hard-rules.test.mjs`) asserting no plugin command or agent body contains "only humans merge".

6. **Verification in the dogfood repo.** After the PR lands, `node pipeline-cli/bin/cli-merge-if-eligible.mjs <open filing PR> --source-kind backlog --dry-run` from the main checkout reports eligible on a green + CLEAN PR authored by deefactorial, and `--arm` arms it. Record the command and its output in the PR body.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `.ai-sdlc/agent-role.yaml` carries `allowMerge: onGreenClean` and `mergeAuthors: [deefactorial]`; the schema still offers `never | onGreenClean` and its default is unchanged.
- [ ] `cli-merge-if-eligible <pr> --source-kind backlog --dry-run` on a green + CLEAN same-repo PR authored by a `mergeAuthors` login reports eligible in this repo; under `allowMerge: never` the refusal names the key and the file, not a human-merge rule.
- [ ] Session-start and subagent-start hard rules are rendered from the resolved policy: helper path under `onGreenClean`, configuration-forbids wording under `never`, raw command blocked in both; no "only humans merge" sentence under either value.
- [ ] `grep -rn "only humans merge\|human to merge\|human to click merge"` returns nothing outside `backlog/completed`, CHANGELOGs and the RFC-0048 note; a test guards the plugin command and agent bodies against it coming back.
- [ ] CLAUDE.md, README.md, the governance reference and every plugin command and agent body named above defer to `governance.allowMerge`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.
