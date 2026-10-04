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

const { existsSync, lstatSync, readFileSync, readdirSync } = require('fs');
const { join, resolve, isAbsolute, basename } = require('path');
const { ROLE_SKILL } = require('./hierarchy-role');
const { verifiedMainRoot, runGit, safeReal } = require('./trusted-policy');

/** Roles a roster can assign. */
const ROLES = Object.freeze(Object.keys(ROLE_SKILL));

/** Where a refused session is told to turn, per role. */
const ESCALATION_PATH = Object.freeze({
  executor:
    'escalate to your dispatch session: send it one status message, or raise a decision with `cli-decisions escalate` and stop',
  'operator-dispatch':
    'escalate to the planner session: raise a decision with `cli-decisions escalate` so it is routed to the planner',
  planner:
    'raise it with `cli-decisions escalate` so it is routed, or, if the rule itself is wrong for this repo, override `governance.roles.planner.blockedTools` in the repo policy',
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

const TOOL_PATTERN = /^[A-Za-z0-9_.*|-]{1,100}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+(?:\.\d+)*$/;
const SUB_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+(?:\.\d+)+$/;
/** Longest `${...}` body the normalizer will look through. */
const BRACE_SCAN_LIMIT = 256;

/** Longest command an executor's `cli-decisions` mention is inspected at; longer is refused. */
const MAX_SCANNED_COMMAND = 64 * 1024;
/**
 * The `cli-decisions` subcommands an executor may run: ONE place. Everything else,
 * known or unknown, is refused.
 */
const DECISION_READ_ONLY = Object.freeze([
  'list',
  'show',
  'log-path',
  'graph',
  'coverage',
  'research',
  'summary',
]);
/** Every subcommand name the CLI defines, so a refusal can be told apart from a stray word. */
const DECISION_KNOWN = Object.freeze([
  'list',
  'show',
  'add',
  'escalate',
  'log-path',
  'score-a',
  'coverage',
  'score-c',
  'graph',
  'research',
  'summary',
  'answer',
  'resolve',
  'auto-expire',
  'override',
  'extend',
  'fatigue',
  'corpus',
  'exemplars',
]);
/** `add` flags an executor may not use (compared lower-case with dashes removed). */
const ADD_REFUSED_FLAGS = Object.freeze(['autonomousfallback', 'timebox', 'timeboxhours']);
/** The plugin's own create tool: its `id` is required and binds the sub-task. */
const PLUGIN_TASK_CREATE = /^mcp__plugin_ai-sdlc_ai-sdlc__task_create$/;
const BACKLOG_CREATE_WORDS = new Set(['create', 'new', 'add']);
const BACKLOG_TASK_WORDS = new Set(['task', 'tasks', 'draft', 'drafts']);
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
  const text = String(command).replace(/\\\r?\n/g, '');
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '$') {
      const next = text[i + 1];
      if (next === '{') {
        // Bounded look-ahead for the closing brace: linear overall, whatever the input.
        let close = -1;
        const limit = Math.min(n, i + 2 + BRACE_SCAN_LIMIT);
        for (let j = i + 2; j < limit; j += 1) {
          if (text[j] === '}') {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          const inner = text.slice(i + 2, close);
          // `${IFS}` and `${IFS<non-word>...}` split words; any other variable is empty.
          const isIfs =
            inner === 'IFS' || (inner.startsWith('IFS') && !/[A-Za-z0-9_]/.test(inner[3]));
          if (isIfs) out.push(' ');
          i = close + 1;
          continue;
        }
        i += 1; // unterminated or oversized: drop the stray `$`, keep going
        continue;
      }
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(text[j])) j += 1;
        if (text.slice(i + 1, j) === 'IFS') out.push(' ');
        i = j;
        continue;
      }
      i += 1; // stray `$`
      continue;
    }
    if (ch === '`' || ch === '(' || ch === ')') out.push(';');
    else if (ch !== "'" && ch !== '"' && ch !== '\\') out.push(ch.toLowerCase());
    i += 1;
  }
  return out.join('');
}

/** Stands in for a `$(...)` or backtick span inside its own segment, keeping argument positions. */
const SUBSTITUTION_PLACEHOLDER = 'zzsubstzz';
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Splits `text` into the main text, with each `$(...)` / backtick span replaced by a
 * placeholder, and the spans' contents. Parentheses nest. An unbalanced opener is
 * replaced by the placeholder alone and the text after it stays in the main text.
 */
