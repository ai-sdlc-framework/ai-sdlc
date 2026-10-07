#!/usr/bin/env node
/**
 * post-attestation-review.mjs (AISDLC-747, DEC-0065)
 *
 * Submits an APPROVE pull-request review from the Actions token once the
 * Verify attestation job has verified a v6 envelope, so GitHub, Scorecard and
 * adopters see "reviewed" and not only a commit status.
 *
 * Behaviour:
 *  - Idempotent per head SHA: an own approval already on the head SHA is kept.
 *  - Stale own approvals (other commit) are dismissed before posting.
 *  - A 403 fails loudly naming the repo setting "Allow GitHub Actions to
 *    create and approve pull requests".
 *  - Never approves unless verification status is `valid` and the PR head repo
 *    equals the base repo (no fork PRs).
 *
 * API calls are injected (`api`) so the logic is hermetically testable.
 * Entry point env: GH_TOKEN, REPO, PR_NUMBER, HEAD_SHA, HEAD_REPO, STATUS, REASON.
 */

import { pathToFileURL } from 'node:url';

export const REVIEW_MARKER = '<!-- ai-sdlc-attestation-review -->';

export const SETTING_NAME = 'Allow GitHub Actions to create and approve pull requests';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function buildReviewBody({ repo, headSha, reason }) {
  const base = `https://github.com/${repo}/tree/${headSha}`;
  const summary = (reason || 'valid envelope at HEAD').trim();
  return [
    REVIEW_MARKER,
    `AI-SDLC attestation verified for \`${headSha.slice(0, 12)}\`.`,
    '',
    `Verdict summary: ${summary}`,
    '',
    `- Envelope: ${base}/.ai-sdlc/attestations`,
    `- Nonce-bound transcripts: ${base}/.ai-sdlc/transcript-leaves`,
    '',
    'Posted by the Verify attestation workflow. The v6 envelope signature and Merkle transcript verified against the trusted reviewer keys.',
  ].join('\n');
}

function isOwn(review) {
  return typeof review.body === 'string' && review.body.includes(REVIEW_MARKER);
}

/**
 * @param {object} p
 * @param {{listReviews:()=>Promise<any[]>, createReview:(b:object)=>Promise<any>, dismissReview:(id:number,message:string)=>Promise<void>}} p.api
 * @returns {Promise<{action:'skipped'|'approved', reason:string, dismissed:number}>}
 */
export async function postAttestationReview({
  api,
  repo,
  repoHead,
  headSha,
  status,
  reason,
  log = () => {},
}) {
  if (status !== 'valid') {
    return { action: 'skipped', reason: `verification status is '${status || ''}'`, dismissed: 0 };
  }
  if (!repoHead || repoHead !== repo) {
    return { action: 'skipped', reason: 'fork or unknown head repo', dismissed: 0 };
  }
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) {
    return { action: 'skipped', reason: 'invalid head sha', dismissed: 0 };
  }

  const own = (await api.listReviews()).filter(isOwn);
  const current = own.find((r) => r.state === 'APPROVED' && r.commit_id === headSha);
  const stale = own.filter((r) => r.state === 'APPROVED' && r.commit_id !== headSha);

  let dismissed = 0;
  for (const r of stale) {
    try {
      await api.dismissReview(
        r.id,
        `Superseded: head moved from ${String(r.commit_id).slice(0, 12)} to ${headSha.slice(0, 12)}`,
      );
      dismissed += 1;
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        log(`review ${r.id} already dismissed`);
        continue;
      }
      throw wrap403(err);
    }
  }

  if (current) {
    return { action: 'skipped', reason: 'already approved at this head SHA', dismissed };
  }

  try {
    await api.createReview({
      commit_id: headSha,
      event: 'APPROVE',
      body: buildReviewBody({ repo, headSha, reason }),
    });
  } catch (err) {
    throw wrap403(err);
  }
  return { action: 'approved', reason: 'review posted', dismissed };
}

function wrap403(err) {
  if (err instanceof ApiError && err.status === 403) {
    return new Error(
      `GitHub returned 403 when posting the attestation review. Enable the repository setting "${SETTING_NAME}" (Settings > Actions > General > Workflow permissions) and re-run. Original: ${err.message}`,
    );
  }
  return err;
}

export function createFetchApi({ token, repo, prNumber, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(`${method} ${url} -> ${res.status} ${await res.text()}`, res.status);
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    async listReviews() {
      const all = [];
      for (let page = 1; page <= 20; page++) {
        const batch = await call('GET', `${base}?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    createReview: (b) => call('POST', base, b),
    dismissReview: (id, message) => call('PUT', `${base}/${id}/dismissals`, { message }),
  };
}

async function main() {
  const { GH_TOKEN, REPO, PR_NUMBER, HEAD_SHA, HEAD_REPO, STATUS, REASON } = process.env;
  const api = createFetchApi({ token: GH_TOKEN, repo: REPO, prNumber: PR_NUMBER });
  const result = await postAttestationReview({
    api,
    repo: REPO,
    repoHead: HEAD_REPO,
    headSha: HEAD_SHA,
    status: STATUS,
    reason: REASON,
    log: (m) => console.log(`[post-attestation-review] ${m}`),
  });
  console.log(
    `[post-attestation-review] ${result.action}: ${result.reason} (dismissed ${result.dismissed})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
