/**
 * Developer run turn budget (AISDLC-651.3, RFC-0050 follow-up).
 *
 * Pure helpers for the PostToolUse telemetry hook: resolve the budget from the
 * BASE REF's `.ai-sdlc/review-config.yaml` (never the worktree copy, so a task
 * branch cannot raise its own budget), count tool calls per developer subagent
 * and build the warning / stop notices.
 *
 * Config shape (all fields optional):
 *
 *   developer:
 *     turnBudget:
 *       budget: 120   # tool calls per run
 *       warnAt: 80    # percent of the budget
 */

'use strict';

const { execFileSync } = require('child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const DEFAULT_BUDGET = 120;
const DEFAULT_WARN_AT = 80;

function isDeveloperAgent(agentType) {
  if (typeof agentType !== 'string') return false;
  const t = agentType.trim().toLowerCase();
  return t === 'developer' || t === 'ai-sdlc:developer';
}

/** Read the config as committed on `baseRef`; null when unavailable. */
function readBaseRefConfig(cwd, baseRef = 'origin/main') {
  try {
    return execFileSync('git', ['show', `${baseRef}:.ai-sdlc/review-config.yaml`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch {
    return null;
  }
}

function positiveInt(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse `developer.turnBudget` out of the YAML text; defaults for anything absent or invalid. */
function parseTurnBudget(yaml) {
  const out = { budget: DEFAULT_BUDGET, warnAt: DEFAULT_WARN_AT };
  if (typeof yaml !== 'string') return out;
  const lines = yaml.split('\n');
  let inDeveloper = false;
  let inBudget = false;
  for (const line of lines) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent === 0) {
      inDeveloper = /^developer:\s*(#.*)?$/.test(line);
      inBudget = false;
      continue;
    }
    if (!inDeveloper) continue;
    if (/^\s+turnBudget:\s*(#.*)?$/.test(line)) {
      inBudget = true;
      continue;
    }
    if (!inBudget) continue;
    const m = line.match(/^\s+(budget|warnAt):\s*['"]?(\d+)['"]?\s*(#.*)?$/);
    if (!m) continue;
    const n = positiveInt(m[2]);
    if (n === null) continue;
    if (m[1] === 'budget') out.budget = n;
    else if (n <= 100) out.warnAt = n;
  }
  return out;
}

function resolveTurnBudget(cwd, baseRef) {
  return parseTurnBudget(readBaseRefConfig(cwd, baseRef));
}

/** Notice for the Nth call of a run, or null. Warning fires once, the stop notice on every call at or past the budget. */
function turnNotice(count, { budget, warnAt }) {
  const warnCount = Math.min(budget, Math.ceil((budget * warnAt) / 100));
  if (count >= budget) {
    return (
      `TURN BUDGET REACHED: ${count} of ${budget} tool calls used. STOP now: commit your work in ` +
      `progress on the task branch and return prUrl: null with notes.parked: true, what was done, ` +
      `what remains and why it took this many turns.`
    );
  }
  if (count === warnCount) {
    return (
      `Turn budget warning: ${count} of ${budget} tool calls used (${warnAt}%). Converge now, ` +
      `or prepare to park the task (commit WIP, return notes.parked: true) at the budget.`
    );
  }
  return null;
}

/** Increment and return the per-agent call count. State lives next to the usage records. */
function bumpCount(stateDir, agentId) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `${String(agentId).replace(/[^A-Za-z0-9._-]/g, '_')}.count`);
  let count = 0;
  if (existsSync(file)) count = Number.parseInt(readFileSync(file, 'utf8'), 10) || 0;
  count += 1;
  writeFileSync(file, String(count), 'utf8');
  return count;
}

/** Append one usage record: turns used so far by this agent run. */
function recordTurns(usageDir, record) {
  mkdirSync(usageDir, { recursive: true });
  appendFileSync(join(usageDir, 'developer-turns.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

/** Task id from the worktree sentinel or env; null when unknown. */
function resolveTaskId(cwd, env) {
  if (env.AI_SDLC_ACTIVE_TASK_ID) return env.AI_SDLC_ACTIVE_TASK_ID;
  try {
    const t = readFileSync(join(cwd, '.active-task'), 'utf8').trim();
    return t.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_WARN_AT,
  isDeveloperAgent,
  parseTurnBudget,
  readBaseRefConfig,
  resolveTurnBudget,
  turnNotice,
  bumpCount,
  recordTurns,
  resolveTaskId,
};
