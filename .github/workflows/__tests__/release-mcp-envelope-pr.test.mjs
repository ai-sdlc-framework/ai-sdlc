// AISDLC-1253: the MCP envelope step lands via branch + PR with an allowed commitlint scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const { default: commitlint } = await import(
  pathToFileURL(join(root, 'commitlint.config.mjs')).href
);
const scopes = commitlint.rules['scope-enum'][2];

test('every commit subject in release.yml uses a scope in the commitlint enum', () => {
  const subjects = [...release.matchAll(/(?:SUBJECT=|git commit -m )"([a-z]+)\(([^)]+)\)/g)];
  assert.ok(subjects.length > 0);
  for (const m of subjects) assert.ok(scopes.includes(m[2]), `scope ${m[2]} not in scope-enum`);
  assert.match(release, /chore\(ci\): sign .*\(AISDLC-439\)/);
});

test('envelope step opens a PR and never pushes main', () => {
  assert.doesNotMatch(release, /git push origin HEAD:main/);
  assert.match(release, /ai-sdlc\/mcp-envelope-\$\{MCP_VERSION\}/);
  assert.match(release, /gh pr create/);
  assert.match(release, /--force-with-lease/);
  assert.match(release, /gh pr list --head "\$BRANCH"/);
  assert.match(release, /actions\/runs\/\$\{\{ github\.run_id \}\}/);
});

test('PR is armed via the release lane and refusal is only a warning', () => {
  assert.match(release, /cli-merge-if-eligible\.mjs "\$PR_NUMBER" --source-kind release --arm/);
  assert.match(release, /AI_SDLC_CALLER_ROLE: operator/);
  assert.match(release, /::warning::Could not arm envelope PR/);
});

test('publish-npm permissions add only pull-requests: write', () => {
  const job = release.slice(release.indexOf('publish-npm:'), release.indexOf('publish-pypi:'));
  assert.match(job, /contents: write/);
  assert.match(job, /pull-requests: write/);
  assert.match(job, /id-token: write/);
});

test('envelope step bypasses husky hooks on the runner', () => {
  assert.match(release, /HUSKY: '0'/);
  assert.match(release, /git commit --no-verify/);
  assert.match(release, /git push --no-verify --force-with-lease/);
});
