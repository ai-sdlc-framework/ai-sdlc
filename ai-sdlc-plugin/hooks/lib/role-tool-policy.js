/**
 * Role-scoped tool rules for RFC-0051 hierarchy sessions.
 *
 * The governance section of `.ai-sdlc/agent-role.yaml` may carry, per hierarchy
 * role, a list of tool calls the role must not make:
 *
 *   governance:
 *     roles:
 *       executor:
 *         blockedTools:
 *           - tool: SendMessage
 *             match: notDispatchRecipient
 *           - tool: Bash
 *             argument: command
 *             contains: 'rm -rf'
 *             reason: 'no recursive deletes from an executor'
 *
 * One module owns the whole policy: the defaults, the parsing, the argument
 * matchers, the rule narration and the refusal text. The PreToolUse hook
 * (`enforce-role-tools.js`) ENFORCES it and the render script
 * (`scripts/render-role-tool-rules.mjs`) NARRATES it, so what a skill tells the
 * session and what the hook refuses cannot drift apart.
 *
 * Resolution (strict by default, fail closed on malformed input):
 *  - no `governance.roles` section, or no entry for the role: the role's defaults;
 *  - `blockedTools: []` (explicitly empty): no rules for the role;
 *  - a list of valid entries: exactly those entries (they replace the defaults);
 *  - anything malformed (unknown key, unknown matcher, bad value, empty list
 *    body, wrong shape): the role's defaults. Malformed input never relaxes.
 *
 * Only the executor role has defaults. Every role is matched ONLY on a positive
 * roster identification; a session whose role cannot be resolved is treated as
 * the operator by the hook and is never blocked.
 *
 * The list is read from the main checkout's copy of the policy when it can be
 * verified (a worktree or PR-tree copy cannot relax what the main checkout
 * says), and from the project directory otherwise.
 */

'use strict';

