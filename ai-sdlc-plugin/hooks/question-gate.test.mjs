/**
 * Tests for the operator-question gate (AISDLC-1443): lib/question-gate.js and
 * the hook entry question-gate.js.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/question-gate.test.mjs
 *
 * Checks 2 and 3 are exercised through an injected judge that returns what
 * `cli-judgment question-gate` would print for a fake provider; the TypeScript
 * side is covered by pipeline-cli/src/decisions/question-judgment.test.ts. The
 * end-to-end cases run the real hook under a process named `claude`, with a
 * roster naming that pid, the way the other hierarchy hooks are tested.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const gate = require('./lib/question-gate.js');
const entry = require('./question-gate.js');
const HOOK = join(here, 'question-gate.js');
const PLUGIN_ROOT = join(here, '..');

const NOW = () => new Date('2026-11-27T10:00:00Z');
const OFF = {};

/** An AskUserQuestion input. */
function ask(question, { header = 'Choice', options } = {}) {
  return {
    questions: [
      {
        question,
        header,
        multiSelect: false,
        options: options ?? [
          { label: 'Prebuilt image', description: 'Bake the toolchain into an image.' },
          { label: 'Mounted store', description: 'Mount the package store read-only.' },
        ],
      },
    ],
  };
}

const PLAIN = ask('How does the toolchain get into the untrusted gate sandbox?');
const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
});
const skillCall = (skill) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill } }] },
});
const RUBRIC_TURN = [userPrompt('decide this'), skillCall('ai-sdlc:decision-rubric'), toolResult()];

/** Judge output shaped like `cli-judgment question-gate`. */
function judged({ dup, rev } = {}) {
  const out = {};
  const match = {
    id: 'DEC-0101',
    option: 'opt-a',
    optionDescription: 'Use the prebuilt image',
    summary: 'How does the toolchain get into the sandbox?',
  };
  if (dup === 'enforce') {
    out.duplicate = {
      judgmentId: 'decision.duplicate',
      mode: 'enforce',
      outcome: 'act',
      decision: { duplicateOf: 'DEC-0101' },
      basis: 'decision.duplicate@abc',
      match,
    };
  } else if (dup === 'shadow') {
    out.duplicate = {
      judgmentId: 'decision.duplicate',
      mode: 'shadow',
      outcome: 'abstain',
      reason: 'shadow',
      shadow: { outcome: 'act', decision: { duplicateOf: 'DEC-0101' } },
      basis: 'decision.duplicate@abc',
      match,
    };
  } else if (dup === 'none') {
    out.duplicate = {
      mode: 'enforce',
      outcome: 'act',
      decision: { duplicateOf: null },
      basis: 'decision.duplicate@abc',
    };
  }
  if (rev && rev.mode === 'enforce') {
    out.reversibility = {
      mode: 'enforce',
      outcome: rev.outcome ?? 'act',
      decision: rev.decision,
      basis: 'decision.reversibility@def',
    };
  } else if (rev && rev.mode === 'shadow') {
    out.reversibility = {
      mode: 'shadow',
      outcome: 'abstain',
      reason: 'shadow',
      shadow: { outcome: 'act', decision: rev.decision },
      basis: 'decision.reversibility@def',
    };
  }
  return out;
}

function run(toolInput, { role = null, judge, turn = [], rubricMode, env = OFF } = {}) {
  const calls = [];
  const res = gate.runQuestionGate({
    input: { tool_name: 'AskUserQuestion', tool_input: toolInput, session_id: 'sess-1' },
    role,
    judge: judge
      ? (req) => {
          calls.push(req);
          return judge(req);
        }
      : undefined,
    turn,
    env,
    now: NOW,
    ...(rubricMode ? { rubricMode } : {}),
  });
  return { ...res, calls, checks: res.records.map((r) => `${r.check}:${r.outcome}`) };
}

