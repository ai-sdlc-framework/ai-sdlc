import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRequiredCapabilities, readCapabilitiesConfigFromBaseRef } from './config.js';

const doc = (required: string[]) =>
  `apiVersion: ai-sdlc.io/v1alpha1\nkind: CapabilitiesConfig\nmetadata:\n  name: c\nspec:\n  required: [${required.join(', ')}]\n`;

describe('loadRequiredCapabilities', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_DIR: undefined },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caps-config-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, '.ai-sdlc'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty list when the base ref has no file', () => {
    writeFileSync(join(dir, 'x'), 'x');
    git('add', 'x');
    git('commit', '-q', '-m', 'init');
    expect(loadRequiredCapabilities({ workDir: dir, baseRef: 'HEAD' })).toEqual([]);
  });

  it('ignores a working-tree copy and reads only the base ref', () => {
    const file = join(dir, '.ai-sdlc', 'capabilities.yaml');
    writeFileSync(file, doc(['dor.stage-b']));
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(file, doc([]));
    expect(loadRequiredCapabilities({ workDir: dir, baseRef: 'HEAD' })).toEqual(['dor.stage-b']);
  });

  it('ignores an uncommitted working-tree file', () => {
    writeFileSync(join(dir, 'x'), 'x');
    git('add', 'x');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(dir, '.ai-sdlc', 'capabilities.yaml'), doc(['dor.stage-b']));
    expect(loadRequiredCapabilities({ workDir: dir, baseRef: 'HEAD' })).toEqual([]);
  });

  it('returns an empty list for invalid or unparseable content and a throwing reader', () => {
    const read = (raw: string) => () => raw;
    expect(loadRequiredCapabilities({ readBaseConfig: read('kind: Other\n') })).toEqual([]);
    expect(loadRequiredCapabilities({ readBaseConfig: read(doc(['Bad Id'])) })).toEqual([]);
    expect(loadRequiredCapabilities({ readBaseConfig: read(': : :\n\t- [') })).toEqual([]);
    expect(
      loadRequiredCapabilities({
        readBaseConfig: () => {
          throw new Error('boom');
        },
      }),
    ).toEqual([]);
  });

  it('defaults required to empty when omitted', () => {
    const raw = 'apiVersion: ai-sdlc.io/v1alpha1\nkind: CapabilitiesConfig\nspec: {}\n';
    expect(loadRequiredCapabilities({ readBaseConfig: () => raw })).toEqual([]);
  });

  it('refuses a base ref that looks like an option', () => {
    expect(readCapabilitiesConfigFromBaseRef(dir, '--output=x')).toBeNull();
    expect(readCapabilitiesConfigFromBaseRef(dir, '')).toBeNull();
  });
});
