/**
 * AI-SDLC operator-question gate (PreToolUse on AskUserQuestion; AISDLC-1443).
 *
 * Built as a classic plugin command hook, not a hooks module: checks 1 and 4
 * are deterministic and must run in every session (the hooks module in
 * `hooks/hierarchy/` arms only for hierarchy roles), and checks 2 and 3 run
 * the TypeScript judgment layer through `cli-judgment question-gate`, which a
 * module could not load either. The checks live in `lib/question-gate.js`.
 *
 * Fail posture: anything that goes wrong allows the question. The gate is a
 * nudge toward the documented decision protocol, not a security boundary, and a
 * crash must never stop a session from reaching its operator.
 */

'use strict';

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join, resolve } = require('path');
const { readStdinSync } = require('./lib/read-stdin');
const { appendGateLog, findRoster, runQuestionGate } = require('./lib/question-gate');

const BIN = 'cli-judgment.mjs';
const JUDGE_TIMEOUT_MS = 8000;

/** Path of `cli-judgment`: the env override, the plugin's install, else the monorepo copy. */
function resolveJudgmentBin(env = process.env, pluginDir = resolve(__dirname, '..')) {
  const candidates = [];
  if (env.PIPELINE_CLI_BIN) candidates.push(join(env.PIPELINE_CLI_BIN, BIN));
  if (env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(
      join(env.CLAUDE_PLUGIN_ROOT, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', BIN),
    );
  }
  candidates.push(join(pluginDir, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', BIN));
  candidates.push(join(pluginDir, '..', 'pipeline-cli', 'bin', BIN));
  return candidates.find((c) => existsSync(c));
}

/** Checks 2 and 3 through `cli-judgment question-gate`; null on any failure. */
function makeJudge(projectDir, env = process.env, run = spawnSync) {
  const bin = resolveJudgmentBin(env);
  if (!bin) return () => null;
  // Question text comes from the session; on an untrusted run it may echo
  // external text, so the judgment may not decide permissively there.
  const sourceKind = env.AI_SDLC_UNTRUSTED_RUN ? 'untrusted-external' : 'backlog';
  return (req) => {
    const res = run(
      process.execPath,
      [bin, 'question-gate', '--cwd', projectDir, '--source-kind', sourceKind],
      { input: JSON.stringify(req), encoding: 'utf-8', timeout: JUDGE_TIMEOUT_MS },
    );
    if (!res || res.status !== 0) return null;
    try {
      return JSON.parse(String(res.stdout || '').trim() || 'null');
    } catch {
      return null;
    }
  };
}

/** The hierarchy role of this session, or null outside the hierarchy. */
function resolveRole(input, env = process.env) {
  const boardDir = findRoster(input, env);
  if (!boardDir) return null;
  const { resolveSessionRole, ancestorPids } = require('./lib/hierarchy-role');
  const session = resolveSessionRole({ boardDir, pids: ancestorPids() });
  return session ? session.role : null;
}

function main(env = process.env) {
  if (String(env.AI_SDLC_QUESTION_GATE || '').toLowerCase() === 'off') return null;
  const input = JSON.parse(readStdinSync());
  if (!input || input.tool_name !== 'AskUserQuestion') return null;
  const projectDir = resolve(env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  let role = null;
  try {
    role = resolveRole(input, env);
  } catch {
    role = null;
  }
  const result = runQuestionGate({ input, role, judge: makeJudge(projectDir, env), env });
  appendGateLog(projectDir, result.records);
  return result;
}

if (require.main === module) {
  try {
    const result = main();
    if (result && result.decision === 'deny') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `AI-SDLC question gate: ${result.reason}`,
          },
        }) + '\n',
      );
    }
  } catch {
    // fail open: the question goes through
  }
  process.exit(0);
}

module.exports = { resolveJudgmentBin, makeJudge, resolveRole, main };