describe('check 1: unattended sessions', () => {
  for (const role of ['executor', 'operator-dispatch']) {
    it(`denies in the ${role} session, before any judgment`, () => {
      const r = run(PLAIN, { role, judge: () => judged({ dup: 'enforce' }), turn: RUBRIC_TURN });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /^no operator here: /);
      assert.match(r.reason, /cli-decisions\.mjs escalate --task-id/);
      assert.equal(r.calls.length, 0);
      assert.deepEqual(r.checks, ['unattended:deny']);
    });
  }
  for (const role of ['planner', null]) {
    it(`allows in ${role ?? 'a session outside the hierarchy'}`, () => {
      const r = run(PLAIN, { role, turn: RUBRIC_TURN });
      assert.equal(r.decision, 'allow');
      assert.equal(r.checks[0], 'unattended:allow');
    });
  }
});

describe('check 2: already decided', () => {
  it('denies on an enforce act, naming the DEC id, option and summary', () => {
    const r = run(PLAIN, { judge: () => judged({ dup: 'enforce' }), turn: RUBRIC_TURN });
    assert.equal(r.decision, 'deny');
    assert.equal(
      r.reason,
      'DEC-0101 already answered this (option `opt-a` (Use the prebuilt image): How does the toolchain get into the sandbox?). Proceed on it.',
    );
    assert.deepEqual(r.checks, ['unattended:allow', 'already-decided:deny']);
    assert.equal(r.records[1].basis, 'DEC-0101');
  });

  it('in shadow allows and logs the would-deny, then falls through to checks 3 and 4', () => {
    const r = run(PLAIN, { judge: () => judged({ dup: 'shadow' }), turn: RUBRIC_TURN });
    assert.equal(r.decision, 'allow');
    assert.deepEqual(r.checks, [
      'unattended:allow',
      'already-decided:shadow-would-deny',
      'own-class:abstain',
      'rubric:allow',
    ]);
    assert.equal(r.records[1].mode, 'shadow');
  });

  it('a no-duplicate verdict and a failed judge both fall through', () => {
    assert.equal(
      run(PLAIN, { judge: () => judged({ dup: 'none' }) }).checks[1],
      'already-decided:allow',
    );
    const failed = run(PLAIN, {
      judge: () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(failed.checks.slice(1, 3), ['already-decided:abstain', 'own-class:abstain']);
    assert.equal(run(PLAIN, { judge: () => null }).checks[1], 'already-decided:abstain');
  });

  it('sends the question text and option labels to the judge', () => {
    const r = run(PLAIN, { judge: () => ({}) });
    assert.deepEqual(r.calls[0], {
      summary: 'How does the toolchain get into the untrusted gate sandbox?',
      options: [
        { id: 'Prebuilt image', description: 'Bake the toolchain into an image.' },
        { id: 'Mounted store', description: 'Mount the package store read-only.' },
      ],
      skipReversibility: false,
    });
  });
});

describe('check 3: the session decides its own class', () => {
  it('denies a reversible (class a) question on an enforce act', () => {
    const r = run(PLAIN, {
      judge: () => judged({ rev: { mode: 'enforce', decision: 'reversible' } }),
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /^decide this yourself: the question is class \(a\)/);
    assert.match(r.reason, /cli-decisions\.mjs add .* --file --pr/);
    assert.deepEqual(r.checks.slice(-1), ['own-class:deny']);
  });

  it('a one-way (class b) act names the timebox', () => {
    const r = run(PLAIN, {
      judge: () => judged({ rev: { mode: 'enforce', decision: 'one-way' } }),
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /class \(b\).*--timebox PT10H --autonomous-fallback/);
  });

  it('in shadow allows and logs the would-deny', () => {
    const r = run(PLAIN, {
      judge: () => judged({ rev: { mode: 'shadow', decision: 'reversible' } }),
      turn: RUBRIC_TURN,
    });
    assert.equal(r.decision, 'allow');
    assert.deepEqual(r.checks.slice(2), ['own-class:shadow-would-deny', 'rubric:allow']);
  });

  it('unknown, escalate and abstain fall through', () => {
    for (const rev of [
      { mode: 'enforce', decision: 'unknown' },
      { mode: 'enforce', outcome: 'escalate' },
    ]) {
      const r = run(PLAIN, { judge: () => judged({ rev }), turn: RUBRIC_TURN });
      assert.equal(r.decision, 'allow');
    }
  });

  for (const [what, question] of [
    ['money', 'Should we subscribe to the paid CI plan at $40 a month?'],
    ['credentials', 'Which API key should the release workflow use for npm?'],
  ]) {
    it(`never denies a ${what} question, even when the provider labels it reversible`, () => {
      const r = run(ask(question), {
        judge: () => judged({ rev: { mode: 'enforce', decision: 'reversible' } }),
        turn: RUBRIC_TURN,
      });
      assert.equal(r.decision, 'allow');
      assert.equal(r.calls[0].skipReversibility, true);
      assert.equal(r.records[2].check, 'own-class');
      assert.equal(r.records[2].outcome, 'class-c');
      assert.match(r.records[2].basis, new RegExp(what));
    });
  }
});

describe('RFC Open Question exemption', () => {
  it('(i) header OQ-3: no judgment, checks 2 and 3 skipped, check 4 still applies', () => {
    const q = ask('Which storage backend does RFC-0049 use?', { header: 'OQ-3' });
    const judge = () =>
      judged({ dup: 'enforce', rev: { mode: 'enforce', decision: 'reversible' } });
    const framed = run(q, { judge, turn: RUBRIC_TURN });
    assert.equal(framed.decision, 'allow');
    assert.equal(framed.calls.length, 0);
    assert.deepEqual(framed.checks, ['unattended:allow', 'open-question:exempt', 'rubric:allow']);
    const unframed = run(q, { judge, rubricMode: 'deny' });
    assert.equal(unframed.decision, 'deny');
    assert.match(unframed.reason, /^run the ai-sdlc:decision-rubric skill first/);
  });

  it('(ii) a plain question asked in a turn that invoked rfc-oq-walkthrough', () => {
    const turn = [
      userPrompt('walk the OQs'),
      skillCall('ai-sdlc:rfc-oq-walkthrough'),
      toolResult(),
    ];
    const r = run(PLAIN, { judge: () => judged({ dup: 'enforce' }), turn });
    assert.equal(r.calls.length, 0);
    assert.equal(r.checks[1], 'open-question:exempt');
    assert.equal(r.decision, 'allow');
  });

  it('(iii) a plain question mentioning neither still runs checks 2 and 3', () => {
    const r = run(PLAIN, { judge: () => judged({ dup: 'enforce' }) });
    assert.equal(r.calls.length, 1);
    assert.equal(r.decision, 'deny');
  });

  it('detects the markers and the phrase', () => {
    const yes = [
      ask('Resolve OQ-12 now?'),
      ask('Resolve OQ 4?'),
      ask('x', { header: 'OQ7' }),
      ask('This is an open question in RFC-0051'),
      ask('x', { options: [{ label: 'OQ-2: keep', description: '' }] }),
    ];
    for (const q of yes) assert.equal(gate.isRfcOpenQuestion(q), true, JSON.stringify(q));
    assert.equal(gate.isRfcOpenQuestion(PLAIN), false);
    assert.equal(gate.isRfcOpenQuestion({}), false);
  });
});

describe('check 4: rubric framing', () => {
  it('a rubric Skill call in the current turn allows', () => {
    assert.equal(run(PLAIN, { turn: RUBRIC_TURN, rubricMode: 'deny' }).decision, 'allow');
  });

  it('the rubric slash command opening the turn counts', () => {
    const turn = [userPrompt('<command-name>/ai-sdlc:decision-rubric</command-name> the sandbox')];
    assert.equal(run(PLAIN, { turn, rubricMode: 'deny' }).decision, 'allow');
  });

  it('a rubric call in an earlier turn does not count', () => {
    const entries = [...RUBRIC_TURN, userPrompt('next thing'), toolResult()];
    const turn = gate.currentTurn(entries);
    assert.equal(turn.length, 2);
    const r = run(PLAIN, { turn, rubricMode: 'deny' });
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, gate.MESSAGES.rubric());
  });

  it('a background-task notification does not open a new turn', () => {
    const notice = userPrompt('<task-notification> <task-id>a1</task-id> done');
    const noticeBlocks = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification>x</task-notification>' }] },
    };
    const turn = gate.currentTurn([userPrompt('older'), ...RUBRIC_TURN, notice, noticeBlocks]);
    assert.equal(turn.length, 5);
    assert.equal(run(PLAIN, { turn, rubricMode: 'deny' }).decision, 'allow');
    const blocks = { type: 'user', message: { content: [{ type: 'text', text: 'a prompt' }] } };
    assert.equal(gate.isTurnStart(blocks), true);
    assert.equal(gate.isTurnStart({ type: 'user', message: {} }), false);
  });

  it('an rfc-oq-walkthrough call in the turn frames the question', () => {
    const turn = [userPrompt('walk RFC-0055'), skillCall('ai-sdlc:rfc-oq-walkthrough')];
    assert.equal(run(PLAIN, { turn, rubricMode: 'deny' }).records.at(-1).basis, 'decision-rubric');
  });

  it('a trivial question needs no rubric', () => {
    const trivial = ask('Push now?', {
      options: [{ label: 'Yes, push it' }, { label: 'No', description: '  ' }],
    });
    assert.equal(gate.isTrivialQuestion(trivial), true);
    assert.equal(run(trivial, { rubricMode: 'deny' }).records.at(-1).basis, 'trivial');
    const long = ask('Push now?', { options: [{ label: 'Yes push it to origin right now' }] });
    assert.equal(gate.isTrivialQuestion(long), false);
    assert.equal(gate.isTrivialQuestion({}), true);
  });

  it('an allowlisted header is trivial', () => {
    gate.TRIVIAL_HEADERS.add('confirm-test');
    try {
      assert.equal(gate.isTrivialQuestion(ask('x', { header: 'Confirm-Test' })), true);
    } finally {
      gate.TRIVIAL_HEADERS.delete('confirm-test');
    }
  });

  it(`defaults to ${gate.RUBRIC_CHECK_MODE}`, () => {
    const r = run(PLAIN);
    if (gate.RUBRIC_CHECK_MODE === 'warn') {
      assert.equal(r.decision, 'allow');
      assert.equal(r.checks.at(-1), 'rubric:warn-would-deny');
    } else {
      assert.equal(r.decision, 'deny');
    }
  });
});

describe('kill switch and log records', () => {
  it('AI_SDLC_QUESTION_GATE=off allows every question and logs nothing', () => {
    const r = run(PLAIN, { role: 'executor', env: { AI_SDLC_QUESTION_GATE: 'off' } });
    assert.equal(r.decision, 'allow');
    assert.equal(r.records.length, 0);
  });

  it('records carry the fields, a hash and the first 200 characters only', () => {
    const long = 'Why '.repeat(100) + '?';
    const r = run(ask(long), { turn: RUBRIC_TURN });
    for (const rec of r.records) {
      assert.deepEqual(Object.keys(rec).sort(), [
        'basis',
        'check',
        'mode',
        'outcome',
        'questionHash',
        'questionHead',
        'questionId',
        'role',
        'sessionId',
        'ts',
      ]);
      assert.equal(rec.questionHead.length, 200);
      assert.match(rec.questionHash, /^[0-9a-f]{64}$/);
      assert.equal(rec.sessionId, 'sess-1');
      assert.equal(rec.ts, '2026-11-27T10:00:00.000Z');
    }
    assert.notEqual(gate.questionId(PLAIN, 'a'), gate.questionId(PLAIN, 'b'));
  });

  it('appendGateLog writes one JSON line per record under _question-gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-log-'));
    try {
      gate.appendGateLog(dir, [{ a: 1 }, { b: 2 }], NOW());
      gate.appendGateLog(dir, [], NOW());
      gate.appendGateLog('', [{ a: 1 }], NOW());
      const file = gate.gateLogPath(dir, NOW());
      assert.equal(file, join(dir, '.ai-sdlc/artifacts/_question-gate/log-2026-11-27.jsonl'));
      assert.deepEqual(
        readFileSync(file, 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
        [{ a: 1 }, { b: 2 }],
      );
      assert.match(gate.gateLogPath(dir, new Date('x')), /log-\d{4}-\d{2}-\d{2}\.jsonl$/);
      // a file where the directory should be: swallowed
      writeFileSync(join(dir, 'blocked'), '');
      gate.appendGateLog(join(dir, 'blocked'), [{ a: 1 }], NOW());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transcript reading', () => {
  it('readCurrentTurn returns the entries since the last real prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-tx-'));
    try {
      const file = join(dir, 't.jsonl');
      const lines = [
        userPrompt('first'),
        skillCall('ai-sdlc:decision-rubric'),
        toolResult(),
        {
          type: 'user',
          isMeta: true,
          message: { content: [{ type: 'text', text: 'skill body' }] },
        },
        userPrompt('second'),
        skillCall('other'),
        toolResult(),
      ];
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
      const turn = gate.readCurrentTurn(file);
      assert.equal(turn.length, 3);
      assert.equal(turn[0].message.content, 'second');
      assert.deepEqual(gate.readCurrentTurn(join(dir, 'missing.jsonl')), []);
      assert.deepEqual(gate.readCurrentTurn(undefined), []);
      assert.deepEqual(gate.readCurrentTurn(dir), []); // a directory cannot be read
      assert.equal(gate.currentTurn([toolResult()]).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses transcript_path when no turn is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-tx-'));
    try {
      const file = join(dir, 't.jsonl');
      writeFileSync(file, RUBRIC_TURN.map((l) => JSON.stringify(l)).join('\n'));
      const r = gate.runQuestionGate({
        input: { tool_input: PLAIN, session_id: 's', transcript_path: file },
        role: null,
        env: OFF,
        rubricMode: 'deny',
      });
      assert.equal(r.decision, 'allow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hook entry', () => {
  it('resolveJudgmentBin prefers PIPELINE_CLI_BIN, then the plugin install, then the monorepo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-bin-'));
    try {
      writeFileSync(join(dir, 'cli-judgment.mjs'), '');
      assert.equal(
        entry.resolveJudgmentBin({ PIPELINE_CLI_BIN: dir }),
        join(dir, 'cli-judgment.mjs'),
      );
      const nm = join(dir, 'root', 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');
      mkdirSync(nm, { recursive: true });
      writeFileSync(join(nm, 'cli-judgment.mjs'), '');
      assert.equal(
        entry.resolveJudgmentBin({ CLAUDE_PLUGIN_ROOT: join(dir, 'root') }, join(dir, 'nowhere')),
        join(nm, 'cli-judgment.mjs'),
      );
      assert.equal(entry.resolveJudgmentBin({}, join(dir, 'a', 'b')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makeJudge spawns question-gate with the source kind and parses its JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-bin-'));
    try {
      writeFileSync(join(dir, 'cli-judgment.mjs'), '');
      const seen = [];
      const fake = (status, stdout) => (cmd, args, opts) => {
        seen.push({ args, input: opts.input });
        return { status, stdout };
      };
      const env = { PIPELINE_CLI_BIN: dir };
      assert.deepEqual(
        entry.makeJudge('/p', env, fake(0, '{"duplicate":null}\n'))({ summary: 'q' }),
        {
          duplicate: null,
        },
      );
      assert.deepEqual(seen[0].args.slice(1), [
        'question-gate',
        '--cwd',
        '/p',
        '--source-kind',
        'backlog',
      ]);
      assert.equal(seen[0].input, '{"summary":"q"}');
      entry.makeJudge(
        '/p',
        { ...env, AI_SDLC_UNTRUSTED_RUN: '1' },
        fake(0, '{}'),
      )({ summary: 'q' });
      assert.equal(seen[1].args.at(-1), 'untrusted-external');
      assert.equal(entry.makeJudge('/p', env, fake(1, '{}'))({}), null);
      assert.equal(entry.makeJudge('/p', env, fake(0, 'not json'))({}), null);
      assert.equal(entry.makeJudge('/p', env, fake(0, ''))({}), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('findRoster honours the board env and the project dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-roster-'));
    try {
      const board = join(dir, '.ai-sdlc', 'dispatch');
      mkdirSync(board, { recursive: true });
      assert.equal(gate.findRoster({ cwd: dir }, { CLAUDE_PROJECT_DIR: dir }), null);
      writeFileSync(join(board, 'hierarchy.json'), '{}');
      assert.equal(gate.findRoster({}, { CLAUDE_PROJECT_DIR: dir }), board);
      assert.equal(gate.findRoster({ cwd: join(dir, '.ai-sdlc') }, {}), board);
      assert.equal(gate.findRoster({}, { AI_SDLC_DISPATCH_BOARD_DIR: board }), board);
      assert.equal(gate.findRoster({}, { AI_SDLC_DISPATCH_BOARD_DIR: dir }), null);
      assert.equal(entry.resolveRole({}, { CLAUDE_PROJECT_DIR: join(dir, 'none') }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hook end to end', () => {
  let toolDir;
  let claudeBin;
  let wrapper;
  before(() => {
    toolDir = mkdtempSync(join(tmpdir(), 'qgate-e2e-'));
    claudeBin = join(toolDir, 'claude');
    symlinkSync(process.execPath, claudeBin);
    wrapper = join(toolDir, 'wrapper.mjs');
    writeFileSync(
      wrapper,
      `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, role, payload, hook, rawEnv] = process.argv.slice(2);
if (role !== 'none') {
  const board = join(dir, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  writeFileSync(join(board, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions: [
    { name: 'me', role, status: 'running', pid: process.pid },
  ] }));
}
const r = spawnSync('node', [hook], {
  input: payload,
  encoding: 'utf-8',
  env: { PATH: process.env.PATH, HOME: join(dir, 'home'), CLAUDE_PROJECT_DIR: dir, PIPELINE_CLI_BIN: join(dir, 'no-bin'), ...JSON.parse(rawEnv) },
});
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout }));
`,
    );
  });
  after(() => rmSync(toolDir, { recursive: true, force: true }));

  function hook(role, toolInput, env = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-proj-'));
    const payload = JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: toolInput,
      session_id: 'e2e',
      cwd: dir,
    });
    const r = spawnSync(claudeBin, [wrapper, dir, role, payload, HOOK, JSON.stringify(env)], {
      encoding: 'utf-8',
    });
    const out = JSON.parse(r.stdout);
    const logDir = join(dir, '.ai-sdlc', 'artifacts', '_question-gate');
    const log = existsSync(logDir)
      ? readdirSync(logDir).flatMap((f) =>
          readFileSync(join(logDir, f), 'utf-8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l)),
        )
      : [];
    rmSync(dir, { recursive: true, force: true });
    return { ...out, log };
  }

  it('denies in an executor session and logs the record', () => {
    const r = hook('executor', PLAIN);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      out.hookSpecificOutput.permissionDecisionReason,
      /^AI-SDLC question gate: no operator here/,
    );
    assert.deepEqual(
      r.log.map((x) => [x.check, x.outcome, x.role]),
      [['unattended', 'deny', 'executor']],
    );
  });

  it('allows in the planner and outside the hierarchy', () => {
    for (const role of ['planner', 'none']) {
      const r = hook(role, PLAIN);
      assert.equal(r.stdout, '');
      assert.equal(r.log[0].outcome, 'allow');
    }
  });

  it('the kill switch allows an executor and writes no log', () => {
    const r = hook('executor', PLAIN, { AI_SDLC_QUESTION_GATE: 'off' });
    assert.equal(r.stdout, '');
    assert.equal(r.log.length, 0);
  });

  it('is registered for AskUserQuestion in both plugin manifests', () => {
    for (const rel of ['plugin.json', '.claude-plugin/plugin.json']) {
      const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, rel), 'utf-8'));
      const entryFor = m.hooks.PreToolUse.find((h) => h.matcher === 'AskUserQuestion');
      assert.ok(entryFor, rel);
      assert.match(entryFor.hooks[0].command, /hooks\/question-gate\.sh/);
    }
  });
});
