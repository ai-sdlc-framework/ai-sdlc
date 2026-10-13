import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCatalogRoot } from './catalog-root.js';
import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { projectDecision } from './projection.js';

let base: string;
let main: string;
let wt: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-root-')));
  main = join(base, 'main');
  wt = join(base, 'wt');
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'i');
  git(main, 'worktree', 'add', '-q', '-b', 'task', wt);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveCatalogRoot (AISDLC-825)', () => {
  it('maps a linked worktree to the main checkout', () => {
    expect(resolveCatalogRoot(wt)).toBe(main);
  });
  it('leaves the main checkout, a non-repo dir and a bare repo unchanged', () => {
    expect(resolveCatalogRoot(main)).toBe(main);
    expect(resolveCatalogRoot(base)).toBe(base);
    const bare = join(base, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    expect(resolveCatalogRoot(bare)).toBe(bare);
  });
  it('an event filed via the worktree root is readable from the main checkout', () => {
    const root = resolveCatalogRoot(wt);
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'Pick',
        options: [
          { id: 'opt-a', description: 'A' },
          { id: 'opt-b', description: 'B' },
        ],
      }),
      { workDir: root },
    );
    expect(projectDecision('DEC-0001', { workDir: main })).toBeTruthy();
  });
});
