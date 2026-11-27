/**
 * Tests for the AskUserQuestion evidence gate (AISDLC-1452): lib/evidence-gate.js
 * and its checker wiring in question-gate.js (`makeEvidenceCheck`).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/evidence-gate.test.mjs
 *
 * The unit cases inject the checker. The wiring cases run the hook end to end
 * against a stub `cli-decisions.mjs` (PIPELINE_CLI_BIN) that answers the way
 * `cli-decisions evidence check --format json` does, and record its argv, so
 * the draft the real checker would hash is asserted too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { runEvidenceGate, evidencePath, PREFERENCE_HEADER } = require('./lib/evidence-gate.js');
const entry = require('./question-gate.js');
const HOOK = join(here, 'question-gate.js');

const NOW = () => new Date('2026-11-27T10:00:00Z');
const DRAFT = 'Pick A: the JSONL store.\nCosts: a linear scan.';
const LEDGER = '.ai-sdlc/artifacts/_evidence/pick-store/ledger.json';
const WITH_EVIDENCE = `${DRAFT}\nEvidence: ${LEDGER}`;

function ask(question, header = 'Storage') {
  return {
    questions: [
      {
        question,
        header,
        multiSelect: false,
        options: [
          { label: 'A (Recommended)', description: 'JSONL, a linear scan.' },
          { label: 'B', description: 'sqlite, an extra dependency.' },
        ],
      },
    ],
  };
}

const passes = () => ({ ok: true, failures: [] });

describe('evidence gate', () => {
  it('refuses a question with no Evidence line and never runs the checker', () => {
    let called = false;
    const r = runEvidenceGate({
      toolInput: ask(DRAFT),
      check: () => ((called = true), passes()),
      now: NOW,
    });
    assert.equal(r.decision, 'deny');
    assert.equal(called, false);
    assert.match(r.reason, /question 1 \("Storage"\) has no `Evidence: <ledger path>` line/);
    assert.match(r.reason, /cli-decisions\.mjs evidence check/);
    assert.deepEqual(
      r.records.map((x) => [x.check, x.outcome, x.basis]),
      [['evidence', 'deny', 'no-evidence-line']],
    );
  });

  it('refuses a failing ledger, naming each failing entry and the re-check command', () => {
    const r = runEvidenceGate({
      toolInput: ask(WITH_EVIDENCE),
      check: () => ({
        ok: false,
        failures: [
          { entry: 'f1', reason: 'quote not found in src/a.ts within 5 lines of line 3' },
          { entry: 'a1', reason: 'assumption has no falsifiedBy' },
        ],
      }),
      now: NOW,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, new RegExp(`evidence ledger ${LEDGER} fails`));
    assert.match(r.reason, /f1: quote not found in src\/a\.ts/);
    assert.match(r.reason, /a1: assumption has no falsifiedBy/);
    assert.match(
      r.reason,
      new RegExp(`re-check: node pipeline-cli/bin/cli-decisions\\.mjs evidence check ${LEDGER}`),
    );
    assert.equal(r.records[0].failures.length, 2);
  });

  it('refuses a ledger whose draftSha256 does not match the question text', () => {
    const seen = [];
    const r = runEvidenceGate({
      toolInput: ask(WITH_EVIDENCE),
      check: (ledger, text) => {
        seen.push([ledger, text]);
        return {
          ok: false,
          failures: [{ entry: 'ledger', reason: 'draftSha256 does not match the draft' }],
        };
      },
      now: NOW,
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /ledger: draftSha256 does not match/);
    // the checker gets the whole question text; it drops the Evidence line itself
    assert.deepEqual(seen, [[LEDGER, WITH_EVIDENCE]]);
  });

  it('refuses when the checker cannot run', () => {
    for (const check of [
      () => null,
      () => {
        throw new Error('boom');
      },
    ]) {
      const r = runEvidenceGate({ toolInput: ask(WITH_EVIDENCE), check, now: NOW });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /the evidence checker could not run/);
      assert.equal(r.records[0].basis, 'checker-unavailable');
    }
  });

  it('allows a question whose ledger passes', () => {
    const r = runEvidenceGate({
      toolInput: ask(WITH_EVIDENCE),
      check: passes,
      now: NOW,
      sessionId: 's',
    });
    assert.equal(r.decision, 'allow');
    assert.deepEqual(
      r.records.map((x) => [x.outcome, x.ledger, x.sessionId, x.ts]),
      [['allow', LEDGER, 's', '2026-11-27T10:00:00.000Z']],
    );
  });

  it('allows a Preference question with no ledger and logs its text', () => {
    let called = false;
    const r = runEvidenceGate({
      toolInput: ask('Call it `list` or `ls`?', PREFERENCE_HEADER),
      check: () => ((called = true), passes()),
      now: NOW,
    });
    assert.equal(r.decision, 'allow');
    assert.equal(called, false);
    assert.equal(r.records[0].outcome, 'preference');
    assert.equal(r.records[0].questionText, 'Call it `list` or `ls`?');
  });

  it('the Preference header is exact: case and extra words do not count', () => {
    for (const header of ['preference', 'Preference only', ' Preference']) {
      const r = runEvidenceGate({ toolInput: ask(DRAFT, header), check: passes, now: NOW });
      assert.equal(r.decision, 'deny', header);
    }
  });

  it('every question needs its own ledger; one failing question refuses the call', () => {
    const input = {
      questions: [ask(WITH_EVIDENCE).questions[0], ask(DRAFT, 'Second').questions[0]],
    };
    const r = runEvidenceGate({ toolInput: input, check: passes, now: NOW });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /question 2 \("Second"\) has no `Evidence/);
    assert.deepEqual(
      r.records.map((x) => x.outcome),
      ['allow', 'deny'],
    );
  });

  it('evidencePath reads the Evidence line, and an empty input has nothing to refuse', () => {
    assert.equal(evidencePath(WITH_EVIDENCE), LEDGER);
    assert.equal(evidencePath('Evidence:'), null);
    assert.equal(evidencePath(undefined), null);
    assert.equal(runEvidenceGate({ toolInput: {}, check: passes }).decision, 'allow');
  });
});

describe('checker wiring', () => {
  it('makeEvidenceCheck runs cli-decisions evidence check on the question text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egate-bin-'));
    try {
      writeFileSync(join(dir, 'cli-decisions.mjs'), '');
      const seen = [];
      const fake = (stdout) => (cmd, args) => {
        const draft = args[args.indexOf('--draft') + 1];
        seen.push({ args, draft: readFileSync(draft, 'utf-8'), draftPath: draft });
        return { status: stdout.includes('"ok":true') ? 0 : 1, stdout };
      };
      const env = { PIPELINE_CLI_BIN: dir };
      const check = entry.makeEvidenceCheck('/proj', env, fake('{"ok":true,"failures":[]}'));
      assert.deepEqual(check('l.json', WITH_EVIDENCE), { ok: true, failures: [] });
      assert.deepEqual(seen[0].args.slice(1, 6), [
        '--work-dir',
        '/proj',
        'evidence',
        'check',
        '/proj/l.json',
      ]);
      assert.deepEqual(seen[0].args.slice(-2), ['--format', 'json']);
      assert.equal(seen[0].draft, WITH_EVIDENCE);
      assert.equal(existsSync(seen[0].draftPath), false, 'the draft temp file is removed');
      const failing = '{"ok":false,"failures":[{"entry":"f1","reason":"x"}]}';
      assert.equal(entry.makeEvidenceCheck('/proj', env, fake(failing))('l', 'q').ok, false);
      assert.equal(entry.makeEvidenceCheck('/proj', env, fake('not json'))('l', 'q'), null);
      assert.equal(entry.makeEvidenceCheck('/proj', env, fake(''))('l', 'q'), null);
      assert.equal(entry.makeEvidenceCheck('/proj', env, fake('{"x":1}'))('l', 'q'), null);
      assert.equal(entry.makeEvidenceCheck('/proj', env, () => null)('l', 'q'), null);
      assert.equal(
        entry.makeEvidenceCheck('/proj', { PIPELINE_CLI_BIN: join(dir, 'none') })('l', 'q'),
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function hook(toolInput, stubOut) {
    const dir = mkdtempSync(join(tmpdir(), 'egate-proj-'));
    try {
      const bin = join(dir, 'bin');
      require('fs').mkdirSync(bin);
      writeFileSync(
        join(bin, 'cli-decisions.mjs'),
        `import { readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify({ a, draft: readFileSync(a[a.indexOf('--draft') + 1], 'utf-8') }));
process.stdout.write(${JSON.stringify(stubOut)});
`,
      );
      const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          tool_name: 'AskUserQuestion',
          tool_input: toolInput,
          session_id: 'e',
          cwd: dir,
        }),
        encoding: 'utf-8',
        env: {
          PATH: process.env.PATH,
          HOME: join(dir, 'home'),
          CLAUDE_PROJECT_DIR: dir,
          PIPELINE_CLI_BIN: bin,
        },
      });
      const argvFile = join(dir, 'argv.json');
      const logDir = join(dir, '.ai-sdlc', 'artifacts', '_question-gate');
      return {
        status: r.status,
        stdout: r.stdout,
        stub: existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, 'utf-8')) : null,
        log: readdirSync(logDir).flatMap((f) =>
          readFileSync(join(logDir, f), 'utf-8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l)),
        ),
        dir,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the hook allows a question whose ledger the checker passes', () => {
    const r = hook(ask(WITH_EVIDENCE), '{"ok":true,"failures":[]}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stub.draft, WITH_EVIDENCE);
    assert.equal(r.stub.a[4], join(r.dir, LEDGER));
    assert.equal(r.log.at(-1).outcome, 'allow');
  });

  it('the hook refuses a question whose ledger fails, naming the entry', () => {
    const r = hook(
      ask(WITH_EVIDENCE),
      '{"ok":false,"failures":[{"entry":"ledger","reason":"draftSha256 does not match the draft"}]}',
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      out.hookSpecificOutput.permissionDecisionReason,
      /^AI-SDLC question gate: no question goes out[\s\S]*ledger: draftSha256 does not match/,
    );
  });
});
