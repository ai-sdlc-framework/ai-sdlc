import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveActor } from '../cli/context.js';
import { gitUserEmail, resolveOperatorIdentity } from '../util/operator-identity.js';
import { hashValue } from './entry.js';
import { confirmEntry, correctEntry, supersedeEntry } from './human.js';
import { ingestSource } from './ingest-sources.js';
import { auditLines, knowledgeLogPath, readKnowledgeLog } from './log.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { type Actor, promoteEntry, reobserveEntry, refuteEntry } from './promote.js';
import { resolveKnowledgePrincipal, systemPrincipalDeps, type PrincipalDeps } from './principal.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const noGit = (): string => {
  throw new Error('git must not be spawned');
};
const noCaller = (): null => null;

function deps(over: Partial<PrincipalDeps>): PrincipalDeps {
  return { role: 'agent', gitEmail: noGit, caller: noCaller, ...over };
}

describe('resolveKnowledgePrincipal', () => {
  it('human with a git email', () => {
    const p = resolveKnowledgePrincipal(
      { USER: 'dom' },
      deps({ role: 'human', gitEmail: () => 'op@example.com' }),
    );
    expect(p).toBe('human:op@example.com');
  });

  it('human with no git email falls back to $USER', () => {
    expect(
      resolveKnowledgePrincipal({ USER: 'dom' }, deps({ role: 'human', gitEmail: () => '' })),
    ).toBe('human:dom');
    // a failing git lookup is treated as unset
    expect(resolveKnowledgePrincipal({ USER: 'dom' }, deps({ role: 'human' }))).toBe('human:dom');
    expect(resolveKnowledgePrincipal({}, deps({ role: 'human', gitEmail: () => '' }))).toBe(
      'human:unknown',
    );
  });

  it('roster agent uses the session name', () => {
    const p = resolveKnowledgePrincipal(
      { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' },
      deps({ caller: () => ({ name: 'executor-2', role: 'executor' }) }),
    );
    expect(p).toBe('agent:executor-2');
  });

  it('task agent outside the roster uses the active task id', () => {
    expect(resolveKnowledgePrincipal({ AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1420' }, deps({}))).toBe(
      'agent:task:AISDLC-1420',
    );
  });

  it('unknown agent, including a throwing roster lookup, never throws', () => {
    expect(resolveKnowledgePrincipal({}, deps({}))).toBe('agent:unknown');
    expect(
      resolveKnowledgePrincipal(
        { AI_SDLC_ACTIVE_TASK_ID: '  ' },
        deps({
          caller: () => {
            throw new Error('ps failed');
          },
        }),
      ),
    ).toBe('agent:unknown');
  });
});

describe('resolveOperatorIdentity (shared with cli-capture)', () => {
  it('prefers the override, then git, then $USER, then unknown', () => {
    expect(resolveOperatorIdentity('given', {}, noGit)).toBe('given');
    expect(resolveOperatorIdentity(undefined, { USER: 'u' }, () => 'e@x')).toBe('e@x');
    expect(resolveOperatorIdentity(undefined, { USER: 'u' }, noGit)).toBe('u');
    expect(resolveOperatorIdentity(undefined, {}, () => '')).toBe('unknown');
  });

  it('gitUserEmail returns a trimmed string', () => {
    const v = gitUserEmail();
    expect(typeof v).toBe('string');
    expect(v).toBe(v.trim());
  });
});

let root: string | undefined;
afterEach(() => {
  if (root) removeFixtureDir(root);
  root = undefined;
});

describe('systemPrincipalDeps and resolveActor', () => {
  it('reads the roster of the given board and resolves an agent outside it', () => {
    root = mkdtempSync(join(tmpdir(), 'principal-'));
    const env = { AI_SDLC_DISPATCH_BOARD_DIR: join(root, 'board'), AI_SDLC_ACTIVE_TASK_ID: 'T-9' };
    const d = systemPrincipalDeps('agent', root, env);
    expect(d.role).toBe('agent');
    expect(d.caller()).toBeNull();
    expect(resolveActor(root, env)).toEqual({ by: 'agent', principal: 'agent:task:T-9' });
  });

  it('defaults the board to the project dispatch folder', () => {
    root = mkdtempSync(join(tmpdir(), 'principal-'));
    expect(systemPrincipalDeps('human', root, {}).caller()).toBeNull();
  });
});

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(root as string, rel)), { recursive: true });
  writeFileSync(join(root as string, rel), text);
}

