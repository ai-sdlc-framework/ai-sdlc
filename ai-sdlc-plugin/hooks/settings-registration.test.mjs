/**
 * AISDLC-569: this repo's own `.claude/settings.json` must register the
 * enforcing plugin hook for BOTH Bash and Write|Edit|MultiEdit, and the stale
 * `.claude/hooks/enforce-blocked-actions.*` copy must stay retired.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/settings-registration.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8'));
const TARGET = 'ai-sdlc-plugin/hooks/enforce-blocked-actions.sh';

function commandsFor(toolName) {
  return (settings.hooks.PreToolUse || [])
    .filter((e) => (e.matcher || '').split('|').includes(toolName))
    .flatMap((e) => e.hooks.map((h) => h.command));
}

describe('.claude/settings.json hook registration (AISDLC-569)', () => {
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit']) {
    it(`registers the plugin enforce-blocked-actions hook for ${tool}`, () => {
      assert.ok(commandsFor(tool).some((c) => c.includes(TARGET)));
    });
  }

  it('the registered hook script exists', () => {
    assert.ok(existsSync(join(root, TARGET)));
  });

  it('the stale .claude/hooks enforce-blocked-actions copy is retired', () => {
    for (const f of [
      'enforce-blocked-actions.js',
      'enforce-blocked-actions.sh',
      'enforce-blocked-actions.test.mjs',
    ]) {
      assert.equal(existsSync(join(root, '.claude', 'hooks', f)), false, f);
    }
  });
});
