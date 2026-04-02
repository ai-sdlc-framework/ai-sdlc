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
