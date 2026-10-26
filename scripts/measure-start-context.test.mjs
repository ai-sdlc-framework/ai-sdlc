import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureStatic, countSessionStartRegistrations } from './measure-start-context.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ceiling for the statically measurable executor start context (AISDLC-1067). Raise only
// with a reason; the target for the full second call is 30k tokens.
const STATIC_CEILING_TOKENS = 7500;

describe('executor start context budget (AISDLC-1067)', () => {
  it('stays under the committed ceiling', () => {
    const { total, contributors } = measureStatic();
    assert.ok(
      total <= STATIC_CEILING_TOKENS,
      `start context ${total} > ${STATIC_CEILING_TOKENS}: ${JSON.stringify(contributors)}`,
    );
  });

  it('registers the SessionStart governance hook exactly once', () => {
    assert.equal(countSessionStartRegistrations(root), 1);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    assert.equal(settings.hooks.SessionStart, undefined);
  });

  it('prints the governance block exactly once per hook run', () => {
    const r = spawnSync('node', [join(root, 'ai-sdlc-plugin/hooks/session-start.js')], {
      input: JSON.stringify({ session_id: 'budget-test', source: 'startup' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf8',
    });
    assert.equal(r.stdout.split('AI-SDLC Governance Active').length - 1, 1);
  });
});
