/**
 * AI-SDLC operator-question gate (PreToolUse on AskUserQuestion; AISDLC-1443).
 *
 * Built as a classic plugin command hook, not a hooks module: checks 1 and 4
 * are deterministic and must run in every session (the hooks module in
 * `hooks/hierarchy/` arms only for hierarchy roles), and checks 2 and 3 run
 * the TypeScript judgment layer through `cli-judgment question-gate`, which a
 * module could not load either. The checks live in `lib/question-gate.js`.
 *
 * Fail posture: anything that goes wrong in checks 1 to 4 allows the question;
 * they are a nudge toward the documented decision protocol. The evidence gate
 * (AISDLC-1452, `lib/evidence-gate.js`) runs after them and refuses instead:
 * a question with no passing ledger, or whose ledger the checker could not
 * run, does not go out. Its one exception is a `Preference` header.
 */

'use strict';

const { spawnSync } = require('child_process');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const { readStdinSync } = require('./lib/read-stdin');
const { appendGateLog, findRoster, runQuestionGate } = require('./lib/question-gate');
const { runEvidenceGate } = require('./lib/evidence-gate');

const BIN = 'cli-judgment.mjs';
const JUDGE_TIMEOUT_MS = 8000;
const EVIDENCE_TIMEOUT_MS = 10000;

/** Path of a pipeline-cli bin: the env override, the plugin's install, else the monorepo copy. */
function resolvePipelineBin(bin, env = process.env, pluginDir = resolve(__dirname, '..')) {
  const candidates = [];
  if (env.PIPELINE_CLI_BIN) candidates.push(join(env.PIPELINE_CLI_BIN, bin));
  if (env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(
      join(env.CLAUDE_PLUGIN_ROOT, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', bin),
    );
  }
  candidates.push(join(pluginDir, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', bin));
  candidates.push(join(pluginDir, '..', 'pipeline-cli', 'bin', bin));
  return candidates.find((c) => existsSync(c));
}

/** Path of `cli-judgment`. */
function resolveJudgmentBin(env = process.env, pluginDir = resolve(__dirname, '..')) {
  return resolvePipelineBin(BIN, env, pluginDir);
}

/**
 * The evidence checker for `lib/evidence-gate.js`: `cli-decisions evidence check
 * <ledger> --draft <question text> --format json`, the AISDLC-1451 checker and
 * its hash. Returns `{ ok, failures }`, or null when it could not run.
 */
function makeEvidenceCheck(projectDir, env = process.env, run = spawnSync) {
  const bin = resolvePipelineBin('cli-decisions.mjs', env);
  if (!bin) return () => null;
  return (ledger, draftText) => {
    const dir = mkdtempSync(join(tmpdir(), 'qgate-draft-'));
    try {
      const draft = join(dir, 'draft.md');
      writeFileSync(draft, draftText);
      const res = run(
        process.execPath,
        [
          bin,
          '--work-dir',
          projectDir,
          'evidence',
          'check',
          resolve(projectDir, ledger),
          '--draft',
          draft,
          '--format',
          'json',
        ],
        { encoding: 'utf-8', timeout: EVIDENCE_TIMEOUT_MS },
      );
      if (!res) return null;
      const out = JSON.parse(String(res.stdout || '').trim() || 'null');
      return out && typeof out.ok === 'boolean' && Array.isArray(out.failures) ? out : null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
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
  if (result.decision !== 'allow') {
    appendGateLog(projectDir, result.records);
    return result;
  }
  const evidence = runEvidenceGate({
    toolInput: input.tool_input || {},
    check: makeEvidenceCheck(projectDir, env),
    sessionId: typeof input.session_id === 'string' ? input.session_id : '',
  });
  appendGateLog(projectDir, [...result.records, ...evidence.records]);
  return evidence.decision === 'deny' ? evidence : result;
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

module.exports = {
  resolvePipelineBin,
  resolveJudgmentBin,
  makeJudge,
  makeEvidenceCheck,
  resolveRole,
  main,
};
