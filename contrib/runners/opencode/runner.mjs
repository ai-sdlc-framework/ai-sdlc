#!/usr/bin/env node
/**
 * Standalone OpenCode agent runner for AI-SDLC issue dispatch.
 *
 * Community-contributed companion to the in-tree orchestrator runner
 * (`orchestrator/src/runners/opencode.ts`). Same dispatch contract —
 * spawn `opencode run --standalone --auto --format json`, collect the
 * result via git, commit it, emit ONE JSON result on stdout — plus one
 * thing the in-tree runner deliberately does NOT have: a contract retry
 * that resumes the SAME session via `--session <id>` when an attempt
 * died in a transport failure before producing final text.
 *
 * Targets the opencode v2 CLI contract (`>= 2.0.0`; `--version` output
 * `opencode v2.x.y`). Node >= 18, no build step, no dependencies.
 * `--standalone` is always passed — never attach to a background service.
 *
 * Usage:
 *   node runner.mjs --workdir <path> --issue <id> --title <text>
 *     [--body <text>] [--model <ref>] [--agent <name>] [--branch <name>]
 *     [--max-files <n>] [--blocked-paths a/**,b/**] [--timeout <dur|ms>]
 *     [--retries <n>]
 *
 * Env: OPENCODE_BIN, OPENCODE_MODEL, AI_SDLC_MODEL, OPENCODE_AGENT,
 *      AI_SDLC_RUNNER_TIMEOUT, AI_SDLC_LINT_COMMAND, AI_SDLC_FORMAT_COMMAND,
 *      AI_SDLC_TYPECHECK_COMMAND, AI_SDLC_COMMIT_TEMPLATE, AI_SDLC_CO_AUTHOR,
 *      AI_SDLC_TELEMETRY_DIR (all optional)
 *
 * --max-files / --blocked-paths are ENFORCED against the changed-file list
 * BEFORE anything is staged or committed (violation => success:false, no commit).
 *
 * Exit: 0 = dispatch succeeded, 1 = failed. Diagnostics on stderr.
 * Result JSON on stdout:
 *   { success, sessionID, filesChanged, summary, error?, commitSha?,
 *     tokenUsage?, attempts }
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const log = (msg) => process.stderr.write(`[ai-sdlc:opencode-runner] ${msg}\n`);

/* ── CLI + config ──────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return args;
}

function parseDuration(s) {
  const m = String(s ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] || 'ms']);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || !args.workdir || !args.issue || !args.title) {
  log(
    'usage: runner.mjs --workdir <path> --issue <id> --title <text> ' +
      '[--body <text>] [--model <ref>] [--agent <name>] [--branch <name>] ' +
      '[--max-files <n>] [--blocked-paths a/**,b/**] [--timeout <dur|ms>] [--retries <n>]',
  );
  process.exit(args.help || args.h ? 0 : 1);
}

const env = process.env;
const WORKDIR = resolve(String(args.workdir));
const ISSUE_ID = String(args.issue);
const ISSUE_TITLE = String(args.title);
const ISSUE_BODY = typeof args.body === 'string' ? args.body : '';
const MAX_FILES = Number(args['max-files']) > 0 ? Number(args['max-files']) : 10;
const BLOCKED =
  typeof args['blocked-paths'] === 'string'
    ? args['blocked-paths']
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const RETRIES = Math.max(0, Number(args.retries) || 0);
const TIMEOUT_MS =
  parseDuration(typeof args.timeout === 'string' ? args.timeout : env.AI_SDLC_RUNNER_TIMEOUT) ||
  900_000; // 15 minutes, same default as the in-tree runner

function onPath(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name]).toString();
    return out.trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

const BIN =
  env.OPENCODE_BIN || onPath('opencode') || join(homedir(), '.opencode', 'bin', 'opencode');
const MODEL =
  (typeof args.model === 'string' && args.model) ||
  env.OPENCODE_MODEL ||
  env.AI_SDLC_MODEL ||
  undefined;
const AGENT =
  (typeof args.agent === 'string' ? args.agent : undefined) || env.OPENCODE_AGENT || undefined;

const model = MODEL ? (MODEL.includes('/') ? MODEL : `anthropic/${MODEL}`) : undefined;

/* ── Prompt (mirrors the in-tree issue-framing prompt) ────────────── */

