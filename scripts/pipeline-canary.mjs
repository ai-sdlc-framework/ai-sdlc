#!/usr/bin/env node
/**
 * Post-merge pipeline canary (AISDLC-1023).
 *
 * After a merge broke Step 10.5 (2026-10-21), nothing on main noticed: the
 * first-run smoke drives the legacy path and Linux hides the filesystem-case
 * bug. This builds a throwaway fixture repo (local bare remote, a fake task, a
 * fake attestation, a review ledger written by the REAL writer) and runs the
 * code the executors run next: Step 10.5 (`preSignRebase`) and then the push of
 * Step 11 against the local bare remote. `gh` is never called, so nothing is
 * stubbed on the network side. It exits non-zero naming the step and cause.
 *
 * Prerequisite: `pnpm --filter @ai-sdlc/pipeline-cli... build`.
 *
 * Usage:
 *   node scripts/pipeline-canary.mjs [--pipeline-cli <dir>]
 *
 * `--pipeline-cli` points at another checkout's pipeline-cli (for example one
 * at commit fce26ed50) so the canary can be shown to reproduce a past bug.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASK_ID = 'AISDLC-9001';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'canary',
  GIT_AUTHOR_EMAIL: 'canary@example.com',
  GIT_COMMITTER_NAME: 'canary',
  GIT_COMMITTER_EMAIL: 'canary@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Real git; the content-hash oracle (a node script) is answered with a constant. */
async function runner(command, args, opts) {
  if (command !== 'git') return { stdout: 'H\n', stderr: '', code: 0 };
  try {
    return { stdout: git(opts?.cwd, ...args), stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

/** Build origin + a task clone on a feature branch with origin/main one commit ahead. */
function buildFixture(base) {
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  const other = join(base, 'other');
  git(base, 'init', '--bare', '-b', 'main', origin);
  git(base, 'clone', origin, clone);
  writeFileSync(join(clone, 'README.md'), 'canary\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'init');
  git(clone, 'push', 'origin', 'HEAD:refs/heads/main');
  git(clone, 'checkout', '-b', 'ai-sdlc/aisdlc-9001-canary');
  mkdirSync(join(clone, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(
    join(clone, 'backlog', 'tasks', `${TASK_ID.toLowerCase()} - canary.md`),
    `---\nid: ${TASK_ID}\ntitle: canary\nstatus: In Progress\n---\n`,
  );
  mkdirSync(join(clone, '.ai-sdlc', 'attestations'), { recursive: true });
  writeFileSync(join(clone, '.ai-sdlc', 'attestations', 'canary.v6.dsse.json'), '{}\n');
  writeFileSync(join(clone, 'feature.txt'), 'f\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'feature work');
  git(base, 'clone', origin, other);
  writeFileSync(join(other, 'main-moved.txt'), 'm\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'main moves');
  git(other, 'push', 'origin', 'HEAD:refs/heads/main');
  return clone;
}

/**
 * Run the canary. Returns `{ ok: true }` or `{ ok: false, step, cause, reason }`.
 * `pipelineCli` is the pipeline-cli package directory whose `dist` is exercised.
 */
export async function runCanary({ pipelineCli = join(ROOT, 'pipeline-cli') } = {}) {
  const dist = join(pipelineCli, 'dist');
  if (!existsSync(join(dist, 'next-step', 'ship.js'))) {
    return { ok: false, step: 'setup', cause: 'not-built', reason: `${dist} is not built` };
  }
  const { preSignRebase } = await import(pathToFileURL(join(dist, 'next-step', 'ship.js')).href);
  const { appendReviewLedgerRecord } = await import(
    pathToFileURL(join(dist, 'attestation', 'reviews-ledger.js')).href
  );
  const base = mkdtempSync(join(tmpdir(), 'pipeline-canary-'));
  try {
    const clone = buildFixture(base);
    appendReviewLedgerRecord(
      {
        taskId: TASK_ID,
        prNumber: null,
        commitSha: 'a'.repeat(40),
        iteration: 1,
        role: 'code',
        harness: 'claude-code',
        timestamp: '2026-10-22T00:00:00.000Z',
        verdict: 'approved',
        findings: [],
      },
      clone,
    );
    const noop = () => {};
    const ctx = {
      workDir: clone,
      runner,
      env: { ...process.env },
      homeDir: base,
      now: () => new Date(),
      logger: { info: noop, warn: noop, error: noop, progress: noop },
      cliBinDir: join(pipelineCli, 'bin'),
      pluginScriptsDir: join(ROOT, 'ai-sdlc-plugin', 'scripts'),
      filesDir: join(base, 'files'),
      statePath: join(base, 'state.json'),
      exists: existsSync,
    };
    const state = { taskId: TASK_ID, taskIdLower: TASK_ID.toLowerCase(), worktreePath: clone };
    const rebase = await preSignRebase(ctx, state, () => null);
    if (rebase.kind === 'failed') {
      return {
        ok: false,
        step: 'step-10.5',
        cause: rebase.cause ?? 'failed',
        reason: rebase.reason,
      };
    }
    const tracked = git(clone, 'ls-files', '--', '.ai-sdlc/reviews/').trim();
    if (tracked !== `.ai-sdlc/reviews/${TASK_ID.toLowerCase()}.jsonl`) {
      return {
        ok: false,
        step: 'step-10.5',
        cause: 'ledger-not-tracked',
        reason: `review ledger is not tracked after Step 10.5 (tracked: "${tracked}")`,
      };
    }
    // Step 11 up to the PR: the push, against the local bare remote (gh is not called).
    try {
      git(clone, 'push', '-u', 'origin', 'HEAD:refs/heads/ai-sdlc/aisdlc-9001-canary');
    } catch (err) {
      return {
        ok: false,
        step: 'step-11',
        cause: 'push-failed',
        reason: String(err.stderr ?? err.message).trim(),
      };
    }
    return { ok: true };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  const i = process.argv.indexOf('--pipeline-cli');
  const pipelineCli = i > 0 ? resolve(process.argv[i + 1]) : undefined;
  const result = await runCanary(pipelineCli ? { pipelineCli } : {});
  if (result.ok) {
    console.log('[pipeline-canary] PASS: Step 10.5 to Step 11 reached with no cause');
    return 0;
  }
  console.error(
    `[pipeline-canary] FAIL step=${result.step} cause=${result.cause}: ${result.reason}`,
  );
  console.error(`[pipeline-canary-result] ${JSON.stringify(result)}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[pipeline-canary] FAIL step=setup cause=exception: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
