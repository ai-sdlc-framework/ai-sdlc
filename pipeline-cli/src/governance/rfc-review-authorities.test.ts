import { describe, expect, it } from 'vitest';

import {
  isReviewAuthorityHold,
  parseReviewAuthorities,
  rfcBasePaths,
  reviewAuthorityRefusal,
  validateReviewAuthorities,
} from './rfc-review-authorities.js';

describe('validateReviewAuthorities', () => {
  it('accepts an absent field and a valid list', () => {
    expect(validateReviewAuthorities(undefined)).toEqual({ ok: true, authorities: [] });
    expect(
      validateReviewAuthorities([{ role: 'design', login: 'mohirt' }, { role: 'product' }]),
    ).toEqual({
      ok: true,
      authorities: [{ role: 'design', login: 'mohirt' }, { role: 'product' }],
    });
  });

  it('rejects a non-list, a non-mapping entry, a missing role and a bad login', () => {
    expect(validateReviewAuthorities('design')).toMatchObject({ ok: false });
    expect(validateReviewAuthorities(['design'])).toMatchObject({ error: /must be a mapping/ });
    expect(validateReviewAuthorities([{ login: 'mohirt' }])).toMatchObject({
      error: /missing 'role'/,
    });
    expect(validateReviewAuthorities([{ role: 'design', login: 'not a login' }])).toMatchObject({
      error: /invalid 'login'/,
    });
  });
});

describe('parseReviewAuthorities', () => {
  it('reads the frontmatter field', () => {
    const src = '---\nid: RFC-1\nreviewAuthorities:\n  - { role: design, login: mohirt }\n---\n';
    expect(parseReviewAuthorities(src)).toEqual({
      ok: true,
      authorities: [{ role: 'design', login: 'mohirt' }],
    });
    expect(parseReviewAuthorities('---\r\nid: RFC-1\r\n---')).toEqual({
      ok: true,
      authorities: [],
    });
  });

  it('treats no frontmatter or an empty one as no declaration', () => {
    expect(parseReviewAuthorities('# no frontmatter')).toEqual({ ok: true, authorities: [] });
    expect(parseReviewAuthorities('---\n\n---\nbody')).toEqual({ ok: true, authorities: [] });
  });

  it('errors on an unclosed fence, invalid YAML or a non-mapping', () => {
    expect(parseReviewAuthorities('---\nid: x\n')).toMatchObject({ error: /closing/ });
    expect(parseReviewAuthorities('---\na: [\n---\n')).toMatchObject({ error: /not valid YAML/ });
    expect(parseReviewAuthorities('---\n- a\n---\n')).toMatchObject({ error: /not a mapping/ });
  });
});

describe('rfcBasePaths', () => {
  it('lists modified, removed and renamed-from RFCs, not added or copied ones', () => {
    expect(
      rfcBasePaths([
        { path: 'spec/rfcs/RFC-0001-a.md', status: 'modified' },
        { path: 'spec/rfcs/RFC-0002-b.md', status: 'removed' },
        {
          path: 'spec/rfcs/RFC-0003-new.md',
          previousPath: 'spec/rfcs/RFC-0003-c.md',
          status: 'renamed',
        },
        { path: 'spec/rfcs/RFC-0004-d.md', status: 'added' },
        {
          path: 'spec/rfcs/RFC-0005-e.md',
          previousPath: 'spec/rfcs/RFC-0001-a.md',
          status: 'copied',
        },
        { path: 'spec/rfcs/README.md', status: 'modified' },
        { path: 'spec/rfcs/RFC-0001-a.md', status: 'modified' },
      ]),
    ).toEqual(['spec/rfcs/RFC-0001-a.md', 'spec/rfcs/RFC-0002-b.md', 'spec/rfcs/RFC-0003-c.md']);
  });
});

describe('reviewAuthorityRefusal', () => {
  it('returns null when nothing is declared and a hold naming every RFC otherwise', async () => {
    const files = [
      { path: 'spec/rfcs/RFC-0018-a.md', status: 'modified' },
      { path: 'spec/rfcs/RFC-0049-b.md', status: 'modified' },
    ];
    expect(await reviewAuthorityRefusal(files, async () => '---\nid: x\n---\n')).toBeNull();
    const reason = await reviewAuthorityRefusal(files, async (p) =>
      p.includes('0018') ? '---\nreviewAuthorities:\n  - role: design\n---\n' : null,
    );
    expect(reason).toMatch(
      /RFC-0018 \(spec\/rfcs\/RFC-0018-a\.md\) declares review authorities design;/,
    );
    expect(reason).toMatch(/RFC-0049-b\.md: the base copy could not be read/);
    expect(isReviewAuthorityHold(reason ?? undefined)).toBe(true);
  });

  it('treats a reader that throws as unreadable', async () => {
    const reason = await reviewAuthorityRefusal(
      [{ path: 'spec/rfcs/RFC-0018-a.md', status: 'modified' }],
      async () => {
        throw new Error('network');
      },
    );
    expect(reason).toMatch(/could not be read/);
    expect(isReviewAuthorityHold(undefined)).toBe(false);
  });
});
