import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatter, checkRegistry, applyFixes } from './check-rfc-registry.mjs';
import { statusOf, fixStatus } from './check-completed-status.mjs';

const rfc = {
  num: '0005',
  file: 'RFC-0005-x.md',
  title: 'X',
  status: 'Draft',
  lifecycle: 'Signed Off',
  author: 'A',
};
const readme = [
  '| 0004 | Y | a | Draft | 0 | A | [RFC-0004-y.md](RFC-0004-y.md) | n |',
  '| 0006 | Z | a | Draft | 0 | A | [RFC-0006-z.md](RFC-0006-z.md) | n |',
].join('\n');

test('frontmatter parses scalar keys', () => {
  assert.equal(frontmatter('---\nlifecycle: "Draft"\ntitle: T\n---\nbody').lifecycle, 'Draft');
  assert.deepEqual(frontmatter('no fm'), {});
});

test('missing row is reported and inserted in order', () => {
  const { lines, problems } = checkRegistry(readme, [rfc]);
  assert.equal(problems[0].kind, 'missing');
  const fixed = applyFixes(lines, problems);
  assert.match(fixed[1], /^\| 0005 \| X \| Draft \| Signed Off /);
  assert.equal(checkRegistry(fixed.join('\n'), [rfc]).problems.length, 0);
});

test('stale lifecycle is reported and rewritten', () => {
  const r = { ...rfc, num: '0004', file: 'RFC-0004-y.md', lifecycle: 'Implemented' };
  const { lines, problems } = checkRegistry(readme, [r]);
  assert.equal(problems[0].kind, 'stale');
  assert.equal(checkRegistry(applyFixes(lines, problems).join('\n'), [r]).problems.length, 0);
});

test('completed status helpers', () => {
  const t = '---\nid: A\nstatus: To Do\n---\nstatus: keep\n';
  assert.equal(statusOf(t), 'To Do');
  assert.equal(statusOf(fixStatus(t)), 'Done');
  assert.ok(fixStatus(t).endsWith('status: keep\n'));
  assert.equal(statusOf('none'), null);
});
