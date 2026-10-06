#!/usr/bin/env node
/**
 * Decision logic for `.github/workflows/require-issue-link.yml` (AISDLC-700).
 *
 * Pure `decide()` plus a thin CLI. The workflow runs the CLI from the BASE
 * checkout (pull_request_target never checks out PR code) and passes every
 * pull-request-controlled value through environment variables, so the title
 * and body are only ever treated as data.
 *
 * Rules, in order — the first match wins and names itself in `description`:
 *   1. bypass label `ci:no-issue-required`
 *   2. linked issue / backlog reference keyword in the title or body
 *   3. the diff adds, modifies or moves a file under backlog/tasks/ or
 *      backlog/completed/
 *   4. the title carries a task id in the commit-convention form `(AISDLC-N)`
 *      and that task exists as a file on the base ref or in the PR's diff
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BYPASS_LABEL = 'ci:no-issue-required';
export const CONTRIBUTING_URL =
  'https://github.com/ai-sdlc/ai-sdlc/blob/main/CONTRIBUTING.md#issue-first-workflow';

const LINK_PATTERN =
  /(closes|fixes|resolves|references)\s+(([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)?#[0-9]+|AISDLC-[0-9]+(\.[0-9]+)?)/i;
const BACKLOG_PATH = /^backlog\/(tasks|completed)\/./;
const TITLE_TASK_ID = /\(([A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*)\)/g;

export function titleTaskIds(title) {
  return [...String(title ?? '').matchAll(TITLE_TASK_ID)].map((m) => m[1]);
}

export function touchesBacklogTask(changedFiles) {
  return changedFiles.some((f) => BACKLOG_PATH.test(f));
}

/** True when a task file for `taskId` is among `files` (repo-relative paths). */
export function hasTaskFile(files, taskId) {
  const prefix = `${taskId.toLowerCase()} - `;
  return files.some((f) => {
    const m = /^backlog\/(?:tasks|completed)\/([^/]+)$/.exec(f);
    return m !== null && m[1].toLowerCase().startsWith(prefix);
  });
}

/**
 * @param {{title?: string, body?: string, labels?: string[], changedFiles?: string[],
 *          baseTaskFiles?: string[]}} input
 *   baseTaskFiles: repo-relative `backlog/tasks|completed/*` paths on the base ref.
 * @returns {{state: 'success'|'failure', rule: string, description: string}}
 */
export function decide({
  title = '',
  body = '',
  labels = [],
  changedFiles = [],
  baseTaskFiles = [],
}) {
  if (labels.some((l) => l.toLowerCase() === BYPASS_LABEL)) {
    return {
      state: 'success',
      rule: 'bypass',
      description: `bypass: ${BYPASS_LABEL} label present`,
    };
  }
  if (LINK_PATTERN.test(`${title}\n${body}`)) {
    return { state: 'success', rule: 'issue', description: 'linked issue reference found' };
  }
  if (touchesBacklogTask(changedFiles)) {
    return {
      state: 'success',
      rule: 'backlog-task',
      description: 'backlog task: PR adds or changes a file under backlog/',
    };
  }
  const known = [...baseTaskFiles, ...changedFiles];
  const id = titleTaskIds(title).find((candidate) => hasTaskFile(known, candidate));
  if (id) {
    return {
      state: 'success',
      rule: 'backlog-task',
      description: `backlog task: title references existing task ${id}`,
    };
  }
  return {
    state: 'failure',
    rule: 'none',
    description: 'add Closes/Fixes/Resolves #N to link an issue',
  };
}

function listBaseTaskFiles(root) {
  const out = [];
  for (const dir of ['backlog/tasks', 'backlog/completed']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) out.push(`${dir}/${name}`);
  }
  return out;
}

function main(env) {
  const decision = decide({
    title: env.PR_TITLE ?? '',
    body: env.PR_BODY ?? '',
    labels: JSON.parse(env.PR_LABELS || '[]'),
    changedFiles: (env.PR_FILES ?? '').split('\n').filter(Boolean),
    baseTaskFiles: listBaseTaskFiles(env.BASE_ROOT || process.cwd()),
  });
  process.stdout.write(
    `${JSON.stringify({ ...decision, targetUrl: decision.state === 'failure' ? CONTRIBUTING_URL : '' })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.env);