function entryText(id: string): string {
  const value = `value of ${id}`;
  const f = {
    id,
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.5,
    authority: 'inferred',
    scope: 'internal',
    source: 'src/a.ts',
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
  };
  return `---\n${JSON.stringify(f)}\n---\n`;
}

describe('every knowledge-log emit site records by and principal', () => {
  it('covers promote, reobserve, refute, confirm, correct, supersede and ingest supersession', () => {
    root = mkdtempSync(join(tmpdir(), 'principal-emit-'));
    const tracked = join(root, '.ai-sdlc/knowledge');
    for (const id of ['a', 'b']) put(`.ai-sdlc/knowledge/systems/${id}.md`, entryText(id));
    const human: Actor = { by: 'human', principal: 'human:op@example.com' };
    const agent: Actor = { by: 'agent', principal: 'agent:task:T-1' };

    const verify = {
      projectDir: root,
      config: { trackedRoot: '.ai-sdlc/knowledge', protectedRoot: '.ai-sdlc/private' },
      ontology: DEFAULT_ONTOLOGY,
    } as unknown as Parameters<typeof promoteEntry>[4];
    expect(
      promoteEntry({ backend: 'files' }, tracked, 'a', { to: 'canonical', ...human }, verify).ok,
    ).toBe(true);
    expect(
      reobserveEntry({ backend: 'files' }, tracked, 'a', 1, agent, undefined, root),
    ).not.toBeNull();
    expect(refuteEntry({ backend: 'files' }, tracked, 'a', 'wrong', human, root)).toBe(true);
    expect(
      confirmEntry({ backend: 'files' }, tracked, 'a', 1, human, undefined, root),
    ).not.toBeNull();
    expect(correctEntry({ backend: 'files' }, tracked, 'a', 'new', human, undefined, root)).toBe(
      true,
    );
    expect(supersedeEntry({ backend: 'files' }, tracked, 'a', 'b', human, root).ok).toBe(true);

    const task = (title: string): void =>
      put(
        'backlog/tasks/T-1 - t.md',
        `---\nid: T-1\ntitle: ${title}\nstatus: To Do\n---\n\nbody\n`,
      );
    const ingest = (): void => {
      ingestSource('tasks', {
        backend: 'files',
        projectDir: root as string,
        trackedRootAbs: tracked,
        ontology: DEFAULT_ONTOLOGY,
        observed: '2026-10-26',
        actor: agent,
      });
    };
    task('first');
    ingest();
    task('second');
    ingest();

    const events = readKnowledgeLog(tracked);
    expect(events.map((e) => e.event)).toEqual([
      'promoted',
      'reobserved',
      'refuted',
      'confirmed',
      'corrected',
      'superseded',
      'superseded',
    ]);
    for (const e of events) {
      expect(e.by === 'human' || e.by === 'agent').toBe(true);
      expect(e.principal).toBeTruthy();
    }
    expect(events[1]).toMatchObject({ by: 'agent', principal: 'agent:task:T-1' });
    expect(events[6]).toMatchObject({ id: 'task-t-1', by: 'agent', principal: 'agent:task:T-1' });
    expect(auditLines(events)[0]).toContain('by=human principal=human:op@example.com');
  });
});

describe('older log lines without principal', () => {
  it('still parse and audit with a placeholder', () => {
    root = mkdtempSync(join(tmpdir(), 'principal-old-'));
    const tracked = join(root, '.ai-sdlc/knowledge');
    const file = knowledgeLogPath(tracked);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'promoted', id: 'x', from: 'inferred', to: 'specialist', proof: 'decision-id:DEC-1', by: 'agent' })}\n` +
        `${JSON.stringify({ ts: '2026-01-02T00:00:00.000Z', event: 'reobserved', id: 'x', detail: 'confidence 0.5 -> 0.6' })}\n`,
    );
    const events = readKnowledgeLog(tracked);
    expect(events).toHaveLength(2);
    expect(events[0].principal).toBeUndefined();
    expect(auditLines(events)).toEqual([
      '2026-01-01T00:00:00.000Z x inferred -> specialist proof=decision-id:DEC-1 by=agent principal=?',
    ]);
  });
});
