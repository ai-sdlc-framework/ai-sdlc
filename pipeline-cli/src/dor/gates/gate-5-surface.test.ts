import { describe, expect, it } from 'vitest';
import {
  evaluateGate5,
  findNamedShards,
  findSurfaceSignals,
  isTessellatedManifest,
} from './gate-5-surface.js';
import type { IssueInput, ProjectShardManifest } from '../types.js';

function input(body: string, title = 't', extra: Partial<IssueInput> = {}): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title, body, ...extra };
}

describe('findSurfaceSignals', () => {
  it('matches backtick paths', () => {
    expect(findSurfaceSignals('change `pipeline-cli/src/foo.ts`')).toContain('backtick-path');
  });
  it('matches bare paths with extension', () => {
    expect(findSurfaceSignals('see pipeline-cli/src/foo.ts behavior')).toContain('bare-path');
  });
  it('matches route patterns with verbs', () => {
    expect(findSurfaceSignals('GET /api/users/{id}')).toContain('route-pattern');
  });
  it('matches /api paths bare', () => {
    expect(findSurfaceSignals('Adjust /api/v2/users payload')).toContain('api-path');
  });
  it('matches RFC ID', () => {
    expect(findSurfaceSignals('per RFC-0011 §4')).toContain('rfc-ref');
  });
  it('matches AISDLC ID', () => {
    expect(findSurfaceSignals('see AISDLC-115.1')).toContain('aisdlc-ref');
  });
  it('matches workspace package', () => {
    expect(findSurfaceSignals('@ai-sdlc/pipeline-cli does this')).toContain('workspace-package');
  });
  it('matches database table phrasing', () => {
    expect(findSurfaceSignals('create table tasks with two columns')).toContain('database-table');
  });
  it('matches workflow files', () => {
    expect(findSurfaceSignals('edit .github/workflows/ci.yml')).toContain('github-workflow');
  });
  it('returns empty for vague text', () => {
    expect(findSurfaceSignals('make the dashboard faster')).toEqual([]);
  });
});