function buildPrompt() {
  const lintCmd = env.AI_SDLC_LINT_COMMAND;
  const fmtCmd = env.AI_SDLC_FORMAT_COMMAND;
  const typecheckCmd = env.AI_SDLC_TYPECHECK_COMMAND;
  const num = /^\d+$/.test(ISSUE_ID) ? '#' : '';
  const lines = [
    `You are fixing issue ${num}${ISSUE_ID}: ${ISSUE_TITLE}`,
    '',
    '## Issue Description',
    ISSUE_BODY || '(no description)',
    '',
    '## Instructions',
    '1. Read the relevant source files to understand the codebase.',
    '2. Implement the fix or feature described in the issue.',
    '3. Write or update tests to cover your changes.',
  ];
  let step = 3;
  if (fmtCmd)
    lines.push(`${++step}. Run \`${fmtCmd}\` and fix any formatting problems it reports.`);
  if (lintCmd) lines.push(`${++step}. Run \`${lintCmd}\` and fix any lint problems it reports.`);
  if (typecheckCmd)
    lines.push(`${++step}. Run \`${typecheckCmd}\` and fix any type errors it reports.`);
  lines.push(
    `${++step}. NEVER modify files matching the blocked paths below — violations are detected and rejected.`,
    `${++step}. Keep your changes to at most ${MAX_FILES} files.`,
    '',
    '## Constraints (enforced — violations will be automatically rejected)',
    `- Maximum files to change: ${MAX_FILES}`,
    '- Tests required: true',
    `- Blocked paths (NEVER modify — changes will be rejected): ${BLOCKED.join(', ') || 'none'}`,
    '',
    'The dispatch harness reviews your diff and commits it — do not push branches or open PRs.',
  );
  return lines.join('\n');
}

function resumePrompt(err) {
  return (
    `Your previous attempt ended in a transport failure (${err}). ` +
    'Continue exactly where you left off and finish the task. Do not redo work that is already done.'
  );
}

/* ── git helpers (self-contained mirror of orchestrator git-utils) ── */

async function gitExec(dir, gitArgs) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...gitArgs], {
    cwd: dir,
    env: cleanGitEnv(),
  });
  return stdout.trim();
}

function cleanGitEnv() {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k];
  return e;
}

async function snapshotWorktree(dir) {
  try {
    const [untracked, modified] = await Promise.all([
      gitExec(dir, ['ls-files', '--others', '--exclude-standard']),
      gitExec(dir, ['diff', '--name-only']),
    ]);
    return {
      untracked: new Set(untracked.split('\n').filter(Boolean)),
      modified: new Set(modified.split('\n').filter(Boolean)),
    };
  } catch {
    return { untracked: new Set(), modified: new Set() };
  }
}

