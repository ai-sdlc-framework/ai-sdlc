/**
 * ensureRuntimeGitignore (AISDLC-657.3): `execute` repairs the runtime block of the
 * working tree's .gitignore on every run, including repositories initialised before
 * `.ai-sdlc/artifacts/` was part of the list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntimeGitignore } from './execute.js';

const SENTINEL = '# ai-sdlc:runtime-gitignore';
const OLD_BLOCK = `${SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n.ai-sdlc/audit.jsonl\n`;

let dir: string;
const gitignore = () => join(dir, '.gitignore');
const count = (text: string, needle: string) => text.split(needle).length - 1;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-sdlc-ensure-gitignore-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureRuntimeGitignore', () => {
  it('writes the runtime block, artifacts directory included, when there is no .gitignore', () => {
    ensureRuntimeGitignore(dir);
    const out = readFileSync(gitignore(), 'utf-8');
    expect(out).toBe(
      `${SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n.ai-sdlc/audit.jsonl\n.ai-sdlc/artifacts/\n`,
    );
  });

  it('appends the artifacts entry once to a sentinel block that lacks it, and not again on a second run', () => {
    writeFileSync(gitignore(), `node_modules/\n\n${OLD_BLOCK}\n# build\ndist/\n`);

    ensureRuntimeGitignore(dir);
    const first = readFileSync(gitignore(), 'utf-8');
    expect(count(first, '.ai-sdlc/artifacts/')).toBe(1);
    expect(count(first, SENTINEL)).toBe(1);
    // under the existing heading, not after the unrelated content that follows it
    expect(first).toBe(`node_modules/\n\n${OLD_BLOCK}.ai-sdlc/artifacts/\n\n# build\ndist/\n`);

    ensureRuntimeGitignore(dir);
    expect(readFileSync(gitignore(), 'utf-8')).toBe(first);
  });

  it('adds only what is missing when some runtime paths are already ignored without a sentinel', () => {
    writeFileSync(gitignore(), '.ai-sdlc/state/\n');
    ensureRuntimeGitignore(dir);
    const out = readFileSync(gitignore(), 'utf-8');
    expect(count(out, '.ai-sdlc/state/')).toBe(1);
    expect(out).toContain('.ai-sdlc/state.db');
    expect(out).toContain('.ai-sdlc/audit.jsonl');
    expect(out).toContain('.ai-sdlc/artifacts/');
  });

  it('writes a new block when the sentinel text only appears inside another line', () => {
    writeFileSync(gitignore(), `dist/ ${SENTINEL}\n# ${SENTINEL}-v0\n`);
    ensureRuntimeGitignore(dir);
    const out = readFileSync(gitignore(), 'utf-8');
    expect(out).toContain(`\n${SENTINEL}\n.ai-sdlc/state.db\n`);
    expect(out).toContain('.ai-sdlc/artifacts/');
    // the lines the user wrote are untouched
    expect(out.startsWith(`dist/ ${SENTINEL}\n# ${SENTINEL}-v0\n`)).toBe(true);
  });

  it('does not fight a deliberate negation: no duplicate entry, no growth on any run', () => {
    const negated = `${OLD_BLOCK}.ai-sdlc/artifacts/\n!.ai-sdlc/artifacts/\n`;
    writeFileSync(gitignore(), negated);
    ensureRuntimeGitignore(dir);
    ensureRuntimeGitignore(dir);
    expect(readFileSync(gitignore(), 'utf-8')).toBe(negated);
  });

  it('leaves a complete .gitignore byte-for-byte alone', () => {
    const complete = `${OLD_BLOCK}.ai-sdlc/artifacts/\n`;
    writeFileSync(gitignore(), complete);
    ensureRuntimeGitignore(dir);
    expect(readFileSync(gitignore(), 'utf-8')).toBe(complete);
  });

  it('is best-effort: a working directory that does not exist is not an error and creates nothing', () => {
    const missing = join(dir, 'does-not-exist');
    expect(() => ensureRuntimeGitignore(missing)).not.toThrow();
    expect(existsSync(join(missing, '.gitignore'))).toBe(false);
  });
});

// DEC-0020: a broader line already ignores the directory, so `execute` must not append a
// redundant block (the edit would otherwise land in an unrelated agent PR).
describe('ensureRuntimeGitignore: a broader line already ignores the artifacts directory', () => {
  const STATE_ONLY = `${SENTINEL}\n.ai-sdlc/state.db\n.ai-sdlc/state/\n.ai-sdlc/audit.jsonl\n`;
  const gitAvailable = spawnSync('git', ['--version']).status === 0;
  const initRepo = () => spawnSync('git', ['init', '-q', dir]);

  it.each(['artifacts/', '.ai-sdlc/', '.ai-sdlc/*', '**/artifacts/'])(
    'in a git repository, %j: the file is left byte-for-byte alone',
    (line) => {
      if (!gitAvailable) return;
      initRepo();
      const content = `${STATE_ONLY}${line}\n`;
      writeFileSync(gitignore(), content);
      ensureRuntimeGitignore(dir);
      expect(readFileSync(gitignore(), 'utf-8')).toBe(content);
    },
  );

  it('in a git repository, adds only the three other entries when `artifacts/` is the only line', () => {
    if (!gitAvailable) return;
    initRepo();
    writeFileSync(gitignore(), 'artifacts/\n');
    ensureRuntimeGitignore(dir);
    const out = readFileSync(gitignore(), 'utf-8');
    expect(out).toBe(`artifacts/\n${STATE_ONLY}`);
    expect(count(out, '.ai-sdlc/artifacts/')).toBe(0);
  });

  it('in a git repository, `.ai-sdlc/*` then a re-including `!` gets the entry appended after it, and git then ignores it', () => {
    if (!gitAvailable) return;
    initRepo();
    writeFileSync(gitignore(), '.ai-sdlc/*\n!.ai-sdlc/artifacts\n');
    ensureRuntimeGitignore(dir);
    const out = readFileSync(gitignore(), 'utf-8');
    expect(out.indexOf('!.ai-sdlc/artifacts')).toBeLessThan(out.lastIndexOf('.ai-sdlc/artifacts/'));
    const ignored = spawnSync('git', ['-C', dir, 'check-ignore', '-q', '.ai-sdlc/artifacts/probe']);
    expect(ignored.status).toBe(0);
    // and a second run leaves it alone
    ensureRuntimeGitignore(dir);
    expect(readFileSync(gitignore(), 'utf-8')).toBe(out);
  });

  it.each(['artifacts/', '.ai-sdlc/', '.ai-sdlc/*'])(
    'without git (not a repository), %j is read from the text and the file is left alone',
    (line) => {
      const content = `${STATE_ONLY}${line}\n`;
      writeFileSync(gitignore(), content);
      ensureRuntimeGitignore(dir);
      expect(readFileSync(gitignore(), 'utf-8')).toBe(content);
    },
  );

  it('without git, `.ai-sdlc/*` then a re-including `!` still gets the entry appended', () => {
    writeFileSync(gitignore(), '.ai-sdlc/*\n!.ai-sdlc/artifacts\n');
    ensureRuntimeGitignore(dir);
    expect(readFileSync(gitignore(), 'utf-8')).toContain('\n.ai-sdlc/artifacts/\n');
  });
});
