/**
 * Tests for the bootstrap smoke (AISDLC-1361).
 *
 * The pure checks and the fake `gh` are tested hermetically. The end-to-end runs (a clean
 * run, one skipped stage for each of the nine, a removed prerequisite, a silent doctor check,
 * a doctor `fail`, an `up` warning, a missing operator input) need the workspace built, and
 * are skipped when it is not (CI builds first). They run a few at a time to stay inside the
 * five-minute budget of the first-run smoke.
 *
 * Run with: node --test scripts/bootstrap-smoke.test.mjs
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREREQUISITES,
  STAGES,
  doctorProblems,
  missingStages,
  prerequisiteProblems,
  unknownCalls,
  upProblemLines,
} from './bootstrap-smoke.mjs';
import { answer } from './bootstrap-smoke-gh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'bootstrap-smoke.mjs');
const FAKE_GH = join(ROOT, 'scripts', 'bootstrap-smoke-gh.mjs');
const built = [
  'orchestrator/dist/cli/index.js',
  'pipeline-cli/dist/index.js',
  'pipeline-cli/dist/cli/hierarchy.js',
].every((p) => existsSync(join(ROOT, p)));

describe('stage list and pure checks', () => {
  it('lists the nine stages in order', () => {
    assert.deepEqual(STAGES, [
      'setup',
      'prerequisites',
      'doctor',
      'up',
      'task picked up',
      'pull request opened',
      'review verdict record',
      'merge gate',
      'landing',
    ]);
  });

  it('names every stage that did not run', () => {
    assert.deepEqual(missingStages(STAGES), []);
    assert.deepEqual(missingStages(STAGES.filter((s) => s !== 'merge gate')), ['merge gate']);
    assert.deepEqual(missingStages([]), STAGES);
  });

  it('doctorProblems reports a silent registry check and a fail', () => {
    const ok = { results: [{ id: 'a', severity: 'pass' }] };
    assert.deepEqual(doctorProblems(ok, ['a']), []);
    assert.match(doctorProblems(ok, ['a', 'b'])[0], /b returned no result/);
    const bad = { results: [{ id: 'a', severity: 'fail', title: 'broken' }] };
    assert.match(doctorProblems(bad, ['a'])[0], /fail: a: broken/);
  });

  it('upProblemLines keeps warning and webhook-off lines only', () => {
    const lines = ['started planner', 'warning: x', 'webhook: off (board polls only)', 'note: y'];
    assert.deepEqual(upProblemLines(lines), ['warning: x', 'webhook: off (board polls only)']);
  });

  it('unknownCalls lists calls the fake did not know', () => {
    assert.deepEqual(
      unknownCalls([
        { args: ['pr', 'list'], known: true },
        { args: ['pr', 'edit', '1'], known: false },
      ]),
      ['gh pr edit 1'],
    );
  });

  it('prerequisiteProblems fails when a scaffolded prerequisite is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-prereq-'));
    try {
      const make = () => {
        for (const rel of PREREQUISITES) {
          if (rel.includes('.')) {
            mkdirSync(dirname(join(dir, rel)), { recursive: true });
            writeFileSync(join(dir, rel), '');
          } else mkdirSync(join(dir, rel), { recursive: true });
        }
        writeFileSync(
          join(dir, '.ai-sdlc', 'agent-role.yaml'),
          'governance:\n  allowMerge: never\n  mergeAuthors: []\n  operational: []\n',
        );
      };
      make();
      assert.deepEqual(prerequisiteProblems(dir), []);
      for (const rel of ['.github/workflows/ai-sdlc-gate.yml', 'backlog/tasks']) {
        rmSync(join(dir, rel), { recursive: true, force: true });
        assert.match(prerequisiteProblems(dir).join('\n'), new RegExp(rel.replace('.', '\\.')));
        make();
      }
      writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'governance:\n  allowMerge: never\n');
      assert.match(prerequisiteProblems(dir).join('\n'), /no mergeAuthors merge setting/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fake gh', () => {
  const state = () => ({
    slug: 'smoke/bootstrap',
    origin: '/nonexistent',
    base: 'main',
    author: 'smoke-bot',
    autoMerge: false,
    protection: null,
    prs: [],
    secrets: ['AI_SDLC_PAT'],
  });

  it('answers the calls it knows and keeps state', () => {
    const s = state();
    assert.equal(answer(['auth', 'status'], s).code, 0);
    assert.match(
      answer(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.x'], s).out,
      /smoke\/bootstrap/,
    );
    const put = answer(
      [
        'api',
        '-X',
        'PUT',
        'repos/smoke/bootstrap/branches/main/protection',
        '--input',
        'body.json',
      ],
      s,
      () => '{"required_status_checks":{"contexts":["ai-sdlc/pr-ready"]}}',
    );
    assert.equal(put.code, 0);
    const get = answer(['api', 'repos/smoke/bootstrap/branches/main/protection'], s);
    assert.match(get.out, /ai-sdlc\/pr-ready/);
    const created = answer(['pr', 'create', '--title', 't', '--head', 'b', '--draft'], s);
    assert.match(created.out, /\/pull\/1/);
    assert.equal(s.prs[0].isDraft, true);
  });

  it('returns null for a call it does not know', () => {
    assert.equal(answer(['pr', 'edit', '1', '--add-label', 'x'], state()), null);
    assert.equal(answer(['api', 'repos/smoke/bootstrap/unknown-route'], state()), null);
  });

  it('as a process, records every call and exits 1 on an unknown one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-gh-'));
    try {
      const statePath = join(dir, 'state.json');
      const callsPath = join(dir, 'calls.jsonl');
      writeFileSync(statePath, JSON.stringify(state()));
      const env = { ...process.env, BOOTSTRAP_GH_STATE: statePath, BOOTSTRAP_GH_CALLS: callsPath };
      const known = spawnSync(process.execPath, [FAKE_GH, 'auth', 'status'], {
        env,
        encoding: 'utf8',
      });
      const unknown = spawnSync(process.execPath, [FAKE_GH, 'pr', 'edit', '1'], {
        env,
        encoding: 'utf8',
      });
      assert.equal(known.status, 0);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /unknown call: gh pr edit 1/);
      const calls = readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.deepEqual(
        calls.map((c) => [c.args.join(' '), c.known]),
        [
          ['auth status', true],
          ['pr edit 1', false],
        ],
      );
      assert.deepEqual(unknownCalls(calls), ['gh pr edit 1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Run the script with seam variables; resolves with exit code and combined output. */
