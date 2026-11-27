/**
 * Operator-question gate (AISDLC-1443): the logic behind the `AskUserQuestion`
 * PreToolUse hook (`hooks/question-gate.js`). Pure functions plus one
 * orchestrating `runQuestionGate`, so every check is tested without spawning.
 *
 * Four checks, in order; each falls through when it abstains:
 *   1. unattended: an executor or operator-dispatch session has no operator,
 *      so it may not ask one (deny);
 *   -  RFC Open Question exemption: an OQ question skips checks 2 and 3 and
 *      is never offered to a judgment (only the operator resolves an OQ);
 *   2. already decided: `decision.duplicate` against answered decisions on
 *      `origin/main` (deny in `enforce`, log a would-deny in `shadow`);
 *   3. own class: `decision.reversibility`, class (a)/(b) means the session
 *      decides it (same modes); never for a question carrying a class-(c) marker;
 *   4. rubric framing: the current turn ran the decision-rubric skill, or the
 *      question is trivial; otherwise deny (or, in `warn`, log a would-deny).
 *
 * Every outcome is one JSONL record in
 * `.ai-sdlc/artifacts/_question-gate/log-YYYY-MM-DD.jsonl`. The question is
 * stored as a hash plus its first 200 characters; the transcript never is.
 * Kill switch: `AI_SDLC_QUESTION_GATE=off`.
 */

'use strict';

const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('fs');
const { createHash } = require('crypto');
const { dirname, join, resolve } = require('path');

/** Check 4 mode. `warn` allows and logs the would-deny; `deny` refuses. Set by the replay (AC 8). */
const RUBRIC_CHECK_MODE = 'warn';

/** Hierarchy roles that run with no operator at the keyboard. */
const UNATTENDED_ROLES = ['executor', 'operator-dispatch'];

const OQ_WALKTHROUGH_SKILLS = ['ai-sdlc:rfc-oq-walkthrough', 'rfc-oq-walkthrough'];

/**
 * Skills whose invocation in the current turn frames a question. The OQ
 * walkthrough applies the decision-rubric's six steps to every OQ it asks
 * (its Phase 3), so it counts as framing; the replay found its questions
 * were the largest false-deny group without it.
 */
const RUBRIC_SKILLS = ['ai-sdlc:decision-rubric', 'decision-rubric', ...OQ_WALKTHROUGH_SKILLS];

/** Question headers that are trivial whatever their options say (lower-cased). */
const TRIVIAL_HEADERS = new Set([]);

/** Most words an option label of a trivial question may have. */
const TRIVIAL_LABEL_WORDS = 5;

const OQ_MARKER = /\bOQ[-‑ ]?[A-Z0-9]+\b/;
const OQ_PHRASE = /\bopen questions?\b/i;

/**
 * Class (c) subjects (docs/operations/decision-authority.md): legal and
 * licensing, money, accounts and credentials, actions only the operator's
 * identity can perform, and dependency limits (routed like class (c), DEC-0433).
 */
