#!/usr/bin/env node
/**
 * Attestation gate resolution (AISDLC-803).
 *
 * `Attestation gate (code PRs)` in ai-sdlc-gate.yml used to read the bare
 * `ai-sdlc/attestation` commit status, which any poster could overwrite with
 * no provenance. It now reads the CONCLUSION of the newest `verify-attestation`
 * workflow run for the head SHA instead. A status whose `target_url` is not a
 * workflow run is UNKNOWN (never failure): the gate waits for the verifier run.
 *
 * Pure `resolveAttestationGate` takes already-fetched API data so it can be
 * unit-tested with stubs; the CLI below fetches via `gh` and polls.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN_URL_RE = /\/actions\/runs\/\d+/;

export function isRunTargetedStatus(status) {
  return Boolean(
    status && typeof status.target_url === 'string' && RUN_URL_RE.test(status.target_url),
  );
}

/**
 * @param {{runs?: Array<{databaseId:number,status:string,conclusion:string|null,createdAt:string}>,
 *          statuses?: Array<{context:string,state:string,target_url?:string|null}>}} input
 * @returns {{verdict:'pass'|'fail'|'wait', reason:string}}
 */
export function resolveAttestationGate({ runs = [], statuses = [] } = {}) {
  // Cancelled runs were superseded by a newer push/run; they carry no verdict.
  const candidates = runs
    .filter((r) => !(r.status === 'completed' && r.conclusion === 'cancelled'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const newest = candidates[0];
  if (newest) {
    if (newest.status !== 'completed') {
      return {
        verdict: 'wait',
        reason: `verify-attestation run ${newest.databaseId} is ${newest.status}`,
      };
    }
    if (newest.conclusion === 'success') {
      return { verdict: 'pass', reason: `verify-attestation run ${newest.databaseId} succeeded` };
    }
    return {
      verdict: 'fail',
      reason: `verify-attestation run ${newest.databaseId} concluded ${newest.conclusion}`,
    };
  }
  const posted = statuses.find((s) => s.context === 'ai-sdlc/attestation');
  if (posted && !isRunTargetedStatus(posted)) {
    return {
      verdict: 'wait',
      reason: `ai-sdlc/attestation status (${posted.state}) is not targeted at a workflow run; treated as unknown`,
    };
  }
  return { verdict: 'wait', reason: 'no verify-attestation run found for head yet' };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

function fetchInput(repo, sha) {
  const runs = gh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'verify-attestation.yml',
    '--commit',
    sha,
    '--json',
    'databaseId,status,conclusion,createdAt',
    '--limit',
    '20',
  ]);
  const statuses = gh(['api', `repos/${repo}/commits/${sha}/status`]).statuses ?? [];
  return { runs, statuses };
}

async function main() {
  const repo = process.env.REPO;
  const sha = process.env.HEAD_SHA;
  if (!repo || !sha) {
    process.stderr.write('ERROR: REPO and HEAD_SHA must be set\n');
    process.exit(2);
  }
  const timeoutMs = Number(process.env.GATE_TIMEOUT_SECONDS ?? 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = { verdict: 'wait', reason: 'not checked' };
  while (Date.now() < deadline) {
    last = resolveAttestationGate(fetchInput(repo, sha));
    console.log(`[attestation-gate] ${last.verdict}: ${last.reason}`);
    if (last.verdict === 'pass') process.exit(0);
    if (last.verdict === 'fail') {
      console.log(
        `::error::[attestation-gate] ${last.reason} — code PR must have a valid attestation envelope`,
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log(`::error::[attestation-gate] timed out on ${sha}: ${last.reason}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
