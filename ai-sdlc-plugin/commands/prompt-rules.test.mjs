/**
 * Prompt-rule contract (AISDLC-651.2).
 *
 * "Never do X" rules live in ONE source (`hooks/lib/prompt-rules.js`). A prompt that
 * carries a generated `<!-- prompt-rules:begin ... -->` block must (1) match the
 * source exactly, and (2) not restate any rule outside that one line.
 *
 * Run with: node --test ai-sdlc-plugin/commands/prompt-rules.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  PROMPT_RULES,
  renderPromptRulesBlock,
  findPromptRulesBlock,
  syncPromptRules,
  countRuleRestatements,
} = require(join(pluginDir, 'hooks', 'lib', 'prompt-rules.js'));

/** Prompts that MUST carry the block (they used to hold hand-pasted copies). */
const GUARDED = [
  'agents/developer.md',
  'agents/rebase-resolver.md',
  'agents/ci-conflict-resolver.md',
];

function allPrompts() {
  return ['agents', 'commands'].flatMap((dir) =>
    readdirSync(join(pluginDir, dir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `${dir}/${f}`),
  );
}
const read = (rel) => readFileSync(join(pluginDir, rel), 'utf-8');

describe('prompt-rules source', () => {
  it('every rule is one line and names a detector', () => {
    for (const rule of PROMPT_RULES) {
      assert.ok(!rule.text.includes('\n'), `${rule.id} must be a single line`);
      assert.ok(rule.detect instanceof RegExp, `${rule.id} needs a detect pattern`);
    }
  });

  it('every rule names its enforcement or the config that grants it', () => {
    for (const rule of PROMPT_RULES) {
      assert.match(
        rule.text,
        /hook|blocks|governance\.allowMerge|cli-decisions|never self-authorize/i,
        `${rule.id} must say what enforces it or what to do instead`,
      );
    }
  });

  it('each rule line matches its own detector exactly once', () => {
    for (const rule of PROMPT_RULES) {
      const counts = countRuleRestatements(`- ${rule.text}`);
      assert.equal(counts[rule.id], 1, `${rule.id} line must trip its detector once`);
    }
  });

  it('rejects unknown ids', () => {
    assert.throws(() => renderPromptRulesBlock(['nope']), /unknown prompt rule id/);
  });

  it('syncPromptRules repairs a drifted block and leaves block-less text alone', () => {
    const drifted =
      '# x\n<!-- prompt-rules:begin ids=merge -->\nstale\n<!-- prompt-rules:end -->\ntail';
    const fixed = syncPromptRules(drifted);
    assert.ok(fixed.includes(renderPromptRulesBlock(['merge'])));
    assert.ok(fixed.endsWith('tail'));
    assert.equal(syncPromptRules('no block here'), 'no block here');
  });

  it('findPromptRulesBlock returns null for an unterminated block', () => {
    assert.equal(findPromptRulesBlock('<!-- prompt-rules:begin ids=merge -->\nx'), null);
  });
});

describe('prompts carrying a rules block', () => {
  for (const rel of GUARDED) {
    it(`${rel} carries a block`, () => {
      assert.ok(findPromptRulesBlock(read(rel)), `${rel} must carry a prompt-rules block`);
    });
  }

  for (const rel of allPrompts()) {
    const content = read(rel);
    const found = findPromptRulesBlock(content);
    if (!found) continue;

    it(`${rel} block matches the source (no drift)`, () => {
      assert.equal(
        found.block,
        renderPromptRulesBlock(found.ids),
        `${rel} drifted; run node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs`,
      );
    });

    it(`${rel} states each rule at most once`, () => {
      const counts = countRuleRestatements(content);
      for (const rule of PROMPT_RULES) {
        const expected = found.ids.includes(rule.id) ? 1 : 0;
        assert.equal(
          counts[rule.id],
          expected,
          `${rel}: rule "${rule.id}" appears ${counts[rule.id]} times (expected ${expected})`,
        );
      }
    });
  }
});