const CLASS_C_MARKERS = [
  [
    'legal',
    /\b(legal|licen[cs]e[sd]?|licensing|copyright|trademark|contract|terms of service|gdpr)\b/i,
  ],
  [
    'money',
    /(\$\s?\d|\b(money|paid|pay|payment|billing|billed|invoice|subscri(be|ption)|purchase|price|pricing|spend|budget|usd|eur)\b)/i,
  ],
  [
    'credentials',
    /\b(credentials?|secrets?|passwords?|api[- ]?keys?|tokens?|ssh key|signing key|private key|2fa|mfa|account|login|oauth)\b/i,
  ],
  [
    'operator-identity',
    /\b(release pr|merge the release|close (?:the |this )?(?:pr|issue)|disarm|operator'?s identity|as the operator)\b/i,
  ],
  ['dependency-limit', /\b(rate[- ]limit(?:ed|s)?|quota|throttl\w*)\b/i],
];

/** The questions array of an AskUserQuestion input, or []. */
function questionsOf(toolInput) {
  const qs = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return qs.filter((q) => q && typeof q === 'object');
}

function optionsOf(q) {
  return Array.isArray(q.options) ? q.options.filter((o) => o && typeof o === 'object') : [];
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Every question's text joined, as the gate judges and hashes it. */
function questionText(toolInput) {
  return questionsOf(toolInput)
    .map((q) => str(q.question).trim())
    .filter(Boolean)
    .join('\n');
}

/** Every piece of text the question shows: question, header, option labels and descriptions. */
function allText(toolInput) {
  const parts = [];
  for (const q of questionsOf(toolInput)) {
    parts.push(str(q.question), str(q.header));
    for (const o of optionsOf(q)) parts.push(str(o.label), str(o.description));
  }
  return parts.filter(Boolean);
}

/**
 * Harness-injected user messages that are not an operator prompt: a background
 * task finishing mid-turn. The replay found that counting them as turn starts
 * split rubric and walkthrough flows and caused most false denies.
 */
const SYSTEM_PROMPT = /^\s*<task-notification>/;

/**
 * True for the entry that opens a turn: a real user prompt (string content, or
 * blocks with no tool result), not a meta or sidechain entry and not a
 * background-task notification.
 */
function isTurnStart(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message && e.message.content;
  if (typeof c === 'string') return !SYSTEM_PROMPT.test(c);
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return false;
  const text = c.find((b) => b && b.type === 'text');
  return !(text && SYSTEM_PROMPT.test(str(text.text)));
}

/**
 * Entries of the current turn: from the last turn-opening prompt to the end,
 * prompt included.
 * @param {object[]} entries parsed transcript lines, oldest first.
 * @returns {object[]}
 */
function currentTurn(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isTurnStart(entries[i])) return entries.slice(i);
  }
  return entries.slice();
}

/**
 * The current turn of a transcript file, or [] when it cannot be read. Lines are
 * parsed from the end back to the turn's opening prompt only.
 * @param {string | undefined} transcriptPath
 */
function readCurrentTurn(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return [];
  }
  const turn = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    turn.unshift(e);
    if (isTurnStart(e)) break;
  }
  return turn;
}

