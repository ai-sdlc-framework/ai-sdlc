import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hotfixPipelineRef, parseLabels } from './hotfix-pipeline-ref.mjs';

const GOOD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const kg = JSON.stringify({ sha: GOOD, recordedAt: '2026-10-22T00:00:00Z' });

describe('AISDLC-1024: claim-side AI_SDLC_PIPELINE_REF export', () => {
  it('parses block and inline labels', () => {
    assert.deepEqual(
      parseLabels('---\nid: X\nlabels:\n  - pipeline\n  - pipeline-hotfix\npriority: high\n---\n'),
      ['pipeline', 'pipeline-hotfix'],
    );
    assert.deepEqual(parseLabels("---\nlabels: [a, 'pipeline-hotfix']\n---\n"), [
      'a',
      'pipeline-hotfix',
    ]);
    assert.deepEqual(parseLabels('no front matter'), []);
  });

  it('returns the known-good sha for a hotfix task when it differs from HEAD', () => {
    assert.equal(
      hotfixPipelineRef({ labels: ['pipeline-hotfix'], knownGoodJson: kg, headSha: HEAD }),
      GOOD,
    );
  });

  it('stays on HEAD for other tasks, equal shas, and unreadable or malformed files', () => {
    assert.equal(hotfixPipelineRef({ labels: ['pipeline'], knownGoodJson: kg, headSha: HEAD }), '');
    assert.equal(
      hotfixPipelineRef({ labels: ['pipeline-hotfix'], knownGoodJson: kg, headSha: GOOD }),
      '',
    );
    assert.equal(
      hotfixPipelineRef({ labels: ['pipeline-hotfix'], knownGoodJson: 'nope', headSha: HEAD }),
      '',
    );
    assert.equal(
      hotfixPipelineRef({
        labels: ['pipeline-hotfix'],
        knownGoodJson: '{"sha":"zz"}',
        headSha: HEAD,
      }),
      '',
    );
  });
});