function run(extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    delete env.AI_SDLC_WEBHOOK_SECRET;
    execFile(
      process.execPath,
      [SCRIPT],
      { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` }),
    );
  });
}

/** Run `jobs` (name -> env) a few at a time. */
async function runMatrix(jobs, width = 4) {
  const names = Object.keys(jobs);
  const results = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < names.length) {
        const name = names[next++];
        results[name] = await run(jobs[name]);
      }
    }),
  );
  return results;
}

describe('end to end', { skip: !built && 'workspace not built (run pnpm build)' }, () => {
  const jobs = { clean: {} };
  for (const [i, name] of STAGES.entries())
    jobs[`skip ${i + 1}`] = { BOOTSTRAP_SKIP_STAGE: String(i + 1) };
  jobs['remove merge settings'] = { BOOTSTRAP_REMOVE: '.ai-sdlc/agent-role.yaml' };
  jobs['remove backlog tasks'] = { BOOTSTRAP_REMOVE: 'backlog/tasks' };
  jobs['remove gate workflow'] = { BOOTSTRAP_REMOVE: '.github/workflows/ai-sdlc-gate.yml' };
  jobs['doctor silent'] = { BOOTSTRAP_DOCTOR_DROP: 'config-manifest' };
  jobs['doctor fail'] = { BOOTSTRAP_DOCTOR_FAIL: 'config-manifest' };
  jobs['up warning'] = { BOOTSTRAP_UP_WARNING: 'warning: injected by the test' };
  jobs['no secret'] = { BOOTSTRAP_SKIP_SECRET: '1' };
  jobs['no merge keys'] = { BOOTSTRAP_SKIP_MERGE_KEYS: '1' };
  jobs['empty landing'] = { BOOTSTRAP_LAND_EMPTY: '1' };

  let results;
  before(
    async () => {
      results = await runMatrix(jobs);
    },
    { timeout: 600_000 },
  );

  it('a clean run prints the nine stages in order, each ok, and exits 0', () => {
    const r = results.clean;
    assert.equal(r.code, 0, r.out);
    let at = -1;
    for (const [i, name] of STAGES.entries()) {
      const start = r.out.indexOf(`[bootstrap-smoke] stage ${i + 1} ${name}\n`);
      assert.ok(start > at, `stage ${i + 1} ${name} out of order or missing\n${r.out}`);
      const ok = r.out.indexOf('[bootstrap-smoke]   ok', start);
      const nextStart = r.out.indexOf(`[bootstrap-smoke] stage ${i + 2} `, start);
      assert.ok(ok > start && (nextStart < 0 || ok < nextStart), `stage ${name} did not report ok`);
      at = start;
    }
    assert.match(r.out, /PASS in/);
  });

  for (const [i, name] of STAGES.entries()) {
    it(`skipping stage ${i + 1} (${name}) fails the run and names it`, () => {
      const r = results[`skip ${i + 1}`];
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`did not run:[^\\n]*\\b${name}\\b`), r.out);
    });
  }

  it('stage 2 fails when the merge settings, backlog/tasks or the gate workflow are removed', () => {
    for (const k of ['remove merge settings', 'remove backlog tasks', 'remove gate workflow']) {
      assert.notEqual(results[k].code, 0, k);
      assert.match(results[k].out, /setup did not create/, k);
      assert.match(results[k].out, /did not run:[^\n]*prerequisites/, k);
    }
  });

  it('stage 3 fails on a silent registry check and on one fail', () => {
    assert.match(results['doctor silent'].out, /config-manifest returned no result/);
    assert.notEqual(results['doctor silent'].code, 0);
    assert.match(results['doctor fail'].out, /doctor reported fail: config-manifest/);
    assert.notEqual(results['doctor fail'].code, 0);
  });

  it('stage 4 fails when up prints a warning line', () => {
    assert.notEqual(results['up warning'].code, 0);
    assert.match(results['up warning'].out, /warning: injected by the test/);
  });

  it('stage 4 shows the webhook: off line without the secret and passes with it', () => {
    assert.match(results.clean.out, /webhook: off/);
    assert.notEqual(results['no secret'].code, 0);
    assert.match(results['no secret'].out, /webhook: off[^\n]*AI_SDLC_WEBHOOK_SECRET/);
  });

  it('stage 4 fails while the merge keys are still off', () => {
    assert.notEqual(results['no merge keys'].code, 0);
    assert.match(results['no merge keys'].out, /merge off:|did not run:[^\n]*up/);
  });

  it('stage 9 does not pass on an empty landing report and names mergeAuthors', () => {
    assert.match(results.clean.out, /landing note: mergeAuthors is empty/);
    const r = results['empty landing'];
    assert.notEqual(r.code, 0);
    assert.match(r.out, /did not land pull request/);
    assert.match(r.out, /mergeAuthors/);
  });

  it('the clean run stays inside the five minute budget', () => {
    const m = /PASS in ([\d.]+)s/.exec(results.clean.out);
    assert.ok(m && Number(m[1]) < 300, results.clean.out);
  });
});
