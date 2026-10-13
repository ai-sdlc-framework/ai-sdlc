# Governance rule admission test and audit (AISDLC-711)

Every governance rule must justify its necessity and its velocity effect (DEC-0048), and none may leave work blocked on a human. Two tests enforce that for the plugin hooks.

## Admission test

`ai-sdlc-plugin/hooks/governance-happy-path.test.mjs` runs the documented agent workflow through `enforce-blocked-actions.js`, `enforce-role-tools.js` and `permission-check.js` with default configuration in a fresh fixture repository, and asserts nothing is denied. The command set lives in ONE file, `ai-sdlc-plugin/hooks/governance-workflow-commands.json`. To cover a new workflow step, add an entry there. A new rule that denies any entry fails CI.

An entry may carry `skipPermissionCheck` with a reason when the PermissionRequest hook is not the authority for that command; see the audit row for lease push.

## Refusal-message test

`ai-sdlc-plugin/hooks/governance-refusal-messages.test.mjs` asserts that every refusal names the rule, names the config key and value or sanctioned command that resolves it, and never tells the agent to ask a person. It scans every `deny(` call site statically and triggers each denial for real. When you add a deny, give its message a `Next step:` with a command the agent can run (usually `node pipeline-cli/bin/cli-decisions.mjs escalate ...`) or a config key.

## Audit

| Rule | Blocks on a human? | Result and fix |
|---|---|---|
| Force-push default (AISDLC-663, default now `leaseOnOwnBranch`, AISDLC-710) | No by default. An explicit `never` told the agent to ask the operator. | Message now gives a plain push, the `cli-decisions escalate` command and the key `spec.governance.allowForcePush`. Control unchanged. |
| Merge governance (raw merge, API merge, merge policy root) | No. The sanctioned command is named. | Policy-root refusal had no way forward; now names `spec.governance.allowMerge` and the escalate command. Control unchanged. |
| `blockedActions` match | Partly: gave only the pattern. | Message names the key and the escalate command. Control unchanged. |
| `blockedPaths` match | Yes: "out of scope for agent edits" with no next step. | Message names the key and the escalate command. Control unchanged. |
| Outside-worktree write | No for the no-allowlist case; the allowlist-present case had no next step. | Both cases name `permittedExternalPaths`. Control unchanged. |
| Untrusted-run protected paths and fail-closed (AISDLC-720) | Yes: "ask a maintainer". | Messages name the rule and a self-serve step (describe the change in the PR, or `cli-decisions escalate`). Control unchanged: untrusted runs stay blocked. |
| Stash governance (AISDLC-611) | No. Safe pattern is named. | None. |
| Role tool rules (executor) | No. Each refusal names the rule, a next step and the dispatch session. | None. |
| Workflow-path edits | No by default: `.github/workflows/**` is only refused when `blockedPaths` lists it. | The happy-path test covers a workflow edit. |
| PermissionRequest hook (`permission-check.js`) | Its `git push --force*` glob also matches a lease push; the message had no resolver. | Message now has a resolver. The hook still lacks lease policy, so the happy path skips it for the lease push entry. Loosening it would change a control, so it is left as a follow-up for the planner. |
| Merge phrase anywhere in command text (AISDLC-602) | Yes for greps and docs that quote the phrase. | Not changed: relaxing the matcher weakens a control (decision needed). Write such text with a file tool, or describe it in words. |