async function detectChangedFiles(dir, baseline) {
  const [diffOut, stagedOut, untrackedOut] = await Promise.all([
    gitExec(dir, ['diff', '--name-only']),
    gitExec(dir, ['diff', '--name-only', '--cached']),
    gitExec(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const allUntracked = untrackedOut.split('\n').filter(Boolean);
  const agentUntracked = baseline
    ? allUntracked.filter((f) => !baseline.untracked.has(f))
    : allUntracked;
  const uncommitted = [...new Set([...diffOut, ...stagedOut, ...agentUntracked].filter(Boolean))];

  let committedFiles = [];
  let agentAlreadyCommitted = false;
  try {
    const mergeBase = await gitExec(dir, ['merge-base', 'HEAD', 'origin/main']);
    if (mergeBase) {
      committedFiles = (await gitExec(dir, ['diff', '--name-only', `${mergeBase}..HEAD`]))
        .split('\n')
        .filter(Boolean);
      agentAlreadyCommitted = committedFiles.length > 0 && uncommitted.length === 0;
    }
  } catch {
    /* no origin/main — treat everything uncommitted as the diff */
  }
  return {
    filesChanged: agentAlreadyCommitted ? committedFiles : uncommitted,
    agentAlreadyCommitted,
  };
}

async function resolveMainCloneRoot(workDir) {
  try {
    const out = await gitExec(workDir, ['rev-parse', '--git-common-dir']);
    if (!out) return undefined;
    return dirname(isAbsolute(out) ? out : resolve(workDir, out));
  } catch {
    return undefined;
  }
}

/* ── Per-dispatch OPENCODE_CONFIG_CONTENT ──────────────────────────── */

function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

const SCRIPT_EXT_RE = /\.(?:[cm]?js|ts|py|sh|rb)$/i;
const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'tsx',
  'ruby',
  'bash',
  'sh',
]);

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isRelativePathArg(part) {
  return !part.startsWith('-') && !isAbsolute(part) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(part);
}

function buildDispatchConfig(workDir, mainRoot) {
  // opencode v2 merges this env-var document LAST (per-key): permission and
  // agent entries from the project's opencode.json survive; we override
  // autoupdate/snapshot and re-anchor the local MCP servers at the main
  // clone (dist/ is git-ignored, so relative paths dangle in worktrees).
  const config = { autoupdate: false, snapshot: false };
  if (mainRoot) {
    try {
      let raw;
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        try {
          raw = readFileSync(join(workDir, name), 'utf-8');
          break;
        } catch {
          /* try the next candidate */
        }
      }
      if (raw) {
        const parsed = parseJsonc(raw);
        if (parsed && typeof parsed === 'object' && parsed.mcp && typeof parsed.mcp === 'object') {
          const mcp = {};
          for (const [name, entry] of Object.entries(parsed.mcp)) {
            if (
              !entry ||
              typeof entry !== 'object' ||
              Array.isArray(entry) ||
              entry.type === 'remote' ||
              !Array.isArray(entry.command)
            ) {
              mcp[name] = entry;
              continue;
            }
            const exe =
              typeof entry.command[0] === 'string' ? entry.command[0].split(/[\\/]/).pop() : '';
            const script = entry.command[1];
            if (
              INTERPRETERS.has(exe) &&
              typeof script === 'string' &&
              isRelativePathArg(script) &&
              SCRIPT_EXT_RE.test(script) &&
              !isFile(resolve(mainRoot, script)) &&
              !isFile(resolve(workDir, script))
            ) {
              continue; // unbuilt everywhere — drop rather than dangle
            }
            // Re-anchor ONLY args that resolve to an existing file under the
            // main clone; everything else (npx/uvx/docker args, @scope/pkg,
            // URLs, owner/repo, --flag=a/b) is left untouched.
            mcp[name] = {
              ...entry,
              command: entry.command.map((part, idx) => {
                if (idx === 0 || typeof part !== 'string' || !isRelativePathArg(part)) return part;
                const anchored = resolve(mainRoot, part);
                return isFile(anchored) ? anchored : part;
              }),
            };
          }
          config.mcp = mcp;
        }
      }
    } catch {
      /* unreadable project config — dispatch without MCP remapping */
    }
  }
  return JSON.stringify(config);
}

/* ── Spawn + NDJSON stream ─────────────────────────────────────────── */

