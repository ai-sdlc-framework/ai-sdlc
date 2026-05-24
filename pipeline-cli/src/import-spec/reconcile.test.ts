/**
 * Tests for `cli-import-spec --reconcile` drift handling (RFC-0036
 * Phase 6 / AISDLC-331).
 *
 * AC coverage:
 *   #1 `--reconcile` detects drift between in-progress task + upstream.
 *   #2 Drift severity classified via Stage A (typo / cosmetic / semantic / scope).
 *   #3 Low-severity drift auto-syncs without operator interrupt.
 *   #4 High-severity drift auto-defers with 24h override window.
 *   #5 In-progress task NEVER halts; continues against dispatched version.
 *   #6 Default-on-silence at 24h expiry = no-fork (continue against dispatched version).
 *   #7 Reads `adopter-authoring.yaml drift-handling.severityThresholds` config.
 *   #8 Integration tests: each severity tier produces correct routing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDrift,
  reconcileSpec,
  scanImportedTasks,
  type ImportedTaskRecord,
} from './reconcile.js';
import { resolveEventLogPath } from '../decisions/event-log.js';
import type { SpecKitTaskEntry } from './parser.js';

let workDir: string;
let prevFlag: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'import-spec-reconcile-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(workDir, 'backlog', 'completed'), { recursive: true });
  prevFlag = process.env.AI_SDLC_DECISION_CATALOG;
  delete process.env.AI_SDLC_DECISION_CATALOG; // default-ON
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = prevFlag;
});

// ── classifyDrift unit tests (AC #2) ─────────────────────────────────────────

describe('classifyDrift', () => {
  const baseUpstream = (overrides: Partial<SpecKitTaskEntry> = {}): SpecKitTaskEntry => ({
    taskId: 'T-001',
    title: 'Implement bearer-token validator',
    body: 'Body line one.\nBody line two.',
    acceptanceCriteria: ['returns 200 on well-formed token', 'returns 401 on malformed token'],
    ...overrides,
  });

  it('returns no-change when snapshot and upstream agree exactly', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: up.body,
      acceptanceCriteria: [...up.acceptanceCriteria],
    };
    expect(classifyDrift(snap, up)).toBe('no-change');
  });

  it('returns removed-upstream when upstream is null', () => {
    const snap = {
      title: 'x',
      body: '',
      acceptanceCriteria: [],
    };
    expect(classifyDrift(snap, null)).toBe('removed-upstream');
  });

  it('returns no-change when only whitespace + blank-line diff (normaliseBody collapses both)', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: 'Body  line   one.\n\n\nBody line two.', // collapsed whitespace differs
      acceptanceCriteria: [...up.acceptanceCriteria],
    };
    expect(classifyDrift(snap, up)).toBe('no-change');
  });

  it('classifies punctuation / case-only body diff as cosmetic', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: 'Body line ONE!\nBody line two!', // punctuation + case differ, words same
      acceptanceCriteria: [...up.acceptanceCriteria],
    };
    expect(classifyDrift(snap, up)).toBe('cosmetic');
  });

  it('classifies real word changes in body as semantic', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: 'Body line one.\nBody line three is COMPLETELY different.',
      acceptanceCriteria: [...up.acceptanceCriteria],
    };
    expect(classifyDrift(snap, up)).toBe('semantic');
  });

  it('classifies title change as scope', () => {
    const up = baseUpstream();
    const snap = {
      title: 'Implement REFRESH-token validator',
      body: up.body,
      acceptanceCriteria: [...up.acceptanceCriteria],
    };
    expect(classifyDrift(snap, up)).toBe('scope');
  });

  it('classifies AC count change as scope', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: up.body,
      acceptanceCriteria: ['only one'],
    };
    expect(classifyDrift(snap, up)).toBe('scope');
  });

  it('classifies AC body word change as scope', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: up.body,
      acceptanceCriteria: ['returns 200 on well-formed token', 'returns 403 on EXPIRED token'],
    };
    expect(classifyDrift(snap, up)).toBe('scope');
  });

  it('classifies AC whitespace-only change as no-change (normaliseLine collapses ws)', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: up.body,
      acceptanceCriteria: [
        'returns 200 on well-formed token  ',
        'returns 401 on  malformed   token',
      ],
    };
    expect(classifyDrift(snap, up)).toBe('no-change');
  });

  it('classifies AC punctuation/case-only change as cosmetic (auto-sync tier)', () => {
    const up = baseUpstream();
    const snap = {
      title: up.title,
      body: up.body,
      acceptanceCriteria: ['Returns 200 on Well-Formed Token!', 'Returns 401, on Malformed Token!'],
    };
    expect(classifyDrift(snap, up)).toBe('cosmetic');
  });
});

// ── scanImportedTasks helper ─────────────────────────────────────────────────

describe('scanImportedTasks', () => {
  it('finds only tasks with specRef.source: spec-kit and extracts snapshots', () => {
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'imp-1 - foo.md'),
      [
        '---',
        'id: IMP-1',
        "title: 'foo'",
        "status: 'To Do'",
        'specRef:',
        '  source: spec-kit',
        "  featureId: 'auth-feature'",
        "  taskId: 'T-001'",
        "  artifactPath: '.specify/specs/auth-feature/tasks.md'",
        "  importedAt: '2026-05-24T00:00:00.000Z'",
        '---',
        '',
        '## Description',
        '',
        '<!-- SECTION:DESCRIPTION:BEGIN -->',
        'Body of the imported task.',
        '<!-- SECTION:DESCRIPTION:END -->',
        '',
        '## Acceptance Criteria',
        '',
        '<!-- AC:BEGIN -->',
        '- [ ] #1 returns 200',
        '- [ ] #2 returns 401',
        '<!-- AC:END -->',
        '',
      ].join('\n'),
      'utf8',
    );

    // Non-spec-kit task with no specRef block — should be skipped.
    writeFileSync(
      join(workDir, 'backlog', 'tasks', 'aisdlc-99 - normal.md'),
      [
        '---',
        'id: AISDLC-99',
        "title: 'normal'",
        "status: 'To Do'",
        '---',
        '',
        '## Description',
        '<!-- SECTION:DESCRIPTION:BEGIN -->',
        'Just a normal task.',
        '<!-- SECTION:DESCRIPTION:END -->',
      ].join('\n'),
      'utf8',
    );

    const records = scanImportedTasks(workDir);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.id).toBe('IMP-1');
    expect(r.upstreamTaskId).toBe('T-001');
    expect(r.featureId).toBe('auth-feature');
    expect(r.artifactPath).toBe('.specify/specs/auth-feature/tasks.md');
    expect(r.snapshot.title).toBe('foo');
    expect(r.snapshot.body.trim()).toBe('Body of the imported task.');
    expect(r.snapshot.acceptanceCriteria).toEqual(['returns 200', 'returns 401']);
  });

  it('also scans backlog/completed/ tasks', () => {
    writeFileSync(
      join(workDir, 'backlog', 'completed', 'imp-2 - done.md'),
      [
        '---',
        'id: IMP-2',
        "title: 'done'",
        "status: 'Done'",
        'specRef:',
        '  source: spec-kit',
        "  taskId: 'T-002'",
        "  artifactPath: '.specify/specs/x/tasks.md'",
        '---',
        '',
        '## Description',
        '<!-- SECTION:DESCRIPTION:BEGIN -->',
        'Body.',
        '<!-- SECTION:DESCRIPTION:END -->',
        '',
        '## Acceptance Criteria',
        '<!-- AC:BEGIN -->',
        '- [x] #1 done',
        '<!-- AC:END -->',
      ].join('\n'),
      'utf8',
    );

    const records = scanImportedTasks(workDir);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('Done');
  });
});

// ── reconcileSpec integration tests (AC #1, #3, #4, #5, #7, #8) ──────────────

describe('reconcileSpec', () => {
  function writeImportedTask(opts: {
    id: string;
    status?: string;
    title?: string;
    body?: string;
    acs?: string[];
    upstreamTaskId?: string;
    artifactPath?: string;
  }): string {
    const id = opts.id;
    const filePath = join(workDir, 'backlog', 'tasks', `${id.toLowerCase()} - x.md`);
    writeFileSync(
      filePath,
      [
        '---',
        `id: ${id}`,
        `title: '${(opts.title ?? 'Implement bearer-token validator').replace(/'/g, "''")}'`,
        `status: '${opts.status ?? 'In Progress'}'`,
        'specRef:',
        '  source: spec-kit',
        "  featureId: 'auth'",
        `  taskId: '${opts.upstreamTaskId ?? 'T-001'}'`,
        `  artifactPath: '${opts.artifactPath ?? '.specify/specs/auth/tasks.md'}'`,
        "  importedAt: '2026-05-24T00:00:00.000Z'",
        '---',
        '',
        '## Description',
        '',
        '<!-- SECTION:DESCRIPTION:BEGIN -->',
        opts.body ?? 'Body line one.\nBody line two.',
        '<!-- SECTION:DESCRIPTION:END -->',
        '',
        '## Acceptance Criteria',
        '',
        '<!-- AC:BEGIN -->',
        ...(opts.acs ?? ['returns 200 on well-formed token', 'returns 401 on malformed token']).map(
          (ac, i) => `- [ ] #${i + 1} ${ac}`,
        ),
        '<!-- AC:END -->',
        '',
      ].join('\n'),
      'utf8',
    );
    return filePath;
  }

  function makeUpstream(overrides: Partial<SpecKitTaskEntry> = {}): SpecKitTaskEntry {
    return {
      taskId: 'T-001',
      title: 'Implement bearer-token validator',
      body: 'Body line one.\nBody line two.',
      acceptanceCriteria: ['returns 200 on well-formed token', 'returns 401 on malformed token'],
      ...overrides,
    };
  }

  function upstreamReader(entries: SpecKitTaskEntry[]): (artifactPath: string) => string | null {
    return () => {
      // Build a synthetic tasks.md the parser can consume.
      const lines = ['## Tasks', ''];
      for (const e of entries) {
        lines.push(`### ${e.taskId} — ${e.title}`);
        if (e.body) lines.push(e.body);
        for (const ac of e.acceptanceCriteria) lines.push(`AC: ${ac}`);
        lines.push('');
      }
      return lines.join('\n');
    };
  }

  it('AC #1: detects drift and reports per-task severity', () => {
    writeImportedTask({ id: 'IMP-1' });
    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        makeUpstream({
          body: 'COMPLETELY new body that has nothing in common with the old.',
        }),
      ]),
    });
    expect(result.perTask).toHaveLength(1);
    expect(result.perTask[0].importedTaskId).toBe('IMP-1');
    expect(result.perTask[0].severity).toBe('semantic');
  });

  it('AC #3: low-severity (cosmetic) auto-syncs the task body in place', () => {
    const filePath = writeImportedTask({ id: 'IMP-1' });
    const before = readFileSync(filePath, 'utf8');
    expect(before).toContain('Body line one.');

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        // Punctuation + case differ but the underlying words match → cosmetic.
        makeUpstream({ body: 'Body line ONE!\nBody line TWO!' }),
      ]),
    });
    expect(result.perTask[0].severity).toBe('cosmetic');
    expect(result.perTask[0].action).toBe('auto-sync-applied');
    expect(result.perTask[0].decisionId).toMatch(/^DEC-\d{4,}$/);

    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('Body line ONE!');
    expect(after).toContain('Body line TWO!');

    // Decision audit-trail: auto-sync emits decision-opened + operator-answered.
    const eventLog = readFileSync(resolveEventLogPath(workDir), 'utf8');
    expect(eventLog).toContain('"type":"decision-opened"');
    expect(eventLog).toContain('"type":"operator-answered"');
    expect(eventLog).toContain('accept-auto-sync');
  });

  it('auto-sync preserves literal $-prefixed substrings in upstream body (reviewer MAJOR)', () => {
    // Defense against String.replace's $&, $1, $`, $' interpretation in
    // rewriteTaskBodyAndAcs. The seed body already contains $1 / $&; the
    // upstream body differs by punctuation+case only (cosmetic-tier), so the
    // auto-sync path runs. Without the function-replacer fix, the $-tokens
    // resolve as backreferences and corrupt the body on write.
    const seedBody = 'Cost is $1 per call. Matched is $&.';
    const filePath = writeImportedTask({ id: 'IMP-1', body: seedBody });
    const upstreamBody = 'COST IS $1 PER CALL! MATCHED IS $&!';

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([makeUpstream({ body: upstreamBody })]),
    });
    expect(result.perTask[0].severity).toBe('cosmetic');
    expect(result.perTask[0].action).toBe('auto-sync-applied');

    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('$1');
    expect(after).toContain('$&');
    expect(after).toContain('COST IS $1 PER CALL!');
  });

  it('AC #4 + #5: high-severity (semantic) defers with 24h window and does NOT mutate the task', () => {
    const filePath = writeImportedTask({ id: 'IMP-1', status: 'In Progress' });
    const before = readFileSync(filePath, 'utf8');

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        makeUpstream({ body: 'COMPLETELY DIFFERENT BODY with rewritten content top to bottom.' }),
      ]),
    });
    expect(result.perTask[0].severity).toBe('semantic');
    expect(result.perTask[0].action).toBe('defer-24h-window-opened');
    expect(result.perTask[0].decisionId).toMatch(/^DEC-\d{4,}$/);

    // AC #5 — in-progress task body must be byte-identical after reconcile.
    expect(readFileSync(filePath, 'utf8')).toBe(before);

    // AC #6 — defer Decision is open (no operator-answered yet); default-on-silence pattern.
    const eventLog = readFileSync(resolveEventLogPath(workDir), 'utf8');
    const events = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const opened = events.filter((e: { type: string }) => e.type === 'decision-opened');
    const answered = events.filter((e: { type: string }) => e.type === 'operator-answered');
    expect(opened).toHaveLength(1);
    expect(answered).toHaveLength(0);
    // The defer Decision body references the 24h-override-window contract.
    expect(opened[0].body).toContain('24h');
    expect(opened[0].body).toContain('default-on-silence');
    expect(opened[0].body).toContain('NOT halted');
    // First option is the no-fork default per OQ-2.
    expect(opened[0].options[0].id).toBe('no-fork-accept-drift');
  });

  it('AC #4 + #5: high-severity (scope) defers with 24h window for an In Progress task', () => {
    const filePath = writeImportedTask({ id: 'IMP-2', status: 'In Progress' });
    const before = readFileSync(filePath, 'utf8');

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        makeUpstream({ acceptanceCriteria: ['returns 200', 'returns 401', 'NEW: returns 403'] }),
      ]),
    });
    expect(result.perTask[0].severity).toBe('scope');
    expect(result.perTask[0].action).toBe('defer-24h-window-opened');
    // AC #5 — file is unchanged.
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('AC #1 + #8: no-change drift is silent (no Decision emitted)', () => {
    writeImportedTask({ id: 'IMP-1' });
    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([makeUpstream()]),
    });
    expect(result.perTask[0].severity).toBe('no-change');
    expect(result.perTask[0].action).toBe('no-op');
    expect(result.perTask[0].decisionId).toBeNull();
    expect(existsSync(resolveEventLogPath(workDir))).toBe(false);
  });

  it('AC #8: removed-upstream marks superseded + emits Decision, never deletes', () => {
    const filePath = writeImportedTask({ id: 'IMP-1' });
    const result = reconcileSpec({
      workDir,
      // Upstream tasks.md exists but lacks T-001.
      readUpstream: upstreamReader([
        { taskId: 'T-999', title: 'Other task', body: '', acceptanceCriteria: [] },
      ]),
    });
    expect(result.perTask[0].severity).toBe('removed-upstream');
    expect(result.perTask[0].action).toBe('superseded-marker-added');
    expect(result.perTask[0].decisionId).toMatch(/^DEC-\d{4,}$/);

    expect(existsSync(filePath)).toBe(true); // never deletes
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('IMPORT-SPEC-RECONCILE:SUPERSEDED');
    expect(content).toContain('superseded');
  });

  it('AC #7: respects --task <id> filter and reports unknown ids', () => {
    writeImportedTask({ id: 'IMP-1', upstreamTaskId: 'T-001' });
    writeImportedTask({ id: 'IMP-2', upstreamTaskId: 'T-002' });
    const result = reconcileSpec({
      workDir,
      taskFilter: 'IMP-2',
      readUpstream: upstreamReader([
        makeUpstream({ taskId: 'T-001' }),
        makeUpstream({ taskId: 'T-002' }),
      ]),
    });
    expect(result.perTask).toHaveLength(1);
    expect(result.perTask[0].importedTaskId).toBe('IMP-2');
    expect(result.unknownFilterIds).toEqual([]);

    const miss = reconcileSpec({
      workDir,
      taskFilter: 'IMP-99',
      readUpstream: upstreamReader([makeUpstream()]),
    });
    expect(miss.perTask).toHaveLength(0);
    expect(miss.unknownFilterIds).toEqual(['IMP-99']);
  });

  it('AC #7: reads drift-handling severityThresholds from adopter-authoring.yaml', () => {
    // Override: defer cosmetic drift instead of auto-syncing.
    mkdirSync(join(workDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(workDir, '.ai-sdlc', 'adopter-authoring.yaml'),
      [
        'adopter-authoring:',
        '  drift-handling:',
        '    severityThresholds:',
        '      typoCosmetic: defer-24h-window',
        '      semanticScope: defer-24h-window',
      ].join('\n'),
      'utf8',
    );
    const filePath = writeImportedTask({ id: 'IMP-1' });
    const before = readFileSync(filePath, 'utf8');

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        // Punctuation/case-only diff → classifier returns cosmetic.
        makeUpstream({ body: 'Body line ONE!\nBody line TWO!' }),
      ]),
    });
    expect(result.perTask[0].severity).toBe('cosmetic');
    expect(result.perTask[0].action).toBe('defer-24h-window-opened');
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('AC #5: skips reconcile when upstream tasks.md is missing entirely (still emits removed-upstream Decisions)', () => {
    writeImportedTask({ id: 'IMP-1' });
    const result = reconcileSpec({
      workDir,
      readUpstream: () => null,
    });
    expect(result.perTask[0].severity).toBe('removed-upstream');
    expect(result.perTask[0].action).toBe('superseded-marker-added');
  });

  it('AC #1: produces an empty perTask list when no imported tasks exist', () => {
    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([]),
    });
    expect(result.perTask).toEqual([]);
    expect(result.unknownFilterIds).toEqual([]);
  });

  it('AC #8: parallel multi-task scenario produces one Decision per drifting task', () => {
    writeImportedTask({ id: 'IMP-1', upstreamTaskId: 'T-001' });
    writeImportedTask({
      id: 'IMP-2',
      upstreamTaskId: 'T-002',
      title: 'Add expiry check',
      body: 'Some body.',
      acs: ['tokens older than 1h return 401'],
    });
    writeImportedTask({
      id: 'IMP-3',
      upstreamTaskId: 'T-003',
      title: 'Untouched task',
      body: 'Body of T-003.',
      acs: ['ac-1'],
    });

    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        // T-001: cosmetic (auto-sync) — punctuation-only delta.
        makeUpstream({
          taskId: 'T-001',
          body: 'Body line ONE!\nBody line TWO!',
        }),
        // T-002: scope (defer) — AC count change.
        {
          taskId: 'T-002',
          title: 'Add expiry check',
          body: 'Some body.',
          acceptanceCriteria: ['tokens older than 1h return 401', 'NEW AC added'],
        },
        // T-003: no-change.
        {
          taskId: 'T-003',
          title: 'Untouched task',
          body: 'Body of T-003.',
          acceptanceCriteria: ['ac-1'],
        },
      ]),
    });
    expect(result.perTask).toHaveLength(3);
    const byId = Object.fromEntries(result.perTask.map((p) => [p.importedTaskId, p]));
    expect(byId['IMP-1'].severity).toBe('cosmetic');
    expect(byId['IMP-1'].action).toBe('auto-sync-applied');
    expect(byId['IMP-2'].severity).toBe('scope');
    expect(byId['IMP-2'].action).toBe('defer-24h-window-opened');
    expect(byId['IMP-3'].severity).toBe('no-change');
    expect(byId['IMP-3'].action).toBe('no-op');
  });

  it('honours injected scanImported (tests + future-proofing)', () => {
    const injected: ImportedTaskRecord[] = [
      {
        filePath: join(workDir, 'fake'),
        id: 'IMP-FAKE',
        status: 'To Do',
        featureId: 'x',
        upstreamTaskId: 'T-001',
        artifactPath: '.specify/x/tasks.md',
        snapshot: { title: 't', body: 'b', acceptanceCriteria: ['a1'] },
      },
    ];
    const result = reconcileSpec({
      workDir,
      scanImported: () => injected,
      readUpstream: () => null,
    });
    expect(result.perTask).toHaveLength(1);
    expect(result.perTask[0].severity).toBe('removed-upstream');
  });

  it('respects the Decision Catalog feature flag (off → no DEC-NNNN ids)', () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    writeImportedTask({ id: 'IMP-1' });
    const result = reconcileSpec({
      workDir,
      readUpstream: upstreamReader([
        makeUpstream({ body: 'COMPLETELY different body content here.' }),
      ]),
    });
    expect(result.perTask[0].severity).toBe('semantic');
    expect(result.perTask[0].action).toBe('defer-24h-window-opened');
    expect(result.perTask[0].decisionId).toBeNull();
    expect(existsSync(resolveEventLogPath(workDir))).toBe(false);
  });
});