/** True when the turn invoked one of `skills` (a Skill tool call, or the turn's slash command). */
function turnInvokedSkill(turn, skills) {
  for (const e of turn) {
    const c = e && e.message && e.message.content;
    if (e.type === 'user' && typeof c === 'string') {
      const m = c.match(/<command-name>\/?([^<\s]+)<\/command-name>/);
      if (m && skills.includes(m[1])) return true;
    }
    if (e.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input) {
        if (skills.includes(str(b.input.skill).replace(/^\//, ''))) return true;
      }
    }
  }
  return false;
}

/**
 * Does this question resolve an RFC Open Question? Reused by AISDLC-1445.
 * True when the question text, header or an option label carries an OQ marker
 * (`OQ-3`, `OQ 12`, `OQ7`) or the phrase "open question", or the current turn
 * invoked the rfc-oq-walkthrough skill.
 * @param {object} toolInput AskUserQuestion input.
 * @param {object[]} [turn] current-turn transcript entries.
 */
function isRfcOpenQuestion(toolInput, turn = []) {
  for (const q of questionsOf(toolInput)) {
    const texts = [str(q.question), str(q.header), ...optionsOf(q).map((o) => str(o.label))];
    if (texts.some((t) => OQ_MARKER.test(t) || OQ_PHRASE.test(t))) return true;
  }
  return turnInvokedSkill(turn, OQ_WALKTHROUGH_SKILLS);
}

/** Names of the class-(c) markers the question carries (empty when none). */
function classCMarkers(toolInput) {
  const text = allText(toolInput).join('\n');
  return CLASS_C_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Trivial: every question has an allowlisted header, or only short option
 * labels (at most five words) and no option description.
 */
function isTrivialQuestion(toolInput) {
  const qs = questionsOf(toolInput);
  if (qs.length === 0) return true;
  return qs.every((q) => {
    if (TRIVIAL_HEADERS.has(str(q.header).trim().toLowerCase())) return true;
    const opts = optionsOf(q);
    return opts.every(
      (o) =>
        str(o.label).trim().split(/\s+/).filter(Boolean).length <= TRIVIAL_LABEL_WORDS &&
        str(o.description).trim() === '',
    );
  });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Stable id for one question asked in one session. */
function questionId(toolInput, sessionId) {
  const opts = questionsOf(toolInput).map((q) =>
    optionsOf(q).map((o) => [str(o.label), str(o.description)]),
  );
  return sha256(`${questionText(toolInput)}\n${JSON.stringify(opts)}\n${str(sessionId)}`).slice(
    0,
    32,
  );
}

/** Path of the gate log for a date (UTC). */
function gateLogPath(projectDir, date) {
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  return join(
    projectDir,
    '.ai-sdlc',
    'artifacts',
    '_question-gate',
    `log-${d.toISOString().slice(0, 10)}.jsonl`,
  );
}

/** Append records to the gate log. A write failure is swallowed. */
function appendGateLog(projectDir, records, now = new Date()) {
  if (!projectDir || records.length === 0) return;
  try {
    const file = gateLogPath(projectDir, now);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch {
    // logging never changes the outcome
  }
}

/** The command line a session runs instead of asking, for the deny messages. */
const ESCALATE_CMD =
  'node pipeline-cli/bin/cli-decisions.mjs escalate --task-id <task-id> --summary "<question>" --option "<id>:<description>" --option "<id>:<description>"';
const ADD_CMD =
  'node pipeline-cli/bin/cli-decisions.mjs add --summary "<question>" --scope <area> --option "<id>:<description>" --option "<id>:<description>" --file --pr';

const MESSAGES = {
  unattended: (role) =>
    `no operator here: this is the hierarchy ${role} session, and no session opens AskUserQuestion while the operator is away. ` +
    `Record the question for the planner instead: \`${ESCALATE_CMD}\`, then keep working other eligible tasks.`,
  duplicate: (m) =>
    `${m.id} already answered this (option \`${m.option || '?'}\`${m.optionDescription ? ` (${m.optionDescription})` : ''}: ${m.summary}). Proceed on it.`,
  ownClass: (cls) =>
    `decide this yourself: the question is class ${cls} under docs/operations/decision-authority.md, which a session decides by rubric. ` +
    `Record it with \`${ADD_CMD}\`${cls === '(b)' ? ' plus `--timebox PT10H --autonomous-fallback <id>`' : ''}, then answer and proceed.`,
  rubric: () =>
    'run the ai-sdlc:decision-rubric skill first (problem, options, recommendation, counter-argument), then ask again with its framing. ' +
    'A short yes/no question (option labels of five words or fewer, no descriptions) needs no rubric.',
};

/**
 * Run the gate. Never throws; any failure inside checks 2 and 3 abstains.
 *
 * @param {object} args
 * @param {object} args.input hook input (`tool_input`, `session_id`, `transcript_path`).
 * @param {string | null} args.role hierarchy role, or null outside the hierarchy.
 * @param {(req: object) => object | null} [args.judge] checks 2 and 3; returns the
 *   `cli-judgment question-gate` JSON, or null on failure.
 * @param {object[]} [args.turn] current-turn entries; read from `transcript_path` when absent.
 * @param {Record<string, string | undefined>} [args.env]
 * @param {() => Date} [args.now]
 * @param {'warn' | 'deny'} [args.rubricMode]
 * @returns {{ decision: 'allow' | 'deny', reason?: string, records: object[] }}
 */
function runQuestionGate({
  input,
  role,
  judge,
  turn,
  env = process.env,
  now = () => new Date(),
  rubricMode = RUBRIC_CHECK_MODE,
}) {
  if (str(env.AI_SDLC_QUESTION_GATE).toLowerCase() === 'off') {
    return { decision: 'allow', records: [] };
  }
  const toolInput = (input && input.tool_input) || {};
  const sessionId = str(input && input.session_id);
  const text = questionText(toolInput);
  const base = {
    sessionId,
    role: role || null,
    questionId: questionId(toolInput, sessionId),
    questionHash: sha256(text),
    questionHead: text.slice(0, 200),
  };
  const records = [];
  const record = (check, outcome, basis = null, mode = 'enforce') =>
    records.push({ ts: now().toISOString(), ...base, check, outcome, basis, mode });
  const deny = (reason) => ({ decision: 'deny', reason, records });

  // 1. Unattended session.
  if (role && UNATTENDED_ROLES.includes(role)) {
    record('unattended', 'deny', role);
    return deny(MESSAGES.unattended(role));
  }
  record('unattended', 'allow', role || null);

  const thisTurn = Array.isArray(turn) ? turn : readCurrentTurn(input && input.transcript_path);

  // RFC Open Question exemption: no judgment request, straight to check 4.
  if (isRfcOpenQuestion(toolInput, thisTurn)) {
    record('open-question', 'exempt');
  } else {
    const markers = classCMarkers(toolInput);
    let judged = null;
    if (typeof judge === 'function' && text) {
      try {
        judged = judge({
          summary: text,
          options: questionsOf(toolInput).flatMap((q) =>
            optionsOf(q).map((o) => ({ id: str(o.label), description: str(o.description) })),
          ),
          skipReversibility: markers.length > 0,
        });
      } catch {
        judged = null;
      }
    }
    const j = judged && typeof judged === 'object' ? judged : {};

    // 2. Already decided.
    const dup = j.duplicate;
    if (!dup) {
      record('already-decided', 'abstain', null, 'off');
    } else if (dup.outcome === 'act' && dup.mode === 'enforce' && dup.match) {
      record('already-decided', 'deny', dup.match.id, dup.mode);
      return deny(MESSAGES.duplicate(dup.match));
    } else if (dup.shadow && dup.shadow.outcome === 'act' && dup.match) {
      record('already-decided', 'shadow-would-deny', dup.match.id, dup.mode);
    } else {
      record(
        'already-decided',
        dup.outcome === 'act' ? 'allow' : 'abstain',
        dup.basis || null,
        dup.mode || 'off',
      );
    }

    // 3. The session's own class. A class-(c) marker always falls through.
    const rev = j.reversibility;
    const classOf = (d) => (d === 'reversible' ? '(a)' : d === 'one-way' ? '(b)' : null);
    if (markers.length > 0) {
      record('own-class', 'class-c', markers.join(','));
    } else if (!rev) {
      record('own-class', 'abstain', null, 'off');
    } else if (rev.outcome === 'act' && rev.mode === 'enforce' && classOf(rev.decision)) {
      record('own-class', 'deny', rev.basis || null, rev.mode);
      return deny(MESSAGES.ownClass(classOf(rev.decision)));
    } else if (rev.shadow && rev.shadow.outcome === 'act' && classOf(rev.shadow.decision)) {
      record('own-class', 'shadow-would-deny', rev.basis || null, rev.mode);
    } else {
      record(
        'own-class',
        rev.outcome === 'act' ? 'allow' : 'abstain',
        rev.basis || null,
        rev.mode || 'off',
      );
    }
  }

  // 4. Rubric framing.
  if (turnInvokedSkill(thisTurn, RUBRIC_SKILLS)) {
    record('rubric', 'allow', 'decision-rubric', rubricMode);
  } else if (isTrivialQuestion(toolInput)) {
    record('rubric', 'allow', 'trivial', rubricMode);
  } else if (rubricMode === 'deny') {
    record('rubric', 'deny', null, rubricMode);
    return deny(MESSAGES.rubric());
  } else {
    record('rubric', 'warn-would-deny', null, rubricMode);
  }
  return { decision: 'allow', records };
}

/**
 * Locate the hierarchy roster with plain filesystem checks (the same lookup as
 * `enforce-role-tools.js`): the board from `AI_SDLC_DISPATCH_BOARD_DIR`, else
 * `.ai-sdlc/dispatch` under the project dir or the nearest ancestor of cwd.
 */
function findRoster(input, env = process.env) {
  const rosterIn = (board) => existsSync(join(board, 'hierarchy.json'));
  const start = resolve(
    env.CLAUDE_PROJECT_DIR ||
      (input && typeof input.cwd === 'string' ? input.cwd : '') ||
      process.cwd(),
  );
  if (env.AI_SDLC_DISPATCH_BOARD_DIR) {
    return rosterIn(env.AI_SDLC_DISPATCH_BOARD_DIR) ? env.AI_SDLC_DISPATCH_BOARD_DIR : null;
  }
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    const board = join(dir, '.ai-sdlc', 'dispatch');
    if (rosterIn(board)) return board;
    if (env.CLAUDE_PROJECT_DIR) return null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

module.exports = {
  RUBRIC_CHECK_MODE,
  UNATTENDED_ROLES,
  TRIVIAL_HEADERS,
  CLASS_C_MARKERS,
  MESSAGES,
  questionText,
  isTurnStart,
  currentTurn,
  readCurrentTurn,
  turnInvokedSkill,
  isRfcOpenQuestion,
  classCMarkers,
  isTrivialQuestion,
  questionId,
  gateLogPath,
  appendGateLog,
  runQuestionGate,
  findRoster,
};