function runOpenCode({ prompt, sessionID, mainRoot }) {
  const state = {
    sessionID: sessionID,
    summaryText: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    streamError: undefined,
  };
  const list = ['run', '--standalone', '--auto', '--format', 'json', '--model', model];
  if (sessionID) list.push('--session', sessionID);
  if (AGENT) list.push('--agent', AGENT);
  // `--` ends option parsing so a prompt starting with `-` is never read as a flag.
  list.push('--', prompt);

  return new Promise((resolveP, rejectP) => {
    const startedAt = Date.now();
    log(
      `spawning: ${BIN} ${list.filter((a) => a !== prompt).join(' ')} (prompt ${prompt.length} chars)`,
    );
    log(`workDir: ${WORKDIR}`);

    const child = spawn(BIN, list, {
      cwd: WORKDIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        AI_SDLC_PROJECT_ROOT: WORKDIR,
        AI_SDLC_ACTIVE_TASK_ID: ISSUE_ID,
        OPENCODE_CONFIG_CONTENT: buildDispatchConfig(WORKDIR, mainRoot),
      },
      timeout: TIMEOUT_MS,
    });

    let lastActivity = Date.now();
    let lineBuf = '';
    const errBuf = [];
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const idle = Math.round((Date.now() - lastActivity) / 1000);
      log(`heartbeat: ${elapsed}s elapsed, ${idle}s idle`);
    }, 30_000);

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise outside JSON mode — ignore
      }
      if (typeof parsed.sessionID === 'string' && !state.sessionID) {
        state.sessionID = parsed.sessionID;
      }
      const part = parsed.part || {};
      if (parsed.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        state.summaryText = part.text;
      } else if (parsed.type === 'step_finish' && part.tokens && typeof part.tokens === 'object') {
        state.inputTokens += part.tokens.input || 0;
        state.outputTokens += (part.tokens.output || 0) + (part.tokens.reasoning || 0);
        state.cacheReadTokens += part.tokens.cache?.read || 0;
      } else if (parsed.type === 'error') {
        state.streamError = parsed.error?.message || 'unknown stream error';
      }
    };

    child.stdout.on('data', (d) => {
      lastActivity = Date.now();
      lineBuf += d.toString('utf-8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', (d) => {
      lastActivity = Date.now();
      errBuf.push(d);
      process.stderr.write(d);
    });
    child.on('close', (code, signal) => {
      clearInterval(heartbeat);
      if (lineBuf.trim()) consumeLine(lineBuf);
      const stderr = Buffer.concat(errBuf).toString('utf-8');
      if (code === 0) {
        resolveP({ ...state, stderr });
      } else {
        const failure = new Error(
          `opencode exited with code ${code}${signal ? ` (signal ${signal})` : ''}: ` +
            `${stderr.slice(-800) || state.streamError || state.summaryText || ''}`,
        );
        // Carry the captured session + partial stream state on the error so the
        // retry loop can resume the SAME session (--session) after a dead run.
        failure.sessionID = state.sessionID;
        failure.streamState = state;
        rejectP(failure);
      }
    });
    child.on('error', (err) => {
      clearInterval(heartbeat);
      rejectP(new Error(`opencode spawn error: ${err.message}`));
    });
  });
}

