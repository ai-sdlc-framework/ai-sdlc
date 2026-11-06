import { describe, expect, it } from 'vitest';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { isRebaseOnlyPush } from './rebase-rearm.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
const bad: ExecResult = { stdout: '', stderr: 'x', code: 1 };

interface Fake {
  bases?: Record<string, string | null>;
  trees?: Record<string, string>;
  merged?: string | null;
  version?: string;
}

function run(f: Fake = {}, prev = A, next = B) {
  const bases = f.bases ?? { [A]: M1, [B]: M2 };
  const trees = f.trees ?? { [A]: 'T1', [B]: 'T2' };
  const runner: Runner = async (_c, args) => {
    if (args[0] === '--version') return ok(f.version ?? 'git version 2.43.0');
    if (args[0] === 'merge-base') {
      const b = bases[args[2]!];
      return b ? ok(`${b}\n`) : bad;
    }
    if (args[0] === 'rev-parse') {
      const t = trees[args[1]!.replace('^{tree}', '')];
      return t ? ok(`${t}\n`) : bad;
    }
    if (args[0] === 'merge-tree') return f.merged ? ok(`${f.merged}\n`) : bad;
    return bad;
  };
  return isRebaseOnlyPush({ previousHead: prev, newHead: next, repoRoot: '/x', runner });
}

describe('isRebaseOnlyPush (clean-replay rule, no patch-id)', () => {
  it('is true when the three-way replay reproduces the new tree', async () => {
    expect((await run({ merged: 'T2' })).rebaseOnly).toBe(true);
  });
  it('is false when the replay is conflicted or differs', async () => {
    expect((await run({ merged: null })).rebaseOnly).toBe(false);
    const r = await run({ merged: 'T9' });
    expect(r.rebaseOnly).toBe(false);
    expect(r.reason).toContain('not a clean replay');
  });
  it('fails closed on a missing merge-base', async () => {
    expect((await run({ bases: { [A]: M1 } })).rebaseOnly).toBe(false);
  });
  it('fails closed on git older than 2.40', async () => {
    const r = await run({ version: 'git version 2.30.0', merged: 'T2' });
    expect(r.rebaseOnly).toBe(false);
    expect(r.reason).toContain('git 2.40');
  });
  it('treats an unchanged head as rebase-only', async () => {
    expect((await run({}, A, A)).rebaseOnly).toBe(true);
  });
});
