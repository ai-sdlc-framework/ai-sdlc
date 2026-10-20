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
    text: '**Force-push:** only `git push --force-with-lease origin HEAD:refs/heads/<your-branch>` to your own task branch after a rebase (from the parent cwd, prefix `git -C <main>/.worktrees/<task-id>`); plain `git push --force`/`-f` and any push to `main`/`master` are blocked by the PreToolUse hook.',
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
  {
    id: 'executor-no-question',
    text: '**Executor questions:** no channel reaches an executor, so never wait on a question; when a step cannot proceed, write the exact refusal and the options into the verdict notes, report `failed` or `iterate-needed`, release nothing by force and stop; the dispatch tick routes it, and a class (c) question goes through `cli-decisions escalate`.',
    detect: /never wait on a question/g,
  },
  {
    id: 'hold-reporting',
    text: '**A hold limits actions, never reporting:** the planner pauses the drain with `cli-hierarchy hold --reason <text>` (never a prose "stay idle"), which blocks claims and relaunches only; every blocker, verdict and merge sha still goes to the parent tier by `SendMessage` as it happens, and pane text is not a report.',
    detect: /hold limits actions/g,
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

// ── Standing decision rules (AISDLC-873) ─────────────────────────────────────

const STANDING_BEGIN = '<!-- standing-rules:begin -->';
const STANDING_END = '<!-- standing-rules:end -->';

/**
 * Projects the catalog events to the standing rules that may render: a decision
 * whose `decision-opened` event carries a one-line `standingRule`, that has an
 * `operator-answered` event, and that is not superseded, archived or overridden.
 * A rule tagged as a weakening governance change never renders (a standing rule
 * can narrow what a session does, never loosen a control). Pure and
 * deterministic; sorted by decision id. Calls no model.
 * @param {Array<Record<string, any>>} events
 * @returns {Array<{ decisionId: string, rule: string }>}
 */
function projectStandingRules(events) {
  /** @type {Map<string, { rule?: string, weakening: boolean, answered: boolean, dead: boolean }>} */
  const byId = new Map();
  for (const e of events) {
    if (!e || typeof e.decisionId !== 'string') continue;
    const cur = byId.get(e.decisionId) || { weakening: false, answered: false, dead: false };
    if (e.type === 'decision-opened') {
      const rule = typeof e.standingRule === 'string' ? e.standingRule.trim() : '';
      cur.rule = rule && !/[\r\n\u2028\u2029]/.test(rule) ? rule : undefined;
      cur.weakening = e.governanceChange?.kind === 'weakening';
    } else if (e.type === 'operator-answered') {
      cur.answered = true;
    } else if (e.type === 'superseded' || e.type === 'archived' || e.type === 'overridden') {
      cur.dead = true;
    }
    byId.set(e.decisionId, cur);
  }
  return [...byId.entries()]
    .filter(([, d]) => d.rule && d.answered && !d.dead && !d.weakening)
    .map(([decisionId, d]) => ({ decisionId, rule: /** @type {string} */ (d.rule) }))
    .sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));
}

/**
 * Reads the checked-in decision events (`<root>/.ai-sdlc/_decisions/events/*.json`),
 * in file-name order. Returns [] when the catalog is absent.
 * @param {string} root repository root
 * @returns {Array<Record<string, any>>}
 */
function loadCatalogEvents(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(root, '.ai-sdlc', '_decisions', 'events');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

/**
 * Renders the standing-rules block (markers included): one line per rule.
 * @param {Array<Record<string, any>>} events
 */
function renderStandingRulesBlock(events) {
  const lines = projectStandingRules(events).map(
    (r) => `- **Standing (${r.decisionId}):** ${r.rule}`,
  );
  // No rules: one line, so an empty block costs a prompt a single line.
  if (lines.length === 0) return STANDING_BEGIN + STANDING_END;
  return [STANDING_BEGIN, ...lines, STANDING_END].join('\n');
}

/**
 * Regenerates the standing-rules block in `content`; unchanged when it has none.
 * @param {string} content
 * @param {Array<Record<string, any>>} events
 */
function syncStandingRules(content, events) {
  const start = content.indexOf(STANDING_BEGIN);
  if (start === -1) return content;
  const endIdx = content.indexOf(STANDING_END, start);
  if (endIdx === -1) return content;
  return (
    content.slice(0, start) +
    renderStandingRulesBlock(events) +
    content.slice(endIdx + STANDING_END.length)
  );
}

module.exports = {
  PROMPT_RULES,
  projectStandingRules,
  loadCatalogEvents,
  renderStandingRulesBlock,
  syncStandingRules,
  getRule,
  renderPromptRulesBlock,
  findPromptRulesBlock,
  syncPromptRules,
  countRuleRestatements,
};