/** Authoritative tokens from the session DB (fast local read, no model call). */
async function fetchSessionTokens(sessionID) {
  if (!sessionID) return undefined;
  try {
    const { stdout } = await execFileAsync(BIN, ['session', 'export', '--standalone', sessionID], {
      cwd: WORKDIR,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const t = JSON.parse(stdout)?.info?.tokens;
    if (!t || typeof t !== 'object') return undefined;
    return {
      inputTokens: t.input || 0,
      outputTokens: (t.output || 0) + (t.reasoning || 0),
      cacheReadTokens: t.cache?.read || undefined,
    };
  } catch {
    return undefined;
  }
}

function streamTokens(run) {
  if (!run || (!run.inputTokens && !run.outputTokens)) return undefined;
  return {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens || undefined,
  };
}

/* ── Constraint enforcement (--max-files / --blocked-paths) ───────── */

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (/[.+?^${}()|[\]\\]/.test(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Returns a violation message, or undefined when filesChanged is within bounds. */
function constraintViolation(files) {
  const blocked = files.filter((f) => BLOCKED.some((g) => globToRegExp(g).test(f)));
  if (blocked.length > 0) {
    return `blocked paths modified (rejected before commit): ${blocked.slice(0, 10).join(', ')}`;
  }
  if (files.length > MAX_FILES) {
    return `${files.length} files changed, exceeding --max-files ${MAX_FILES} (rejected before commit)`;
  }
  return undefined;
}

/* ── Main: dispatch (with one contract retry), commit, report ─────── */

function emit(result, ok) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(ok ? 0 : 1);
}

const main = (async () => {
  if (!model) {
    emit(
      {
        success: false,
        sessionID: undefined,
        filesChanged: [],
        summary: 'Agent execution failed',
        error: 'No model — set --model, OPENCODE_MODEL, or AI_SDLC_MODEL (provider/model)',
        attempts: 0,
      },
      false,
    );
  }

  const baseline = await snapshotWorktree(WORKDIR);
  const mainRoot = await resolveMainCloneRoot(WORKDIR);
  const commitTemplate = env.AI_SDLC_COMMIT_TEMPLATE || 'fix: {issueNumber} {issueTitle}';
  const coAuthor = env.AI_SDLC_CO_AUTHOR || 'ai-sdlc';
  const fmtCmd = env.AI_SDLC_FORMAT_COMMAND;
  const lintCmd = env.AI_SDLC_LINT_COMMAND;
  const autoFix = async () => {
    for (const cmd of [fmtCmd, lintCmd]) {
      if (!cmd) continue;
      const [bin, ...a] = cmd.split(' ');
      try {
        await execFileAsync(bin, a, { cwd: WORKDIR });
      } catch {
        /* auto-fix is best-effort, like the in-tree runner */
      }
    }
  };

  let sessionID;
  let lastRun;
  let lastError;
  let attempts = 0;

  for (let attempt = 1; attempt <= 1 + RETRIES; attempt++) {
    attempts = attempt;
    const promptForAttempt = attempt === 1 ? buildPrompt() : resumePrompt(String(lastError));
    log(
      `attempt ${attempt}/${1 + RETRIES}${sessionID ? ` (resuming session ${sessionID})` : ' (fresh session)'}`,
    );
    try {
      lastRun = await runOpenCode({ prompt: promptForAttempt, sessionID, mainRoot });
      sessionID = lastRun.sessionID ?? sessionID;
      // Exit 0 with a stream-level transport error and no final text is a
      // failure, not a success (an empty diff would silently read as
      // "no changes") — this is the contract-retry trigger.
      if (lastRun.streamError && !(lastRun.summaryText ?? '').trim()) {
        throw new Error(`stream error: ${lastRun.streamError}`);
      }
      break;
    } catch (err) {
      lastError = err;
      sessionID = err?.sessionID ?? sessionID;
      lastRun = err?.streamState ?? lastRun;
      log(`attempt ${attempt} failed: ${String(err.message ?? err).slice(0, 200)}`);
      if (attempt <= RETRIES) continue;
      emit(
        {
          success: false,
          sessionID,
          filesChanged: [],
          summary: 'Agent execution failed',
          error: String(lastError?.message ?? lastError).slice(0, 1000),
          tokenUsage: (await fetchSessionTokens(sessionID)) ?? streamTokens(lastRun),
          attempts,
        },
        false,
      );
    }
  }

  const tokenUsage = (await fetchSessionTokens(sessionID)) ?? streamTokens(lastRun);
  const { filesChanged, agentAlreadyCommitted } = await detectChangedFiles(WORKDIR, baseline);

  if (filesChanged.length === 0) {
    emit(
      {
        success: false,
        sessionID,
        filesChanged: [],
        summary: 'Agent made no changes',
        error: 'No files were modified',
        tokenUsage,
        attempts,
      },
      false,
    );
  }

  // Enforced BEFORE anything is staged or committed; the offending changes
  // are left in the worktree for the operator (never auto-reverted).
  const violation = constraintViolation(filesChanged);
  if (violation) {
    emit(
      {
        success: false,
        sessionID,
        filesChanged,
        summary: 'Agent violated dispatch constraints',
        error: violation,
        tokenUsage,
        attempts,
      },
      false,
    );
  }

  if (agentAlreadyCommitted) {
    emit(
      {
        success: true,
        sessionID,
        filesChanged,
        summary: (lastRun.summaryText ?? '').slice(0, 2000),
        tokenUsage,
        attempts,
      },
      true,
    );
  }

  await gitExec(WORKDIR, ['add', '--', ...filesChanged]);
  await autoFix();
  await gitExec(WORKDIR, ['add', '--', ...filesChanged]);
  const commitMsg = commitTemplate
    .replaceAll('{issueNumber}', ISSUE_ID)
    .replaceAll('{issueTitle}', ISSUE_TITLE);
  try {
    await gitExec(WORKDIR, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
  } catch {
    await autoFix();
    await gitExec(WORKDIR, ['add', '--', ...filesChanged]);
    await gitExec(WORKDIR, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
  }
  const commitSha = await gitExec(WORKDIR, ['rev-parse', 'HEAD']);

  emit(
    {
      success: true,
      sessionID,
      filesChanged,
      summary: (lastRun.summaryText ?? '').slice(0, 2000),
      commitSha,
      tokenUsage,
      attempts,
    },
    true,
  );
})();

main.catch((err) => {
  emit(
    {
      success: false,
      sessionID: undefined,
      filesChanged: [],
      summary: 'Agent execution failed',
      error: String(err?.message ?? err).slice(0, 1000),
      attempts: 0,
    },
    false,
  );
});
