/**
 * ensureRuntimeGitignore (AISDLC-657.3): `execute` repairs the runtime block of the
 * working tree's .gitignore on every run, including repositories initialised before
 * `.ai-sdlc/artifacts/` was part of the list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
