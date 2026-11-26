import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  checkPrBodyKnowledge,
  checkPushKnowledgeScope,
  hasKnowledgeStore,
  resolveContextCli,
} from './push-guard.js';

const PROTECTED = '---\nid: acme-pricing\ntitle: Acme pricing\nscope: protected\n---\nbody\n';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'push-guard-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: root,
    encoding: 'utf-8',
  }).trim();
}

/** Records calls; never runs anything. */
function recordingRunner(code = 0, stderr = ''): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const r = (async (_cmd: string, args: string[]) => {
    calls.push(args);
    return { stdout: '', stderr, code };
  }) as Runner & { calls: string[][] };
  r.calls = calls;
  return r;
}

const cli = resolveContextCli();

describe('hasKnowledgeStore', () => {
  it('is false for a project with no store', () => {
    expect(hasKnowledgeStore(root)).toBe(false);
    put('.ai-sdlc/context.yaml', 'retrieval:\n  adapter: sqlite\n');
    expect(hasKnowledgeStore(root)).toBe(false);
  });

  it('is true when a root exists, knowledge is configured, or the config is unreadable', () => {
    put('.ai-sdlc/knowledge-protected/a.md', 'x');
    expect(hasKnowledgeStore(root)).toBe(true);
    rmSync(join(root, '.ai-sdlc', 'knowledge-protected'), { recursive: true });
    put('.ai-sdlc/context.yaml', 'knowledge:\n  trackedRoot: kb\n');
    expect(hasKnowledgeStore(root)).toBe(true);
    put('.ai-sdlc/context.yaml', 'knowledge: [unclosed\n');
    expect(hasKnowledgeStore(root)).toBe(true);
  });
});

describe('resolveContextCli', () => {
  it('returns null when the bin is missing', () => {
    expect(resolveContextCli(join(root, 'bin', 'cli-context.mjs'))).toBeNull();
  });
});

describe('checkPushKnowledgeScope (AISDLC-1409)', () => {
  it('a project with no knowledge store passes and runs no check', async () => {
    const runner = recordingRunner(1);
    const r = await checkPushKnowledgeScope({ projectDir: root, runner, revs: ['HEAD'] });
    expect(r.status).toBe('no-store');
    expect(runner.calls).toHaveLength(0);
  });

  it('a project with a store and an unresolvable CLI fails closed', async () => {
    put('.ai-sdlc/knowledge/a.md', 'x');
    const runner = recordingRunner(0);
    const r = await checkPushKnowledgeScope({ projectDir: root, runner, cliPath: null });
    expect(r.status).toBe('refused');
    expect(r.status === 'refused' && r.reason).toMatch(/could not be resolved/);
    expect(runner.calls).toHaveLength(0);
  });

  it('passes the project and every rev to cli-context check-scope', async () => {
    put('.ai-sdlc/knowledge/a.md', 'x');
    const runner = recordingRunner(0);
    const r = await checkPushKnowledgeScope({
      projectDir: root,
      runner,
      cliPath: '/x/cli-context.mjs',
      revs: ['HEAD', '^origin/main'],
    });
    expect(r.status).toBe('clean');
    expect(runner.calls[0]).toEqual([
      '/x/cli-context.mjs',
      'check-scope',
      '--project-dir',
      root,
      '--rev',
      'HEAD',
      '--rev',
      '^origin/main',
    ]);
  });

  it('reports the exit code when the CLI prints nothing', async () => {
    put('.ai-sdlc/knowledge/a.md', 'x');
    const r = await checkPushKnowledgeScope({
      projectDir: root,
      runner: recordingRunner(3),
      cliPath: '/x/cli-context.mjs',
    });
    expect(r.status === 'refused' && r.reason).toMatch(/exited 3/);
  });

  it.skipIf(cli === null)(
    'refuses a protected entry in the tracked root and names it (real cli-context)',
    async () => {
      git('init', '-q', '-b', 'main');
      put('.gitignore', '.ai-sdlc/knowledge-protected/\n');
      put('README.md', 'x');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      put('.ai-sdlc/knowledge/acme-pricing.md', PROTECTED);
      git('add', '.');
      git('commit', '-qm', 'leak');
      const r = await checkPushKnowledgeScope({
        projectDir: root,
        runner: defaultRunner,
        revs: ['HEAD', `^${base}`],
      });
      expect(r.status).toBe('refused');
      expect(r.status === 'refused' && r.reason).toContain(
        '.ai-sdlc/knowledge/acme-pricing.md (scope: protected in tracked root)',
      );
    },
  );
});

describe('checkPrBodyKnowledge (AISDLC-1409)', () => {
  it('a project with no knowledge store runs no check', async () => {
    const runner = recordingRunner(1);
    const r = await checkPrBodyKnowledge({ projectDir: root, runner, body: 'acme-pricing' });
    expect(r.status).toBe('no-store');
    expect(runner.calls).toHaveLength(0);
  });

  it('a project with a store and an unresolvable CLI fails closed', async () => {
    put('.ai-sdlc/knowledge-protected/acme-pricing.md', PROTECTED);
    const r = await checkPrBodyKnowledge({
      projectDir: root,
      runner: recordingRunner(0),
      cliPath: null,
      body: 'clean',
    });
    expect(r.status).toBe('refused');
  });

  it.skipIf(cli === null)(
    'refuses a body citing a protected entry and passes a clean one (real cli-context)',
    async () => {
      put('.ai-sdlc/knowledge-protected/acme-pricing.md', PROTECTED);
      const cited = await checkPrBodyKnowledge({
        projectDir: root,
        runner: defaultRunner,
        body: 'This uses acme-pricing for the quote.',
      });
      expect(cited.status).toBe('refused');
      expect(cited.status === 'refused' && cited.reason).toContain('acme-pricing');
      const clean = await checkPrBodyKnowledge({
        projectDir: root,
        runner: defaultRunner,
        body: 'Nothing private here.',
      });
      expect(clean.status).toBe('clean');
    },
  );
});
