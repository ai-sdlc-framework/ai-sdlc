# Prompt rules: one source, one line per prompt

AISDLC-651.2. "Never do X" rules used to be pasted (and sometimes escalated in louder words) into every agent and command prompt. Each prompt is re-read on every turn, so each copy costs tokens on every turn and the copies drift.

## The contract

- The rules live in ONE file: `ai-sdlc-plugin/hooks/lib/prompt-rules.js` (`PROMPT_RULES`).
- Each rule is a single line that names the sanctioned alternative and says whether a hook enforces it.
- A prompt opts in by carrying a generated block:

  ```
  <!-- prompt-rules:begin ids=merge,force-push -->
  ...generated lines...
  <!-- prompt-rules:end -->
  ```

- Regenerate with `node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` (`--check` exits 1 on drift). Never edit text inside the markers by hand.
- Do not restate a rule in prose elsewhere in the same prompt. Role-specific carve-outs (for example "`git rebase --abort` is allowed") are fine as long as they do not repeat the rule's trigger text.
- `ai-sdlc-plugin/commands/prompt-rules.test.mjs` fails when a block drifts from the source, when a rule is restated more than once in a prompt, and when a guarded prompt loses its block.

## Adding or changing a rule

1. Edit `PROMPT_RULES` (keep it to one line; name the alternative; say when a hook enforces it; give it a `detect` pattern that matches its trigger text).
2. Run the sync script, then `node --test ai-sdlc-plugin/commands/prompt-rules.test.mjs`.
3. Add the id to the `ids=` list of each prompt that needs it.

## Rule ids

`merge`, `force-push`, `close`, `branch-delete`, `destructive-git`, `stash`, `ci-skip`, `governance-config`, `oq-resolution`, `pre-work`, `worktree-cwd`, `executor-no-question`, `hold-reporting`, and `waived-tests` (AISDLC-1022: a waived or skipped `pnpm test` on a change under `pipeline-cli/src`, `orchestrator/src` or `ai-sdlc-plugin/hooks` is a critical finding; `check-pr-governance.mjs` `waived-tests` fails the governance-gate when the completed task file records the suite as waived or skipped).

## Session hooks

`session-start.js` and `subagent-start.js` render the RESOLVED policy (`governance-resolver.js`) in a compact form, one line per rule; the explanatory prose lives in [agent-governance-reference.md](./agent-governance-reference.md). The prompt rules above name the config key instead of restating the resolved policy.

## Measurement

Before/after prefix sizes: [prefix-diet-measurements.md](./prefix-diet-measurements.md).

## Standing decision rules (AISDLC-873)

A decision can become a standing rule that the dispatch and executor prompts carry, without hand-editing either prompt.

- **The marker.** Open the decision with `cli-decisions add ... --standing-rule "<one line>"` (event field and spec field `standingRule`, single line). The rule is a separate sentence from the decision body, so it states the behaviour, not the history.
- **When it renders.** `projectStandingRules` in `ai-sdlc-plugin/hooks/lib/prompt-rules.js` renders exactly one line, `- **Standing rule:** <rule>`, for a decision that carries `standingRule` (the decision id orders the lines but is not printed: adopter-visible command text carries no internal ids), has an `operator-answered` event, and is not superseded, archived or overridden. The catalog read is the checked-in tree (`.ai-sdlc/_decisions/events/`), so a record that is not yet on `main` renders nothing. Unanswered and non-standing decisions render nothing.
- **Where.** The generated `<!-- standing-rules:begin -->...<!-- standing-rules:end -->` block in `commands/operator-dispatch.md` and `commands/executor.md`. Regenerate with `node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` (`--check` exits 1 on drift; `prompt-rules.test.mjs` fails on drift). Output is sorted by decision id, byte-identical for the same catalog, and calls no model. With no rules the block is a single line.
- **Authority limit.** A standing rule narrows what a session does; it never loosens a control. A decision tagged `--governance-change weakening` never renders, and a rule can only be authorized by the same record authority as the decision itself (a planner-authored record on `main` for classes (a) and (b); class (c) stays operator-only; see [decision-authority.md](./decision-authority.md)). Hard rules still live in `PROMPT_RULES`, not in the catalog.

### First three standing rules

The first three records to carry `--standing-rule` are the planner's to author, from rulings the operator has already given and the memory notes record:

1. Lease pushes on a session's own task branch are always authorized; never ask.
2. Executors run one task per context and are cleared once they report done.
3. Dispatch reports every blocker, brief and verdict to the planner, even under a hold.

Until each record is answered on `main`, the blocks stay empty.

## Enforcement is server-side (AISDLC-1014, DEC-0267)

The PreToolUse hook `enforce-blocked-actions.js` no longer matches command text. A rule line for merge, close, branch-delete, destructive-git or stash is instruction only. What holds the outcome is GitHub branch protection on `main` (no direct push, no force push, required `ai-sdlc/pr-ready`), the pr-ready rollup, and `cli-merge-if-eligible`. The hook keeps two checks that are not text matches: the `blockedPaths` refusal for untrusted runs and the lease-push guard (`lib/lease-push-guard.js`). A rule line may say "hook" only for those two.
