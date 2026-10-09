/**
 * AISDLC-766 AC-4: the hierarchy command bodies carry no manual handoff-writing or
 * ask-before-clearing instruction; the CLI keeps the handoff and clearing is automatic.
 *
 * Run with: node --test ai-sdlc-plugin/commands/handoff-contract.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const body = (name) => readFileSync(join(here, `${name}.md`), 'utf-8');
const ROLES = {
  planner: 'planner',
  'operator-dispatch': 'operator-dispatch',
  executor: 'executor',
};

describe('hierarchy command bodies and the handoff contract', () => {
  for (const [file, role] of Object.entries(ROLES)) {
    it(`${file} uses the CLI handoff and has no manual handoff or ask-before-clear text`, () => {
      const text = body(file);
      if (role === 'operator-dispatch') {
        // `tick` regenerates the handoff itself and returns it
        assert.match(text, /`handoff`: this session's handoff, regenerated/);
        assert.match(text, /handoff read --role operator-dispatch/);
      } else {
        assert.match(text, new RegExp(`handoff write --role ${role}`));
        assert.match(text, new RegExp(`handoff read --role ${role}`));
      }
      assert.doesNotMatch(text, /operator-dispatch-handoff\.md/);
      assert.doesNotMatch(text, /Hand off and `\/clear`/i);
      assert.doesNotMatch(
        text,
        /(write|refresh|update) (a|the) (dispatch )?handoff (file|memory)/i,
      );
      assert.doesNotMatch(text, /ask the operator (before|whether) (to )?clear/i);
    });
  }

  it('the planner resumes with /ai-sdlc:planner', () => {
    assert.match(body('planner'), /\/ai-sdlc:planner/);
  });
});
