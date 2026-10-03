import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnv } from './runtime/git-env.js';
import {
  ARTIFACTS_GITIGNORE_ENTRY,
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
  gitCheckIgnoreArgs,
  gitignoreCovers,
  hasSentinelLine,
  interpretCheckIgnoreExit,
  insertIntoSentinelBlock,
  missingRuntimeGitignorePaths,
} from './runtime-gitignore.js';

describe('runtime gitignore list', () => {
  it('includes the artifacts directory next to the other runtime paths', () => {
    expect(RUNTIME_GITIGNORE_PATHS).toEqual([
      '.ai-sdlc/state.db',
      '.ai-sdlc/state/',
      '.ai-sdlc/audit.jsonl',
      ARTIFACTS_GITIGNORE_ENTRY,
    ]);
    expect(ARTIFACTS_GITIGNORE_ENTRY).toBe('.ai-sdlc/artifacts/');
  });
});

describe('gitignoreCovers', () => {
  it.each(['.ai-sdlc/state/', '.ai-sdlc/state', '/.ai-sdlc/state/', '.ai-sdlc/state/  '])(
    'treats %j as the same entry',
    (line) => {
      expect(gitignoreCovers(`node_modules/\n${line}\n`, '.ai-sdlc/state/')).toBe(true);
    },
  );

  it('does not treat an indented entry as covered: git keeps leading spaces in the pattern', () => {
    expect(gitignoreCovers('  .ai-sdlc/artifacts/\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(false);
  });

  it('stops counting an entry once a later line negates it, and counts it again when re-ignored', () => {
    const entry = ARTIFACTS_GITIGNORE_ENTRY;
    expect(gitignoreCovers(`${entry}\n!${entry}\n`, entry)).toBe(false);
    expect(gitignoreCovers(`${entry}\n!.ai-sdlc/artifacts\n`, entry)).toBe(false);
    expect(gitignoreCovers(`${entry}\n!${entry}\n${entry}\n`, entry)).toBe(true);
    expect(gitignoreCovers(`!${entry}\n${entry}\n`, entry)).toBe(true);
  });

  it('ignores a negation of a path below the directory, which has no effect in git', () => {
    const entry = ARTIFACTS_GITIGNORE_ENTRY;
    expect(gitignoreCovers(`${entry}\n!.ai-sdlc/artifacts/keep.json\n`, entry)).toBe(true);
  });

  it('handles a pathological line of slashes in linear time', () => {
    const hostile = '/'.repeat(300_000) + 'x\n' + '/'.repeat(300_000) + '\n';
    const started = Date.now();
    expect(gitignoreCovers(hostile, ARTIFACTS_GITIGNORE_ENTRY)).toBe(false);
    expect(missingRuntimeGitignorePaths(hostile)).toEqual([...RUNTIME_GITIGNORE_PATHS]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not match a comment, a longer name or a different directory', () => {
    expect(gitignoreCovers('# .ai-sdlc/state/\n', '.ai-sdlc/state/')).toBe(false);
    expect(gitignoreCovers('.ai-sdlc/state.db\n', '.ai-sdlc/state/')).toBe(false);
    expect(gitignoreCovers('.ai-sdlc/artifacts-old/\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(false);
  });
});

// Real-git agreement (DEC-0020): the text reading must give the answer
// `git check-ignore` gives for every pattern shape it claims to understand. The cases
// include the ones where git is counter-intuitive (a parent directory excluded for good).
// Every git call below strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (husky pre-push
// exports them from a worktree) so the repository under test is the one in the tmpdir.
const gitEnv = cleanGitEnv();
const gitAvailable = spawnSync('git', ['--version'], { env: gitEnv }).status === 0;

describe.skipIf(!gitAvailable)('gitignoreCovers agrees with git check-ignore', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ai-sdlc-check-ignore-'));
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', repo], { env: gitEnv });
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const gitSays = (gitignore: string, entry: string): boolean | null => {
    writeFileSync(join(repo, '.gitignore'), gitignore);
    const r = spawnSync('git', gitCheckIgnoreArgs(repo, entry), { env: gitEnv });
    return interpretCheckIgnoreExit(r.status ?? -1);
  };

  const entry = ARTIFACTS_GITIGNORE_ENTRY;
  const cases: Array<[string, string, boolean]> = [
    ['exact', '.ai-sdlc/artifacts/\n', true],
    ['no trailing slash', '.ai-sdlc/artifacts\n', true],
    ['bare directory name', 'artifacts/\n', true],
    ['bare name without slash', 'artifacts\n', true],
    ['parent directory', '.ai-sdlc/\n', true],
    ['parent contents', '.ai-sdlc/*\n', true],
    ['directory contents', '.ai-sdlc/artifacts/*\n', true],
    ['recursive glob', '**/artifacts/\n', true],
    ['wildcard name', 'art*/\n', true],
    ['rooted', '/.ai-sdlc/artifacts/\n', true],
    ['unrelated', 'node_modules/\ndist/\n', false],
    ['look-alike directory', '.ai-sdlc/artifacts-old/\n', false],
    ['file-only pattern does not ignore a directory', 'artifacts\n!artifacts/\n', false],
    ['negated after contents pattern', '.ai-sdlc/*\n!.ai-sdlc/artifacts\n', false],
    ['negated after exact line', '.ai-sdlc/artifacts/\n!.ai-sdlc/artifacts/\n', false],
    [
      'negation cannot re-include below an ignored parent',
      '.ai-sdlc/\n!.ai-sdlc/artifacts\n',
      true,
    ],
    ['negation before the line has no effect', '!.ai-sdlc/artifacts/\n.ai-sdlc/artifacts/\n', true],
    ['indented line is a different pattern', '  .ai-sdlc/artifacts/\n', false],
    ['comment', '# .ai-sdlc/artifacts/\n', false],
  ];

  it.each(cases)('%s', (_name, gitignore, expected) => {
    expect(gitSays(gitignore, entry)).toBe(expected);
    expect(gitignoreCovers(gitignore, entry)).toBe(expected);
  });

  it('git answers null (exit 128) outside a repository, so callers fall back to the text', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ai-sdlc-not-a-repo-'));
    try {
      const r = spawnSync('git', gitCheckIgnoreArgs(outside, entry), {
        env: { ...gitEnv, GIT_CEILING_DIRECTORIES: tmpdir() },
      });
      expect(interpretCheckIgnoreExit(r.status ?? -1)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('gitCheckIgnoreArgs / interpretCheckIgnoreExit', () => {
  it('probes a file inside a directory entry and the path itself for a file entry', () => {
    expect(gitCheckIgnoreArgs('/repo', '.ai-sdlc/artifacts/').at(-1)).toBe(
      '.ai-sdlc/artifacts/probe',
    );
    expect(gitCheckIgnoreArgs('/repo', '.ai-sdlc/state.db').at(-1)).toBe('.ai-sdlc/state.db');
  });

  it('ignores the index and the global excludes file, and targets the given directory', () => {
    const args = gitCheckIgnoreArgs('/repo', '.ai-sdlc/artifacts/');
    expect(args.slice(0, 2)).toEqual(['-C', '/repo']);
    expect(args).toContain('core.excludesFile=/dev/null');
    expect(args).toContain('--no-index');
    expect(args).toContain('-q');
  });

  it('maps exit codes: 0 ignored, 1 not ignored, anything else unknown', () => {
    expect(interpretCheckIgnoreExit(0)).toBe(true);
    expect(interpretCheckIgnoreExit(1)).toBe(false);
    expect(interpretCheckIgnoreExit(128)).toBeNull();
    expect(interpretCheckIgnoreExit(-1)).toBeNull();
  });
});

describe('gitignoreCovers without git: broader lines and globs', () => {
  it.each(['artifacts/', '.ai-sdlc/', '.ai-sdlc/*', '**/artifacts/', '.ai-sdlc/artifacts/**'])(
    '%j covers the artifacts directory',
    (line) => {
      expect(gitignoreCovers(`${line}\n`, ARTIFACTS_GITIGNORE_ENTRY)).toBe(true);
    },
  );

  it('a negation after `.ai-sdlc/*` re-includes it; after `.ai-sdlc/` it cannot', () => {
    expect(gitignoreCovers('.ai-sdlc/*\n!.ai-sdlc/artifacts\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(
      false,
    );
    expect(gitignoreCovers('.ai-sdlc/\n!.ai-sdlc/artifacts\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(
      true,
    );
  });

  it('does not treat a file-name pattern as covering a directory-only entry, or the reverse', () => {
    expect(gitignoreCovers('state.db/\n', '.ai-sdlc/state.db')).toBe(false);
    expect(gitignoreCovers('state.db\n', '.ai-sdlc/state.db')).toBe(true);
  });

  it('consecutive `**` segments mean the same as one', () => {
    expect(gitignoreCovers('**/**/**/artifacts/\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(true);
    expect(gitignoreCovers('.ai-sdlc/**/**/probe\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(true);
    expect(gitignoreCovers('**/**/nothing-here/\n', ARTIFACTS_GITIGNORE_ENTRY)).toBe(false);
  });

  it('a long run of `**` segments does not blow up (bound is generous: it took minutes before)', () => {
    for (const tail of ['zzz', 'artifacts', '']) {
      const line = `${'**/'.repeat(2000)}${tail}`;
      const started = Date.now();
      gitignoreCovers(`${line}\n`, ARTIFACTS_GITIGNORE_ENTRY);
      expect(Date.now() - started).toBeLessThan(5000);
    }
    // the same with the segments split apart by an empty component
    const started = Date.now();
    gitignoreCovers(`${'**//'.repeat(1500)}zzz\n`, ARTIFACTS_GITIGNORE_ENTRY);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30000);

  it('a hostile glob line is matched in bounded time', () => {
    const hostile = `${'*'.repeat(5000)}a${'*'.repeat(5000)}b/\n`;
    const started = Date.now();
    expect(gitignoreCovers(hostile, ARTIFACTS_GITIGNORE_ENTRY)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('missingRuntimeGitignorePaths', () => {
  it('does not report the artifacts entry when a broader line already ignores it', () => {
    const rest = RUNTIME_GITIGNORE_PATHS.filter((p) => p !== ARTIFACTS_GITIGNORE_ENTRY);
    expect(missingRuntimeGitignorePaths('artifacts/\n')).toEqual(rest);
    expect(missingRuntimeGitignorePaths('.ai-sdlc/\n')).toEqual([]);
    expect(missingRuntimeGitignorePaths('.ai-sdlc/*\n')).toEqual([]);
  });

  it('reports it when `.ai-sdlc/*` is followed by a negation, so the new line lands after it', () => {
    const missing = missingRuntimeGitignorePaths('.ai-sdlc/*\n!.ai-sdlc/artifacts\n');
    expect(missing).toContain(ARTIFACTS_GITIGNORE_ENTRY);
  });

  it("takes git's answer over the text reading, and the text reading when git cannot answer", () => {
    expect(missingRuntimeGitignorePaths('', () => true)).toEqual([]);
    expect(missingRuntimeGitignorePaths('artifacts/\n', () => false)).toEqual([
      ...RUNTIME_GITIGNORE_PATHS,
    ]);
    const rest = RUNTIME_GITIGNORE_PATHS.filter((p) => p !== ARTIFACTS_GITIGNORE_ENTRY);
    expect(missingRuntimeGitignorePaths('artifacts/\n', () => null)).toEqual(rest);
  });

  it('never asks git about an entry a plain line already writes', () => {
    const asked: string[] = [];
    missingRuntimeGitignorePaths(`${ARTIFACTS_GITIGNORE_ENTRY}\n`, (entry) => {
      asked.push(entry);
      return false;
    });
    expect(asked).not.toContain(ARTIFACTS_GITIGNORE_ENTRY);
  });

  it('reports every path for an empty file and none for a complete one', () => {
    expect(missingRuntimeGitignorePaths('')).toEqual([...RUNTIME_GITIGNORE_PATHS]);
    expect(missingRuntimeGitignorePaths(RUNTIME_GITIGNORE_PATHS.join('\n') + '\n')).toEqual([]);
  });

  it('counts a negated or indented entry as written only when a plain line writes it', () => {
    const entry = ARTIFACTS_GITIGNORE_ENTRY;
    const rest = RUNTIME_GITIGNORE_PATHS.filter((p) => p !== entry).join('\n');
    // written, then negated: left alone, so a run never re-adds it
    expect(missingRuntimeGitignorePaths(`${rest}\n${entry}\n!${entry}\n`)).toEqual([]);
    // only a negation or an indented line (not an effective pattern): the plain entry is still added
    expect(missingRuntimeGitignorePaths(`${rest}\n!${entry}\n`)).toEqual([entry]);
    expect(missingRuntimeGitignorePaths(`${rest}\n  ${entry}\n`)).toEqual([entry]);
  });

  it('reports only the artifacts entry for a repository initialised before it existed', () => {
    const old = `${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n.ai-sdlc/audit.jsonl\n`;
    expect(missingRuntimeGitignorePaths(old)).toEqual([ARTIFACTS_GITIGNORE_ENTRY]);
  });
});

describe('hasSentinelLine', () => {
  it('matches a whole line, with surrounding whitespace', () => {
    expect(hasSentinelLine(`a\n  ${RUNTIME_GITIGNORE_SENTINEL}  \nb\n`)).toBe(true);
    expect(hasSentinelLine(`${RUNTIME_GITIGNORE_SENTINEL}\r\n`)).toBe(true);
  });

  it('does not match the sentinel text inside another line', () => {
    expect(hasSentinelLine(`foo ${RUNTIME_GITIGNORE_SENTINEL}\n`)).toBe(false);
    expect(hasSentinelLine(`${RUNTIME_GITIGNORE_SENTINEL}-v0\n`)).toBe(false);
    expect(hasSentinelLine('')).toBe(false);
  });
});

describe('insertIntoSentinelBlock', () => {
  const missing = [ARTIFACTS_GITIGNORE_ENTRY];

  it('adds the entry at the end of the sentinel block, before later content', () => {
    const before =
      `dist/\n\n${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n` +
      `.ai-sdlc/audit.jsonl\n\n# other\ncoverage/\n`;
    expect(insertIntoSentinelBlock(before, missing)).toBe(
      `dist/\n\n${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n` +
        `.ai-sdlc/audit.jsonl\n.ai-sdlc/artifacts/\n\n# other\ncoverage/\n`,
    );
  });

  it('works when the block is the last thing in the file, with or without a final newline', () => {
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\na\n`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\na\n.ai-sdlc/artifacts/\n`,
    );
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\na`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\na\n.ai-sdlc/artifacts/`,
    );
  });

  it('stops the block at a comment line that follows it directly', () => {
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\na\n# other\nb\n`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\na\n.ai-sdlc/artifacts/\n# other\nb\n`,
    );
  });

  it('keeps CRLF files CRLF', () => {
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\r\na\r\n`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\r\na\r\n.ai-sdlc/artifacts/\r\n`,
    );
  });

  it('adds under a sentinel that has an empty block', () => {
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\n\nnext\n`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/artifacts/\n\nnext\n`,
    );
  });

  it('returns the text unchanged when there is no sentinel', () => {
    expect(insertIntoSentinelBlock('dist/\n', missing)).toBe('dist/\n');
  });
});
