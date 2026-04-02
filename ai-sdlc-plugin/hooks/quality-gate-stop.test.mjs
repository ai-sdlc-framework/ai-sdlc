/**
 * Tests for the AI-SDLC plugin quality-gate-stop hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/quality-gate-stop.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'quality-gate-stop.js');

// We need to control the telemetry file location. The hook reads from
// ~/.claude/usage-data/tool-sequences.jsonl which is the real user's home.
// To test properly, we use a unique session_id and check behavior.
// For "no telemetry file" test, we use a session_id that won't match anything.

let tempDir;
const testSessionId = `test-qg-${Date.now()}`;

before(() => {
  tempDir = join(tmpdir(), `quality-gate-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runHook(sessionId, extraEnv = {}) {
  const input = JSON.stringify({ session_id: sessionId || testSessionId });
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, ...extraEnv },
      timeout: 5000,
    });
    return { stdout: output.trim(), stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status,
    };
  }
}

describe('ai-sdlc-plugin quality-gate-stop hook', () => {
  it('exits 0 when no telemetry file exists for this session', () => {
    // Use a session ID that definitely has no telemetry data
    const result = runHook(`nonexistent-session-${Date.now()}`);
    assert.equal(result.exitCode, 0, 'should exit with code 0');
    assert.equal(result.stdout, '', 'should produce no stdout');
  });

  it('exits 0 when no code-modifying events in session', () => {
    // Even if the telemetry file exists, a session with only Read/Grep events
    // should pass through without blocking. We use a session id that won't
    // match any real entries.
    const result = runHook(`no-code-mods-${Date.now()}`);
    assert.equal(result.exitCode, 0, 'should exit with code 0');
    assert.equal(result.stdout, '', 'should produce no stdout');
  });

  it('exits 0 on missing session_id', () => {
    const input = JSON.stringify({});
    try {
      const output = execFileSync('node', [hookScript], {
        input,
        encoding: 'utf-8',
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output');
    } catch (err) {
      assert.equal(err.status, 0, 'should exit 0');
    }
  });

  it('exits 0 on invalid JSON input (fail-safe)', () => {
    try {
      const output = execFileSync('node', [hookScript], {
        input: 'not json',
        encoding: 'utf-8',
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output');
    } catch (err) {
      // Fail-safe: exits 0
      assert.equal(err.status, 0, 'should exit 0 on invalid input');
    }
  });

  it('exits 2 when code was modified but verification is missing', () => {
    // Write a temporary telemetry file with code-modifying events
    // but no verification commands
    const usageDir = join(tempDir, '.claude', 'usage-data');
    mkdirSync(usageDir, { recursive: true });
    const jsonlPath = join(usageDir, 'tool-sequences.jsonl');
    const sid = `test-blocking-${Date.now()}`;
    const entries = [
      { ts: new Date().toISOString(), sid, tool: 'Edit', action: 'edit:.ts', project: tempDir },
      { ts: new Date().toISOString(), sid, tool: 'Bash', action: 'git add -A', project: tempDir },
    ];
    writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // The hook reads from ~/.claude/usage-data/tool-sequences.jsonl (hardcoded to homedir).
    // We cannot easily override homedir, so this test verifies the blocking path
    // only if we can set HOME. On macOS, Node respects HOME for os.homedir().
    const result = runHook(sid, { HOME: tempDir });
    assert.equal(result.exitCode, 2, 'should exit with code 2 (blocking error)');
    assert.ok(result.stderr.includes('Quality Gate'), 'stderr should mention Quality Gate');
    assert.ok(
      result.stderr.includes('pnpm build') || result.stderr.includes('pnpm test'),
      'stderr should list missing verification steps',
    );

    // Clean up
    rmSync(usageDir, { recursive: true, force: true });
  });

  it('exits 0 when code was modified AND verification commands were run', () => {
    const usageDir = join(tempDir, '.claude', 'usage-data');
    mkdirSync(usageDir, { recursive: true });
    const jsonlPath = join(usageDir, 'tool-sequences.jsonl');
    const sid = `test-passing-${Date.now()}`;
    const entries = [
      { ts: new Date().toISOString(), sid, tool: 'Edit', action: 'edit:.ts', project: tempDir },
      { ts: new Date().toISOString(), sid, tool: 'Bash', action: 'pnpm build', project: tempDir },
      { ts: new Date().toISOString(), sid, tool: 'Bash', action: 'pnpm test', project: tempDir },
      { ts: new Date().toISOString(), sid, tool: 'Bash', action: 'pnpm lint', project: tempDir },
      {
        ts: new Date().toISOString(),
        sid,
        tool: 'Bash',
        action: 'git commit -m "fix"',
        project: tempDir,
      },
    ];
    writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const result = runHook(sid, { HOME: tempDir });
    assert.equal(result.exitCode, 0, 'should exit 0 when all checks passed');
    assert.equal(result.stdout, '', 'should produce no stdout');

    // Clean up
    rmSync(usageDir, { recursive: true, force: true });
  });
});
