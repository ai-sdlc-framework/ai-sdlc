#!/usr/bin/env node
/**
 * Offline pipeline leg of the first-run smoke test (AISDLC-771).
 *
 * `cli-orchestrator tick --spawner mock` is plumbing-only (it admits the task
 * and refuses to dispatch), so it cannot reach a committed branch. The closest
 * offline path that does is the Step 0-13 library, `executePipeline()`, driven
 * by the shipped `MockSpawner` and a Runner that stubs only `gh` (no network,
 * no GitHub). git runs for real against a local bare "origin", so the result
 * is a genuine committed + pushed branch.
 *
 * Usage: node scripts/first-run-smoke-pipeline.mjs <workDir> <taskId> <pipelineCliDistDir>
 * Prints one JSON line: { outcome, branch, commit, prUrl }.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [workDir, taskId, distDir] = process.argv.slice(2);
if (!workDir || !taskId || !distDir) {
  console.error('usage: first-run-smoke-pipeline.mjs <workDir> <taskId> <pipelineCliDistDir>');
  process.exit(2);
}

const { executePipeline, MockSpawner, defaultRunner } = await import(
  pathToFileURL(join(distDir, 'index.js')).href
);

const FAKE_PR_URL = 'https://github.com/smoke/first-run/pull/1';

/** Real git, stubbed gh: the only network-bound command the pipeline issues. */
const runner = async (command, args, opts) => {
  if (command === 'gh') {
    return {
      stdout: args[0] === 'pr' && args[1] === 'create' ? `${FAKE_PR_URL}\n` : '',
      stderr: '',
      code: 0,
    };
  }
  return defaultRunner(command, args, opts);
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const approve = (type) => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'smoke: approved' },
  status: 'success',
  durationMs: 0,
});

const spawner = new MockSpawner({
  // The "developer" does the one thing a real one must: commit in its worktree.
  developer: (opts) => {
    appendFileSync(join(opts.cwd, 'index.js'), "\nexports.greet = () => 'hello';\n");
    git(opts.cwd, 'add', 'index.js');
    git(opts.cwd, 'commit', '-q', '-m', `feat: add greeting (${taskId})`);
    return {
      type: 'developer',
      output: '',
      status: 'success',
      durationMs: 0,
      parsed: {
        summary: 'added greet()',
        filesChanged: ['index.js'],
        commitSha: git(opts.cwd, 'rev-parse', 'HEAD'),
        verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
        acceptanceCriteriaMet: [1],
        notes: 'first-run smoke',
      },
    };
  },
  'code-reviewer': approve('code-reviewer'),
  'test-reviewer': approve('test-reviewer'),
  'security-reviewer': approve('security-reviewer'),
});

const result = await executePipeline({ taskId, workDir, spawner, runner, maxReviewIterations: 1 });

const branch = git(
  workDir,
  'branch',
  '--list',
  `*${taskId.toLowerCase()}*`,
  '--format=%(refname:short)',
).split('\n')[0];
const commit = branch ? git(workDir, 'rev-parse', branch) : '';
console.log(
  JSON.stringify({ outcome: result.outcome, branch, commit, prUrl: result.prUrl ?? null }),
);
if (result.outcome !== 'approved') console.error(JSON.stringify(result, null, 2));
process.exit(result.outcome === 'approved' ? 0 : 1);
