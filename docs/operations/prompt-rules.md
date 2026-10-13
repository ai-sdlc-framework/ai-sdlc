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

## Session hooks

`session-start.js` and `subagent-start.js` render the RESOLVED policy (`governance-resolver.js`) in a compact form, one line per rule; the explanatory prose lives in [agent-governance-reference.md](./agent-governance-reference.md). The prompt rules above name the config key instead of restating the resolved policy.

## Measurement

Before/after prefix sizes: [prefix-diet-measurements.md](./prefix-diet-measurements.md).
