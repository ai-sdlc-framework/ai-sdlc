import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGovernanceBoundary as ev } from './check-governance-boundary.mjs';

const gov = ['.ai-sdlc/agent-role.yaml'];
const wf = ['.github/workflows/ci.yml'];

test('fork changing governance config fails with maintainer message', () => {
  const r = ev({ isFork: true, authorAssociation: 'OWNER', changedFiles: gov });
  assert.equal(r.ok, false);
  assert.match(r.message, /maintainer must make that change/);
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
