#!/usr/bin/env node
/**
 * Attestation gate resolution (AISDLC-803).
 *
 * `Attestation gate (code PRs)` in ai-sdlc-gate.yml used to read the bare
 * `ai-sdlc/attestation` commit status, which any poster could overwrite with
 * no provenance. It now reads the CONCLUSION of a `verify-attestation`
 * workflow run instead. A status whose `target_url` is not a workflow run is
 * UNKNOWN (never failure): the gate waits for the verifier run.
 *
 * Trust model (fail closed: when trust cannot be established the verdict is
 * `wait`, which times out into a failure; nothing here ever fails open):
 *
 *  - `pull_request_target` runs execute main's copy of verify-attestation.yml,
 *    so a PR cannot rewrite them. Their `headSha` is the BASE tip, so they are
 *    not found by commit. A run is associated with this PR head only when
 *    (a) its `headBranch` equals the PR head ref AND (b) a status posted on the
 *    head SHA targets that run id (the verifier posts on the PR head).
 *  - `pull_request` runs execute the PR's own copy of the workflow. They count
 *    only when `headSha` equals the head SHA exactly, and NEVER when the PR
 *    modifies `.github/workflows/verify-attestation.yml` or
 *    `scripts/resolve-attestation-gate.mjs` (then a self-edited no-op verifier
 *    could conclude success), in which case only trusted pull_request_target
 *    runs can pass.
 *  - If any trusted pull_request_target run exists it is authoritative (a fork
 *    `pull_request` run has a read-only token and fails at the post step even
 *    when the real verification passed). Otherwise trusted pull_request runs.
 *  - Within the chosen set the newest run wins: createdAt, tie-broken by
 *    higher databaseId (a NaN createdAt sorts as oldest).
 *  - Only `success` passes. queued/in_progress => wait. Cancelled runs are
 *    ignored (superseded). Any other conclusion (failure, skipped, timed_out,
 *    action_required, neutral, stale) => fail.
 *
 * Pure `resolveAttestationGate` takes already-fetched API data so it can be
 * unit-tested with stubs; `main` is injectable for polling tests.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN_URL_RE = /\/actions\/runs\/(\d+)/;
export const PROTECTED_FILES = [
  '.github/workflows/verify-attestation.yml',
  'scripts/resolve-attestation-gate.mjs',
];

export function isRunTargetedStatus(status) {
  return Boolean(
    status && typeof status.target_url === 'string' && RUN_URL_RE.test(status.target_url),
  );
}

function runIdOfStatus(s) {
  const m = typeof s?.target_url === 'string' ? s.target_url.match(RUN_URL_RE) : null;
  return m ? Number(m[1]) : null;
}

function newestFirst(a, b) {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const na = Number.isNaN(ta) ? -Infinity : ta;
  const nb = Number.isNaN(tb) ? -Infinity : tb;
  if (na !== nb) return nb > na ? 1 : -1;
  return Number(b.databaseId) - Number(a.databaseId);
}

/**
 * @param {{runs?: Array<{databaseId:number,status:string,conclusion:string|null,createdAt:string,event?:string,headSha?:string,headBranch?:string}>,
 *          statuses?: Array<{context:string,state:string,target_url?:string|null}>,
 *          headSha?: string, headRef?: string, changedFiles?: string[]}} input
 * @returns {{verdict:'pass'|'fail'|'wait', reason:string}}
 */
export function resolveAttestationGate({
  runs = [],
  statuses = [],
  headSha,
  headRef,
  changedFiles = [],
} = {}) {
  const attestationStatuses = statuses.filter((s) => s.context === 'ai-sdlc/attestation');
  const postedRunIds = new Set(attestationStatuses.map(runIdOfStatus).filter((id) => id !== null));
  const touchesProtected = changedFiles.some((f) => PROTECTED_FILES.includes(f));

  const live = runs.filter((r) => !(r.status === 'completed' && r.conclusion === 'cancelled'));
  const targetRuns = live
    .filter(
      (r) =>
        r.event === 'pull_request_target' &&
        Boolean(headRef) &&
        r.headBranch === headRef &&
        postedRunIds.has(Number(r.databaseId)),
    )
    .sort(newestFirst);
  const prRuns = touchesProtected
    ? []
    : live
        .filter((r) => r.event === 'pull_request' && Boolean(headSha) && r.headSha === headSha)
        .sort(newestFirst);

  const newest = targetRuns[0] ?? prRuns[0];
  if (newest) {
    const label = `verify-attestation ${newest.event} run ${newest.databaseId}`;
    if (newest.status !== 'completed') {
      return { verdict: 'wait', reason: `${label} is ${newest.status}` };
    }
    if (newest.conclusion === 'success') {
      return { verdict: 'pass', reason: `${label} succeeded` };
    }
    return { verdict: 'fail', reason: `${label} concluded ${newest.conclusion}` };
  }
  if (touchesProtected) {
    return {
      verdict: 'wait',
      reason:
        'PR modifies the verifier workflow or gate resolver; only a trusted pull_request_target run can pass',
    };
  }
  const posted = attestationStatuses[0];
  if (posted && !isRunTargetedStatus(posted)) {
    return {
      verdict: 'wait',
      reason: `ai-sdlc/attestation status (${posted.state}) is not targeted at a workflow run; treated as unknown`,
    };
  }
  return { verdict: 'wait', reason: 'no trusted verify-attestation run found for head yet' };
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

const RUN_FIELDS = 'databaseId,status,conclusion,createdAt,event,headSha,headBranch';

export function fetchInput({ repo, sha, headRef, prNumber }) {
  const list = (extra) =>
    gh([
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'verify-attestation.yml',
      '--json',
      RUN_FIELDS,
      '--limit',
      '30',
      ...extra,
    ]);
  const runs = [
    ...list(['--event', 'pull_request', '--commit', sha]),
    ...list(['--event', 'pull_request_target', '--branch', headRef]),
  ];
  const statuses =
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/commits/${sha}/statuses?per_page=100`,
    ]).flat() ?? [];
  const changedFiles = gh([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
  ])
    .flat()
    .map((f) => f.filename);
  return { runs, statuses, headSha: sha, headRef, changedFiles };
}

/** Poll until pass/fail/timeout. Returns the process exit code. */
export async function runGate({
  env = process.env,
  fetch = fetchInput,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = console.log,
} = {}) {
  const { REPO: repo, HEAD_SHA: sha, HEAD_REF: headRef, PR_NUMBER: prNumber } = env;
  if (!repo || !sha || !headRef || !prNumber) {
    log('ERROR: REPO, HEAD_SHA, HEAD_REF and PR_NUMBER must be set');
    return 2;
  }
  const deadline = now() + Number(env.GATE_TIMEOUT_SECONDS ?? 300) * 1000;
  let last = { verdict: 'wait', reason: 'not checked' };
  while (now() < deadline) {
    try {
      last = resolveAttestationGate(fetch({ repo, sha, headRef, prNumber }));
    } catch (err) {
      // Transient gh failure: retry inside the window, still fail closed on timeout.
      last = { verdict: 'wait', reason: `gh lookup failed: ${err.message}` };
    }
    log(`[attestation-gate] ${last.verdict}: ${last.reason}`);
    if (last.verdict === 'pass') return 0;
    if (last.verdict === 'fail') {
      log(
        `::error::[attestation-gate] ${last.reason} — code PR must have a valid attestation envelope`,
      );
      return 1;
    }
    await sleep(15000);
  }
  log(`::error::[attestation-gate] timed out on ${sha}: ${last.reason}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGate().then((code) => process.exit(code));
}
