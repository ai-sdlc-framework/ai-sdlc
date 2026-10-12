/**
 * Per-role context and turn budgets for the Stop-hook notice (AISDLC-651.4).
 *
 * A main session re-reads its whole context on every turn, so a session that
 * outlives its unit of work gets expensive. This module reads the tail of the
 * session's own transcript, works out the size of the last call's context and
 * the number of model calls since the last `/clear`, and compares both with the
 * budget of the session's role.
 *
 * LOCKSTEP: `DEFAULT_ROLE_BUDGETS` and the config precedence mirror
 * `pipeline-cli/src/usage/usage-config.ts` (`DEFAULT_ROLE_BUDGETS`,
 * `loadUsageConfig`); `pipeline-cli/src/usage/context-budget-lockstep.test.ts`
 * loads both and asserts they agree. The transcript markers (`SessionStart:clear`
 * hook attachment, `custom-title` / `agent-name` entries) are read the same way
 * by `pipeline-cli/src/usage/transcript-inspect.ts`.
 *
 * The transcript is untrusted input and is only parsed, never executed. Every
 * function here is bounded and never throws to its caller's caller: the Stop
 * hook must never delay or fail a session.
 */

'use strict';

const { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } = require('fs');
const { execFileSync } = require('child_process');
const { homedir } = require('os');
const { join } = require('path');

const DEFAULT_ROLE_BUDGETS = {
  planner: { contextBudgetTokens: 150000, turnBudget: 300 },
  'operator-dispatch': { contextBudgetTokens: 100000, turnBudget: 200 },
  executor: { contextBudgetTokens: 120000, turnBudget: 150 },
};

const ROLES = Object.keys(DEFAULT_ROLE_BUDGETS);
const MACHINE_CONFIG_FILE = 'usage-config.yaml';
const BASE_CONFIG_PATH = '.ai-sdlc/usage-config.yaml';
/** Only this much of the transcript's end is read; turns beyond it are not counted. */
const TAIL_BYTES = 8 * 1024 * 1024;
const CLEAR_HOOK_NAME = 'SessionStart:clear';

function cloneDefaults() {
  const out = {};
  for (const role of ROLES) out[role] = { ...DEFAULT_ROLE_BUDGETS[role] };
  return out;
}

/**
 * The hierarchy role a session name denotes: the name is the role, or starts
 * with the role followed by a separator (`executor-aisdlc-12`). Otherwise null.
 */
function roleFromName(name) {
  if (typeof name !== 'string') return null;
  const lower = name.trim().toLowerCase();
  for (const role of ROLES) {
    if (lower === role || lower.startsWith(`${role}-`) || lower.startsWith(`${role}.`)) return role;
  }
  return null;
}

/**
 * Role budgets from the `spec.roles` block of a usage-config document, applied
 * over the defaults. A deliberately small indentation parser: the hook is a
 * standalone script with no YAML dependency. Unknown roles, non-integer and
 * non-positive values are ignored.
 */
