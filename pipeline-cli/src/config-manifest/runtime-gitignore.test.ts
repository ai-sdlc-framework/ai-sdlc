import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
  gitCheckIgnoreArgs,
  gitignoreCovers,
  insertIntoSentinelBlock,
  interpretCheckIgnoreExit,
  writeRuntimeGitignore,
} from './runtime-gitignore.js';

// The orchestrator suite (`orchestrator/src/runtime-gitignore.test.ts`) covers the
// list in depth through its re-export; these cases cover the module where it lives.
describe('runtime-gitignore (AISDLC-1407)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'rt-gitignore-'));
    dirs.push(d);
    return d;
  };

  it('lists the protected knowledge root', () => {
    expect(RUNTIME_GITIGNORE_PATHS).toContain('.ai-sdlc/knowledge-protected/');
  });

  it('matches `*` and `?` glob segments', () => {
    expect(gitignoreCovers('.ai-sdlc/*.db\n', '.ai-sdlc/state.db')).toBe(true);
    expect(gitignoreCovers('.ai-sdlc/stat?.db\n', '.ai-sdlc/state.db')).toBe(true);
    expect(gitignoreCovers('.ai-sdlc/*.txt\n', '.ai-sdlc/state.db')).toBe(false);
  });

  it('builds check-ignore args, probing a directory through a file inside it', () => {
    const args = gitCheckIgnoreArgs('/repo', '.ai-sdlc/dispatch/');
    expect(args.slice(0, 2)).toEqual(['-C', '/repo']);
    expect(args).toContain('check-ignore');
    expect(args.at(-1)?.startsWith('.ai-sdlc/dispatch/')).toBe(true);
    expect(args.at(-1)).not.toBe('.ai-sdlc/dispatch/');
    expect(gitCheckIgnoreArgs('/repo', '.ai-sdlc/state.db').at(-1)).toBe('.ai-sdlc/state.db');
  });

  it('maps check-ignore exit codes', () => {
    expect(interpretCheckIgnoreExit(0)).toBe(true);
    expect(interpretCheckIgnoreExit(1)).toBe(false);
    expect(interpretCheckIgnoreExit(128)).toBeNull();
  });

  it('inserts into the sentinel block, keeping CRLF, and leaves text without one alone', () => {
    const crlf = `node_modules/\r\n${RUNTIME_GITIGNORE_SENTINEL}\r\n.ai-sdlc/state.db\r\n\r\n# mine\r\n`;
    expect(insertIntoSentinelBlock(crlf, ['x/'])).toBe(
      `node_modules/\r\n${RUNTIME_GITIGNORE_SENTINEL}\r\n.ai-sdlc/state.db\r\nx/\r\n\r\n# mine\r\n`,
    );
    expect(insertIntoSentinelBlock('a\n', ['x/'])).toBe('a\n');
  });

  it('writes every entry once, keeps existing lines, then changes nothing', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf-8');
    expect(writeRuntimeGitignore(dir, { dryRun: true })).toEqual([...RUNTIME_GITIGNORE_PATHS]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('node_modules/');
    expect(writeRuntimeGitignore(dir)).toEqual([...RUNTIME_GITIGNORE_PATHS]);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(after.startsWith(`node_modules/\n\n${RUNTIME_GITIGNORE_SENTINEL}\n`)).toBe(true);
    expect(writeRuntimeGitignore(dir)).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(after);
  });

  it('adds a missing entry under an existing sentinel block', () => {
    const dir = tmp();
    const rest = RUNTIME_GITIGNORE_PATHS.filter((p) => p !== '.ai-sdlc/knowledge-protected/');
    writeFileSync(
      join(dir, '.gitignore'),
      `${RUNTIME_GITIGNORE_SENTINEL}\n${rest.join('\n')}\n`,
      'utf-8',
    );
    expect(writeRuntimeGitignore(dir)).toEqual(['.ai-sdlc/knowledge-protected/']);
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(text.split(RUNTIME_GITIGNORE_SENTINEL)).toHaveLength(2);
    expect(text).toContain('.ai-sdlc/knowledge-protected/');
  });
});
