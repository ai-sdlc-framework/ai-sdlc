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
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
  projectStandingRules,
  loadCatalogEvents,
  renderStandingRulesBlock,
  syncStandingRules,
} = require(join(pluginDir, 'hooks', 'lib', 'prompt-rules.js'));

/** Prompts that MUST carry the block (they used to hold hand-pasted copies). */
const GUARDED = [
  'agents/developer.md',
  'agents/rebase-resolver.md',
  'agents/ci-conflict-resolver.md',
  'agents/code-reviewer.md',
  'agents/test-reviewer.md',
  'agents/security-reviewer.md',
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

describe('executor command', () => {
  it('renders the no-question rule (AISDLC-948)', () => {
    const found = findPromptRulesBlock(read('commands/executor.md'));
    assert.ok(found?.ids.includes('executor-no-question'));
    assert.match(found.block, /never wait on a question/);
  });
});

describe('waived-tests rule (AISDLC-1022)', () => {
  for (const rel of ['agents/developer.md', 'agents/correctness-reviewer.md']) {
    it(`${rel} carries the rendered rule exactly once`, () => {
      const found = findPromptRulesBlock(read(rel));
      assert.ok(found?.ids.includes('waived-tests'), `${rel} must carry waived-tests`);
      assert.match(found.block, /critical finding/);
      assert.equal(countRuleRestatements(read(rel))['waived-tests'], 1);
    });
  }
});

describe('hold-and-reporting rule (AISDLC-899)', () => {
  for (const rel of [
    'commands/operator-dispatch.md',
    'commands/executor.md',
    'commands/planner.md',
  ]) {
    it(`${rel} carries the rendered rule exactly once`, () => {
      const found = findPromptRulesBlock(read(rel));
      assert.ok(found?.ids.includes('hold-reporting'), `${rel} must carry hold-reporting`);
      assert.equal(countRuleRestatements(read(rel))['hold-reporting'], 1);
    });
  }
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

describe('standing decision rules (AISDLC-873)', () => {
  const opened = (id, extra = {}) => ({
    type: 'decision-opened',
    decisionId: id,
    standingRule: `rule for ${id}`,
    ...extra,
  });
  const answered = (id) => ({ type: 'operator-answered', decisionId: id });

  it('renders exactly one line for an answered standing decision', () => {
    const block = renderStandingRulesBlock([opened('DEC-0002'), answered('DEC-0002')]);
    assert.equal(
      block,
      '<!-- standing-rules:begin -->\n- **Standing (DEC-0002):** rule for DEC-0002\n<!-- standing-rules:end -->',
    );
  });

  it('renders nothing for unanswered, non-standing, superseded or weakening decisions', () => {
    const events = [
      opened('DEC-0001'),
      opened('DEC-0003', { standingRule: undefined }),
      answered('DEC-0003'),
      opened('DEC-0004'),
      answered('DEC-0004'),
      { type: 'superseded', decisionId: 'DEC-0004' },
      opened('DEC-0005', { governanceChange: { kind: 'weakening' } }),
      answered('DEC-0005'),
      opened('DEC-0006', { standingRule: 'two\nlines' }),
      answered('DEC-0006'),
      opened('DEC-0007', { standingRule: 'one\rinjected' }),
      answered('DEC-0007'),
      opened('DEC-0008', { standingRule: 'a\u2028b' }),
      answered('DEC-0008'),
      { type: 'operator-answered' },
    ];
    assert.deepEqual(projectStandingRules(events), []);
  });

  it('is deterministic and sorted by decision id, independent of input order', () => {
    const a = [opened('DEC-0009'), answered('DEC-0009'), opened('DEC-0002'), answered('DEC-0002')];
    const first = renderStandingRulesBlock(a);
    assert.equal(renderStandingRulesBlock([...a].reverse()), first);
    assert.equal(renderStandingRulesBlock(a), first);
    assert.ok(first.indexOf('DEC-0002') < first.indexOf('DEC-0009'));
  });

  it('syncStandingRules leaves block-less text alone and rewrites a drifted block', () => {
    assert.equal(syncStandingRules('plain', []), 'plain');
    assert.equal(
      syncStandingRules('<!-- standing-rules:begin -->\nx', []),
      '<!-- standing-rules:begin -->\nx',
    );
    const out = syncStandingRules(
      'a\n<!-- standing-rules:begin -->\nold\n<!-- standing-rules:end -->\nb',
      [opened('DEC-0001'), answered('DEC-0001')],
    );
    assert.match(out, /Standing \(DEC-0001\)/);
    assert.ok(out.startsWith('a\n') && out.endsWith('\nb'));
  });

  it('loadCatalogEvents returns [] for a root that is not a git repo', () => {
    assert.deepEqual(loadCatalogEvents('/nonexistent-root-873'), []);
  });

  it('loadCatalogEvents reads only records committed on main, not branch or working-tree ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'standing-873-'));
    const sh = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    const evDir = join(root, '.ai-sdlc', '_decisions', 'events');
    const write = (name, ev) => writeFileSync(join(evDir, name), JSON.stringify(ev));
    try {
      sh('init', '-q', '-b', 'main');
      sh('config', 'user.email', 't@example.com');
      sh('config', 'user.name', 't');
      sh('config', 'commit.gpgsign', 'false');
      mkdirSync(evDir, { recursive: true });
      write('a__DEC-0001__decision-opened.json', opened('DEC-0001'));
      write('b__DEC-0001__operator-answered.json', answered('DEC-0001'));
      sh('add', '.');
      sh('commit', '-q', '-m', 'main catalog');
      sh('checkout', '-q', '-b', 'feature');
      write('c__DEC-0002__decision-opened.json', opened('DEC-0002'));
      write('d__DEC-0002__operator-answered.json', answered('DEC-0002'));
      sh('add', '.');
      sh('commit', '-q', '-m', 'branch-only catalog');
      write('e__DEC-0003__decision-opened.json', opened('DEC-0003'));
      write('f__DEC-0003__operator-answered.json', answered('DEC-0003'));
      const loaded = loadCatalogEvents(root);
      assert.deepEqual(
        projectStandingRules(loaded).map((r) => r.decisionId),
        ['DEC-0001'],
      );
      assert.deepEqual(loadCatalogEvents(root, { ref: 'no-such-ref' }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const repoRoot = join(pluginDir, '..');
  const events = loadCatalogEvents(repoRoot);
  for (const rel of ['commands/operator-dispatch.md', 'commands/executor.md']) {
    it(`${rel} carries the standing-rules block, in sync with the catalog`, () => {
      const content = read(rel);
      assert.equal(
        syncStandingRules(content, events),
        content,
        `${rel}: run sync-prompt-rules.mjs`,
      );
      assert.ok(content.includes('<!-- standing-rules:begin -->'));
    });
  }
});

describe('skills are listed once (AISDLC-1071)', () => {
  it('no skill name exists in both the project .claude/skills and the plugin', () => {
    const list = (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    };
    const project = new Set(list(join(pluginDir, '..', '.claude', 'skills')));
    const dupes = list(join(pluginDir, 'skills')).filter((n) => project.has(n));
    assert.deepEqual(dupes, [], `skill(s) listed twice: ${dupes.join(', ')}`);
  });
});
