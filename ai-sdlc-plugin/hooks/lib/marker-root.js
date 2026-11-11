/**
 * Resolves the directory under which SubagentStart session markers are written
 * (AISDLC-1260).
 *
 * In a Pattern C adopter the session cwd is the parent checkout, so writing
 * `.ai-sdlc/subagent-sessions/` there leaves untracked files that make Step 0.5
 * refuse. The marker goes to the task worktree named by `AI_SDLC_ACTIVE_TASK_ID`
 * or a `.active-task` sentinel; with neither, it falls back to `projectDir`,
 * whose `.ai-sdlc/subagent-sessions/` is gitignored by `ai-sdlc init`.
 * Readers (`markerSearchRoots`) search both the worktree and the main checkout.
 */
'use strict';

const { existsSync, readFileSync, statSync } = require('fs');
const { join, resolve, sep } = require('path');

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function worktreeFor(projectDir, id) {
  if (!id || !SAFE_ID.test(id) || id === '.' || id === '..') return null;
  const wanted = id.toLowerCase();
  const wtRoot = join(projectDir, '.worktrees');
  const exact = join(wtRoot, id);
  if (isDir(exact)) return exact;
  const lower = join(wtRoot, wanted);
  return isDir(lower) ? lower : null;
}

function readSentinel(file) {
  try {
    return readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} projectDir session project root
 * @param {{env?: object, cwd?: string}} [opts]
 * @returns {string} directory whose `.ai-sdlc/subagent-sessions/` receives markers
 */
function resolveMarkerRoot(projectDir, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const project = resolve(projectDir);

  // 1. cwd inside `<project>/.worktrees/<id>/` (the worktree names itself).
  const wtPrefix = join(project, '.worktrees') + sep;
  const abs = resolve(cwd);
  if (abs.startsWith(wtPrefix)) {
    const id = abs.slice(wtPrefix.length).split(sep)[0];
    const wt = join(project, '.worktrees', id);
    if (id && isDir(wt)) return wt;
  }

  // 2. Explicit env var.
  const fromEnv = worktreeFor(project, (env.AI_SDLC_ACTIVE_TASK_ID || '').trim());
  if (fromEnv) return fromEnv;

  // 3. Project-level `.active-task` sentinel (legacy location).
  const sentinel = join(project, '.worktrees', '.active-task');
  if (existsSync(sentinel)) {
    const fromSentinel = worktreeFor(project, readSentinel(sentinel));
    if (fromSentinel) return fromSentinel;
  }

  // 4. Gitignored fallback in the project dir.
  return project;
}

module.exports = { resolveMarkerRoot };