describe('evaluateGate5', () => {
  it('passes when title contains a surface signal', () => {
    const v = evaluateGate5(input('vague body', 'fix RFC-0011 typo'));
    expect(v.verdict).toBe('pass');
  });
  it('fails when neither title nor body name a surface', () => {
    const v = evaluateGate5(input('Make the dashboard faster.', 'speedup'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/No affected-surface signal/);
  });
});

// ---------------------------------------------------------------------------
// AISDLC-115.8 — Alex's Addition 2: tessellated-platform shard naming
// ---------------------------------------------------------------------------

describe('isTessellatedManifest', () => {
  it('treats a missing manifest as non-tessellated', () => {
    expect(isTessellatedManifest(undefined)).toBe(false);
  });
  it('treats an empty shard list as non-tessellated', () => {
    expect(isTessellatedManifest({ shards: [] })).toBe(false);
  });
  it('treats a single-shard manifest as non-tessellated', () => {
    expect(isTessellatedManifest({ shards: ['core'] })).toBe(false);
  });
  it('ignores blank shard entries when computing the count', () => {
    // Filtering preserves the "1 effective shard" semantics so an
    // accidental trailing blank in the config doesn't trip the gate.
    expect(isTessellatedManifest({ shards: ['core', '   '] })).toBe(false);
  });
  it('treats >1 non-blank shards as tessellated', () => {
    expect(isTessellatedManifest({ shards: ['customer-app', 'admin-app'] })).toBe(true);
  });
});

describe('findNamedShards', () => {
  it('returns empty when no shard appears in text', () => {
    expect(findNamedShards('vague text about the dashboard', ['customer-app'])).toEqual([]);
  });
  it('matches a shard id case-insensitively', () => {
    expect(findNamedShards('Update the Customer-App banner', ['customer-app'])).toEqual([
      'customer-app',
    ]);
  });
  it('returns multiple matches when several shards are named', () => {
    expect(
      findNamedShards('customer-app and admin-app share', ['customer-app', 'admin-app']),
    ).toEqual(['customer-app', 'admin-app']);
  });
  it('does not match shard id substrings inside larger words', () => {
    // `admin` should not match inside `administrator` — \b boundaries.
    expect(findNamedShards('the administrator role expanded', ['admin'])).toEqual([]);
  });
  it('skips blank shard entries without throwing', () => {
    expect(findNamedShards('customer-app announce', ['customer-app', '', '  '])).toEqual([
      'customer-app',
    ]);
  });
  it('escapes regex metacharacters inside shard ids', () => {
    // A shard literally named `app.v2` must match `app.v2` and NOT
    // `appXv2` — i.e. the dot is treated as a literal, not regex `.`.
    expect(findNamedShards('release notes for app.v2 land', ['app.v2'])).toEqual(['app.v2']);
    expect(findNamedShards('release notes for appXv2 land', ['app.v2'])).toEqual([]);
  });
  it('returns empty when shards list is empty', () => {
    expect(findNamedShards('any text at all', [])).toEqual([]);
  });
});

describe('evaluateGate5 — tessellated-platform extension (AC #3)', () => {
  const tessellated: ProjectShardManifest = {
    shards: ['customer-app', 'admin-app', 'public-api'],
    manifestRef: '.ai-sdlc/dor-config.yaml#shards',
  };

  it('fails when surface is named but no shard is identified', () => {
    const v = evaluateGate5(
      input('Update `pipeline-cli/src/foo.ts` to read the new env var.', 'tweak config', {
        shardManifest: tessellated,
      }),
    );
    expect(v.verdict).toBe('fail');
    expect(v.severity).toBe('block');
    expect(v.finding).toMatch(/does not identify which tessellated shard/);
    // The clarification message must list every candidate shard, so the
    // author/agent can pick — the whole point of Alex's Addition 2.
    expect(v.clarificationQuestion).toMatch(/customer-app/);
    expect(v.clarificationQuestion).toMatch(/admin-app/);
    expect(v.clarificationQuestion).toMatch(/public-api/);
    // And cite the manifest source so reviewers can audit how Gate 5
    // reached its conclusion.
    expect(v.clarificationQuestion).toMatch(/\.ai-sdlc\/dor-config\.yaml/);
  });

  it('passes when the body names a candidate shard', () => {
    const v = evaluateGate5(
      input('In the customer-app, update `src/foo.ts`.', 'tweak', {
        shardManifest: tessellated,
      }),
    );
    expect(v.verdict).toBe('pass');
    expect(v.finding).toMatch(/customer-app/);
  });

  it('passes when the title (alone) names a shard', () => {
    const v = evaluateGate5(
      input('Update `pipeline-cli/src/foo.ts`.', 'admin-app: tweak config', {
        shardManifest: tessellated,
      }),
    );
    expect(v.verdict).toBe('pass');
  });

  it('still fails the surface check first when no surface signal is present', () => {
    // The shard branch only runs when the surface-signal check passes,
    // so the standard "name the surface" finding still wins.
    const v = evaluateGate5(
      input('Make the dashboard faster on customer-app.', 'speedup', {
        shardManifest: tessellated,
      }),
    );
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/No affected-surface signal/);
  });

  it('omits the manifest-ref suffix when manifestRef is not set', () => {
    const v = evaluateGate5(
      input('Update `pipeline-cli/src/foo.ts`.', 't', {
        shardManifest: { shards: ['core', 'edge'] },
      }),
    );
    expect(v.verdict).toBe('fail');
    expect(v.clarificationQuestion).not.toMatch(/per /);
    expect(v.clarificationQuestion).toMatch(/core/);
    expect(v.clarificationQuestion).toMatch(/edge/);
  });
});

describe('evaluateGate5 — non-tessellated regression (AC #4)', () => {
  it('absent manifest: surface-only behaviour (passes when surface named)', () => {
    const issue = input('Edit `pipeline-cli/src/foo.ts`.');
    expect(issue.shardManifest).toBeUndefined();
    const v = evaluateGate5(issue);
    expect(v.verdict).toBe('pass');
    expect(v.finding).toMatch(/Stage A surface signals/);
    expect(v.finding).not.toMatch(/shard/);
    expect(v.clarificationQuestion).toBeUndefined();
  });

  it('single-shard manifest behaves identically to no manifest', () => {
    const single: ProjectShardManifest = { shards: ['monolith'] };
    const v = evaluateGate5(
      input('Edit `pipeline-cli/src/foo.ts` to fix bug.', 't', {
        shardManifest: single,
      }),
    );
    expect(v.verdict).toBe('pass');
    // Critically: no shard-naming clarification, no shard-mention in finding.
    expect(v.finding).not.toMatch(/shard/);
    expect(v.clarificationQuestion).toBeUndefined();
  });

  it('empty-shards manifest behaves identically to no manifest', () => {
    const empty: ProjectShardManifest = { shards: [] };
    const v = evaluateGate5(
      input('Edit `pipeline-cli/src/foo.ts`.', 't', { shardManifest: empty }),
    );
    expect(v.verdict).toBe('pass');
    expect(v.finding).not.toMatch(/shard/);
  });

  it('single-shard manifest does NOT trigger the shard-naming clarification when surface is missing', () => {
    // The fail path stays the standard surface-naming clarification —
    // shard-naming logic must not leak into single-shard projects.
    const single: ProjectShardManifest = { shards: ['monolith'] };
    const v = evaluateGate5(
      input('make the dashboard faster', 'speedup', { shardManifest: single }),
    );
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/No affected-surface signal/);
    expect(v.clarificationQuestion).not.toMatch(/shard/);
  });
});
