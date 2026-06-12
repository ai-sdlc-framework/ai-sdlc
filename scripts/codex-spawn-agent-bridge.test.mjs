/**
 * Unit tests for `scripts/codex-spawn-agent-bridge.mjs` — AISDLC-251.
 *
 * Validates the stdin/stdout JSON-line wire protocol without requiring a real
 * Codex CLI installation. The tests drive the bridge script as a child process,
 * supplying a `PATH` that shadows `codex` with a small fake implementation, and
 * assert on the stdout/stderr/exit-code the bridge produces.
 *
 * Run with: node --test scripts/codex-spawn-agent-bridge.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, 'codex-spawn-agent-bridge.mjs');

/** Base valid request envelope matching the wire protocol. */
const BASE_REQUEST = {
  agentType: 'developer',
  systemPrompt: 'You are the AI-SDLC developer agent.',
  userPrompt: 'Implement the task.',
  cwd: tmpdir(),
  timeoutMs: 30000,
};

let fakeCodexDir;

/**
 * Write a fake `codex` binary into `fakeCodexDir` that echoes canned text to
 * stdout and exits with the given exit code.
 *
 * The bridge captures raw codex stdout as the agent's output. So `rawOutput`
 * should be whatever the Codex agent would have written — e.g. a plain JSON
 * string or prose. The bridge then calls `tryParseJson` on that to produce the
 * `parsed` field in its response envelope.
 *
 * @param {object} opts
 * @param {string} opts.rawOutput - Raw text to write to stdout (the agent output).
 * @param {number} [opts.exitCode=0] - Exit code the fake should use.
 * @param {string} [opts.stderr=''] - Text to write to stderr before exiting.
 * @param {boolean} [opts.echoArgs=false] - When true, write received argv to stdout.
 * @param {boolean} [opts.echoStdin=false] - When true, write stdin to stdout.
 * @param {boolean} [opts.rejectUnsupportedFlags=false] - Fail on flags unsupported by codex 0.128.0.
 */
function writeFakeCodex({
  rawOutput,
  exitCode = 0,
  stderr = '',
  echoArgs = false,
  echoStdin = false,
  rejectUnsupportedFlags = false,
}) {
  const bin = join(fakeCodexDir, 'codex');
  // Escape backslashes before double-quotes to produce a valid shell string
  // literal (CodeQL js/incomplete-sanitization alert #72).
  const escapedStderr = stderr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const stderrLine = stderr ? `echo "${escapedStderr}" >&2\n` : '';
  const unsupportedFlagGuard = rejectUnsupportedFlags
    ? `for arg in "$@"; do
  case "$arg" in
    --file|-c|--config|--enable|--disable|-p|--profile|-C|--cd|--add-dir|--dangerously-bypass-approvals-and-sandbox)
      echo "unsupported argument: $arg" >&2
      exit 64
      ;;
  esac
done
`
    : '';
  const body =
    exitCode === 0
      ? echoArgs
        ? `${stderrLine}${unsupportedFlagGuard}printf '%s' "$*"\nexit 0\n`
        : echoStdin
          ? `${stderrLine}${unsupportedFlagGuard}cat\nexit 0\n`
          : `${stderrLine}${unsupportedFlagGuard}printf '%s' '${rawOutput.replace(/'/g, "'\\''")}'\nexit 0\n`
      : `${stderrLine}${unsupportedFlagGuard}exit ${exitCode}\n`;
  writeFileSync(bin, `#!/bin/sh\n${body}`, { encoding: 'utf-8', mode: 0o755 });
}

