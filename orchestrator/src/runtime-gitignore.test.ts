import { describe, it, expect } from 'vitest';
import {
  ARTIFACTS_GITIGNORE_ENTRY,
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
  gitignoreCovers,
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
  it.each(['.ai-sdlc/state/', '.ai-sdlc/state', '/.ai-sdlc/state/', '  .ai-sdlc/state/ '])(
    'treats %j as the same entry',
    (line) => {
      expect(gitignoreCovers(`node_modules/\n${line}\n`, '.ai-sdlc/state/')).toBe(true);
    },
  );

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

  it('reports only the artifacts entry for a repository initialised before it existed', () => {
    const old = `${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n.ai-sdlc/audit.jsonl\n`;
    expect(missingRuntimeGitignorePaths(old)).toEqual([ARTIFACTS_GITIGNORE_ENTRY]);
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

  it('adds under a sentinel that has an empty block', () => {
    expect(insertIntoSentinelBlock(`${RUNTIME_GITIGNORE_SENTINEL}\n\nnext\n`, missing)).toBe(
      `${RUNTIME_GITIGNORE_SENTINEL}\n.ai-sdlc/artifacts/\n\nnext\n`,
    );
  });

  it('returns the text unchanged when there is no sentinel', () => {
    expect(insertIntoSentinelBlock('dist/\n', missing)).toBe('dist/\n');
  });
});
