#!/usr/bin/env node
/**
 * AISDLC-720.1: CI boundary for outside contributions.
 *
 * Fails a pull request that changes governance config or workflow files when it
 * comes from a fork, or from an author whose author_association is not OWNER,
 * MEMBER or COLLABORATOR. Decided purely from GitHub facts passed in by the
 * workflow (never from the PR's own content).
 *
 * CLI: node scripts/check-governance-boundary.mjs --files <file-with-one-path-per-line>
 * Env: PR_IS_FORK ('true'|'false'), PR_AUTHOR_ASSOCIATION, PR_AUTHOR_LOGIN, PR_AUTHOR_TYPE
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** Governance config under .ai-sdlc/, listed explicitly (runtime artifacts are not config). */
export const GOVERNANCE_CONFIG_FILES = [
  '.ai-sdlc/adapter-binding-backlog.yaml',
  '.ai-sdlc/adapter-binding.yaml',
  '.ai-sdlc/agent-role-triage.yaml',
  '.ai-sdlc/agent-role.yaml',
  '.ai-sdlc/autonomy-policy.yaml',
  '.ai-sdlc/decision-exemplars.yaml',
  '.ai-sdlc/decision-policy.md',
  '.ai-sdlc/decision-principles.md',
  '.ai-sdlc/decisions-config.yaml',
  '.ai-sdlc/dor-config.yaml',
  '.ai-sdlc/lifecycle-approvers.yaml',
  '.ai-sdlc/model-routing.yaml',
  '.ai-sdlc/orchestrator-failure-patterns.yaml',
  '.ai-sdlc/pipeline-backlog.yaml',
  '.ai-sdlc/pipeline.yaml',
  '.ai-sdlc/quality-gate.yaml',
  '.ai-sdlc/review-exemplars.yaml',
  '.ai-sdlc/review-policy.md',
  '.ai-sdlc/review-principles.md',
  '.ai-sdlc/trusted-reviewers.yaml',
  '.ai-sdlc/untrusted-pr-gate.yaml',
  '.ai-sdlc/untrusted-pr.openshell.yaml',
];

export function isGovernancePath(p) {
  return GOVERNANCE_CONFIG_FILES.includes(p) || p.startsWith('.github/workflows/');
}

/**
 * @param {{isFork: boolean, authorAssociation?: string, authorLogin?: string,
 *          authorType?: string, changedFiles: string[]}} input
 * @returns {{ok: boolean, offending: string[], message: string}}
 */
export function evaluateGovernanceBoundary({
  isFork,
  authorAssociation = '',
  authorLogin = '',
  authorType = '',
  changedFiles,
}) {
  const offending = changedFiles.filter(isGovernancePath);
  // Dependabot is GitHub's own bot identity and only ever pushes same-repository branches.
  const isDependabot = authorLogin === 'dependabot[bot]' && authorType === 'Bot' && !isFork;
  const trusted = !isFork && (TRUSTED_ASSOCIATIONS.includes(authorAssociation) || isDependabot);
  if (trusted || offending.length === 0) return { ok: true, offending: [], message: 'ok' };
  const who = isFork ? 'a fork' : `an author with association ${authorAssociation || 'NONE'}`;
  return {
    ok: false,
    offending,
    message:
      `This pull request is from ${who} and changes governance config or workflows ` +
      `(${offending.join(', ')}). A maintainer must make that change: ask a maintainer to ` +
      'open the change from a branch in this repository.',
  };
}

function main() {
  const i = process.argv.indexOf('--files');
  if (i < 0 || !process.argv[i + 1]) {
    console.error('usage: check-governance-boundary.mjs --files <file>');
    process.exit(2);
  }
  const changedFiles = readFileSync(process.argv[i + 1], 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const r = evaluateGovernanceBoundary({
    isFork: process.env.PR_IS_FORK !== 'false',
    authorAssociation: process.env.PR_AUTHOR_ASSOCIATION,
    authorLogin: process.env.PR_AUTHOR_LOGIN,
    authorType: process.env.PR_AUTHOR_TYPE,
    changedFiles,
  });
  if (!r.ok) {
    for (const f of r.offending) console.error(`::error file=${f}::${r.message}`);
    console.error(r.message);
    process.exit(1);
  }
  console.log('governance boundary: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
