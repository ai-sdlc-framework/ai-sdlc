/**
 * AISDLC-1363 (DEC-0421): the head branch of the PR a fix task was filed to fix.
 *
 * `cli-file task --fixes-pr <n>` records `fixesPr` and `prHeadRef` on the board manifest, which
 * the claim moves to `<main>/.ai-sdlc/dispatch/inflight/<task-id>.dispatch.json`. This is the ONLY
 * source: a value from the command line, the environment or a message is never read. The
 * manifest sits in the main checkout, outside an executor's worktree, so the Write/Edit
 * outside-home rule of enforce-blocked-actions.js refuses an executor write to it; a shell
 * write by a trusted session is not fenced (the claim check reads the same directory).
 *
 * readFixPrHead(mainRoot, taskId) returns `{ fixesPr, prHeadRef }` or null. It fails closed: a
 * missing, odd (symlink, not a plain file) or malformed manifest, a missing `fixesPr` or
 * `prHeadRef`, and a head that names another repository (`owner:branch`, or a recorded
 * cross-repository flag) all return null.
 */

'use strict';

const { lstatSync, readFileSync, readdirSync, realpathSync } = require('fs');
const { join, dirname } = require('path');

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUFFIX = '.dispatch.json';

function readFixPrHead(mainRoot, taskId) {
  try {
    if (typeof mainRoot !== 'string' || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
      return null;
    }
    const inflight = join(mainRoot, '.ai-sdlc', 'dispatch', 'inflight');
    const realInflight = realpathSync(inflight);
    if (
      realInflight !== inflight &&
      realInflight !==
        realpathSync(join(realpathSync(mainRoot), '.ai-sdlc', 'dispatch', 'inflight'))
    ) {
      return null;
    }
    const want = `${taskId}${SUFFIX}`.toLowerCase();
    const matches = readdirSync(inflight).filter((f) => f.toLowerCase() === want);
    if (matches.length !== 1) return null;
    const file = join(inflight, matches[0]);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || dirname(realpathSync(file)) !== realInflight) {
      return null;
    }
    const m = JSON.parse(readFileSync(file, 'utf-8'));
    if (!m || typeof m !== 'object') return null;
    if (!Number.isInteger(m.fixesPr) || m.fixesPr <= 0) return null;
    const ref = m.prHeadRef;
    if (typeof ref !== 'string' || ref === '' || ref !== ref.trim() || ref.includes(':')) {
      return null;
    }
    if (m.isCrossRepository === true || m.crossRepository === true) return null;
    return { fixesPr: m.fixesPr, prHeadRef: ref };
  } catch {
    return null;
  }
}

module.exports = { readFixPrHead };