function splitSubstitutions(text) {
  const n = text.length;
  // Matching parenthesis for every `(` in one pass (a stack): linear, whatever the input.
  const close = new Int32Array(n).fill(-1);
  const stack = [];
  for (let i = 0; i < n; i += 1) {
    if (text[i] === '(') stack.push(i);
    else if (text[i] === ')' && stack.length > 0) close[stack.pop()] = i;
  }
  const parts = [];
  const spans = [];
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '$' && text[i + 1] === '(') {
      const end = close[i + 1];
      parts.push(SUBSTITUTION_PLACEHOLDER);
      if (end !== -1) {
        spans.push(text.slice(i + 2, end));
        i = end + 1;
      } else {
        // Unbalanced: only the opener is replaced; the rest stays in place, so a
        // subcommand after it is still seen (and an unknown word there fails closed).
        i += 2;
      }
    } else if (ch === '`') {
      const next = text.indexOf('`', i + 1);
      parts.push(SUBSTITUTION_PLACEHOLDER);
      if (next === -1) {
        i += 1;
      } else {
        spans.push(text.slice(i + 1, next));
        i = next + 1;
      }
    } else {
      parts.push(ch);
      i += 1;
    }
  }
  return { main: parts.join(''), spans };
}

/**
 * The normalized command segments of a shell command: the main text with command
 * substitutions replaced by a placeholder (so an argument keeps its position), plus
 * every substitution's contents as additional segments, to a bounded depth.
 */
function commandSegments(command) {
  const out = [];
  const queue = [{ text: String(command), depth: 0 }];
  while (queue.length > 0) {
    const { text, depth } = queue.pop();
    if (depth >= MAX_SUBSTITUTION_DEPTH) {
      out.push(...splitSegments(normalizeCommand(text)));
      continue;
    }
    const { main, spans } = splitSubstitutions(text);
    out.push(...splitSegments(normalizeCommand(main)));
    for (const span of spans) queue.push({ text: span, depth: depth + 1 });
  }
  return out;
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
 * First positional token after a CLI token and its index, skipping options. Two
 * models are tried by the caller because the real parser's behaviour for an
 * unknown option is not worth betting on: in the "pairs" model an option swallows
 * the next token as its value (unless written `--opt=value` or the next token is
 * itself an option); in the "flags" model options stand alone.
 */
function firstPositional(tokens, from, pairs) {
  for (let i = from; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) return { token: tok, index: i };
    if (pairs && !tok.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  return null;
}

/** Why a `cli-decisions` invocation (tokens after the CLI name) is refused, or null. */
function decisionInvocationRefusal(tokens, from, lenient = false) {
  const pairs = firstPositional(tokens, from, true);
  const flags = firstPositional(tokens, from, false);
  // The flags model only matters when it lands on a real subcommand the pairs model
  // does not: a stray option value (`--work-dir . list`) is not a subcommand.
  for (const found of [pairs, flags]) {
    if (found && found !== pairs && !DECISION_KNOWN.includes(found.token)) continue;
    if (!found) continue;
    // Safety-net path (the command word was not recognised): only a real subcommand counts.
    if (lenient && !DECISION_KNOWN.includes(found.token)) continue;
    const sub = found.token;
    if (DECISION_READ_ONLY.includes(sub) || sub === 'escalate') continue;
    if (sub === 'add') {
      for (let i = from; i < tokens.length; i += 1) {
        if (!tokens[i].startsWith('-')) continue;
        const name = tokens[i].replace(/^-+/, '').split('=')[0].replace(/-/g, '');
        if (ADD_REFUSED_FLAGS.includes(name)) return `add ${tokens[i].split('=')[0]}`;
      }
      continue;
    }
    if (sub === 'exemplars') {
      const next = firstPositional(tokens, found.index + 1, found === flags ? false : true);
      if (next && next.token === 'list') continue;
      return 'exemplars (writes)';
    }
    return sub; // any other subcommand, known or unknown
  }
  return null;
}

/** Command words that run another command given as their arguments. */
const RUNNER_WORDS = new Set([
  'npx',
  'pnpm',
  'yarn',
  'npm',
  'bunx',
  'corepack',
  'env',
  'sudo',
  'doas',
  'time',
  'nohup',
  'command',
  'exec',
  'nice',
  'timeout',
  'gtimeout',
  'stdbuf',
  'setsid',
  'ionice',
  'chrt',
  'flock',
  'caffeinate',
  'unbuffer',
  'script',
  'watch',
  'strace',
]);
/** Shell reserved words and grouping tokens that may precede the command word. */
const LEADING_RESERVED = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'time',
  'fi',
  'done',
  'esac',
]);
/** First words of commands that only read or move text/files: a mention is not an invocation. */
const MENTION_WORDS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'cat',
  'echo',
  'printf',
  'git',
  'sed',
  'awk',
  'head',
  'tail',
  'less',
  'ls',
  'find',
  'wc',
  'bat',
  'man',
  'cp',
  'mv',
  'rm',
  'stat',
  'diff',
  'cmp',
  'chmod',
]);
const NODE_WORDS = new Set(['node', 'nodejs', 'bun', 'deno']);
const SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Where, in one segment's tokens, the decisions CLI is INVOKED: the index just after
 * the CLI token, or `'indirect'` when the segment hands the CLI to something that
 * runs it from text (`sh -c`, `eval`, `xargs`, `node -e`), or null when the CLI is
 * only mentioned (an argument of grep, cat, echo, git and the like).
 */
