/**
 * AISDLC-779: RFC-0053 surfacing hooks.
 * Run with: node --test ai-sdlc-plugin/hooks/context-surface.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(here, '..');
const HOOK_SH = join(here, 'context-surface.sh');
const require = createRequire(import.meta.url);
const { parseProfiles, render } = require('./lib/context-surface.js');

let dir;
let stub;
let argsLog;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctx-surface-'));
  argsLog = join(dir, 'args.log');
  stub = join(dir, 'stub-cli.sh');
  writeFileSync(
    stub,
    `#!/bin/bash\necho "$@" >> "${argsLog}"\necho '{"results":[{"id":"DEC-0038","score":0.9,"citations":["decisions/DEC-0038"],"tokens":10}]}'\n`,
  );
  chmodSync(stub, 0o755);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function project(profilesYaml) {
  const p = mkdtempSync(join(dir, 'proj-'));
  if (profilesYaml) {
    mkdirSync(join(p, '.ai-sdlc'));
    writeFileSync(join(p, '.ai-sdlc', 'context-profiles.yaml'), profilesYaml);
  }
  return p;
}

function run(moment, input, { cli = stub, role = 'planner', profiles } = {}) {
  const p = project(profiles);
  const env = { ...process.env, AI_SDLC_CONTEXT_ROLE: role, CLAUDE_PROJECT_DIR: p };
  delete env.AI_SDLC_ACTIVE_TASK_ID;
  if (cli) env.AI_SDLC_CONTEXT_CLI = cli;
  const res = spawnSync('bash', [HOOK_SH, moment], {
    input: JSON.stringify({ session_id: 's1', ...input }),
    encoding: 'utf-8',
    env,
  });
  return res;
}

const INPUTS = {
  sessionStart: {},
  taskClaim: { prompt: 'implement AISDLC-779' },
  userPrompt: { prompt: 'what governs trusted-policy.js?' },
  toolTouch: { tool_input: { file_path: '.ai-sdlc/trusted-policy.js' } },
  compaction: { source: 'compact', summary: 'we were editing the hooks' },
};

describe('manifests', () => {
  for (const file of ['plugin.json', join('.claude-plugin', 'plugin.json')]) {
    it(`${file} registers new and existing hook events`, () => {
      const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, file), 'utf-8')).hooks;
      for (const ev of [
        'UserPromptSubmit',
        'PreCompact',
        'SessionStart',
        'SubagentStart',
        'PreToolUse',
        'PostToolUse',
        'Stop',
      ]) {
        assert.ok(Array.isArray(hooks[ev]) && hooks[ev].length > 0, `${file} ${ev}`);
      }
      const cmds = (ev) => JSON.stringify(hooks[ev]);
      assert.match(cmds('UserPromptSubmit'), /context-surface\.sh\\" userPrompt/);
      assert.match(cmds('PreCompact'), /context-surface\.sh\\" compaction/);
      assert.match(cmds('SessionStart'), /context-surface\.sh\\" compaction/);
      assert.match(cmds('SubagentStart'), /subagent-start\.sh/);
      assert.match(cmds('SessionStart'), /session-start\.sh/);
    });
  }
});

describe('query call and rendering', () => {
  for (const [moment, input] of Object.entries(INPUTS)) {
    it(`${moment}: calls cli-context query with session, budget, min-score from the profile`, () => {
      rmSync(argsLog, { force: true });
      const res = run(moment, input, { role: 'planner' });
      assert.equal(res.status, 0);
      const args = readFileSync(argsLog, 'utf-8');
      assert.match(args, /^query /);
      assert.match(args, /--session s1/);
      assert.match(args, /--budget \d+/);
      assert.match(args, /--min-score 0\.4/);
      assert.match(args, new RegExp(`--moment ${moment}`));
      const out = JSON.parse(res.stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /DEC-0038/);
    });
  }

  it('uses the budget from the profile file', () => {
    rmSync(argsLog, { force: true });
    run('userPrompt', INPUTS.userPrompt, {
      profiles:
        'profiles:\n  planner:\n    moments: [userPrompt]\n    budget: { userPrompt: 777 }\n    minScore: 0.55\n',
    });
    const args = readFileSync(argsLog, 'utf-8');
    assert.match(args, /--budget 777/);
    assert.match(args, /--min-score 0\.55/);
  });

  it('renders data with ids and citations and no imperative framing', () => {
    const text = render('userPrompt', [
      { id: 'DEC-0038', score: 0.9, citations: ['decisions/DEC-0038'] },
    ]);
    assert.match(text, /DEC-0038/);
    assert.match(text, /decisions\/DEC-0038/);
    assert.match(text, /not instructions/);
    assert.doesNotMatch(text, /\b(you must|always|never|do not|should|ignore)\b/i);
  });
});

describe('fail-open', () => {
  it('missing binary: exit 0, no injection', () => {
    const res = run('userPrompt', INPUTS.userPrompt, { cli: join(dir, 'does-not-exist') });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });

  it('failing binary: exit 0, no injection', () => {
    const bad = join(dir, 'bad.sh');
    writeFileSync(bad, '#!/bin/bash\nexit 3\n');
    chmodSync(bad, 0o755);
    const res = run('toolTouch', INPUTS.toolTouch, { cli: bad });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });

  it('garbage output and garbage stdin: exit 0, no injection', () => {
    const junk = join(dir, 'junk.sh');
    writeFileSync(junk, '#!/bin/bash\necho nope\n');
    chmodSync(junk, 0o755);
    assert.equal(run('userPrompt', INPUTS.userPrompt, { cli: junk }).stdout.trim(), '');
    const res = spawnSync('bash', [HOOK_SH, 'userPrompt'], {
      input: '{not json',
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0);
  });

  it('unknown moment exits 0 silently', () => {
    const res = spawnSync('bash', [HOOK_SH, 'bogus'], { input: '{}', encoding: 'utf-8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });
});

describe('compaction', () => {
  it('re-runs retrieval against the summary read from the transcript on SessionStart(compact)', () => {
    rmSync(argsLog, { force: true });
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(
      tp,
      [
        JSON.stringify({ message: { content: 'old' } }),
        JSON.stringify({
          isCompactSummary: true,
          message: { content: [{ type: 'text', text: 'SUMMARY-MARKER about hooks' }] },
        }),
      ].join('\n'),
    );
    const res = run('compaction', { source: 'compact', transcript_path: tp });
    assert.match(readFileSync(argsLog, 'utf-8'), /SUMMARY-MARKER/);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  });

  it('injects nothing on PreCompact or a non-compact SessionStart', () => {
    assert.equal(run('compaction', { custom_instructions: 'x' }).stdout.trim(), '');
    assert.equal(run('compaction', { source: 'startup', summary: 'x' }).stdout.trim(), '');
  });

  it('session-start retrieval yields to compaction after a compact', () => {
    assert.equal(run('sessionStart', { source: 'compact' }).stdout.trim(), '');
    assert.notEqual(run('sessionStart', { source: 'startup' }).stdout.trim(), '');
  });
});

describe('profile gating', () => {
  const only = (m) => `profiles:\n  planner:\n    moments: [${m}]\n`;
  for (const moment of Object.keys(INPUTS)) {
    it(`${moment}: nothing injected when the profile disables it`, () => {
      const other = Object.keys(INPUTS).find((k) => k !== moment);
      rmSync(argsLog, { force: true });
      const res = run(moment, INPUTS[moment], { profiles: only(other) });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '');
    });
  }

  it('role without a profile gets nothing', () => {
    assert.equal(run('userPrompt', INPUTS.userPrompt, { role: 'mystery' }).stdout.trim(), '');
  });

  it('default reviewer profile is task claim only', () => {
    assert.equal(run('userPrompt', INPUTS.userPrompt, { role: 'reviewer' }).stdout.trim(), '');
    assert.notEqual(run('taskClaim', INPUTS.taskClaim, { role: 'reviewer' }).stdout.trim(), '');
  });

  it('executor tool touch fires only on governance-bearing paths', () => {
    const ex = (file) =>
      run('toolTouch', { tool_input: { file_path: file } }, { role: 'executor' });
    assert.notEqual(ex('.ai-sdlc/agent-role.yaml').stdout.trim(), '');
    assert.equal(ex('src/foo.ts').stdout.trim(), '');
  });

  it('parseProfiles reads flow lists and maps', () => {
    const p = parseProfiles(
      'profiles:\n  a:\n    moments: [x, y]\n    budget: { x: 5 }\n    minScore: 0.4\n',
    );
    assert.deepEqual(p.a.moments, ['x', 'y']);
    assert.deepEqual(p.a.budget, { x: 5 });
    assert.equal(p.a.minScore, 0.4);
  });
});
