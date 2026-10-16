/**
 * README site-link UTM gate (AISDLC-890).
 *
 * Every link to ai-sdlc.io in README.md must carry the fixed utm_source,
 * utm_medium and utm_campaign, plus a utm_content placement unique in the file,
 * so the site side can report on which README placement drives a visit.
 *
 * Run with: node --test scripts/check-readme-utm.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXED = { utm_source: 'github', utm_medium: 'readme', utm_campaign: 'ai-sdlc-repo' };

/** Return every https://ai-sdlc.io URL found in the markdown text. */
export function findSiteUrls(text) {
  return [...text.matchAll(/https?:\/\/(?:www\.)?ai-sdlc\.io[^\s)\]>"']*/g)].map((m) => m[0]);
}

/** Return a list of problems with the given markdown's site links. */
export function checkUtm(text) {
  const problems = [];
  const seen = new Set();
  for (const raw of findSiteUrls(text)) {
    const params = new URL(raw).searchParams;
    for (const [key, value] of Object.entries(FIXED)) {
      if (params.get(key) !== value) problems.push(`${raw}: ${key} must be ${value}`);
    }
    const content = params.get('utm_content');
    if (!content) problems.push(`${raw}: missing utm_content`);
    else if (seen.has(content)) problems.push(`${raw}: duplicate utm_content ${content}`);
    else seen.add(content);
  }
  return problems;
}

describe('README site-link UTM parameters', () => {
  it('README.md has site links and every one is tagged with a unique placement', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    assert.ok(findSiteUrls(readme).length > 0, 'expected README.md to link to ai-sdlc.io');
    assert.deepEqual(checkUtm(readme), []);
  });

  it('fails on a site URL lacking utm parameters', () => {
    assert.equal(checkUtm('[x](https://ai-sdlc.io/docs)').length, 4);
  });

  it('fails on a repeated utm_content value', () => {
    const q = '?utm_source=github&utm_medium=readme&utm_campaign=ai-sdlc-repo&utm_content=a';
    const problems = checkUtm(`[a](https://ai-sdlc.io/x${q}) [b](https://ai-sdlc.io/y${q})`);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /duplicate utm_content/);
  });
});
