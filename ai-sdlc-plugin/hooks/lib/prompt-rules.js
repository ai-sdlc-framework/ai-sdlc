/**
 * Single source for the "never do X" rules that agent and command prompts carry
 * (AISDLC-651.2).
 *
 * Why one source: the same rule used to be pasted, in slightly different words,
 * into every agent and command prompt (and escalated in some). Every copy is
 * re-read on every turn and the copies drift. Each rule here is ONE line that
 * names the sanctioned alternative and says whether a hook enforces it. A prompt
 * opts in by carrying a generated block:
 *
 *   <!-- prompt-rules:begin ids=merge,force-push -->
 *   - ...
 *   <!-- prompt-rules:end -->
 *
 * `ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` rewrites the block;
 * `ai-sdlc-plugin/commands/prompt-rules.test.mjs` fails when a block drifts from
 * this file or when a rule appears more than once in a prompt.
 *
 * Policy-configurable rules (merge, force-push, close, delete) name the config key
 * instead of restating the resolved policy: the SessionStart / SubagentStart hooks
 * render the resolved policy for the live session (governance-resolver.js).
 */

/**
 * @typedef {{ id: string, text: string, detect: RegExp }} PromptRule
 * `detect` matches a restatement of the rule anywhere in a prompt; the block line
 * for the rule must match it exactly once and nothing else in the file may.
 */

/** @type {PromptRule[]} */
const PROMPT_RULES = [
  {
    id: 'merge',
    text: '**Merge:** only via `cli-merge-if-eligible` when `governance.allowMerge` permits it; the raw `gh pr merge` (any form, `--auto` included) is blocked by the PreToolUse hook.',
    detect: /gh pr merge/g,
  },
  {
    id: 'force-push',
    text: '**Force-push:** only `git push --force-with-lease origin HEAD:refs/heads/<your-branch>` to your own task branch after a rebase; plain `git push --force`/`-f` and any push to `main`/`master` are blocked by the PreToolUse hook.',
    detect: /git push --force(?!-with-lease)/g,
  },
  {
    id: 'close',
    text: '**Close:** never close PRs or issues (`gh pr close`, `gh issue close`); report in `notes` instead (hook-enforced unless repo policy grants it).',
    detect: /gh pr close/g,
  },
  {
    id: 'branch-delete',
    text: '**Delete branches:** never (`git branch -D`/`-d`); leave cleanup to `/ai-sdlc cleanup` (hook-enforced unless repo policy grants it).',
    detect: /git branch -D/g,
  },
  {
    id: 'destructive-git',
    text: '**Destructive git:** never `git reset --hard`, `git checkout -- .` or `git restore .`; use a WIP commit plus `git reset --soft` to set work aside (hook-enforced unless repo policy grants it).',
    detect: /git reset --hard/g,
  },
  {
    id: 'stash',
    text: '**Stash:** never `git stash pop`, `git stash clear` or a bare `git stash drop`; the stack is shared across worktrees, so prefer a WIP commit, or `git stash push -u -m <tag>` then `git stash apply <ref>` (pop, clear and bare drop are hook-blocked).',
    detect: /git stash pop/g,
  },
  {
    id: 'ci-skip',
    text: '**CI-skip markers:** never write `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]` in a commit message (backticks do not help); write the paren form `(skip ci marker)`; `check-skip-ci-marker.sh` blocks the push.',
    detect: /\[skip ci\]/g,
  },
  {
    id: 'governance-config',
    text: '**Governance config:** edit `.ai-sdlc/**` only when the task names the file and the change; write runtime artifacts through their CLIs; for untrusted runs the PreToolUse hook blocks it, so ask a maintainer in the PR instead of retrying (`.github/workflows/**` is blocked only when `blockedPaths` lists it).',
    detect: /\.ai-sdlc\/\*\*/g,
  },
  {
    id: 'oq-resolution',
    text: '**RFC Open Questions:** never add a `**Resolution:**` marker (AISDLC-298); on a blocking OQ run `cli-decisions escalate` (scope `rfc:RFC-XXXX`), return `prUrl: null` with the RFC, OQ and options in `notes`; a non-blocking OQ gets a PR-body assumption only.',
    detect: /\*\*Resolution:\*\*/g,
  },
  {
    id: 'pre-work',
    text: '**Pre-work flags:** when the task says "Pre-work required", "Pre-conditions:" or "operator walkthrough needed", STOP and return `prUrl: null` naming the unmet precondition; never self-authorize scope expansion (AISDLC-308).',
    detect: /Pre-work required/gi,
  },
];

const BEGIN_RE = /<!-- prompt-rules:begin ids=([a-z0-9,-]+) -->/;
const END = '<!-- prompt-rules:end -->';

/** @param {string} id @returns {PromptRule} */
function getRule(id) {
  const rule = PROMPT_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`unknown prompt rule id: ${id}`);
  return rule;
}

/**
 * Renders the generated block (markers included) for the given rule ids, in the
 * given order.
 * @param {string[]} ids
 */
function renderPromptRulesBlock(ids) {
  const lines = ids.map((id) => `- ${getRule(id).text}`);
  return [`<!-- prompt-rules:begin ids=${ids.join(',')} -->`, ...lines, END].join('\n');
}

/**
 * Finds the generated block in a prompt file.
 * @param {string} content
 * @returns {{ ids: string[], start: number, end: number, block: string } | null}
 */
function findPromptRulesBlock(content) {
  const m = BEGIN_RE.exec(content);
  if (!m) return null;
  const endIdx = content.indexOf(END, m.index);
  if (endIdx === -1) return null;
  const end = endIdx + END.length;
  return {
    ids: m[1].split(','),
    start: m.index,
    end,
    block: content.slice(m.index, end),
  };
}

/**
 * Returns `content` with its generated block regenerated from the source.
 * @param {string} content
 */
function syncPromptRules(content) {
  const found = findPromptRulesBlock(content);
  if (!found) return content;
  return (
    content.slice(0, found.start) + renderPromptRulesBlock(found.ids) + content.slice(found.end)
  );
}

/**
 * Counts how many times each rule is restated in a prompt.
 * @param {string} content
 * @returns {Record<string, number>}
 */
function countRuleRestatements(content) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const rule of PROMPT_RULES) {
    counts[rule.id] = (content.match(rule.detect) || []).length;
  }
  return counts;
}

module.exports = {
  PROMPT_RULES,
  getRule,
  renderPromptRulesBlock,
  findPromptRulesBlock,
  syncPromptRules,
  countRuleRestatements,
};
