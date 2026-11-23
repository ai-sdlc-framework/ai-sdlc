#!/usr/bin/env node
/**
 * Stateful fake `gh` for the bootstrap smoke (AISDLC-1361).
 *
 * Answers the calls the AI-SDLC CLIs make from a small JSON state file and from the scratch
 * repository's bare origin (file contents, trees, commits and compare are read with git, so
 * the answers agree with what was really pushed). Every call is appended to a JSONL log with
 * `known: true|false`. A call it does not know exits 1 and is logged `known: false`; the smoke
 * fails the stage on one, so a new `gh` call in a CLI is caught here instead of being swallowed
 * by a caller that tolerates a failing `gh`.
 *
 * It proves the CLIs' own logic only. It cannot prove real branch protection, repository
 * secrets, the auto-merge setting or that the canned answers match the live API. It never
 * leaves the temporary directory: it reads and writes only the two files named by
 * BOOTSTRAP_GH_STATE and BOOTSTRAP_GH_CALLS and runs git against the origin in the state.
 *
 * State file: { slug, origin, author, autoMerge, protection, prs, secrets, checks }.
 * `checks` is `PENDING` until CI has posted the required checks, then `SUCCESS` (the default).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ZERO_QUOTA = JSON.stringify({
  resources: {
    core: { limit: 5000, remaining: 5000, reset: 4102444800 },
    graphql: { limit: 5000, remaining: 5000, reset: 4102444800 },
  },
});

const git = (origin, ...args) =>
  execFileSync('git', ['--git-dir', origin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Value following `flag` in `args`, or undefined. */
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function prObject(state, pr) {
  let head = '';
  try {
    head = git(state.origin, 'rev-parse', `refs/heads/${pr.headRefName}`).trim();
  } catch {
    head = '';
  }
  let files = [];
  try {
    files = git(state.origin, 'diff', '--name-status', `refs/heads/${state.base}...${head}`)
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ path: l.split('\t').pop(), changeType: 'MODIFIED' }));
  } catch {
    files = [];
  }
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    headRefOid: head,
    baseRefName: state.base,
    isCrossRepository: false,
    author: { login: state.author },
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    files,
    autoMergeRequest: pr.autoMerge ? { enabledBy: { login: state.author } } : null,
    mergeCommit: pr.state === 'MERGED' ? { oid: pr.mergeSha } : null,
    url: `https://github.com/${state.slug}/pull/${pr.number}`,
    labels: [],
    reviewDecision: '',
    statusCheckRollup: requiredContexts(state).map((name) => ({
      __typename: 'CheckRun',
      name,
      status: state.checks === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: state.checks === 'PENDING' ? null : 'SUCCESS',
    })),
  };
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields.split(',')) out[f] = obj[f] ?? null;
  return out;
}

/** Contexts a green pull request has posted: the ones the stored branch protection requires. */
function requiredContexts(state) {
  const fromProtection = state.protection?.required_status_checks?.contexts;
  return Array.isArray(fromProtection) && fromProtection.length ? fromProtection : [];
}

/**
 * Answer one call. Returns { out?, code?, err?, mutate? } or null when the call is unknown.
 * `state` may be mutated by the handler; the caller writes it back.
 */
export function answer(args, state, readInput = (p) => readFileSync(p, 'utf8')) {
  const [cmd, sub] = args;
  const ok = (out = '') => ({ out, code: 0 });
  const slugPath = `repos/${state.slug}`;

  if (cmd === 'auth' && sub === 'status') return ok('Logged in (bootstrap smoke fake)\n');
  if (cmd === 'repo' && sub === 'view') {
    const fields = flagValue(args, '--json');
    if (fields === 'nameWithOwner,defaultBranchRef') return ok(`${state.slug} ${state.base}\n`);
    if (fields === 'nameWithOwner') return ok(`${state.slug}\n`);
    if (fields === 'autoMergeAllowed') return ok(`${state.autoMerge}\n`);
    return null;
  }
  if (cmd === 'run' && sub === 'list') return ok('[]\n');
  if (cmd === 'secret' && sub === 'list') {
    return ok(state.secrets.map((s) => `${s}\t2026-11-19T00:00:00Z`).join('\n') + '\n');
  }

  if (cmd === 'pr') return answerPr(args, state);
  if (cmd === 'api') return answerApi(args, state, readInput, slugPath);
  return null;
}

function answerPr(args, state) {
  const [, sub] = args;
  const ok = (out = '') => ({ out, code: 0 });
  if (sub === 'create') {
    const head = flagValue(args, '--head');
    const title = flagValue(args, '--title');
    if (!head || !title) return null;
    const number = state.prs.length + 1;
    state.prs.push({
      number,
      title,
      headRefName: head,
      state: 'OPEN',
      isDraft: args.includes('--draft'),
    });
    return ok(`https://github.com/${state.slug}/pull/${number}\n`);
  }
  if (sub === 'list') {
    const fields = flagValue(args, '--json');
    if (!fields) return null;
    const wanted = flagValue(args, '--state') ?? 'open';
    const head = flagValue(args, '--head');
    const rows = state.prs
      .filter((p) => (wanted === 'all' ? true : p.state === wanted.toUpperCase()))
      .filter((p) => (head ? p.headRefName === head : true))
      .map((p) => pick(prObject(state, p), fields));
    return ok(`${JSON.stringify(rows)}\n`);
  }
  const num = Number(args[2]);
  const pr = state.prs.find((p) => p.number === num);
  if (sub === 'view' && pr) {
    const fields = flagValue(args, '--json');
    if (!fields) return null;
    return ok(`${JSON.stringify(pick(prObject(state, pr), fields))}\n`);
  }
  if (sub === 'checks' && pr) {
    const rows = requiredContexts(state).map((name) => ({
      name,
      state: state.checks ?? 'SUCCESS',
    }));
    return ok(`${JSON.stringify(rows)}\n`);
  }
  if (sub === 'ready' && pr) {
    pr.isDraft = false;
    return ok();
  }
  if (sub === 'merge' && pr) {
    const head = flagValue(args, '--match-head-commit');
    const current = prObject(state, pr).headRefOid;
    if (head && head !== current) {
      return { out: '', code: 1, err: 'head commit does not match (bootstrap smoke fake)' };
    }
    if (args.includes('--auto')) {
      pr.autoMerge = true;
      return ok();
    }
    pr.state = 'MERGED';
    pr.mergeSha = current;
    return ok();
  }
  return null;
}

