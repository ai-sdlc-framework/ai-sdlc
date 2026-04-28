#!/usr/bin/env node
/**
 * Post (or skip) the friendly educational PR comment when the
 * `verify-attestation` workflow finds an invalid or missing attestation
 * (AISDLC-74, AC #8).
 *
 * Idempotent: scans the PR's existing comments for our marker, posts only
 * when no prior comment exists. The marker is invisible to humans (HTML
 * comment) but stable for the next run to detect.
 *
 * Inputs (env vars):
 *   GH_TOKEN          — GitHub token with `pull-requests: write`
 *   GITHUB_REPOSITORY — `owner/repo`
 *   PR_NUMBER         — PR number to comment on
 *   ATTESTATION_REASON — short reason (`missing`, `invalid (<details>)`)
 *   PR_HEAD_SHA       — head SHA of the PR (informational only)
 *
 * Exits 0 on success or "comment already present" (the idempotent path).
 * Exits non-zero only on hard errors (missing env, network failure).
 */

const MARKER = '<!-- ai-sdlc:attestation-fallback-comment -->';

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-sdlc-attestation-fallback',
  };
}

async function fetchExistingComments(apiBase, headers) {
  const res = await fetch(`${apiBase}?per_page=100`, { headers });
  if (!res.ok) {
    throw new Error(`GET comments failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function postComment(apiBase, headers, body) {
  const res = await fetch(apiBase, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`POST comment failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function buildBody(reason, headSha) {
  return [
    MARKER,
    '## AI-SDLC: review attestation not accepted',
    '',
    `CI didn't find a valid review attestation for this PR (\`${reason}\`), so it ran its`,
    `own review instead. Heads-up: that's the slower + more token-heavy path.`,
    '',
    '### How to skip CI review on your next PR',
    '',
    '1. **One-time setup** (per machine): `/ai-sdlc init-signing-key`, then open',
    '   the printed onboarding PR adding your pubkey to',
    '   `.ai-sdlc/trusted-reviewers.yaml`. Once that PR merges, `/ai-sdlc execute`',
    '   will produce attestations CI accepts.',
    '2. **Per task**: run `/ai-sdlc execute <task-id>` instead of pushing manually.',
    '   It runs the three reviewer subagents locally, signs a DSSE envelope at',
    '   `.ai-sdlc/attestations/<head-sha>.dsse.json`, and commits it alongside',
    '   your work. CI then verifies the signature and skips its review.',
    '',
    '### Why CI still ran a review this time',
    '',
    `The most common causes:`,
    '- No attestation file present (you pushed without `/ai-sdlc execute`).',
    '- Diff changed after the attestation was signed (force-push, manual amend).',
    '- `.ai-sdlc/review-policy.md` or a reviewer agent file changed since you signed.',
    "- The signing key isn't in `.ai-sdlc/trusted-reviewers.yaml` yet.",
    '',
    'See `CLAUDE.md` → "Review attestations" for the full bootstrap flow.',
    '',
    headSha ? `_Head SHA: \`${headSha}\`_` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main(env = process.env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const prNumber = env.PR_NUMBER;
  const reason = env.ATTESTATION_REASON || 'missing or invalid';
  const headSha = env.PR_HEAD_SHA || '';

  if (!token) fail('GH_TOKEN (or GITHUB_TOKEN) not set');
  if (!repo) fail('GITHUB_REPOSITORY not set');
  if (!prNumber) fail('PR_NUMBER not set');

  const apiBase = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = buildHeaders(token);

  const comments = await fetchExistingComments(apiBase, headers);
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
  if (existing) {
    process.stdout.write(`Idempotent skip: marker already present (comment id ${existing.id})\n`);
    return;
  }
  const body = buildBody(reason, headSha);
  const result = await postComment(apiBase, headers, body);
  process.stdout.write(`Posted attestation-fallback comment id ${result.id}\n`);
}

// Only run main() when invoked directly — not when imported by tests.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('post-attestation-comment.mjs');
if (invokedDirectly) {
  main().catch((err) => fail(err.message ?? String(err)));
}

// Re-export the marker + body builder for unit tests via dynamic import.
export { MARKER, buildBody, fetchExistingComments, postComment, buildHeaders, main };
