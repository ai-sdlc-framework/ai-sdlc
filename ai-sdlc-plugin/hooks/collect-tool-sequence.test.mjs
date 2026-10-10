/**
 * Tests for the AI-SDLC plugin collect-tool-sequence hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/collect-tool-sequence.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'collect-tool-sequence.js');

let tempHome;

before(() => {
  tempHome = join(tmpdir(), `collect-tool-seq-test-${Date.now()}`);
  mkdirSync(tempHome, { recursive: true });
});

after(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function runHook(inputObj, extraEnv = {}) {
  const input = JSON.stringify(inputObj);
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, HOME: tempHome, CLAUDE_PROJECT_DIR: tempHome, ...extraEnv },
      timeout: 5000,
    });
    return { output: output.trim(), exitCode: 0 };
  } catch (err) {
    return { output: err.stdout?.trim() || '', exitCode: err.status };
  }
}

describe('ai-sdlc-plugin collect-tool-sequence hook', () => {
  it('appends JSONL entry for a Bash tool event', () => {
    const sid = `test-bash-${Date.now()}`;
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      session_id: sid,
    });
    assert.equal(result.exitCode, 0, 'should exit 0');

    const jsonlPath = join(tempHome, '.claude', 'usage-data', 'tool-sequences.jsonl');
    assert.ok(existsSync(jsonlPath), 'JSONL file should be created');

    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastLine.sid, sid, 'session id should match');
    assert.equal(lastLine.tool, 'Bash', 'tool should be Bash');
    assert.ok(lastLine.action.includes('pnpm test'), 'action should contain the command');
    assert.ok(lastLine.ts, 'should have a timestamp');
  });

  it('appends JSONL entry for an Edit tool event', () => {
    const sid = `test-edit-${Date.now()}`;
    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/foo.ts', old_string: 'a', new_string: 'b' },
      session_id: sid,
    });

    const jsonlPath = join(tempHome, '.claude', 'usage-data', 'tool-sequences.jsonl');
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.sid === sid);
    assert.ok(entry, 'should find entry for this session');
    assert.equal(entry.tool, 'Edit');
    assert.equal(entry.action, 'edit:.ts', 'should canonicalize to edit:.ts');
  });

  it('appends JSONL entry for a Read tool event', () => {
    const sid = `test-read-${Date.now()}`;
    runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/path/to/config.json' },
      session_id: sid,
    });

    const jsonlPath = join(tempHome, '.claude', 'usage-data', 'tool-sequences.jsonl');
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.sid === sid);
    assert.ok(entry);
    assert.equal(entry.action, 'read:.json');
  });

  it('exits 0 on invalid input (fail-safe)', () => {
    try {
      const output = execFileSync('node', [hookScript], {
        input: 'not json at all',
        encoding: 'utf-8',
        env: { ...process.env, HOME: tempHome },
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output');
    } catch (err) {
      assert.equal(err.status, 0, 'should exit 0');
    }
  });

  it('exits 0 when tool_name is missing', () => {
    const result = runHook({ tool_input: { command: 'ls' }, session_id: 'test' });
    assert.equal(result.exitCode, 0, 'should exit 0');
  });

  it('exits 0 when session_id is missing', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(result.exitCode, 0, 'should exit 0');
  });

  it('canonicalizes Bash commands to last 3 tokens', () => {
    const sid = `test-canon-${Date.now()}`;
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd /foo && git add -A' },
      session_id: sid,
    });

    const jsonlPath = join(tempHome, '.claude', 'usage-data', 'tool-sequences.jsonl');
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.sid === sid);
    assert.ok(entry);
    assert.equal(entry.action, 'git add -A', 'should use last command after &&');
  });
});

describe('large-output notice (AISDLC-651.5)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const lib = await import('./lib/large-output-notice.js');
  const { largeOutputNotice, noticeTokensFromYaml, DEFAULT_NOTICE_TOKENS } = lib.default ?? lib;

  const big = 'x'.repeat(DEFAULT_NOTICE_TOKENS * 4 + 4);
  let project;
  let usageDir;
  before(() => {
    project = mkdtempSync(join(tmpdir(), 'lon-proj-'));
    usageDir = mkdtempSync(join(tmpdir(), 'lon-usage-'));
    mkdirSync(join(project, '.ai-sdlc', 'dispatch'), { recursive: true });
    writeFileSync(join(project, '.ai-sdlc', 'dispatch', 'hierarchy.json'), '{}');
  });
  after(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(usageDir, { recursive: true, force: true });
  });

  const env = () => ({ CLAUDE_PROJECT_DIR: project, AI_SDLC_USAGE_DIR: usageDir });
  const asRole = (role) => () => ({ role });
  const noBase = () => null;

  it('returns the notice for a planner session and an over-threshold result', () => {
    const msg = largeOutputNotice(
      { tool_response: big },
      { env: env(), resolveRole: asRole('planner'), readBase: noBase },
    );
    assert.match(msg, /Explore subagent/);
    assert.match(msg, /tail/);
    assert.match(msg, /artifacts directory/);
    assert.match(msg, /8000 token/);
  });

  it('covers operator-dispatch and object-shaped results', () => {
    const msg = largeOutputNotice(
      { tool_response: { stdout: big } },
      { env: env(), resolveRole: asRole('operator-dispatch'), readBase: noBase },
    );
    assert.ok(msg);
  });

  it('returns nothing for developer and executor roles, or below the threshold', () => {
    for (const role of ['developer', 'executor']) {
      assert.equal(
        largeOutputNotice({ tool_response: big }, { env: env(), resolveRole: asRole(role) }),
        null,
      );
    }
    assert.equal(
      largeOutputNotice(
        { tool_response: 'small' },
        { env: env(), resolveRole: asRole('planner'), readBase: noBase },
      ),
      null,
    );
    assert.equal(largeOutputNotice({}, { env: env(), resolveRole: asRole('planner') }), null);
  });

  it('returns nothing outside a hierarchy and never throws', () => {
    const lone = mkdtempSync(join(tmpdir(), 'lon-none-'));
    try {
      assert.equal(
        largeOutputNotice(
          { tool_response: big, cwd: lone },
          { env: { CLAUDE_PROJECT_DIR: lone }, resolveRole: asRole('planner') },
        ),
        null,
      );
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
    assert.equal(
      largeOutputNotice(
        { tool_response: big },
        {
          env: env(),
          resolveRole: () => {
            throw new Error('boom');
          },
        },
      ),
      null,
    );
  });

  it('reads the threshold from the machine config, then the base config, else 8000', () => {
    const text =
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nspec:\n  output:\n    noticeTokens: 100\n';
    assert.equal(noticeTokensFromYaml(text), 100);
    assert.equal(noticeTokensFromYaml('spec:\n  output:\n    noticeTokens: 0\n'), undefined);
    assert.equal(noticeTokensFromYaml('spec: {}\n'), undefined);

    const mid = 'y'.repeat(2000); // 500 tokens: under the default, over a threshold of 100
    const opts = { env: env(), resolveRole: asRole('planner') };
    assert.equal(largeOutputNotice({ tool_response: mid }, { ...opts, readBase: noBase }), null);
    assert.ok(largeOutputNotice({ tool_response: mid }, { ...opts, readBase: () => text }));

    writeFileSync(join(usageDir, 'usage-config.yaml'), text.replace('100', '5000'));
    assert.equal(
      largeOutputNotice({ tool_response: mid }, { ...opts, readBase: () => text }),
      null,
    );
    rmSync(join(usageDir, 'usage-config.yaml'));
  });

  it('the hook exits 0 with no output for a large result outside a hierarchy', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/a.txt' },
      tool_response: big,
      session_id: `test-big-${Date.now()}`,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, '');
  });
});

describe('explore-first rule in the skills (AISDLC-651.5)', () => {
  for (const skill of ['planner', 'operator-dispatch']) {
    it(`${skill} skill carries the rule`, () => {
      const text = readFileSync(join(__dirname, '..', 'commands', `${skill}.md`), 'utf-8');
      assert.match(text, /\*\*Explore first\.\*\*/);
      assert.match(text, /`Explore` or Sonnet subagent/);
    });
  }
});
