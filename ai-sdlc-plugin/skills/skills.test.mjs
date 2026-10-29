import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_DESCRIPTION = 1500;
const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

test('at least one skill directory ships', () => {
  assert.ok(dirs.length > 0);
});

for (const dir of dirs) {
  test(`skill ${dir}: frontmatter and cross-references`, () => {
    const file = join(root, dir, 'SKILL.md');
    assert.ok(existsSync(file), `${dir}/SKILL.md missing`);
    const text = readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    assert.ok(fm, 'frontmatter must parse');
    assert.equal(fm.name, dir, 'name must equal the directory name');
    assert.ok(fm.description && fm.description.length > 0, 'description must be non-empty');
    assert.ok(
      fm.description.length <= MAX_DESCRIPTION,
      `description over ${MAX_DESCRIPTION} chars`,
    );
    for (const [, ref] of text.matchAll(/\[\[([a-z0-9-]+)\]\]/g)) {
      assert.ok(dirs.includes(ref), `[[${ref}]] does not resolve to a sibling skill`);
    }
  });
}

test('rfc-oq-walkthrough: composes with decision-rubric and never writes a resolution itself', () => {
  const text = readFileSync(join(root, 'rfc-oq-walkthrough', 'SKILL.md'), 'utf8');
  assert.match(text, /\[\[decision-rubric\]\]/);
  assert.ok(dirs.includes('decision-rubric'));
  assert.match(text, /never writes a `Resolution:` marker on its own/);
  assert.equal((text.match(/^## Phase \d+/gm) ?? []).length, 8);
});
