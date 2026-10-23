/**
 * Fixed prefix, path-bound rules and control linter (RFC-0053 OQ-4, AISDLC-782).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/fixed-prefix.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const { PREFIX_MAX_BYTES, buildFixedPrefix, renderFixedPrefix } = require('./fixed-prefix.js');
const {
  findControlSentences,
  hasPathsFrontmatter,
  lintControls,
  normalizeSentence,
} = require('./control-linter.js');
const { runLint } = await import('../../scripts/lint-controls.mjs');

const GOV = `spec:\n  governance:\n    allowMerge: never\n`;
const prefixOf = (extra = {}) =>
  renderFixedPrefix(
    buildFixedPrefix({ governanceYaml: GOV, role: 'developer', taskId: 'AISDLC-1', ...extra }),
  );

describe('fixed prefix size', () => {
  it('is at most prefix.maxBytes', () => {
    assert.equal(PREFIX_MAX_BYTES, 10240);
    const bytes = Buffer.byteLength(prefixOf({ pointers: ['docs/operations/x.md'] }));
    assert.ok(
      bytes <= PREFIX_MAX_BYTES,
      `fixed prefix is ${bytes} bytes (max ${PREFIX_MAX_BYTES})`,
    );
  });
});

describe('fixed prefix contents', () => {
  it('holds only controls, the role/task frame and pointers', () => {
    const built = buildFixedPrefix({
      governanceYaml: GOV,
      role: 'developer',
      taskId: 'T-1',
      pointers: ['p'],
    });
    assert.deepEqual(Object.keys(built).sort(), ['controls', 'frame', 'pointers']);
    assert.deepEqual(built.frame, ['Role: developer', 'Task: T-1']);
    const headings = renderFixedPrefix(built)
      .split('\n')
      .filter((l) => l.startsWith('#'));
    assert.deepEqual(headings, ['## Frame', '## Governance controls', '## Pointers']);
  });

  it('renders the merge control from configuration', () => {
    const never = buildFixedPrefix({ governanceYaml: GOV }).controls.join('\n');
    const green = buildFixedPrefix({
      governanceYaml: `spec:\n  governance:\n    allowMerge: onGreenClean\n`,
    }).controls.join('\n');
    assert.match(never, /forbids agent merges/);
    assert.match(green, /onGreenClean/);
  });

  it('omits empty frame and pointers sections', () => {
    const text = renderFixedPrefix(buildFixedPrefix({ governanceYaml: GOV }));
    assert.doesNotMatch(text, /## Frame|## Pointers/);
  });
});

describe('control linter', () => {
  const prefixText = prefixOf();

  it('fails on a control-shaped sentence outside the prefix that is not rendered', () => {
    const f = lintControls({
      files: [{ path: 'k.md', text: 'Background.\n\nYou must always squash before pushing.\n' }],
      prefixText,
    });
    assert.equal(f.length, 1);
    assert.match(f[0].sentence, /must always squash/);
  });

  it('passes when the sentence is also rendered from configuration', () => {
    const rendered = buildFixedPrefix({ governanceYaml: GOV }).controls[0];
    const f = lintControls({ files: [{ path: 'k.md', text: `${rendered}\n` }], prefixText });
    assert.deepEqual(f, []);
  });

  it('passes on prose with no control word and on path-bound rule files', () => {
    assert.deepEqual(
      lintControls({ files: [{ path: 'a.md', text: 'History of the design.\n' }], prefixText }),
      [],
    );
    const bound = '---\npaths:\n  - "a/**"\n---\n\nNever edit this.\n';
    assert.equal(hasPathsFrontmatter(bound), true);
    assert.deepEqual(lintControls({ files: [{ path: 'b.md', text: bound }], prefixText }), []);
  });

  it('ignores headings, fenced code and frontmatter; normalizes markdown', () => {
    const text = '---\nx: never\n---\n# Never heading\n```\nnever in code\n```\n';
    assert.deepEqual(findControlSentences(text), []);
    assert.equal(normalizeSentence('**Only** [a](b) `c`'), 'only a c');
  });

  it('the repository passes its own lint', () => {
    assert.deepEqual(runLint(root), []);
  });

  it('the CLI flags a violating knowledge entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-controls-'));
    try {
      mkdirSync(join(dir, '.ai-sdlc/knowledge/process'), { recursive: true });
      writeFileSync(join(dir, '.ai-sdlc/knowledge/process/x.md'), 'Agents must never rebase.\n');
      assert.throws(() =>
        execFileSync(
          'node',
          [join(root, 'ai-sdlc-plugin/scripts/lint-controls.mjs'), '--root', dir],
          { stdio: 'pipe' },
        ),
      );
      writeFileSync(join(dir, '.ai-sdlc/knowledge/process/x.md'), 'Just history.\n');
      execFileSync(
        'node',
        [join(root, 'ai-sdlc-plugin/scripts/lint-controls.mjs'), '--root', dir],
        { stdio: 'pipe' },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const rulesDir = join(root, '.claude/rules');
const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith('.md'));

function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}$`);
}

describe('path-bound rules', () => {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64e6,
  }).split('\n');

  for (const f of ruleFiles) {
    it(`${f} carries paths: frontmatter and loads for a matching file`, () => {
      const text = readFileSync(join(rulesDir, f), 'utf-8');
      assert.ok(hasPathsFrontmatter(text), `${f} lacks paths: frontmatter`);
      const globs = [...text.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((m) => m[1]);
      assert.ok(globs.length > 0, `${f} lists no paths`);
      const hit = globs.some((g) => tracked.some((t) => globToRegExp(g).test(t)));
      assert.ok(hit, `${f}: no tracked file matches ${globs.join(', ')}`);
    });
  }
});

describe('no control lost from the prior CLAUDE.md', () => {
  const before = readFileSync(join(here, 'fixtures/claude-md-before-782.md'), 'utf-8');
  const homes = {
    prefix: normalizeSentence(prefixOf()),
    'CLAUDE.md': normalizeSentence(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')),
    ...Object.fromEntries(
      ruleFiles.map((f) => [
        `.claude/rules/${f}`,
        normalizeSentence(readFileSync(join(rulesDir, f), 'utf-8')),
      ]),
    ),
  };

  it('maps every control sentence to the prefix, CLAUDE.md or a rule file', () => {
    const sentences = [...new Set(findControlSentences(before))];
    assert.ok(sentences.length > 30);
    const lost = sentences.filter((s) => !Object.values(homes).some((h) => h.includes(s)));
    assert.deepEqual(lost, []);
  });

  it('moved the path-bound sections out of CLAUDE.md into rule files', () => {
    const moved = findControlSentences(before).filter(
      (s) => !homes['CLAUDE.md'].includes(s) && !homes.prefix.includes(s),
    );
    assert.ok(moved.length > 0);
    for (const s of moved) {
      assert.ok(
        ruleFiles.some((f) => homes[`.claude/rules/${f}`].includes(s)),
        s,
      );
    }
  });
});
