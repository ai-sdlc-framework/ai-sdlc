/**
 * Lint: no session skill body addresses a peer by a bare role name.
 *
 * Session names are project-qualified (`<project>-<role>`) and a peer is addressed
 * through its roster entry. A bare role name (`planner`, `operator-dispatch`,
 * `executor-alpha` ...) in an addressing position, or as a shell default for a peer
 * name, would reach another project's session of the same name.
 *
 * Run with: node --test ai-sdlc-plugin/commands/hierarchy-peer-names.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SKILLS = ['executor.md', 'planner.md', 'operator-dispatch.md'];

/** Findings for one skill body; each names the offending line. */
export function bareNameFindings(text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const at = `line ${i + 1}: ${line.trim()}`;
    // A bare Greek-letter executor name not preceded by a project qualifier.
    if (/(^|[^A-Za-z0-9>-])executor-(alpha|beta|gamma|delta|epsilon)\b/.test(line)) {
      findings.push(`bare executor name, ${at}`);
    }
    // A shell default that falls back to a bare role name.
    if (/:-(planner|operator-dispatch|executor)[}"' ]/.test(line)) {
      findings.push(`bare role as a peer-name default, ${at}`);
    }
    // A message, send or --to aimed at a backticked or quoted bare role name.
    if (
      /\b(send|sends|message|messages|tell)\b[^\n]*[`'"](planner|operator-dispatch)[`'"]/i.test(
        line,
      ) ||
      /--to\s+["']?(planner|operator-dispatch)\b/.test(line)
    ) {
      findings.push(`message addressed to a bare role name, ${at}`);
    }
  });
  return findings;
}

describe('session skills never address a bare role name', () => {
  for (const file of SKILLS) {
    it(`${file} has no bare peer name`, () => {
      const text = readFileSync(join(dir, file), 'utf-8');
      assert.deepEqual(bareNameFindings(text), []);
    });
  }

  it('the lint itself catches the shapes it exists for', () => {
    assert.equal(bareNameFindings('send it to executor-beta now').length, 1);
    assert.equal(bareNameFindings('--to "${PLANNER_NAME:-planner}"').length, 1);
    assert.equal(bareNameFindings('Message the `planner` with the id').length, 1);
    assert.equal(bareNameFindings('route --to planner --task-id x').length, 1);
    assert.deepEqual(bareNameFindings('send it to <project>-executor-beta now'), []);
    assert.deepEqual(bareNameFindings('`<project>-executor-alpha-2` is not it'), []);
  });
});