function answerApi(args, state, readInput, slugPath) {
  const ok = (out = '') => ({ out, code: 0 });
  const rest = args.slice(1);
  let method = 'GET';
  let input;
  let jq;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-X' || a === '--method') method = rest[++i];
    else if (a === '--input') input = rest[++i];
    else if (a === '--jq' || a === '-q') jq = rest[++i];
    else if (a === '-H') i++;
    else if (a === '--paginate') continue;
    else positional.push(a);
  }
  const target = positional[0];
  if (!target) return null;
  const [route, query = ''] = target.split('?');
  const ref = /(?:^|&)ref=([^&]+)/.exec(query)?.[1];

  if (route === 'rate_limit') return ok(`${ZERO_QUOTA}\n`);
  if (route === 'repos/{owner}/{repo}' || route === slugPath) {
    return jq === '.allow_auto_merge'
      ? ok(`${state.autoMerge}\n`)
      : ok(`${JSON.stringify({ allow_auto_merge: state.autoMerge })}\n`);
  }
  if (route === `${slugPath}/branches/${state.base}/protection`) {
    if (method === 'PUT' && input) {
      state.protection = JSON.parse(readInput(input));
      return ok('{}\n');
    }
    if (method === 'GET') {
      return state.protection
        ? ok(`${JSON.stringify(state.protection)}\n`)
        : { out: 'Branch not protected (404)\n', code: 1, err: 'HTTP 404' };
    }
    return null;
  }
  if (route === `${slugPath}/git/ref/heads/${state.base}`) {
    const sha = git(state.origin, 'rev-parse', `refs/heads/${state.base}`).trim();
    return ok(`${JSON.stringify({ type: 'commit', sha })}\n`);
  }
  if (route.startsWith(`${slugPath}/contents/`) && ref) {
    const file = route.slice(`${slugPath}/contents/`.length);
    try {
      return ok(git(state.origin, 'show', `${ref}:${file}`));
    } catch {
      return { out: '', code: 1, err: 'HTTP 404' };
    }
  }
  if (route.startsWith(`${slugPath}/git/trees/`)) {
    const treeish = route.slice(`${slugPath}/git/trees/`.length);
    const tree = git(state.origin, 'ls-tree', treeish)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [meta, path] = l.split('\t');
        const [, type, sha] = meta.split(' ');
        return { path, type, sha };
      });
    return ok(`${JSON.stringify({ truncated: false, tree })}\n`);
  }
  const commitRoute = new RegExp(
    `^${slugPath}/commits/([0-9a-f]{7,40})(/check-runs|/status)?$`,
  ).exec(route);
  if (commitRoute) {
    const [, , kind] = commitRoute;
    if (kind === '/check-runs') {
      const lines = requiredContexts(state).map((name) =>
        JSON.stringify(
          state.checks === 'PENDING'
            ? { name, status: 'in_progress', conclusion: null }
            : { name, status: 'completed', conclusion: 'success' },
        ),
      );
      return ok(lines.length ? `${lines.join('\n')}\n` : '');
    }
    if (kind === '/status') return ok('');
    return ok(`${JSON.stringify({ author: state.author, committer: state.author })}\n`);
  }
  const compare = new RegExp(
    `^${slugPath}/compare/([0-9a-f]{7,40})\\.\\.\\.([0-9a-f]{7,40})$`,
  ).exec(route);
  if (compare) {
    const lines = git(state.origin, 'diff', '--name-status', `${compare[1]}...${compare[2]}`)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status, filename] = l.split('\t');
        return JSON.stringify({ filename, status: status === 'A' ? 'added' : 'modified' });
      });
    return ok(lines.length ? `${lines.join('\n')}\n` : '');
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const statePath = process.env.BOOTSTRAP_GH_STATE;
  const callsPath = process.env.BOOTSTRAP_GH_CALLS;
  if (!statePath || !callsPath) {
    console.error('bootstrap-smoke-gh: BOOTSTRAP_GH_STATE and BOOTSTRAP_GH_CALLS must be set');
    process.exit(2);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  let result = null;
  try {
    result = answer(args, state);
  } catch (err) {
    result = { out: '', code: 1, err: `bootstrap-smoke-gh: ${err.message}` };
  }
  const known = result !== null;
  appendFileSync(callsPath, `${JSON.stringify({ args, known })}\n`);
  if (!known) {
    console.error(`bootstrap-smoke-gh: unknown call: gh ${args.join(' ')}`);
    process.exit(1);
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(`${result.err}\n`);
  process.exit(result.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
