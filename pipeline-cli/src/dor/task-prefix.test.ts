import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { evaluateGate3 } from './gates/gate-3-references.js';
import { evaluateGate5, findSurfaceSignals } from './gates/gate-5-surface.js';
import { findInvisibleDependencies } from './gates/gate-7-deps.js';
import { fileExistenceResolver } from './resolvers/file-existence.js';
import { escapeRegex, taskIdSource, taskPrefixSource } from './task-prefix.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => cleanupTmpProject(tmp));

const setPrefix = (p: string) =>
  writeFileSync(join(tmp, 'backlog', 'config.yml'), `task_prefix: '${p}'\n`);

describe('task prefix of the repository (AISDLC-1360)', () => {
  it('ACS prefix: all four spots recognise ACS-12', async () => {
    setPrefix('ACS');
    writeFileSync(join(tmp, 'backlog', 'tasks', 'acs-12 - x.md'), 't');
    const base = { source: 'backlog' as const, id: 'ACS-1', title: 't', workDir: tmp };
    const g3 = await evaluateGate3(
      { ...base, body: 'plain', references: ['ACS-13'] },
      { resolvers: [fileExistenceResolver], pendingRefs: { 'ACS-13': 'PR #9' } },
    );
    expect(g3.pending).toEqual([{ ref: 'ACS-13', where: 'PR #9' }]);
    expect(findSurfaceSignals('see ACS-12', tmp)).toContain('aisdlc-ref');
    expect(findSurfaceSignals('see AISDLC-12', tmp)).not.toContain('aisdlc-ref');
    expect(evaluateGate5({ ...base, body: 'follows ACS-12' }).verdict).toBe('pass');
    expect(findInvisibleDependencies({ ...base, body: 'after ACS-12 ships' })).toHaveLength(1);
    const ref = { raw: 'ACS-12', kind: 'file-existence' as const };
    expect(fileExistenceResolver.supports({ raw: 'ACS-12', kind: 'unknown' }, base)).toBe(true);
    expect((await fileExistenceResolver.resolve(ref, { workDir: tmp })).resolved).toBe(true);
    writeFileSync(join(tmp, 'backlog', 'completed', 'acs-14 - y.md'), 't');
    const done = { raw: 'ACS-14', kind: 'file-existence' as const };
    expect((await fileExistenceResolver.resolve(done, { workDir: tmp })).resolved).toBe(true);
  });

  it('AISDLC prefix and no prefix behave as before', () => {
    expect(taskIdSource(tmp)).toBe(String.raw`AISDLC-\d+(?:\.\d+)?`);
    setPrefix('AISDLC');
    expect(taskIdSource(tmp)).toBe(String.raw`AISDLC-\d+(?:\.\d+)?`);
    const input = { source: 'backlog' as const, id: 'X-1', title: 't', workDir: tmp };
    expect(findInvisibleDependencies({ ...input, body: 'after AISDLC-12 ships' })).toHaveLength(1);
    expect(findSurfaceSignals('AISDLC-5')).toContain('aisdlc-ref');
  });

  it('escapes regex characters in the prefix', () => {
    expect(escapeRegex('A.B+(C)')).toBe(String.raw`A\.B\+\(C\)`);
    setPrefix('A-B');
    expect(taskPrefixSource(tmp)).toBe('A-B');
  });
});