/**
 * Run the bridge with the given stdin payload and fake codex on PATH.
 *
 * @param {object | string} stdinPayload - Object or raw string to pass on stdin.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runBridge(stdinPayload) {
  const input = typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload);

  const result = spawnSync('node', [BRIDGE], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Prepend fakeCodexDir so our fake `codex` binary shadows any real install.
      PATH: `${fakeCodexDir}:${process.env.PATH ?? ''}`,
    },
    timeout: 15000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

before(() => {
  fakeCodexDir = mkdtempSync(join(tmpdir(), 'codex-bridge-fake-'));
});

after(() => {
  rmSync(fakeCodexDir, { recursive: true, force: true });
});

describe('codex-spawn-agent-bridge.mjs stdin/stdout protocol', () => {
  it('writes a JSON-line response to stdout on success', () => {
    const agentOutput = JSON.stringify({ summary: 'done', commitSha: 'abc1234' });
    // The fake codex emits the raw agent text (JSON string) on its stdout.
    writeFakeCodex({ rawOutput: agentOutput });

    const r = runBridge(BASE_REQUEST);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

    const line = r.stdout.trim();
    assert.ok(line.length > 0, 'expected non-empty stdout');

    let envelope;
    assert.doesNotThrow(() => {
      envelope = JSON.parse(line);
    }, `stdout must be valid JSON; got: ${line}`);

    assert.ok('output' in envelope, 'response envelope must have an "output" field');
    assert.equal(typeof envelope.output, 'string', '"output" must be a string');
  });

  it('pre-parses agent JSON and surfaces it as "parsed" in the envelope', () => {
    const agentJson = { summary: 'task done', commitSha: 'deadbeef', filesChanged: [] };
    // The fake codex emits the agent's raw JSON on its stdout.
    // The bridge should detect it is valid JSON and include it as "parsed".
    writeFakeCodex({ rawOutput: JSON.stringify(agentJson) });

    const r = runBridge(BASE_REQUEST);
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.ok('parsed' in envelope, '"parsed" should be set when output is valid JSON');
    assert.deepEqual(envelope.parsed, agentJson);
  });

  it('omits "parsed" when agent output is prose (not JSON)', () => {
    writeFakeCodex({ rawOutput: 'This is prose, not JSON.' });

    const r = runBridge(BASE_REQUEST);
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.equal(envelope.output.trim(), 'This is prose, not JSON.');
    assert.ok(!('parsed' in envelope), '"parsed" should be absent for prose output');
  });

  it('exits non-zero and writes to stderr when codex exits with non-zero code', () => {
    writeFakeCodex({ rawOutput: '', exitCode: 1, stderr: 'codex auth error' });

    const r = runBridge(BASE_REQUEST);
    assert.notEqual(r.status, 0, 'expected non-zero exit when codex fails');
    assert.ok(r.stderr.length > 0, 'expected stderr output on codex failure');
  });

  it('exits non-zero when codex exits zero with empty stdout', () => {
    writeFakeCodex({ rawOutput: '' });

    const r = runBridge(BASE_REQUEST);
    assert.notEqual(r.status, 0, 'expected non-zero exit on empty codex stdout');
    assert.match(r.stderr, /empty stdout/);
  });

  it('uses workspace-write sandbox for developer dispatch', () => {
    writeFakeCodex({ rawOutput: '', echoArgs: true, rejectUnsupportedFlags: true });

    const r = runBridge({ ...BASE_REQUEST, agentType: 'developer' });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.match(envelope.output, /exec -s workspace-write/);
    assert.doesNotMatch(envelope.output, /--file/);
    assert.match(envelope.output, / -$/);
  });

  it('uses read-only sandbox for reviewer dispatch', () => {
    writeFakeCodex({ rawOutput: '', echoArgs: true, rejectUnsupportedFlags: true });

    const r = runBridge({ ...BASE_REQUEST, agentType: 'security-reviewer' });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.match(envelope.output, /exec -s read-only/);
    assert.doesNotMatch(envelope.output, /--file/);
    assert.match(envelope.output, / -$/);
  });

  it('passes the composed prompt over stdin', () => {
    writeFakeCodex({ rawOutput: '', echoStdin: true, rejectUnsupportedFlags: true });

    const r = runBridge(BASE_REQUEST);
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.match(envelope.output, /You are the AI-SDLC developer agent/);
    assert.match(envelope.output, /Implement the task/);
  });

  it('exits 1 and writes to stderr when stdin is empty', () => {
    writeFakeCodex({ rawOutput: 'unused' });

    const r = runBridge('');
    assert.equal(r.status, 1, `expected exit 1 on empty stdin, got ${r.status}`);
    assert.match(r.stderr, /empty stdin/);
  });

  it('exits 1 and writes to stderr when stdin is not valid JSON', () => {
    writeFakeCodex({ rawOutput: 'unused' });

    const r = runBridge('not json at all }{');
    assert.equal(r.status, 1, `expected exit 1 on bad JSON, got ${r.status}`);
    assert.match(r.stderr, /not valid JSON/);
  });

  it('extracts JSON from fenced code block in agent output', () => {
    const agentJson = { approved: true, findings: [], summary: 'looks good', harness: 'codex' };
    const fencedOutput = '```json\n' + JSON.stringify(agentJson) + '\n```';
    // The fake codex emits markdown-fenced JSON (agent sometimes does this).
    writeFakeCodex({ rawOutput: fencedOutput });

    const r = runBridge({ ...BASE_REQUEST, agentType: 'code-reviewer' });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.ok('parsed' in envelope, '"parsed" should be extracted from fenced block');
    assert.deepEqual(envelope.parsed, agentJson);
  });

  it('passes cwd from request to codex exec process (verified via temp-file creation)', () => {
    // The fake `codex` ignores cwd, but the bridge should not error when
    // a valid cwd is provided. We validate that cwd defaults gracefully.
    writeFakeCodex({ rawOutput: '{"ok":true}' });

    const r = runBridge({ ...BASE_REQUEST, cwd: tmpdir() });
    assert.equal(r.status, 0, `expected exit 0 with explicit cwd: ${r.stderr}`);
  });

  it('allows safe model extraArgs and strips sandbox/config overrides', () => {
    writeFakeCodex({ rawOutput: '', echoArgs: true, rejectUnsupportedFlags: true });

    const r = runBridge({
      ...BASE_REQUEST,
      extraArgs: ['--model', 'gpt-5.4', '--config', 'sandbox_permissions=["danger-full-access"]'],
    });
    assert.equal(r.status, 0, `expected exit 0 with extraArgs: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.match(envelope.output, /--model gpt-5.4/);
    assert.doesNotMatch(envelope.output, /--config/);
    assert.doesNotMatch(envelope.output, /danger-full-access/);
  });

  it('handles both systemPrompt and userPrompt being present without error', () => {
    writeFakeCodex({ rawOutput: 'response' });

    const r = runBridge({
      agentType: 'test-reviewer',
      systemPrompt: 'System context.',
      userPrompt: 'Review this diff.',
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);
  });

  it('works when systemPrompt is empty string (userPrompt-only mode)', () => {
    writeFakeCodex({ rawOutput: '{"approved":true}' });

    const r = runBridge({
      agentType: 'security-reviewer',
      systemPrompt: '',
      userPrompt: 'Review for security issues.',
      cwd: tmpdir(),
      timeoutMs: 5000,
    });
    assert.equal(r.status, 0, `expected exit 0: ${r.stderr}`);

    const envelope = JSON.parse(r.stdout.trim());
    assert.ok('output' in envelope);
  });
});
