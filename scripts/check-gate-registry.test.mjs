/**
 * Gate registry ratchet (AISDLC-805).
 *
 * Derives the live gate set from the repository itself and compares it with
 * `.ai-sdlc/gates.yaml`:
 *   - workflows that fire on pull request events           -> workflow:<file>
 *   - jobs inside the ai-sdlc/pr-ready rollup               -> gate-job:<job id>
 *   - scripts run by .husky/pre-push and .husky/pre-commit  -> pre-push:<x> / pre-commit:<x>
 *   - entries chained in the root `pnpm test` script        -> test-chain:<command>
 *   - agent-role.yaml blockedActions / blockedPaths         -> role-action:<p> / role-path:<p>
 *
 * A gate that exists but is not registered fails this test; so does an entry
 * lacking origin or owner, or an entry that is neither baseline nor carries a
 * decision id. The registry may shrink freely: an entry whose gate no longer
 * exists is reported but does not fail (delete the entry). Same ratchet shape
 * as the dark-code baseline (AISDLC-552).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Does this workflow's `on:` block list a pull request event? */
export function firesOnPullRequest(doc) {
  const on = doc?.on ?? doc?.[true];
  if (!on) return false;
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
  return events.some((e) => e === 'pull_request' || e === 'pull_request_target');
}

/** Script paths and commands a husky hook runs, in order of appearance. */
export function hookGates(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    for (const m of line.matchAll(/(?:\.\/|node\s+)?(scripts\/[\w.-]+\.(?:sh|mjs))/g))
      out.add(m[1]);
    if (/pnpm exec lint-staged/.test(line)) out.add('lint-staged');
  }
  return [...out];
}

