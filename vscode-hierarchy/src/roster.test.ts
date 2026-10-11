import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findRosterFiles,
  parseRosterNames,
  repoRootOf,
  resolveHierarchyBin,
  type RosterFs,
} from './roster.js';

function fakeFs(files: string[], dirs: Record<string, string[]> = {}): RosterFs {
  return {
    exists: (p) => files.includes(p),
    subdirs: (d) => dirs[d] ?? [],
  };
}

describe('parseRosterNames', () => {
  it('returns tmux windows, skipping invalid and duplicate entries', () => {
    const text = JSON.stringify({
      schemaVersion: 'v1',
      sessions: [
        { tmuxWindow: 'planner' },
        { tmuxWindow: 'planner' },
        { tmuxWindow: 'Bad Name' },
        { role: 'x' },
        null,
        { tmuxWindow: 'executor-a' },
      ],
    });
    expect(parseRosterNames(text)).toEqual(['planner', 'executor-a']);
  });

  it('returns undefined for unparseable or shapeless documents', () => {
    expect(parseRosterNames('{')).toBeUndefined();
    expect(parseRosterNames('null')).toBeUndefined();
    expect(parseRosterNames('{"sessions":1}')).toBeUndefined();
  });

  it('returns an empty list for an empty roster', () => {
    expect(parseRosterNames('{"sessions":[]}')).toEqual([]);
  });
});

describe('findRosterFiles / repoRootOf', () => {
  const rel = path.join('.ai-sdlc', 'dispatch', 'hierarchy.json');
  it('finds rosters in the folder and one level below', () => {
    const direct = path.join('/w', rel);
    const nested = path.join('/w', 'repo', rel);
    const fs = fakeFs([direct, nested], { '/w': ['repo', 'other'] });
    expect(findRosterFiles(['/w'], fs)).toEqual([direct, nested]);
    expect(repoRootOf(nested)).toBe(path.join('/w', 'repo'));
  });

  it('finds nothing when no roster exists', () => {
    expect(findRosterFiles(['/w'], fakeFs([]))).toEqual([]);
  });
});

describe('resolveHierarchyBin', () => {
  const repoBin = path.join('/r', 'pipeline-cli', 'bin', 'cli-hierarchy.mjs');
  const cache = (v: string, m = 'mk') =>
    path.join(
      '/h/.claude/plugins/cache',
      m,
      'ai-sdlc',
      v,
      'node_modules/@ai-sdlc/pipeline-cli/bin/cli-hierarchy.mjs',
    );
  const dirs = {
    '/h/.claude/plugins/cache': ['mk'],
    [path.join('/h/.claude/plugins/cache', 'mk', 'ai-sdlc')]: ['0.9.0', '0.10.0', '0.2'],
  };

  it('prefers the repository bin', () => {
    const fs = fakeFs([repoBin, cache('0.10.0'), '/s.mjs'], dirs);
    expect(resolveHierarchyBin({ repoRoot: '/r', homeDir: '/h', setting: '/s.mjs', fs })).toBe(
      repoBin,
    );
  });

  it('then the highest plugin cache version', () => {
    const fs = fakeFs([cache('0.9.0'), cache('0.10.0'), '/s.mjs'], dirs);
    expect(resolveHierarchyBin({ repoRoot: '/r', homeDir: '/h', setting: '/s.mjs', fs })).toBe(
      cache('0.10.0'),
    );
  });

  it('then the setting', () => {
    const fs = fakeFs(['/s.mjs']);
    expect(resolveHierarchyBin({ repoRoot: '/r', homeDir: '/h', setting: ' /s.mjs ', fs })).toBe(
      '/s.mjs',
    );
  });

  it('is undefined when nothing exists', () => {
    const fs = fakeFs([]);
    expect(resolveHierarchyBin({ repoRoot: '/r', homeDir: '/h', setting: '', fs })).toBeUndefined();
    expect(
      resolveHierarchyBin({ repoRoot: '/r', homeDir: '/h', setting: '/missing', fs }),
    ).toBeUndefined();
  });
});