const { existsSync, readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { ROLE_SKILL } = require('./hierarchy-role');
const { verifiedMainRoot, runGit } = require('./trusted-policy');

/** Roles a roster can assign. */
const ROLES = Object.freeze(Object.keys(ROLE_SKILL));

/** Where a refused session is told to turn, per role. */
const ESCALATION_PATH = Object.freeze({
  executor:
    'ask the dispatch session: send it one status message, or raise a decision with `cli-decisions escalate` and stop',
  'operator-dispatch': 'ask the planner session or the operator',
  planner: 'ask the operator',
});

/** Argument-field names a SendMessage recipient may arrive under, in order. */
const RECIPIENT_FIELDS = Object.freeze([
  'to',
  'recipient',
  'target',
  'name',
  'agent',
  'session',
  'agentId',
]);

const TOOL_PATTERN = /^[A-Za-z0-9_.*-]{1,100}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+(?:\.\d+)*$/;
const SUB_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+(?:\.\d+)+$/;
const DECISION_MUTATIONS = new Set(['answer', 'resolve', 'override']);
const RULE_KEYS = new Set(['tool', 'match', 'argument', 'contains', 'reason']);

// ── Command text handling ────────────────────────────────────────────

/**
 * Normalizes a shell command for DETECTION only (never alters what runs):
 * `$IFS` becomes whitespace, every other `$VAR` / `${VAR}` collapses to nothing
 * (an unset variable concatenates its neighbours), quotes, backslashes and stray
 * `$` are dropped, command-substitution and subshell delimiters become
 * separators, and the text is lower-cased (file systems that ignore case run
 * `CLI-DECISIONS.MJS` just the same). Like every static matcher it cannot see
 * `eval`, base64 pipelines or constructed names; it is a guard against a
 * session's own mistakes and casual workarounds, not a sandbox.
 */
function normalizeCommand(command) {
  let out = String(command);
  out = out.replace(/\\\r?\n/g, '');
  out = out.replace(/\$\{IFS\}/g, ' ');
  out = out.replace(/\$\{IFS[^}A-Za-z0-9_][^}]*\}/g, ' ');
  out = out.replace(/\$IFS\b/g, ' ');
  out = out.replace(/\$\{[^}]*\}/g, '');
  out = out.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
  out = out.replace(/[`()]/g, ';');
  out = out.replace(/['"\\$]/g, '');
  return out.toLowerCase();
}

/** Splits normalized text into segments on shell control operators. */
function splitSegments(text) {
  return text
    .split(/(?:&&|\|\||;|\||&|\r?\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cheap pre-check: does this command text mention the decisions CLI at all? */
function mentionsDecisionsCli(command) {
  return typeof command === 'string' && normalizeCommand(command).includes('cli-decisions');
}

/** True for a path or bare word naming the decisions CLI (any directory, any extension). */
function isDecisionsCli(token) {
  const base = token.split('/').pop();
  return /^cli-decisions(?:\.(?:mjs|js|cjs|ts))?$/.test(base);
}

/**
 * First positional token after a CLI token, skipping options. Two models are
 * tried by the caller because the real parser's behaviour for an unknown option
 * is not worth betting on: in the "pairs" model an option swallows the next
 * token as its value (unless written `--opt=value` or the next token is itself
 * an option); in the "flags" model options stand alone.
 */
function firstPositional(tokens, from, pairs) {
  for (let i = from; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) return tok;
    if (pairs && !tok.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  return null;
}

/**
 * The decision-mutating subcommand (`answer`, `resolve`, `override`) a shell
 * command would run through the decisions CLI, or null. Handles `node
 * .../cli-decisions.mjs`, bare and path-qualified bin names, `npx` / `pnpm exec`
 * spellings, env-var prefixes, chained commands (`&&`, `||`, `;`, `|`, `&`,
 * newlines), subshells and command substitution, quoting, extra whitespace and
 * case variants. Every occurrence in every segment is checked; the subcommand is
 * the first positional token after the CLI name, so `escalate --summary "resolve
 * the conflict"` is not mistaken for `resolve`.
 *
 * Text that merely MENTIONS such a command (a commit message, a `grep`
 * pattern) is also refused; write it with a file tool or describe it in words.
 */
function decisionMutationIn(command) {
  if (typeof command !== 'string' || command === '') return null;
  const text = normalizeCommand(command);
  if (!text.includes('cli-decisions')) return null;
  for (const segment of splitSegments(text)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    for (let k = 0; k < tokens.length; k += 1) {
      if (!isDecisionsCli(tokens[k])) continue;
      for (const pairs of [true, false]) {
        const sub = firstPositional(tokens, k + 1, pairs);
        if (sub && DECISION_MUTATIONS.has(sub)) return sub;
      }
    }
  }
  return null;
}

// ── Matchers ─────────────────────────────────────────────────────────

/** First string value among the named fields of a tool input, or undefined. */
function firstString(input, fields) {
  for (const f of fields) {
    if (typeof input[f] === 'string' && input[f].trim() !== '') return input[f].trim();
  }
  return undefined;
}

/** Task ids in `inflight/` whose recorded worker is `name`, or null when unreadable. */
function ownInflightTasks(boardDir, name) {
  try {
    const dir = join(boardDir, 'inflight');
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.dispatch.json')) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, entry), 'utf-8'));
        if (m && m.workerId === name && typeof m.taskId === 'string') out.push(m.taskId);
      } catch {
        // an unreadable manifest is not this session's
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** True when `parent` is `own`, a sub-task of it, or (digits only) names the same number. */
function isUnderOwnTask(parent, own) {
  const p = parent.toUpperCase();
  const o = own.toUpperCase();
  if (p === o || p.startsWith(`${o}.`)) return true;
  if (/^\d+(?:\.\d+)*$/.test(p)) {
    const num = o.replace(/^.*-(?=\d)/, '');
    return p === num || p.startsWith(`${num}.`);
  }
  return false;
}

/**
 * Matchers a rule can name with `match:`. Each has:
 *  - `text`: the narration (what the rule forbids, in the session's voice);
 *  - `quick(input)`: a cheap, context-free test that may rule a call out before
 *    any session lookup (false means the rule can never match this input);
 *  - `test(input, ctx)`: `null` when the call is allowed, else a short detail.
 *    `ctx` is `{ role, name, dispatchName, boardDir }`.
 */
const MATCHERS = Object.freeze({
  notDispatchRecipient: Object.freeze({
    text:
      'Never message anyone but the dispatch session named in the roster. ' +
      'That message carries status only.',
    quick: () => true,
    test(input, ctx) {
      const recipient = firstString(input, RECIPIENT_FIELDS);
      if (!recipient) return 'the recipient could not be determined';
      if (!ctx.dispatchName) {
        return `the roster names no dispatch session (recipient '${recipient}')`;
      }
      return recipient === ctx.dispatchName
        ? null
        : `the recipient is '${recipient}', not the dispatch session '${ctx.dispatchName}'`;
    },
  }),
  decisionMutation: Object.freeze({
    text:
      'Never answer, resolve or override a decision (`cli-decisions answer`, `resolve`, ' +
      '`override`). Answers belong to the dispatch session and the planner.',
    quick: (input) => mentionsDecisionsCli(input.command),
    test(input) {
      const sub = decisionMutationIn(input.command);
      return sub ? `the command runs \`cli-decisions ${sub}\`` : null;
    },
  }),
  topLevelTask: Object.freeze({
    text:
      'Never create a top-level task. File a follow-up as a sub-task of your own task ' +
      '(`<task-id>.<n>`, with `<n>` the first free number from `cli-dispatch next-subid <task-id>`).',
    quick: () => true,
    test(input, ctx) {
      const id = firstString(input, ['id']);
      const parent = firstString(input, ['parentTaskId', 'parent_task_id', 'parent']);
      let candidate;
      if (id) {
        if (!SUB_TASK_ID_PATTERN.test(id)) return `'${id}' is a top-level task id`;
        candidate = id.slice(0, id.lastIndexOf('.'));
      } else if (parent) {
        if (!TASK_ID_PATTERN.test(parent) && !/^\d+(?:\.\d+)*$/.test(parent)) {
          return `'${parent}' is not a task id`;
        }
        candidate = parent;
      } else {
        return 'the task has neither a sub-task id nor a parent task';
      }
      const own = ownInflightTasks(ctx.boardDir, ctx.name);
      // Unreadable board or no claim on record: the sub-task shape is all there is to check.
      if (!own || own.length === 0) return null;
      return own.some((t) => isUnderOwnTask(candidate, t))
        ? null
        : `'${candidate}' is not a task this session holds`;
    },
  }),
});

const MATCHER_NAMES = Object.freeze(Object.keys(MATCHERS));

// ── Defaults ─────────────────────────────────────────────────────────

function rule(fields) {
  return Object.freeze({ source: 'default', ...fields });
}

/** Strict defaults. Only the executor has any: the other roles hold wider authority. */
const DEFAULT_ROLE_BLOCKED_TOOLS = Object.freeze({
  executor: Object.freeze([
    rule({ id: 'message-non-dispatch', tool: 'SendMessage', match: 'notDispatchRecipient' }),
    rule({ id: 'decision-mutation', tool: 'Bash', match: 'decisionMutation' }),
    rule({ id: 'top-level-task', tool: 'mcp__*__task_create', match: 'topLevelTask' }),
  ]),
  'operator-dispatch': Object.freeze([]),
  planner: Object.freeze([]),
});

// ── YAML parsing (hand-rolled, like the rest of governance) ──────────

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

function isBlankOrComment(line) {
  return /^\s*(#.*)?$/.test(line);
}

/** Non-blank lines nested under `lines[i]` (deeper indent), comments dropped. */
function subBlock(lines, i) {
  const base = indentOf(lines[i]);
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (isBlankOrComment(lines[j])) continue;
    if (indentOf(lines[j]) <= base) break;
    out.push(lines[j]);
  }
  return out;
}

/** Finds `key:` at the block's own child indent; returns `{ index, value }` or null. */
function findKey(block, key) {
  if (block.length === 0) return null;
  const childIndent = indentOf(block[0]);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(.*)$`);
  for (let i = 0; i < block.length; i += 1) {
    if (indentOf(block[i]) !== childIndent) continue;
    const m = block[i].match(re);
    if (m) return { index: i, value: m[1].replace(/\s+#.*$/, '').trim() };
  }
  return null;
}

/** A scalar value: quoted (no escapes beyond `\\` and the quote) or plain. Null when malformed. */
function scalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  const q = v[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < v.length; i += 1) {
      const c = v[i];
      if (q === '"' && c === '\\' && (v[i + 1] === '"' || v[i + 1] === '\\')) {
        out += v[i + 1];
        i += 1;
      } else if (c === q) {
        if (q === "'" && v[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        const rest = v.slice(i + 1).trim();
        return rest === '' || rest.startsWith('#') ? out : null;
      } else {
        out += c;
      }
    }
    return null;
  }
  return v.replace(/\s+#.*$/, '').trim();
}

/** Parses the item lines of one `blockedTools` list into raw maps; null when malformed. */
function parseItems(lines) {
  if (lines.length === 0) return null;
  const itemIndent = indentOf(lines[0]);
  if (!/^\s*-(\s|$)/.test(lines[0])) return null;
  const items = [];
  let current = null;
  const addPair = (text) => {
    const m = text.match(/^([A-Za-z]+):(.*)$/);
    if (!m || !current) return false;
    const value = scalar(m[2]);
    if (value === null || Object.prototype.hasOwnProperty.call(current, m[1])) return false;
    current[m[1]] = value;
    return true;
  };
  for (const line of lines) {
    const ind = indentOf(line);
    if (ind === itemIndent && /^\s*-(\s|$)/.test(line)) {
      current = {};
      items.push(current);
      const rest = line.replace(/^\s*-\s*/, '');
      if (rest !== '' && !addPair(rest)) return null;
    } else if (ind > itemIndent) {
      if (!addPair(line.trim())) return null;
    } else {
      return null;
    }
  }
  return items;
}

/** Validates one raw item into a rule, or null. */
function validateItem(raw, index) {
  for (const k of Object.keys(raw)) if (!RULE_KEYS.has(k)) return null;
  if (typeof raw.tool !== 'string' || !TOOL_PATTERN.test(raw.tool)) return null;
  const out = { id: `custom-${index + 1}`, source: 'repo', tool: raw.tool };
  const hasMatch = raw.match !== undefined;
  const hasArg = raw.argument !== undefined || raw.contains !== undefined;
  if (hasMatch && hasArg) return null;
  if (hasMatch) {
    if (!MATCHER_NAMES.includes(raw.match)) return null;
    out.match = raw.match;
  }
  if (hasArg) {
    if (typeof raw.argument !== 'string' || !ARGUMENT_PATTERN.test(raw.argument)) return null;
    if (typeof raw.contains !== 'string' || raw.contains === '' || raw.contains.length > 200) {
      return null;
    }
    out.argument = raw.argument;
    out.contains = raw.contains;
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string' || raw.reason === '' || raw.reason.length > 300) return null;
    out.reason = raw.reason;
  }
  return Object.freeze(out);
}

/**
 * Per-role state read from `governance.roles.<role>.blockedTools`:
 * `{ [role]: { state: 'default' } | { state: 'empty' } | { state: 'rules', rules } }`.
 * Malformed input of any kind yields `default` for the affected role.
 */
function parseRoleToolPolicy(yamlText) {
  const result = {};
  for (const role of ROLES) result[role] = { state: 'default' };
  if (typeof yamlText !== 'string') return result;
  try {
    const lines = yamlText.split(/\r?\n/);
    const gi = lines.findIndex((l) => /^\s*governance:\s*(#.*)?$/.test(l));
    if (gi === -1) return result;
    const govBlock = subBlock(lines, gi);
    const roles = findKey(govBlock, 'roles');
    if (!roles || roles.value !== '') return result;
    const rolesBlock = subBlock(govBlock, roles.index);
    for (const role of ROLES) {
      const entry = findKey(rolesBlock, role);
      if (!entry || entry.value !== '') continue;
      const roleBlock = subBlock(rolesBlock, entry.index);
      const tools = findKey(roleBlock, 'blockedTools');
      if (!tools) continue;
      if (/^\[\s*\]$/.test(tools.value)) {
        result[role] = { state: 'empty' };
        continue;
      }
      if (tools.value !== '') continue;
      const raws = parseItems(subBlock(roleBlock, tools.index));
      if (!raws) continue;
      const rules = raws.map((r, i) => validateItem(r, i));
      if (rules.length === 0 || rules.some((r) => r === null)) continue;
      result[role] = { state: 'rules', rules };
    }
  } catch {
    for (const role of ROLES) result[role] = { state: 'default' };
  }
  return result;
}

/**
 * The resolved rules per role: `{ executor: Rule[], 'operator-dispatch': Rule[], planner: Rule[] }`.
 * @param {string | null | undefined} yamlText raw agent-role.yaml text
 */
function resolveRoleBlockedTools(yamlText) {
  const parsed = parseRoleToolPolicy(yamlText);
  const out = {};
  for (const role of ROLES) {
    const p = parsed[role];
    if (p.state === 'empty') out[role] = [];
    else if (p.state === 'rules') out[role] = [...p.rules];
    else out[role] = [...DEFAULT_ROLE_BLOCKED_TOOLS[role]];
  }
  return out;
}

/**
 * Reads the policy text: the main checkout's copy when it can be verified, else
 * the project directory's. A main checkout without the file resolves to the
 * defaults. Never throws.
 * @param {string} projectDir
 * @param {typeof runGit} [run]
 * @returns {string}
 */
function readPolicyText(projectDir, run = runGit) {
  let dir = projectDir;
  try {
    const main = verifiedMainRoot(projectDir, run);
    if (main) dir = main;
  } catch {
    // keep the project directory
  }
  try {
    return readFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
  } catch {
    return '';
  }
}

/** Resolved rules for every role from the project's policy. Never throws. */
function loadRoleBlockedTools(projectDir, run = runGit) {
  return resolveRoleBlockedTools(readPolicyText(projectDir, run));
}

// ── Evaluation ───────────────────────────────────────────────────────

function toolMatches(pattern, toolName) {
  if (typeof toolName !== 'string') return false;
  if (pattern === toolName) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(toolName);
}

/** Case-insensitive substring test over a tool-input value, raw and quote-stripped. */
function argumentContains(value, needle) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const n = needle.toLowerCase();
  return text.toLowerCase().includes(n) || normalizeCommand(text).includes(normalizeCommand(n));
}

/**
 * Cheap, context-free test: can this rule possibly match this call?
 * Used to skip the session lookup for the vast majority of tool calls.
 */
function ruleCouldMatch(r, toolName, toolInput) {
  if (!toolMatches(r.tool, toolName)) return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (r.match) return MATCHERS[r.match].quick(input);
  return true;
}

/**
 * Evaluates one rule against a call. Returns null when the call is allowed, else
 * `{ rule, detail }`. An evaluation error is a refusal: the caller has already
 * established that this session positively holds the role.
 */
function evaluateRule(r, toolName, toolInput, ctx) {
  if (!toolMatches(r.tool, toolName)) return null;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  try {
    if (r.match) {
      const detail = MATCHERS[r.match].test(input, ctx);
      return detail ? { rule: r, detail } : null;
    }
    if (r.argument !== undefined) {
      return argumentContains(input[r.argument], r.contains)
        ? { rule: r, detail: `${r.argument} contains '${r.contains}'` }
        : null;
    }
    return { rule: r, detail: `${toolName} is not available to this role` };
  } catch (err) {
    return {
      rule: r,
      detail: `the call could not be evaluated (${err instanceof Error ? err.message : 'error'})`,
    };
  }
}

/** First rule of `rules` that refuses the call, or null. */
function firstRefusal(rules, toolName, toolInput, ctx) {
  for (const r of rules) {
    const hit = evaluateRule(r, toolName, toolInput, ctx);
    if (hit) return hit;
  }
  return null;
}

/** Fresh copy of the strict defaults for every role. */
function defaultRoleBlockedTools() {
  const out = {};
  for (const role of ROLES) out[role] = [...DEFAULT_ROLE_BLOCKED_TOOLS[role]];
  return out;
}

/**
 * The refusal message for a call by a session positively holding `session.role`,
 * or null when the call is allowed.
 *
 * Fail posture once the role is known: an executor fails CLOSED. If the role's
 * rules cannot be obtained or evaluated (`getRules` throws), the strict
 * defaults are applied instead, so an error can only keep a default rule in
 * force, never relax it; and if even that cannot be evaluated, the call is
 * refused. Other roles fail open (they hold wider authority and have no
 * defaults).
 *
 * @param {{ role: string, name: string, dispatchName: string | null }} session
 * @param {(role: string) => object[]} getRules
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} boardDir
 * @returns {string | null}
 */
function decideForSession(session, getRules, toolName, toolInput, boardDir) {
  const ctx = {
    role: session.role,
    name: session.name,
    dispatchName: session.dispatchName,
    boardDir,
  };
  try {
    const hit = firstRefusal(getRules(session.role) || [], toolName, toolInput, ctx);
    return hit ? refusalMessage(session.role, hit) : null;
  } catch {
    if (session.role !== 'executor') return null;
  }
  try {
    const hit = firstRefusal(DEFAULT_ROLE_BLOCKED_TOOLS.executor, toolName, toolInput, ctx);
    return hit ? refusalMessage('executor', hit) : null;
  } catch {
    return (
      'the executor role may not make this call: its tool rules could not be evaluated. ' +
      `Do not retry it; ${escalationPath('executor')}.`
    );
  }
}

// ── Narration ────────────────────────────────────────────────────────

/** The sentence a rule is narrated and refused with. */
function describeRule(r) {
  if (r.match) return MATCHERS[r.match].text;
  if (r.reason) return r.reason;
  if (r.argument !== undefined) {
    return `Never call ${r.tool} with ${r.argument} containing '${r.contains}'.`;
  }
  return `Never call ${r.tool}.`;
}

/** Where a session of `role` is told to turn when refused. */
function escalationPath(role) {
  return ESCALATION_PATH[role] || 'ask the operator';
}

/** The permission-denied reason for a refused call. */
function refusalMessage(role, hit) {
  return (
    `the ${role} role may not make this call (rule ${hit.rule.id}: ${describeRule(hit.rule)}) ` +
    `[${hit.detail}]. Do not retry it in another spelling; ${escalationPath(role)}.`
  );
}

/**
 * Markdown narration of a role's resolved rules, for a skill to print. Rendered
 * from the same rules the hook enforces.
 * @param {string} role
 * @param {object[]} rules
 */
function renderRoleToolRules(role, rules) {
  if (!rules || rules.length === 0) {
    return `No tool rules are configured for the ${role} role.`;
  }
  const lines = [
    `Tool rules for the ${role} role (a PreToolUse hook refuses a matching call; ` +
      `the policy is \`governance.roles.${role}.blockedTools\`):`,
  ];
  for (const r of rules) lines.push(`- ${describeRule(r)}`);
  lines.push(`When a call is refused, ${escalationPath(role)}.`);
  return lines.join('\n');
}

module.exports = {
  ROLES,
  MATCHER_NAMES,
  DEFAULT_ROLE_BLOCKED_TOOLS,
  parseRoleToolPolicy,
  resolveRoleBlockedTools,
  readPolicyText,
  loadRoleBlockedTools,
  decisionMutationIn,
  toolMatches,
  ruleCouldMatch,
  evaluateRule,
  firstRefusal,
  defaultRoleBlockedTools,
  decideForSession,
  describeRule,
  escalationPath,
  refusalMessage,
  renderRoleToolRules,
};
