'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'archive-transcript.sh');

function run(payload, projectDir) {
  return spawnSync('bash', [HOOK], {
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf-8',
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-transcript-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  return { root, project, home, dest: path.join(project, '.claude', 'transcripts') };
}

test('valid payload copies the transcript and writes a log line', () => {
  const { project, home, dest } = setup();
  const transcript = path.join(home, 'abc.jsonl');
  fs.writeFileSync(transcript, '{"a":1}\n');
  const r = run(
    JSON.stringify({ session_id: 'abc', transcript_path: transcript, reason: 'clear' }),
    project,
  );
  assert.strictEqual(r.status, 0);
  const copied = fs.readdirSync(dest).filter((f) => /^\d{8}T\d{6}Z-clear-abc\.jsonl$/.test(f));
  assert.strictEqual(copied.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dest, copied[0]), 'utf-8'), '{"a":1}\n');
  assert.match(fs.readFileSync(path.join(dest, '.log'), 'utf-8'), / clear abc -> /);
});

test('missing transcript path exits 0 with no copy', () => {
  const { project, home, dest } = setup();
  const r = run(
    JSON.stringify({
      session_id: 'abc',
      transcript_path: path.join(home, 'nope.jsonl'),
      reason: 'other',
    }),
    project,
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(dest), false);
});

test('empty payload exits 0', () => {
  const { project } = setup();
  assert.strictEqual(run('', project).status, 0);
});

test('subagent transcripts are copied when present', () => {
  const { project, home, dest } = setup();
  const transcript = path.join(home, 'abc.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const sub = path.join(home, 'abc', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{"s":1}\n');
  const r = run(
    JSON.stringify({ session_id: 'abc', transcript_path: transcript, reason: 'logout' }),
    project,
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(
    fs.readFileSync(path.join(dest, 'abc-subagents', 'agent-1.jsonl'), 'utf-8'),
    '{"s":1}\n',
  );
});
