/**
 * AISDLC-1411: the auto-enable workflow arms only PRs whose author is in
 * `spec.governance.mergeAuthors`, read from the base branch through the API.
 *
 * On 2026-11-25 a collaborator with write access opened nine PRs from in-repo
 * branches; the workflow armed each within seconds and they merged unreviewed.
 * These tests pin the author check structurally and run the guard step's shell
 * against stub `gh` and `yq` binaries.
 *
 * AISDLC-1461: the filter first read `.governance.mergeAuthors` while the key
 * lives at `spec.governance.mergeAuthors`, so the list was always empty and
 * nothing was armed. The yq stub now evaluates the filter the workflow passes
 * (not a hard-coded path), and a test runs it against the repository's real
 * `.ai-sdlc/agent-role.yaml`, so a path drift fails here instead of production.
 *
 * Run with: node --test .github/workflows/__tests__/auto-enable-author.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_ROLE_FILE = resolve(WORKFLOWS_DIR, '..', '..', '.ai-sdlc', 'agent-role.yaml');

function loadYaml(name) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',
        join(WORKFLOWS_DIR, name),
      ],
      { encoding: 'utf8' },
    ),
  );
}

const wf = loadYaml('auto-enable-auto-merge.yml');
const steps = wf.jobs['enable-auto-merge'].steps;
const guard = steps.find((s) => s.id === 'guard');
const arm = steps.find((s) => String(s.name).startsWith('Refresh auto-merge'));
const FILTER = /yq -o=json '([^']+)'/.exec(guard?.run ?? '')?.[1];

// Python evaluator for the `.a.b.c // []` filter shape the guard uses. It walks
// whatever path the workflow names, so the tests follow the real filter.
const YQ_EVAL = [
  'import sys, json, yaml',
  'expr = sys.argv[-1]',
  'path, _, default = expr.partition("//")',
  'node = yaml.safe_load(sys.stdin.read())',
  'for key in [k for k in path.strip().split(".") if k]:',
  '    node = node.get(key) if isinstance(node, dict) else None',
  'print(json.dumps(node if node is not None else json.loads(default.strip() or "null")))',
].join('\n');

function evalFilter(filter, yamlText) {
  return JSON.parse(
    execFileSync('python3', ['-c', YQ_EVAL, filter], { input: yamlText, encoding: 'utf8' }),
  );
}

describe('auto-enable author rule: structure (AISDLC-1411)', () => {
  it('the guard step reads spec.governance.mergeAuthors from the base branch via the API', () => {
    assert.ok(guard, 'guard step exists');
    assert.match(guard.run, /--json [^\n]*\bauthor\b/);
    assert.match(guard.run, /--json [^\n]*\bbaseRefName\b/);
    assert.match(guard.run, /contents\/\.ai-sdlc\/agent-role\.yaml\?ref=\$BASE_REF/);
    assert.equal(FILTER, '.spec.governance.mergeAuthors // []');
    assert.match(guard.run, /is not in spec\.governance\.mergeAuthors/);
    assert.match(guard.run, /spec\.governance\.mergeAuthors is missing or empty/);
    assert.match(guard.run, /is in spec\.governance\.mergeAuthors — arming\./);
  });

  it('the arm step runs only when the guard explicitly said skip=false', () => {
    assert.ok(arm, 'arm step exists');
    assert.match(arm.if, /steps\.guard\.outputs\.skip == 'false'/);
  });

  it('no step checks out code (the list is never read from the PR head)', () => {
    for (const s of steps) assert.ok(!String(s.uses ?? '').startsWith('actions/checkout'));
  });
});

describe('auto-enable author rule: real agent-role.yaml (AISDLC-1461)', () => {
  it("the workflow's filter yields the configured merge authors from the real file", () => {
    const text = readFileSync(REAL_ROLE_FILE, 'utf8');
    const configured = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))["spec"]["governance"]["mergeAuthors"]))',
          REAL_ROLE_FILE,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.ok(Array.isArray(configured) && configured.length > 0, 'mergeAuthors configured');
    const got = evalFilter(FILTER, text);
    assert.ok(Array.isArray(got) && got.length > 0, `filter ${FILTER} yields a non-empty list`);
    assert.deepEqual(got, configured);
    assert.ok(got.includes('deefactorial'));
  });
});

describe('auto-enable author rule: behaviour (AISDLC-1411)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-enable-author-'));
    // Stub gh: `pr view` prints the already-filtered PR info; `api` prints the role file.
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "pr" ]; then printf "%s\\n" "$FAKE_PR_INFO"; exit 0; fi',
        'if [ "$1" = "api" ]; then',
        '  echo "$*" >> "$FAKE_API_LOG"',
        '  [ -n "$FAKE_ROLE_FAIL" ] && { echo "HTTP 404" >&2; exit 1; }',
        '  cat "$FAKE_ROLE_FILE"; exit 0',
        'fi',
        'exit 2',
      ].join('\n'),
    );
    // Stub yq: evaluates the filter the workflow passes (`.a.b // []`) to JSON.
    writeFileSync(join(dir, 'yq'), `#!/usr/bin/env python3\n${YQ_EVAL}\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    chmodSync(join(dir, 'yq'), 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function runGuard({ author, role, roleFail = false, isDraft = false }) {
    const roleFile = join(dir, 'agent-role.yaml');
    writeFileSync(roleFile, role ?? '');
    const out = join(dir, 'out');
    const apiLog = join(dir, 'api.log');
    writeFileSync(out, '');
    writeFileSync(apiLog, '');
    const prInfo = JSON.stringify({
      isDraft,
      headRefName: 'feat/x',
      baseRefName: 'main',
      author,
      headFull: 'org/repo',
    });
    const res = spawnSync('bash', ['-c', guard.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        PR: '42',
        REPO: 'org/repo',
        GH_REPO: 'org/repo',
        FAKE_PR_INFO: prInfo,
        FAKE_ROLE_FILE: roleFile,
        FAKE_ROLE_FAIL: roleFail ? '1' : '',
        FAKE_API_LOG: apiLog,
      },
    });
    assert.equal(res.status, 0, res.stderr);
    return {
      skip: /skip=(\w+)/.exec(readFileSync(out, 'utf8'))?.[1],
      log: res.stdout,
      api: readFileSync(apiLog, 'utf8'),
    };
  }

  const ROLE = 'spec:\n  governance:\n    mergeAuthors:\n      - Alice\n      - bob\n';

  it('arms a PR whose author is a merge author (case-insensitive)', () => {
    const r = runGuard({ author: 'alice', role: ROLE });
    assert.equal(r.skip, 'false');
    assert.match(r.log, /author 'alice' is in spec\.governance\.mergeAuthors — arming\./);
    assert.match(r.api, /contents\/\.ai-sdlc\/agent-role\.yaml\?ref=main/);
  });

  it('does not arm a PR from a collaborator outside mergeAuthors, and names the author', () => {
    const r = runGuard({ author: 'outsider', role: ROLE });
    assert.equal(r.skip, 'true');
    assert.match(r.log, /author 'outsider' is not in spec\.governance\.mergeAuthors/);
  });

  it('arms a merge author against the real agent-role.yaml (AISDLC-1461)', () => {
    const r = runGuard({ author: 'deefactorial', role: readFileSync(REAL_ROLE_FILE, 'utf8') });
    assert.equal(r.skip, 'false', r.log);
    assert.match(r.log, /is in spec\.governance\.mergeAuthors — arming\./);
  });

  it('does not arm dependabot', () => {
    assert.equal(runGuard({ author: 'dependabot[bot]', role: ROLE }).skip, 'true');
  });

  it('does not arm when the author is unknown', () => {
    const r = runGuard({ author: '', role: ROLE });
    assert.equal(r.skip, 'true');
    assert.match(r.log, /author '<unknown>'/);
  });

  it('does not arm when the role file cannot be read on the base branch', () => {
    const r = runGuard({ author: 'alice', role: ROLE, roleFail: true });
    assert.equal(r.skip, 'true');
    assert.match(r.log, /cannot read \.ai-sdlc\/agent-role\.yaml/);
  });

  it('does not arm when mergeAuthors is missing, empty or not a list', () => {
    for (const role of [
      'spec:\n  governance:\n    allowMerge: onGreenClean\n',
      'spec:\n  governance:\n    mergeAuthors: []\n',
      'spec:\n  governance:\n    mergeAuthors: alice\n',
      // The pre-AISDLC-1461 top-level path is not read.
      'governance:\n  mergeAuthors:\n    - alice\n',
      '',
    ]) {
      const r = runGuard({ author: 'alice', role });
      assert.equal(r.skip, 'true', `role: ${JSON.stringify(role)}`);
      assert.match(r.log, /spec\.governance\.mergeAuthors is missing or empty/);
    }
  });

  it('still skips drafts before reading the role file', () => {
    const r = runGuard({ author: 'alice', role: ROLE, isDraft: true });
    assert.equal(r.skip, 'true');
    assert.equal(r.api, '');
  });
});
