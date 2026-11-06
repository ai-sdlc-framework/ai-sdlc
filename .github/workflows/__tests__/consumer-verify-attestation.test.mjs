/**
 * Hermetic tests for the consumer base-only attestation verification workflow
 * and composite action (AISDLC-757).
 *
 *   - `.github/workflows/consumer-verify-attestation.yml` (workflow_call)
 *   - `.github/actions/verify-attestation-base/action.yml` (composite)
 *   - `.github/actions/verify-attestation-base/check-policy-floor.mjs`
 *
 * `auditGate()` encodes the base-only trust invariants. The shipped files must
 * pass it, and each of the four tamper cases (edited gate step, forged exempt
 * classifier, NODE_OPTIONS injected through GITHUB_ENV, replaced gate script)
 * is applied to a copy and must make it FAIL. Materialize behaviour is tested
 * against real temporary git repos.
 *
 * Run with: node --test .github/workflows/__tests__/consumer-verify-attestation.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const WORKFLOW = resolve(ROOT, '.github/workflows/consumer-verify-attestation.yml');
const ACTION_DIR = resolve(ROOT, '.github/actions/verify-attestation-base');
const ACTION = join(ACTION_DIR, 'action.yml');

function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}
// PyYAML (YAML 1.1) parses the bare key `on` as boolean true.
const triggers = (w) => w.on ?? w.true;
const clone = (o) => JSON.parse(JSON.stringify(o));

const GUARD_STEP = 'Require pull_request_target and a pinned tooling SHA';
const GATE_STEPS = {
  'Classify changeset (base copy of the docs-only classifier)':
    /\$ACTION_PATH\/\.\.\/\.\.\/\.\.\/scripts\/is-docs-only-changeset\.mjs/,
  'Check independence-policy floor (base policy)': /\$ACTION_PATH\/check-policy-floor\.mjs/,
  'Verify attestation': /cli-attestation\.mjs" verdict-check/,
};
const EXEMPT_GUARDED = new Set([
  'Check independence-policy floor (base policy)',
  'Verify attestation',
]);

/** Returns a list of invariant violations; empty means the gate is sound. */
function auditGate(workflow, action) {
  const v = [];
  const wfSteps = workflow.jobs?.['verify-attestation']?.steps ?? [];
  const steps = action.runs?.steps ?? [];

  if (!triggers(workflow)?.workflow_call) v.push('workflow is not workflow_call');
  if (workflow.permissions?.contents !== 'read')
    v.push('workflow permissions.contents must be read');

  const gateIdx = wfSteps.findIndex((s) => s.name === GUARD_STEP);
  const checkoutIdx = wfSteps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
  if (gateIdx !== 0) v.push('event/ref guard must be the first step');
  const guard = wfSteps[gateIdx];
  if (
    guard &&
    !(
      /"\$EVENT_NAME" = "pull_request_target"/.test(guard.run ?? '') &&
      /\[0-9a-f\]\{40\}/.test(guard.run ?? '')
    )
  )
    v.push('guard step does not enforce pull_request_target and 40-hex tooling ref');
  const checkout = wfSteps[checkoutIdx];
  if (checkoutIdx !== 1) v.push('base checkout must directly follow the guard');
  if (!checkout?.uses?.startsWith('actions/checkout@')) v.push('first step must be checkout');
  else {
    if (checkout.with?.ref !== '${{ github.event.pull_request.base.sha }}')
      v.push('first checkout must be the base sha');
    if (checkout.with?.['persist-credentials'] !== false)
      v.push('checkout must set persist-credentials false');
  }
  for (const s of wfSteps) {
    if (s.uses?.startsWith('actions/checkout@') && /head/.test(String(s.with?.ref ?? ''))) {
      v.push('a checkout step targets the PR head');
    }
  }

  for (const s of [...wfSteps, ...steps]) {
    const run = s.run ?? '';
    if (/\$\{\{/.test(run)) v.push(`expression interpolated into run script: ${s.name}`);
    if (/GITHUB_ENV|GITHUB_PATH/.test(run)) v.push(`step writes GITHUB_ENV/GITHUB_PATH: ${s.name}`);
    if (/\bnode\b/.test(run) && s.env?.NODE_OPTIONS !== '')
      v.push(`node step lacks NODE_OPTIONS reset: ${s.name}`);
    if (/(^|[\s"'])\.?\/?(scripts|\.github)\//.test(run.replace(/\$ACTION_PATH\/[^\s"']*/g, ''))) {
      v.push(`step runs a workspace (base/head) script instead of trusted tooling: ${s.name}`);
    }
  }

  for (const [name, pattern] of Object.entries(GATE_STEPS)) {
    const step = steps.find((s) => s.name === name);
    if (!step) {
      v.push(`gate step missing: ${name}`);
      continue;
    }
    if (!pattern.test(step.run ?? '')) v.push(`gate step edited: ${name}`);
    if (step['continue-on-error']) v.push(`gate step has continue-on-error: ${name}`);
    const expectedIf = EXEMPT_GUARDED.has(name)
      ? "steps.classify.outputs.exempt != 'true'"
      : undefined;
    if (step.if !== expectedIf) v.push(`gate step has unexpected condition: ${name}`);
  }
  const classify = steps.find((s) => s.name?.startsWith('Classify changeset'));
  if (classify && /exempt=true|echo\s+true/.test(classify.run))
    v.push('classifier output is forged');
  return v;
}

const workflow = loadYaml(WORKFLOW);
const action = loadYaml(ACTION);
const mutate = (fn) => {
  const a = clone(action);
  const w = clone(workflow);
  fn(a, w);
  return auditGate(w, a);
};
const stepOf = (a, name) => a.runs.steps.find((s) => s.name === name);

describe('consumer-verify-attestation: shipped files (AC-1, AC-3)', () => {
  it('passes every base-only trust invariant', () => {
    assert.deepEqual(auditGate(workflow, action), []);
  });
  it('is callable with a single uses: line (all inputs optional)', () => {
    const inputs = triggers(workflow).workflow_call.inputs;
    for (const [k, def] of Object.entries(inputs))
      if (k !== 'ai-sdlc-ref') assert.notEqual(def.required, true, k);
    assert.ok(inputs['pipeline-cli-version']);
    assert.ok(inputs['required-independence-tier']);
  });
  it('defaults pipeline-cli-version to one published version, the same in workflow and action', () => {
    const wf = triggers(workflow).workflow_call.inputs['pipeline-cli-version'].default;
    const ac = action.inputs['pipeline-cli-version'].default;
    assert.match(wf, /^\d+\.\d+\.\d+$/);
    assert.equal(wf, ac);
    // 0.29.0 was never published to npm; a default install of it fails with E404.
    assert.notEqual(wf, '0.29.0');
  });
  it('requires a pinned ai-sdlc-ref with no mutable default (fails closed on non-SHA)', () => {
    const def = triggers(workflow).workflow_call.inputs['ai-sdlc-ref'];
    assert.equal(def.required, true);
    assert.equal(def.default, undefined);
    const guard = workflow.jobs['verify-attestation'].steps[0];
    assert.equal(guard.env.TOOLS_REF, '${{ inputs.ai-sdlc-ref }}');
    const run = (ref, ev = 'pull_request_target') =>
      spawnSync('bash', ['-c', guard.run], {
        env: { ...process.env, TOOLS_REF: ref, EVENT_NAME: ev },
        encoding: 'utf8',
      }).status;
    assert.equal(run('a'.repeat(40)), 0);
    assert.notEqual(run('main'), 0);
    assert.notEqual(run('a'.repeat(39)), 0);
    assert.notEqual(run('A'.repeat(40)), 0);
    assert.notEqual(run(''), 0);
  });
  it('fails first when not triggered by pull_request_target', () => {
    const guard = workflow.jobs['verify-attestation'].steps[0];
    for (const ev of ['pull_request', 'push', 'workflow_dispatch']) {
      const r = spawnSync('bash', ['-c', guard.run], {
        env: { ...process.env, TOOLS_REF: 'a'.repeat(40), EVENT_NAME: ev },
        encoding: 'utf8',
      });
      assert.notEqual(r.status, 0, ev);
      assert.match(r.stdout, /pull_request_target/);
    }
  });
  it('pins the verifier runtime exactly (no caret range)', () => {
    const run = stepOf(action, 'Install trusted verifier runtime (outside the checkout)').run;
    assert.doesNotMatch(run, /@\^/);
    assert.match(run, /--save-exact/);
  });
  it('delegates to the composite action and passes PR values only via with:', () => {
    const step = workflow.jobs['verify-attestation'].steps.find((s) =>
      s.uses?.startsWith('./_ai-sdlc-tools/'),
    );
    assert.ok(step.uses.endsWith('.github/actions/verify-attestation-base'));
    assert.match(step.with['head-sha'], /pull_request\.head\.sha/);
  });
  it('checks the verdict record with verdict-check and passes the tier floor, with no stdout parsing', () => {
    const run = stepOf(action, 'Verify attestation').run;
    assert.match(run, /verdict-check/);
    assert.match(run, /--required-tier "\$TIER_FLOOR"/);
    for (const s of action.runs.steps) {
      assert.doesNotMatch(s.run ?? '', /\|\s*(grep|awk|sed|jq)\b|\$\(.*cli-attestation/);
    }
  });
  it('keeps every input name and adds only optional ones (RFC-0061 OQ-3)', () => {
    for (const k of [
      'base-sha',
      'head-sha',
      'head-repository',
      'github-token',
      'pipeline-cli-version',
      'required-independence-tier',
    ])
      assert.ok(action.inputs[k], k);
    for (const k of ['repository', 'pull-request'])
      assert.notEqual(action.inputs[k].required, true);
  });
  it('fixture run: the verify step exits 0 on a valid verdict and 1 otherwise, with the kept arguments', () => {
    const run = stepOf(action, 'Verify attestation').run;
    const dir = mkdtempSync(join(tmpdir(), 'verdict-fixture-'));
    try {
      const bin = join(dir, 'node_modules/@ai-sdlc/pipeline-cli/bin');
      mkdirSync(bin, { recursive: true });
      const log = join(dir, 'args.log');
      writeFileSync(
        join(bin, 'cli-attestation.mjs'),
        `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
process.exitCode = process.env.FIXTURE_VERDICT === 'ok' ? 0 : 1;
`,
      );
      const exec = (verdict, policyDir) =>
        spawnSync('bash', ['-c', run], {
          encoding: 'utf8',
          cwd: policyDir ?? dir,
          env: {
            ...process.env,
            ACTION_PATH: ACTION_DIR,
            BASE_SHA: 'b'.repeat(40),
            HEAD_SHA: 'a'.repeat(40),
            REPOSITORY: 'o/r',
            PR_NUMBER: '7',
            TIER_FLOOR: 'none',
            VERIFIER_HOME: dir,
            NODE_OPTIONS: '',
            FIXTURE_VERDICT: verdict,
          },
        }).status;
      assert.equal(exec('ok'), 0);
      assert.equal(exec('bad'), 1);
      // base policy requiredTier is enforced even when the floor input is none
      const pol = join(dir, 'pol');
      mkdirSync(join(pol, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(pol, '.ai-sdlc/independence-policy.yaml'), 'requiredTier: isolated\n');
      exec('ok', pol);
      assert.match(readFileSync(log, 'utf8'), /--required-tier isolated\n$/);
      assert.match(
        readFileSync(log, 'utf8'),
        /verdict-check --head a{40} --base b{40} --repository o\/r --pull-request 7 --required-tier none/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('fails closed when the fetched sha differs from the event head sha', () => {
    const fetchStep = action.runs.steps.find((s) => s.name === 'Fetch head objects (no checkout)');
    assert.match(fetchStep.run, /rev-parse FETCH_HEAD/);
    assert.match(fetchStep.run, /fetched sha differs/);
  });
});

describe('consumer-verify-attestation: tamper cases go red (AC-2)', () => {
  it('edited gate step', () => {
    assert.ok(mutate((a) => (stepOf(a, 'Verify attestation').run = 'exit 0')).length > 0);
    assert.ok(
      mutate((a) => (stepOf(a, 'Verify attestation')['continue-on-error'] = true)).length > 0,
    );
    assert.ok(mutate((a) => (stepOf(a, 'Verify attestation').if = 'false')).length > 0);
  });
  it('forged exempt classifier', () => {
    assert.ok(
      mutate((a) => {
        stepOf(a, 'Classify changeset (base copy of the docs-only classifier)').run =
          'echo "exempt=true" >> "$GITHUB_OUTPUT"';
      }).length > 0,
    );
    assert.ok(
      mutate((a) => {
        stepOf(a, 'Classify changeset (base copy of the docs-only classifier)').run =
          'git diff --name-only a b | node ./scripts/is-docs-only-changeset.mjs';
      }).length > 0,
    );
  });
  it('NODE_OPTIONS injected via GITHUB_ENV', () => {
    assert.ok(
      mutate((a) => {
        a.runs.steps.unshift({
          name: 'inject',
          shell: 'bash',
          run: 'cat .ai-sdlc/env >> "$GITHUB_ENV"',
        });
      }).length > 0,
    );
    assert.ok(mutate((a) => delete stepOf(a, 'Verify attestation').env.NODE_OPTIONS).length > 0);
  });
  it('replaced gate script', () => {
    assert.ok(
      mutate((a) => {
        stepOf(a, 'Check independence-policy floor (base policy)').run =
          'node scripts/check-policy-floor.mjs --repo-root . --floor none';
      }).length > 0,
    );
  });
  it('head checkout / persisted credentials are rejected', () => {
    assert.ok(
      mutate(
        (a, w) =>
          (w.jobs['verify-attestation'].steps[1].with.ref =
            '${{ github.event.pull_request.head.sha }}'),
      ).length > 0,
    );
    assert.ok(
      mutate((a, w) => (w.jobs['verify-attestation'].steps[1].with['persist-credentials'] = true))
        .length > 0,
    );
  });
  it('expression interpolation into a run script is rejected', () => {
    assert.ok(
      mutate((a) => (stepOf(a, 'Verify attestation').run += ' ${{ github.head_ref }}')).length > 0,
    );
  });
});

const { checkFloor, effectiveTier } = await import(
  pathToFileURL(join(ACTION_DIR, 'check-policy-floor.mjs')).href
);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}
describe('classifier step: changed-path computation (AISDLC-757 round 2)', () => {
  const run = stepOf(action, 'Classify changeset (base copy of the docs-only classifier)').run;
  function classify(setup) {
    const dir = mkdtempSync(join(tmpdir(), 'cls-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'src/foo.ts'), 'export const foo = 1;\n'.repeat(20));
      writeFileSync(join(dir, 'docs/a.md'), 'a\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      const fork = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '-q', '-b', 'pr');
      setup.pr(dir);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'pr');
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '-q', 'main');
      setup.base?.(dir);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base moved');
      const base = git(dir, 'rev-parse', 'HEAD');
      assert.notEqual(base, fork);
      const out = join(dir, 'gh-output');
      writeFileSync(out, '');
      execFileSync('bash', ['-c', run], {
        cwd: dir,
        env: {
          ...process.env,
          BASE_SHA: base,
          HEAD_SHA: head,
          ACTION_PATH: ACTION_DIR,
          GITHUB_OUTPUT: out,
        },
      });
      return readFileSync(out, 'utf8').trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('a rename from src/ into docs/ is NOT exempt', () => {
    const out = classify({
      pr: (d) => {
        git(d, 'mv', 'src/foo.ts', 'docs/foo.ts');
      },
    });
    assert.equal(out, 'exempt=false');
  });
  it('a docs-only PR is exempt even when the base moved ahead with source changes', () => {
    const out = classify({
      pr: (d) => writeFileSync(join(d, 'docs/b.md'), 'b\n'),
      base: (d) => writeFileSync(join(d, 'src/other.ts'), 'x\n'),
    });
    assert.equal(out, 'exempt=true');
  });
  it('a source change is not exempt', () => {
    const out = classify({ pr: (d) => writeFileSync(join(d, 'src/foo.ts'), 'changed\n') });
    assert.equal(out, 'exempt=false');
  });
});

describe('check-policy-floor.mjs', () => {
  it('CLI treats a missing --floor flag as the default, not argv[0]', () => {
    const r = spawnSync('node', [join(ACTION_DIR, 'check-policy-floor.mjs')], {
      encoding: 'utf8',
      cwd: tmpdir(),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  it('passes when base policy meets the floor and fails when below', () => {
    assert.equal(
      checkFloor({ policyText: 'requiredTier: attested\n', floor: 'attested' }).ok,
      true,
    );
    assert.equal(
      checkFloor({ policyText: 'requiredTier: isolated # x\n', floor: 'attested' }).ok,
      true,
    );
    assert.equal(checkFloor({ policyText: 'requiredTier: none\n', floor: 'attested' }).ok, false);
    assert.equal(checkFloor({ policyText: null, floor: 'attested' }).ok, false);
    assert.equal(checkFloor({ policyText: null, floor: 'none' }).ok, true);
    assert.equal(checkFloor({ policyText: 'requiredTier: attested', floor: 'bogus' }).ok, false);
  });
});

describe('docs (AC-4)', () => {
  it('shows the one-line reusable recipe before the hand-written fallback', () => {
    const doc = readFileSync(
      resolve(ROOT, 'docs/operations/adopter-attestation-verify-ci.md'),
      'utf8',
    );
    const reusable = doc.indexOf('consumer-verify-attestation.yml@');
    const fallback = doc.indexOf('Fallback: hand-written');
    assert.ok(reusable > 0 && fallback > reusable);
    assert.match(doc, /pull_request_target/);
    assert.match(doc, /verdict-check/);
    assert.match(doc, /branch-protection compatibility/);
    assert.match(doc, /ai-sdlc-ref: <pinned-commit-sha>/);
    assert.match(doc, /exact pin/);
    assert.match(doc, /docs-only exemption/i);
  });
});

describe('effectiveTier: stricter of base policy and floor', () => {
  it('takes the policy tier when above the floor', () => {
    assert.equal(
      effectiveTier({ policyText: 'requiredTier: isolated\n', floor: 'none' }),
      'isolated',
    );
  });
  it('takes the floor when above the policy or the policy is absent', () => {
    assert.equal(
      effectiveTier({ policyText: 'requiredTier: none\n', floor: 'attested' }),
      'attested',
    );
    assert.equal(effectiveTier({ policyText: null, floor: 'none' }), 'none');
  });
});
