import { describe, it, expect } from 'vitest';
import {
  ARTIFACTS_GITIGNORE_ENTRY,
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
  gitignoreCovers,
  hasSentinelLine,
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

describe('missingRuntimeGitignorePaths', () => {
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
