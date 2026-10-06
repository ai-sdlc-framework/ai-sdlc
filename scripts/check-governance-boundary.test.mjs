import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateGovernanceBoundary as ev,
  checkFileListComplete,
  isGovernancePath,
  main,
} from './check-governance-boundary.mjs';

const gov = ['.ai-sdlc/agent-role.yaml'];
const wf = ['.github/workflows/ci.yml'];

test('fork changing governance config fails with maintainer message', () => {
  const r = ev({ isFork: true, authorAssociation: 'OWNER', changedFiles: gov });
  assert.equal(r.ok, false);
  assert.match(r.message, /maintainer must make that change/);
  assert.match(r.message, /CONTRIBUTOR or NONE/);
  assert.match(r.message, /re-push/);
});
test('fork changing workflows fails', () => {
  assert.equal(ev({ isFork: true, changedFiles: wf }).ok, false);
});
test('outside author (CONTRIBUTOR/NONE) same-repo fails', () => {
  assert.equal(ev({ isFork: false, authorAssociation: 'CONTRIBUTOR', changedFiles: wf }).ok, false);
  assert.equal(ev({ isFork: false, authorAssociation: '', changedFiles: gov }).ok, false);
});
test('internal OWNER/MEMBER/COLLABORATOR same-repo passes', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR'])
    assert.equal(
      ev({ isFork: false, authorAssociation: a, changedFiles: [...gov, ...wf] }).ok,
      true,
    );
});
test('fork or outside author not touching governance passes', () => {
  assert.equal(
    ev({ isFork: true, changedFiles: ['src/a.ts', '.ai-sdlc/attestations/x.json'] }).ok,
    true,
  );
  assert.equal(
    ev({ isFork: false, authorAssociation: 'NONE', changedFiles: ['README.md'] }).ok,
    true,
  );
});
test('dependabot same-repo workflow bump passes; spoofed fork does not', () => {
  const base = { authorLogin: 'dependabot[bot]', authorType: 'Bot', changedFiles: wf };
  assert.equal(ev({ ...base, isFork: false, authorAssociation: 'NONE' }).ok, true);
  assert.equal(ev({ ...base, isFork: true }).ok, false);
});

test('newly covered paths are governance; ordinary source and artifacts are not', () => {
  for (const p of [
    '.github/CODEOWNERS',
    '.github/dependabot.yml',
    '.github/actions/x/action.yml',
    'ai-sdlc-plugin/hooks/enforce-blocked-actions.js',
    '.claude/settings.json',
    '.husky/pre-push',
    'scripts/verify-attestation.mjs',
    '.ai-sdlc/dark-code-baseline.json',
    '.ai-sdlc/adapter-binding-new.yaml',
    '.ai-sdlc/custom-policy.md',
    '.ai-sdlc/custom-principles.md',
    '.ai-sdlc/templates/decisions-config.yaml',
  ])
    assert.equal(isGovernancePath(p), true, p);
  for (const p of [
    'pipeline-cli/src/a.ts',
    'ai-sdlc-plugin/commands/execute.md',
    '.ai-sdlc/attestations/x.dsse.json',
    '.ai-sdlc/reviews/x.jsonl',
    '.ai-sdlc/_decisions/events.jsonl',
    '.ai-sdlc/sub/dir.yaml',
  ])
    assert.equal(isGovernancePath(p), false, p);
});

test('boundary covers every tracked file the operator digest treats as governance', () => {
  const ts = readFileSync('pipeline-cli/src/decisions/operator-digest.ts', 'utf8');
  const block = ts.match(/GOVERNANCE_PATHSPECS = \[([\s\S]*?)\]/)[1];
  const specs = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  const tracked = execFileSync('git', ['ls-files', '--', ...specs], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(tracked.length > 0);
  for (const f of tracked) assert.equal(isGovernancePath(f), true, `${f} not covered`);
});

test('checkFileListComplete: pass, truncation, mismatch, missing, non-numeric', () => {
  assert.equal(checkFileListComplete({ declared: '5', rows: 5 }).ok, true);
  const trunc = checkFileListComplete({ declared: '3000', rows: 3000 });
  assert.equal(trunc.ok, false);
  assert.match(trunc.message, /maintainer must review a PR this large/);
  assert.equal(checkFileListComplete({ declared: '4500', rows: 3000 }).ok, false);
  const mismatch = checkFileListComplete({ declared: '10', rows: 7 });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /maintainer must review/);
  assert.equal(checkFileListComplete({ declared: undefined, rows: 1 }).ok, false);
  assert.equal(checkFileListComplete({ declared: '', rows: 0 }).ok, false);
  assert.equal(checkFileListComplete({ declared: 'abc', rows: 1 }).ok, false);
});

test('main(): count gate, fork default, rename column, trusted pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-'));
  try {
    const f = join(dir, 'files.txt');
    const run = (lines, env) => {
      writeFileSync(f, lines.join('\n'));
      return main(['node', 'x', '--files', f], env);
    };
    assert.equal(main(['node', 'x']).code, 2);
    // missing count fails closed
    assert.equal(run(['README.md'], {}).code, 1);
    // truncated list fails closed even when no row is governance
    const t = run(['a.ts'], {
      PR_CHANGED_FILES: '3000',
      PR_IS_FORK: 'false',
      PR_AUTHOR_ASSOCIATION: 'OWNER',
    });
    assert.equal(t.code, 1);
    assert.match(t.errors[0], /maintainer must review a PR this large/);
    // PR_IS_FORK unset defaults to fork: governance change fails even for OWNER
    const d = run(['.github/workflows/ci.yml'], {
      PR_CHANGED_FILES: '1',
      PR_AUTHOR_ASSOCIATION: 'OWNER',
    });
    assert.equal(d.code, 1);
    // rename out of a governance path is caught through previous_filename
    const r = run(['docs/x.md\t.ai-sdlc/agent-role.yaml'], {
      PR_CHANGED_FILES: '1',
      PR_AUTHOR_ASSOCIATION: 'NONE',
      PR_IS_FORK: 'false',
    });
    assert.equal(r.code, 1);
    // trusted internal author passes
    const ok = run(['.github/workflows/ci.yml'], {
      PR_CHANGED_FILES: '1',
      PR_IS_FORK: 'false',
      PR_AUTHOR_ASSOCIATION: 'MEMBER',
    });
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.out, ['governance boundary: ok']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