function parseRoleBudgets(yamlText) {
  const budgets = cloneDefaults();
  if (typeof yamlText !== 'string') return budgets;
  let rolesIndent = -1;
  let role = null;
  let roleIndent = -1;
  for (const raw of yamlText.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (rolesIndent < 0) {
      if (text === 'roles:' && indent > 0) rolesIndent = indent;
      continue;
    }
    if (indent <= rolesIndent) {
      rolesIndent = text === 'roles:' && indent > 0 ? indent : -1;
      role = null;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(text);
    if (!m) continue;
    if (m[2] === '') {
      role = ROLES.includes(m[1]) ? m[1] : null;
      roleIndent = indent;
      continue;
    }
    if (!role || indent <= roleIndent) continue;
    if (m[1] !== 'contextBudgetTokens' && m[1] !== 'turnBudget') continue;
    if (!/^\d+$/.test(m[2])) continue;
    const n = Number.parseInt(m[2], 10);
    if (n >= 1) budgets[role][m[1]] = n;
  }
  return budgets;
}

function usageDirOf(env) {
  return env.AI_SDLC_USAGE_DIR || join(homedir(), '.ai-sdlc', 'usage');
}

function readBaseConfig(projectDir) {
  try {
    return execFileSync('git', ['show', `origin/main:${BASE_CONFIG_PATH}`], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/**
 * Effective budgets: the machine-level usage config if present, else the base
 * ref's `.ai-sdlc/usage-config.yaml`, else the defaults. Never throws.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.projectDir] repository for the base-ref read.
 * @param {(projectDir: string) => string | null} [opts.readBase] test seam for the base-ref read.
 */
function loadRoleBudgets({ env = process.env, projectDir, readBase = readBaseConfig } = {}) {
  try {
    const machine = join(usageDirOf(env), MACHINE_CONFIG_FILE);
    if (existsSync(machine)) return parseRoleBudgets(readFileSync(machine, 'utf-8'));
  } catch {
    // fall through to the next source
  }
  try {
    if (projectDir) {
      const text = readBase(projectDir);
      if (text !== null && text !== undefined) return parseRoleBudgets(text);
    }
  } catch {
    // fall through to the defaults
  }
  return cloneDefaults();
}

/** The last `maxBytes` of a file as complete lines (a cut first line is dropped). */
function readTailLines(path, maxBytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tokenCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Walk transcript lines in order and report the last call's context size, the
 * model calls since the last `/clear` and the latest session title. Lines that
 * cannot be a usage block, a clear marker or a title are skipped without being
 * parsed, which keeps a 1,000-turn transcript fast.
 *
 * @param {Iterable<string>} lines
 * @returns {{ contextTokens: number, turnsSinceClear: number, sessionName: string | null }}
 */
function analyzeTranscriptLines(lines) {
  let contextTokens = 0;
  let sessionName = null;
  let seen = new Set();
  for (const line of lines) {
    if (!line) continue;
    const isUsage = line.includes('"usage"');
    const isClear = line.includes(CLEAR_HOOK_NAME);
    const isTitle = line.includes('"custom-title"') || line.includes('"agent-name"');
    if (!isUsage && !isClear && !isTitle) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      sessionName = entry.customTitle;
    } else if (entry.type === 'agent-name' && typeof entry.agentName === 'string') {
      sessionName = entry.agentName;
    } else if (
      entry.type === 'attachment' &&
      isRecord(entry.attachment) &&
      entry.attachment.hookName === CLEAR_HOOK_NAME
    ) {
      seen = new Set();
      contextTokens = 0;
    } else if (
      entry.type === 'assistant' &&
      entry.isSidechain !== true &&
      isRecord(entry.message)
    ) {
      const { id, model, usage } = entry.message;
      if (model === '<synthetic>' || !isRecord(usage)) continue;
      if (typeof id === 'string') seen.add(id);
      else seen.add(`line:${seen.size}`);
      contextTokens =
        tokenCount(usage.input_tokens) +
        tokenCount(usage.cache_read_input_tokens) +
        tokenCount(usage.cache_creation_input_tokens);
    }
  }
  return { contextTokens, turnsSinceClear: seen.size, sessionName };
}

const INT = (n) => n.toLocaleString('en-US');

/**
 * The one-line notice when either figure is over the role's budget, else null.
 *
 * @param {{ contextTokens: number, turnsSinceClear: number }} stats
 * @param {{ contextBudgetTokens: number, turnBudget: number }} budget
 * @param {string} role
 */
function buildNotice(stats, budget, role) {
  const overContext = stats.contextTokens > budget.contextBudgetTokens;
  const overTurns = stats.turnsSinceClear > budget.turnBudget;
  if (!overContext && !overTurns) return null;
  return (
    `Context budget exceeded for ${role}: ${INT(stats.contextTokens)} tokens of context ` +
    `(budget ${INT(budget.contextBudgetTokens)}), ${INT(stats.turnsSinceClear)} turns since clear ` +
    `(budget ${INT(budget.turnBudget)}). Finish this unit and \`/clear\`.`
  );
}

module.exports = {
  DEFAULT_ROLE_BUDGETS,
  ROLES,
  TAIL_BYTES,
  CLEAR_HOOK_NAME,
  roleFromName,
  parseRoleBudgets,
  loadRoleBudgets,
  readTailLines,
  analyzeTranscriptLines,
  buildNotice,
};