function invocationPoint(tokens) {
  let c = 0;
  while (
    c < tokens.length &&
    (/^[a-z_][a-z0-9_]*=/.test(tokens[c]) || LEADING_RESERVED.has(tokens[c]))
  ) {
    c += 1;
  }
  const word = tokens[c];
  if (word === undefined) return null;
  const base = word.split('/').pop();
  if (isDecisionsCli(word)) return c + 1;
  const rest = tokens.slice(c + 1);
  const mentionsCli = tokens.some((t) => t.includes('cli-decisions'));
  if (base === 'eval' || base === 'xargs') return mentionsCli ? 'indirect' : null;
  if (SHELL_WORDS.has(base)) {
    return rest.some((t) => /^-[a-z]*c[a-z]*$/.test(t)) && mentionsCli ? 'indirect' : null;
  }
  if (NODE_WORDS.has(base) && rest.some((t) => /^(-e|-p|--eval|--print)$/.test(t))) {
    return mentionsCli ? 'indirect' : null;
  }
  // Node, runners and anything else: the first token that IS the CLI is the invocation,
  // unless the command word is a known reader/mover of text (a mention).
  const k = rest.findIndex((t) => isDecisionsCli(t));
  if (k === -1) return null;
  if (NODE_WORDS.has(base) || RUNNER_WORDS.has(base)) return c + 1 + k + 1;
  if (MENTION_WORDS.has(base)) return null;
  return { lenientAt: c + 1 + k + 1 }; // safety net: an unrecognised command word
}

/**
 * Why a shell command is refused for running the decisions CLI outside the
 * executor allowlist, or null. Only an INVOCATION counts: the command line is split
 * on `;`, `&&`, `||`, `|`, `&` and newlines; in each segment leading `NAME=value`
 * assignments are skipped and the command word decides. `node <path>/cli-decisions.mjs`,
 * `npx` / `pnpm exec` / `pnpm cli-decisions` / `env` style runners and a bare or
 * path-qualified `cli-decisions` are invocations, checked against the subcommand
 * allowlist; a segment that only MENTIONS the name as an argument (grep, cat, rg,
 * echo, git grep, sed, head ...) passes. Indirection fails closed: a segment whose
 * command word is `sh`/`bash`/`zsh` with `-c`, `eval`, `xargs` or `node -e` and which
 * contains the name is refused. Quoting, backslash, variable and IFS tricks are
 * normalized away first, so an obfuscated invocation is still caught. Like every
 * matcher here it is a pattern matcher, not a sandbox. A command longer than
 * MAX_SCANNED_COMMAND that mentions the CLI is refused outright.
 */
