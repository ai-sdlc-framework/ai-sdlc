/**
 * Hermetic tests for the consumer base-only attestation verification workflow
 * and composite action (AISDLC-757).
 *
 *   - `.github/workflows/consumer-verify-attestation.yml` (workflow_call)
 *   - `.github/actions/verify-attestation-base/action.yml` (composite)
 *   - `.github/actions/verify-attestation-base/materialize-head-data.mjs`
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
import { execFileSync } from 'node:child_process';
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

const GATE_STEPS = {
  'Classify changeset (base copy of the docs-only classifier)':
    /\$ACTION_PATH\/\.\.\/\.\.\/\.\.\/scripts\/is-docs-only-changeset\.mjs/,
  'Materialize head attestation data (untrusted data only)':
    /\$ACTION_PATH\/materialize-head-data\.mjs/,
  'Check independence-policy floor (base policy)': /\$ACTION_PATH\/check-policy-floor\.mjs/,
  'Verify attestation': /cli-attestation\.mjs" verify/,
  'Enforce independence policy': /cli-attestation\.mjs" independence-policy/,
};
const EXEMPT_GUARDED = new Set([
  'Materialize head attestation data (untrusted data only)',
  'Check independence-policy floor (base policy)',
  'Verify attestation',
  'Enforce independence policy',
]);

/** Returns a list of invariant violations; empty means the gate is sound. */
function auditGate(workflow, action) {
  const v = [];
  const wfSteps = workflow.jobs?.['verify-attestation']?.steps ?? [];
  const steps = action.runs?.steps ?? [];

  if (!triggers(workflow)?.workflow_call) v.push('workflow is not workflow_call');
  if (workflow.permissions?.contents !== 'read')
    v.push('workflow permissions.contents must be read');

  const checkout = wfSteps[0];
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
    for (const [k, def] of Object.entries(inputs)) assert.notEqual(def.required, true, k);
    assert.ok(inputs['pipeline-cli-version']);
    assert.ok(inputs['required-independence-tier']);
  });
  it('delegates to the composite action and passes PR values only via with:', () => {
    const step = workflow.jobs['verify-attestation'].steps.find((s) =>
      s.uses?.startsWith('./_ai-sdlc-tools/'),
    );
    assert.ok(step.uses.endsWith('.github/actions/verify-attestation-base'));
    assert.match(step.with['head-sha'], /pull_request\.head\.sha/);
  });
  it('enforces independence via cli-attestation independence-policy with no bespoke script or stdout parsing', () => {
    const run = stepOf(action, 'Enforce independence policy').run;
    assert.match(run, /independence-policy/);
    for (const s of action.runs.steps) {
      assert.doesNotMatch(s.run ?? '', /\|\s*(grep|awk|sed|jq)\b|\$\(.*cli-attestation/);
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
    assert.ok(mutate((a) => (stepOf(a, 'Enforce independence policy').if = 'false')).length > 0);
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
        stepOf(a, 'Materialize head attestation data (untrusted data only)').run =
          'node scripts/materialize-head-data.mjs --repo-root . --head-sha "$HEAD_SHA"';
      }).length > 0,
    );
  });
  it('head checkout / persisted credentials are rejected', () => {
    assert.ok(
      mutate(
        (a, w) =>
          (w.jobs['verify-attestation'].steps[0].with.ref =
            '${{ github.event.pull_request.head.sha }}'),
      ).length > 0,
    );
    assert.ok(
      mutate((a, w) => (w.jobs['verify-attestation'].steps[0].with['persist-credentials'] = true))
        .length > 0,
    );
  });
  it('expression interpolation into a run script is rejected', () => {
    assert.ok(
      mutate((a) => (stepOf(a, 'Verify attestation').run += ' ${{ github.head_ref }}')).length > 0,
    );
  });
});

const { materializeHeadData, MaterializeError } = await import(
  pathToFileURL(join(ACTION_DIR, 'materialize-head-data.mjs')).href
);
const { checkFloor } = await import(pathToFileURL(join(ACTION_DIR, 'check-policy-floor.mjs')).href);

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
function repoWithHead(files, symlinks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mat-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README'), 'base');
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(dir, '.ai-sdlc/trusted-reviewers.yaml'), 'trusted: base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  for (const [p, target] of Object.entries(symlinks)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    symlinkSync(target, join(dir, p));
  }
  writeFileSync(join(dir, '.ai-sdlc/trusted-reviewers.yaml'), 'trusted: HEAD-FORGED\n');
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'head');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', base);
  return { dir, head };
}
const LEAF = 'a'.repeat(40);

describe('materialize-head-data.mjs', () => {
  it('copies only envelope + leaves and never head scripts or the trust root', () => {
    const { dir, head } = repoWithHead({
      '.ai-sdlc/attestations/abc.v6.dsse.json': '{"env":1}',
      '.ai-sdlc/transcript-leaves.jsonl': 'leaf\n',
      [`.ai-sdlc/transcript-leaves/${LEAF}.jsonl`]: 'leaf2\n',
      'scripts/is-docs-only-changeset.mjs': 'forged',
      '.github/actions/verify-attestation-base/materialize-head-data.mjs': 'replaced',
    });
    try {
      const copied = materializeHeadData({ repoRoot: dir, headSha: head });
      assert.deepEqual(
        copied.sort(),
        [
          '.ai-sdlc/attestations/abc.v6.dsse.json',
          `.ai-sdlc/transcript-leaves/${LEAF}.jsonl`,
          '.ai-sdlc/transcript-leaves.jsonl',
        ].sort(),
      );
      assert.equal(
        readFileSync(join(dir, '.ai-sdlc/attestations/abc.v6.dsse.json'), 'utf8'),
        '{"env":1}',
      );
      assert.equal(existsSync(join(dir, 'scripts/is-docs-only-changeset.mjs')), false);
      assert.equal(existsSync(join(dir, '.github')), false);
      assert.equal(
        readFileSync(join(dir, '.ai-sdlc/trusted-reviewers.yaml'), 'utf8'),
        'trusted: base\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses a symlinked envelope', () => {
    const { dir, head } = repoWithHead(
      {},
      { '.ai-sdlc/attestations/evil.dsse.json': '/etc/passwd' },
    );
    try {
      assert.throws(() => materializeHeadData({ repoRoot: dir, headSha: head }), MaterializeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses a destination that traverses a base-side symlink', () => {
    const { dir, head } = repoWithHead({ '.ai-sdlc/attestations/ok.dsse.json': '{}' });
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    try {
      rmSync(join(dir, '.ai-sdlc/attestations'), { recursive: true, force: true });
      symlinkSync(outside, join(dir, '.ai-sdlc/attestations'));
      assert.throws(() => materializeHeadData({ repoRoot: dir, headSha: head }), /symlink/);
      assert.equal(existsSync(join(outside, 'ok.dsse.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('rejects a malformed head sha', () => {
    assert.throws(() => materializeHeadData({ repoRoot: '.', headSha: 'HEAD' }), MaterializeError);
  });
  it('CLI exits non-zero on failure', () => {
    assert.throws(() =>
      execFileSync(
        'node',
        [join(ACTION_DIR, 'materialize-head-data.mjs'), '--repo-root', '.', '--head-sha', 'nope'],
        {
          stdio: 'pipe',
        },
      ),
    );
  });
});

describe('check-policy-floor.mjs', () => {
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
    assert.match(doc, /independence-policy/);
  });
});
