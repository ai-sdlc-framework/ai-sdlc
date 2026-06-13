---
id: AISDLC-535
title: >-
  fix(security): resolve CodeQL source-code findings — ReDoS, incomplete
  sanitization, second-order command injection, clear-text logging
status: Done
assignee: []
labels:
  - security
  - bug
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - orchestrator/src/execute.ts
  - pipeline-cli/src/import-spec/parser.ts
  - reference/src/adapters/backlog-md/index.ts
  - pipeline-cli/src/steps/11-late-rebase.ts
  - orchestrator/src/runners/review-agent.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub code-scanning (CodeQL) has a cluster of open **source-code** security findings
(distinct from the workflow-hardening + dependabot findings, which are tracked separately).
These are real, fixable defects in our own TypeScript. Resolve them and add regression
coverage where feasible.

**1. Second-order command injection (HIGH, alert #167) — `orchestrator/src/execute.ts:774`.**
`git fetch origin <branchName>` where `branchName = interpolateBranchPattern(pattern, vars)`.
The default template (`ai-sdlc/issue-{issueNumber}`) and the `slug` var are safe, but `vars`
also exposes **raw `{issueTitle}`** (and `{issueId}`). A repo whose config branching pattern
interpolates `{issueTitle}`, plus an issue title like `--upload-pack=<cmd>`, would inject a
git option (`git fetch origin --upload-pack=...` runs an arbitrary command). Latent under the
default config but a real footgun for custom patterns / untrusted issue authors. **Fix:**
validate the computed `branchName` against a safe ref charset and reject a leading `-` before
ANY `git` invocation (defense-in-depth — kills the alert regardless of config). Audit sibling
`git fetch`/`git checkout <branchName>` call sites in execute.ts for the same pattern.

**2. Polynomial ReDoS (`js/polynomial-redos`, HIGH).** Regexes with super-linear backtracking
on attacker-influenced input at:
- `pipeline-cli/src/import-spec/parser.ts`
- `reference/src/adapters/backlog-md/index.ts`
- `pipeline-cli/src/steps/11-late-rebase.ts`
- `orchestrator/src/runners/review-agent.ts`
Fix: bound the quantifiers / rewrite the offending patterns to linear-time (anchor, use
possessive/atomic equivalents, or a non-regex parse) without changing matched semantics.

**3. Incomplete / incomplete-multi-character sanitization (`js/incomplete-sanitization`, HIGH).**
Several `.replace()` calls that sanitize once where the pattern can re-introduce the bad
substring (e.g. `replace(/x/, '')` instead of `/x/g`, or order-dependent stripping):
`orchestrator/src/cli/commands/init-features.ts`, `orchestrator/src/analysis/file-walker.ts`,
`pipeline-cli/src/deps/dependency-graph.ts`, `orchestrator/src/cycle-utils.ts`. Fix each to be
idempotent / global as appropriate.

**4. Clear-text logging of sensitive data (`js/clear-text-logging`, HIGH).**
`orchestrator/src/cli/commands/run.ts`, `dogfood/src/cli.ts`, `dogfood/src/cli-triage.ts` log
values CodeQL traces from a sensitive source. Confirm whether the logged value is actually
sensitive (token/key/credential) — if so redact; if it's a confirmed false-positive (e.g. a
public ref), dismiss the specific alert with a documented reason rather than code change.

Work through the open CodeQL alerts list (`gh api repos/<org>/<repo>/code-scanning/alerts`)
for the exact current line numbers — they drift as files change. For any finding that is a
genuine false-positive, dismiss it via the code-scanning API with a documented reason instead
of contorting the code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 execute.ts validates the computed branch name (safe ref charset, no leading `-`) before any git invocation; alert #167 (second-order command injection) resolved; sibling git call sites audited
- [ ] #2 All `js/polynomial-redos` findings (parser.ts, backlog-md/index.ts, 11-late-rebase.ts, review-agent.ts) fixed to linear-time regexes (or non-regex parse) with matched semantics preserved
- [ ] #3 All `js/incomplete-sanitization` / `incomplete-multi-character-sanitization` findings fixed to be idempotent/global; verified against the source pattern
- [ ] #4 `js/clear-text-logging` findings either redacted (if genuinely sensitive) or dismissed-with-reason (if confirmed false-positive)
- [ ] #5 Regression tests added where practical (esp. ReDoS bounds + branch-name validation); `pnpm build && pnpm test && pnpm lint` clean
- [ ] #6 Post-change CodeQL re-scan shows the targeted source-code alerts closed (workflow-hardening + dependabot alerts are out of scope — see AISDLC-536 and the bump tasks)
<!-- AC:END -->
