#!/usr/bin/env node
/**
 * AISDLC-1024: claim-side half of the pipeline hotfix lane.
 *
 *   node hotfix-pipeline-ref.mjs <task-id>
 *
 * Prints the sha to export as AI_SDLC_PIPELINE_REF, or nothing. A sha is printed only when
 * the task carries the `pipeline-hotfix` label, `.ai-sdlc/dispatch/pipeline-known-good.json`
 * (written by the canary green handler) names a sha, and that sha differs from HEAD. Any
 * other case prints nothing, so the default stays "run on HEAD". Never fails the run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOTFIX_LABEL = 'pipeline-hotfix';
export const KNOWN_GOOD_REL = path.join('.ai-sdlc', 'dispatch', 'pipeline-known-good.json');

/** Labels from a backlog task's front matter (inline `[a, b]` or a `- a` list). */
export function parseLabels(markdown) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
  const inline = /^labels:\s*\[(.*)\]\s*$/m.exec(fm);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const block = /^labels:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(fm);
  if (!block) return [];
  return block[1]
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[ \t]+-\s*/, '')
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    )
    .filter(Boolean);
}

/** The sha to pin, or '' when the task runs on HEAD. */
export function hotfixPipelineRef({ labels, knownGoodJson, headSha }) {
  if (!labels.includes(HOTFIX_LABEL)) return '';
  let sha;
  try {
    sha = JSON.parse(knownGoodJson).sha;
  } catch {
    return '';
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) return '';
  if (headSha.startsWith(sha) || sha.startsWith(headSha)) return '';
  return sha;
}

function main(taskId, root) {
  const dir = path.join(root, 'backlog', 'tasks');
  const file = existsSync(dir)
    ? readdirSync(dir).find((f) => f.toLowerCase().startsWith(`${taskId.toLowerCase()} -`))
    : undefined;
  if (!file) return '';
  const knownGood = path.join(root, KNOWN_GOOD_REL);
  if (!existsSync(knownGood)) return '';
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf-8',
  }).trim();
  return hotfixPipelineRef({
    labels: parseLabels(readFileSync(path.join(dir, file), 'utf-8')),
    knownGoodJson: readFileSync(knownGood, 'utf-8'),
    headSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    }).trim();
    // The dispatch board lives in the main checkout; fall back to this worktree.
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      cwd: root,
    }).trim();
    const main_ =
      path.basename(path.resolve(root, common)) === '.git'
        ? path.dirname(path.resolve(root, common))
        : root;
    const sha = process.argv[2]
      ? main(process.argv[2], existsSync(path.join(main_, KNOWN_GOOD_REL)) ? main_ : root)
      : '';
    if (sha) process.stdout.write(sha);
  } catch {
    /* never fails the run: no output means HEAD */
  }
}