function decisionMutationIn(command) {
  if (typeof command !== 'string' || command === '') return null;
  const text = normalizeCommand(command);
  if (!text.includes('cli-decisions')) return null;
  if (command.length > MAX_SCANNED_COMMAND) return 'a command too long to inspect';
  for (const segment of commandSegments(command)) {
    if (!segment.includes('cli-decisions')) continue;
    const tokens = segment.split(/\s+/).filter(Boolean);
    const at = invocationPoint(tokens);
    if (at === null) continue;
    if (at === 'indirect') return 'an indirect invocation (sh -c, eval, xargs or node -e)';
    const why =
      typeof at === 'object'
        ? decisionInvocationRefusal(tokens, at.lenientAt, true)
        : decisionInvocationRefusal(tokens, at);
    if (why) return why;
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

/**
 * True when `abs` exists with EXACTLY this spelling from its `backlog` directory
 * down. On a case-insensitive file system a differently cased path resolves to the
 * existing file; here it does not count as that file, so it is treated as a create.
 */
function existsExactCase(abs) {
  if (!existsSync(abs)) return false;
  try {
    const parts = abs.split(/[\\/]/);
    const start = parts.findIndex((p) => p.toLowerCase() === 'backlog');
    if (start === -1) return true;
    let dir = parts.slice(0, start).join('/') || '/';
    for (let i = start; i < parts.length; i += 1) {
      if (!readdirSync(dir).includes(parts[i])) return false;
      dir = join(dir, parts[i]);
    }
    return true;
  } catch {
    return false;
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
    next: 'send your one status line to the dispatch session named in the roster instead',
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
    next:
      'run `cli-decisions escalate --task-id <your task id> --source-worktree "$(pwd)" --summary <one line> ' +
      '--option <id>:<description>` ' +
      'directly (not through sh -c, eval or xargs, and in a shorter command if it was long), then stop; ' +
      'your dispatch session or the planner answers the decision',
    text:
      'Run only these `cli-decisions` subcommands when you invoke it: `escalate`; `add` (never with ' +
      '--autonomous-fallback, --timebox or --timebox-hours); and the read-only ' +
      `${DECISION_READ_ONLY.map((c) => `\`${c}\``).join(', ')} and \`exemplars list\`. ` +
      'Every other subcommand, answer, resolve and override included, is refused, as is running it ' +
      'through `sh -c`, `eval` or `xargs`: answers belong to the dispatch session and the planner.',
    quick: (input) => mentionsDecisionsCli(input.command),
    test(input) {
      const why = decisionMutationIn(input.command);
      return why ? `the command runs \`cli-decisions ${why}\`` : null;
    },
  }),
  topLevelTask: Object.freeze({
    next:
      'get a free id with `cli-dispatch next-subid <your task id>` and file the sub-task with the plugin ' +
      '`task_create` (id `<task-id>.<n>`) or the backlog tool (`parentTaskId` set to your task id, no `id`); ' +
      'if you hold no task, ' +
      'claim a task first with `cli-dispatch claim --worker-kind in-session-agent --worker <your session name>`',
    text:
      'Never create a top-level task with the task tools. File a follow-up as a sub-task of ' +
      'the task you hold: with the plugin `task_create` pass a sub-task id (`<task-id>.<n>`); ' +
      'with any other `task_create` tool (the backlog server) pass `parentTaskId` set to your ' +
      'task id and no `id`, because that server assigns ids itself. `<n>` is the first free ' +
      'number from `cli-dispatch next-subid <task-id>`.',
    quick: () => true,
    test(input, ctx) {
      const own = ownInflightTasks(ctx.boardDir, ctx.name);
      if (!own || own.length === 0) {
        return 'this session holds no claimed task, so a sub-task cannot be verified';
      }
      let candidate;
      if (PLUGIN_TASK_CREATE.test(ctx.toolName || '')) {
        const id = firstString(input, ['id']);
        if (!id || !SUB_TASK_ID_PATTERN.test(id)) {
          return `'${id ?? ''}' is not a sub-task id (the plugin task_create takes \`<task-id>.<n>\`)`;
        }
        candidate = id.slice(0, id.lastIndexOf('.'));
      } else {
        if (Object.prototype.hasOwnProperty.call(input, 'id')) {
          return 'this tool assigns ids itself and takes no `id`; pass `parentTaskId` instead';
        }
        const parent = firstString(input, ['parentTaskId', 'parent_task_id', 'parent']);
        if (!parent) return 'the call carries no `parentTaskId`';
        if (!TASK_ID_PATTERN.test(parent) && !/^\d+(?:\.\d+)*$/.test(parent)) {
          return `'${parent}' is not a task id`;
        }
        candidate = parent;
      }
      return own.some((t) => isUnderOwnTask(candidate, t))
        ? null
        : `'${candidate}' is not a task this session holds`;
    },
  }),
  newTaskFile: Object.freeze({
    next:
      'get a free id with `cli-dispatch next-subid <your task id>` and name the new file `<task-id>.<n> - <title>.md`, ' +
      'or file the sub-task with `task_create` and `parentTaskId`; if you hold no task, ' +
      'claim a task first with `cli-dispatch claim --worker-kind in-session-agent --worker <your session name>`',
    text:
      'Never create a new task file under `backlog/tasks/` or `backlog/drafts/` with Write, ' +
      'Edit or MultiEdit unless its id is a sub-task of the task you hold (`<task-id>.<n>`). ' +
      'Editing an existing task file is fine.',
    quick: (input) => /backlog/i.test(String(input.file_path ?? input.path ?? '')),
    test(input, ctx) {
      const file = firstString(input, ['file_path', 'path']);
      if (!file) return null;
      const abs = resolve(
        isAbsolute(file) ? file : resolve(ctx.cwd || ctx.projectDir || '.', file),
      );
      const m = /(?:^|[\\/])backlog[\\/](?:tasks|drafts)[\\/](.+)$/i.exec(abs);
      if (!m) return null;
      if (existsExactCase(abs)) return null; // an edit of an existing task file
      const name = m[1].split(/[\\/]/).pop();
      const id = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+(?:\.\d+)*)/i.exec(name)?.[1];
      if (!id || !SUB_TASK_ID_PATTERN.test(id)) {
        return `'${name}' would be a new task file that is not a sub-task of a task this session holds`;
      }
      const own = ownInflightTasks(ctx.boardDir, ctx.name);
      if (!own || own.length === 0) {
        return 'this session holds no claimed task, so a sub-task cannot be verified';
      }
      const parent = id.slice(0, id.lastIndexOf('.'));
      return own.some((t) => isUnderOwnTask(parent, t))
        ? null
        : `'${parent}' is not a task this session holds`;
    },
  }),
  backlogCliCreate: Object.freeze({
    next:
      'rerun it with `--parent <your task id>` (first free id from `cli-dispatch next-subid <your task id>`); ' +
      'if you hold no task, ' +
      'claim a task first with `cli-dispatch claim --worker-kind in-session-agent --worker <your session name>`',
    text:
      'Never run `backlog task create` (or `task new`, `create`, `draft create`) without ' +
      '`--parent <your task id>`.',
    quick: (input) =>
      typeof input.command === 'string' && normalizeCommand(input.command).includes('backlog'),
    test(input, ctx) {
      if (typeof input.command !== 'string') return null;
      if (input.command.length > MAX_SCANNED_COMMAND) {
        return normalizeCommand(input.command).includes('backlog')
          ? 'a command too long to inspect'
          : null;
      }
      for (const segment of commandSegments(input.command)) {
        if (!segment.includes('backlog')) continue;
        const tokens = segment.split(/\s+/).filter(Boolean);
        // nextWord[i]: index of the first non-option token at or after i (one backward pass).
        const nextWord = new Array(tokens.length + 1).fill(tokens.length);
        for (let i = tokens.length - 1; i >= 0; i -= 1) {
          nextWord[i] = tokens[i].startsWith('-') ? nextWord[i + 1] : i;
        }
        let parent;
        for (let i = 0; i < tokens.length; i += 1) {
          const t = tokens[i];
          if (t.startsWith('--parent=')) parent = t.slice('--parent='.length);
          else if ((t === '--parent' || t === '-p') && i + 1 < tokens.length)
            parent = tokens[i + 1];
        }
        let creates = false;
        for (let k = 0; k < tokens.length; k += 1) {
          const bin = tokens[k].split('/').pop();
          if (bin !== 'backlog' && bin !== 'backlog.md') continue;
          const w0 = nextWord[k + 1];
          const first = tokens[w0];
          const second = tokens[nextWord[Math.min(w0 + 1, tokens.length)]];
          if (
            BACKLOG_CREATE_WORDS.has(first) ||
            (BACKLOG_TASK_WORDS.has(first) && BACKLOG_CREATE_WORDS.has(second))
          ) {
            creates = true;
            break;
          }
        }
        if (!creates) continue;
        if (!parent) return 'a backlog create command without `--parent`';
        const own = ownInflightTasks(ctx.boardDir, ctx.name);
        if (!own || own.length === 0) {
          return 'this session holds no claimed task, so a sub-task cannot be verified';
        }
        if (!own.some((t) => isUnderOwnTask(parent, t))) {
          return `'${parent}' is not a task this session holds`;
        }
      }
      return null;
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
    rule({ id: 'new-task-file', tool: 'Write|Edit|MultiEdit', match: 'newTaskFile' }),
    rule({ id: 'backlog-cli-create', tool: 'Bash', match: 'backlogCliCreate' }),
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
 * the project directory's, except that a linked git worktree whose main checkout
 * cannot be verified yields no text (strict defaults). A main checkout without
 * the file resolves to the defaults. Never throws.
 * @param {string} projectDir
 * @param {typeof runGit} [run]
 * @returns {string}
 */
function readPolicyText(projectDir, run = runGit) {
  let dir = projectDir;
  try {
    const main = verifiedMainRoot(projectDir, run);
    if (main) {
      dir = main;
    } else if (isLinkedWorktree(projectDir, run)) {
      // A linked worktree whose main checkout cannot be verified: its own copy is
      // agent-writable, so it is not read. The strict defaults apply.
      return '';
    }
  } catch {
    // keep the project directory
  }
  try {
    return readFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
  } catch {
    return '';
  }
}

/** True when `dir` is a linked git worktree (`.git` is a file, or the git dir differs from the common dir). */
function isLinkedWorktree(dir, run) {
  try {
    if (lstatSync(join(dir, '.git')).isFile()) return true;
  } catch {
    // no `.git` entry here; fall through to git itself
  }
  try {
    const gitDir = run(['rev-parse', '--git-dir'], dir);
    const common = run(['rev-parse', '--git-common-dir'], dir);
    if (!gitDir || !common) return false;
    return safeReal(resolve(dir, gitDir)) !== safeReal(resolve(dir, common));
  } catch {
    return false;
  }
}

/** Resolved rules for every role from the project's policy. Never throws. */
function loadRoleBlockedTools(projectDir, run = runGit) {
  return resolveRoleBlockedTools(readPolicyText(projectDir, run));
}

// ── Evaluation ───────────────────────────────────────────────────────

function toolMatches(pattern, toolName) {
  if (typeof toolName !== 'string') return false;
  if (pattern.includes('|')) return pattern.split('|').some((p) => toolMatches(p, toolName));
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
      const detail = MATCHERS[r.match].test(input, { ...ctx, toolName });
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
 * @param {{ projectDir?: string, cwd?: string }} [extra] where relative file paths resolve
 * @returns {string | null}
 */
function decideForSession(session, getRules, toolName, toolInput, boardDir, extra = {}) {
  const ctx = {
    projectDir: extra.projectDir,
    cwd: extra.cwd,
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
  return ESCALATION_PATH[role] || 'raise it with `cli-decisions escalate`';
}

/** The concrete step a refused session can take itself, for a rule. */
function nextStep(r) {
  if (r.match) return MATCHERS[r.match].next;
  return 'use a different tool or command for the same goal';
}

/** The permission-denied reason for a refused call. */
function refusalMessage(role, hit) {
  return (
    `the ${role} role may not make this call (rule ${hit.rule.id}: ${describeRule(hit.rule)}) ` +
    `[${hit.detail}]. Do not retry it in another spelling. Next step: ${nextStep(hit.rule)}. ` +
    `If that does not unblock you, ${escalationPath(role)}.`
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
  const bashRule = rules.some((r) => /(^|\|)Bash(\||$)/.test(r.tool));
  for (const r of rules) lines.push(`- ${describeRule(r)}`);
  if (bashRule) {
    lines.push(
      'The Bash rules are pattern matchers: they do not catch every way a shell can write a file or run a command.',
    );
  }
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
  nextStep,
  MATCHERS,
  escalationPath,
  refusalMessage,
  renderRoleToolRules,
};