export function deriveLiveGates(root = ROOT) {
  const gates = new Set();
  const wfDir = join(root, '.github/workflows');
  for (const f of readdirSync(wfDir)
    .filter((n) => n.endsWith('.yml'))
    .sort()) {
    const doc = yaml.load(readFileSync(join(wfDir, f), 'utf8'));
    if (firesOnPullRequest(doc)) gates.add(`workflow:${f}`);
    if (f === 'ai-sdlc-gate.yml') {
      for (const job of Object.keys(doc.jobs ?? {})) gates.add(`gate-job:${job}`);
    }
  }
  for (const s of hookGates(readFileSync(join(root, '.husky/pre-push'), 'utf8')))
    gates.add(`pre-push:${s}`);
  for (const s of hookGates(readFileSync(join(root, '.husky/pre-commit'), 'utf8')))
    gates.add(`pre-commit:${s}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const c of pkg.scripts.test
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean))
    gates.add(`test-chain:${c}`);
  const role = yaml.load(readFileSync(join(root, '.ai-sdlc/agent-role.yaml'), 'utf8'));
  for (const a of role?.spec?.constraints?.blockedActions ?? []) gates.add(`role-action:${a}`);
  for (const p of role?.spec?.constraints?.blockedPaths ?? []) gates.add(`role-path:${p}`);
  return gates;
}

export function checkRegistry(registry, live) {
  const problems = [];
  const seen = new Set();
  for (const e of registry.gates ?? []) {
    const id = e.id ?? '(no id)';
    if (seen.has(id)) problems.push(`duplicate registry entry ${id}`);
    seen.add(id);
    for (const k of ['id', 'surface', 'origin', 'owner', 'property']) {
      if (!e[k] || String(e[k]).trim() === '') problems.push(`${id}: missing ${k}`);
    }
    if (!e.baseline && !e.decision) problems.push(`${id}: not baseline and carries no decision id`);
  }
  for (const id of live) if (!seen.has(id)) problems.push(`unregistered gate ${id}`);
  const stale = [...seen].filter((id) => !live.has(id));
  return { problems, stale };
}

/** The ids registered when this PR landed. Only `baseline: true` may apply to these. */
const BASELINE_IDS = [
  'pre-push:scripts/check-knowledge-scope.sh',
  'pre-push:scripts/check-pr-body-protected.sh',
  'test-chain:pnpm knowledge:check',
  'workflow:ai-sdlc-gate.yml',
  'gate-job:detect',
  'gate-job:lint',
  'gate-job:build-test',
  'gate-job:integration',
  'gate-job:backlog-drift',
  'gate-job:first-run-smoke',
  'gate-job:test-python',
  'gate-job:test-go',
  'gate-job:attestation-gate',
  'gate-job:dependency-review-gate',
  'gate-job:dor-readiness-gate',
  'gate-job:independence-policy-gate',
  'gate-job:pr-ready',
  'workflow:ai-sdlc-review.yml',
  'workflow:auto-enable-auto-merge.yml',
  'workflow:untrusted-pr-gate.yml',
  'pre-push:scripts/check-substrate-contract.mjs',
  'pre-push:scripts/check-skip-ci-marker.sh',
  'pre-push:scripts/check-dark-code-on-push.sh',
  'pre-push:scripts/typecheck-workspace.mjs',
  'pre-push:scripts/check-followups-on-push.sh',
  'pre-push:scripts/pre-push-fixups.sh',
  'pre-commit:scripts/check-backlog-ascii.sh',
  'pre-commit:lint-staged',
  'test-chain:pnpm -r --no-bail test',
  'test-chain:pnpm test:gates',
  'test-chain:pnpm rfc:check',
  'test-chain:pnpm dark-code:check',
  'test-chain:pnpm git-env-hygiene:check',
  'role-action:gh pr merge*',
  'role-action:git merge*',
  'role-action:git push --force*',
  'role-action:git push -f*',
  'role-action:gh pr close*',
  'role-action:gh issue close*',
  'role-action:git branch -D*',
  'role-action:git branch -d*',
  'role-action:git reset --hard*',
  'role-action:git checkout -- .',
  'role-action:git restore .',
  'role-path:opencode.json',
  'role-path:opencode.jsonc',
  'role-path:.opencode/**',
  'role-path:**/opencode.json',
  'role-path:**/opencode.jsonc',
  'role-path:**/.opencode/**',
  'role-path:scripts/verify-attestation.mjs',
];

describe('gate registry (AISDLC-805)', () => {
  const registry = yaml.load(read('.ai-sdlc/gates.yaml'));

  test('every live gate is registered and every entry has origin and owner', () => {
    const { problems, stale } = checkRegistry(registry, deriveLiveGates());
    if (stale.length) console.log(`stale registry entries (delete them): ${stale.join(', ')}`);
    assert.deepEqual(problems, [], `gate registry violations:\n  ${problems.join('\n  ')}`);
  });

  test('every frozen baseline id is still live (a removed gate must leave this list)', () => {
    const live = deriveLiveGates();
    const gone = BASELINE_IDS.filter((id) => !live.has(id));
    assert.deepEqual(
      gone,
      [],
      `registered gates no longer live; delete them from BASELINE_IDS and gates.yaml: ${gone.join(', ')}`,
    );
  });

  test('only frozen ids may carry baseline: true; new entries need a decision id', () => {
    const frozen = new Set(BASELINE_IDS);
    const bad = (registry.gates ?? [])
      .filter((e) => e.baseline && !frozen.has(e.id))
      .map((e) => e.id);
    assert.deepEqual(
      bad,
      [],
      `new entries must use decision: DEC-NNNN, not baseline: ${bad.join(', ')}`,
    );
  });

  test('derivation finds a plausible live gate set (regression guard)', () => {
    const live = deriveLiveGates();
    assert.ok(live.size >= 30, `live gate set suspiciously small: ${live.size}`);
    for (const id of [
      'workflow:ai-sdlc-gate.yml',
      'gate-job:backlog-drift',
      'pre-push:scripts/pre-push-fixups.sh',
    ])
      assert.ok(live.has(id), `expected live gate ${id}`);
  });

  test('checkRegistry flags an unregistered gate', () => {
    const { problems } = checkRegistry({ gates: [] }, new Set(['workflow:new.yml']));
    assert.deepEqual(problems, ['unregistered gate workflow:new.yml']);
  });

  test('checkRegistry flags an entry without origin or owner', () => {
    const entry = { id: 'a', surface: 's', property: 'p', baseline: true, owner: ' ' };
    const { problems } = checkRegistry({ gates: [entry] }, new Set(['a']));
    assert.deepEqual(problems, ['a: missing origin', 'a: missing owner']);
  });

  test('checkRegistry requires a decision id on a non-baseline entry', () => {
    const entry = { id: 'a', surface: 's', origin: 'o', owner: 'w', property: 'p' };
    const { problems } = checkRegistry({ gates: [entry] }, new Set(['a']));
    assert.deepEqual(problems, ['a: not baseline and carries no decision id']);
    const ok = checkRegistry({ gates: [{ ...entry, decision: 'DEC-0001' }] }, new Set(['a']));
    assert.deepEqual(ok.problems, []);
  });

  test('registry shrinks freely: a stale entry is reported, not failed', () => {
    const entry = {
      id: 'gone',
      surface: 's',
      origin: 'o',
      owner: 'w',
      property: 'p',
      baseline: true,
    };
    const { problems, stale } = checkRegistry({ gates: [entry] }, new Set());
    assert.deepEqual(problems, []);
    assert.deepEqual(stale, ['gone']);
  });

  test('hookGates reads scripts, skips comments, detects lint-staged', () => {
    const text =
      '# ./scripts/commented.sh\n./scripts/a.sh\nnode scripts/b.mjs\nprintf x | ./scripts/c.sh\npnpm exec lint-staged\n';
    assert.deepEqual(hookGates(text), [
      'scripts/a.sh',
      'scripts/b.mjs',
      'scripts/c.sh',
      'lint-staged',
    ]);
  });

  test('firesOnPullRequest handles string, list and map forms', () => {
    assert.equal(firesOnPullRequest({ on: 'pull_request' }), true);
    assert.equal(firesOnPullRequest({ on: ['push', 'pull_request_target'] }), true);
    assert.equal(firesOnPullRequest({ on: { push: {}, schedule: [] } }), false);
  });
});
