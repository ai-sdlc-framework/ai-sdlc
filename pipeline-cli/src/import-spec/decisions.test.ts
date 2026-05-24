import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitIncompleteSpecDecision, emitUnknownSchemaDecision } from './decisions.js';
import { resolveEventLogPath } from '../decisions/event-log.js';

describe('emitIncompleteSpecDecision', () => {
  let workDir: string;
  let prevFlag: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'import-spec-decisions-'));
    prevFlag = process.env.AI_SDLC_DECISION_CATALOG;
    delete process.env.AI_SDLC_DECISION_CATALOG; // default-ON
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
    else process.env.AI_SDLC_DECISION_CATALOG = prevFlag;
  });

  it('appends a decision-opened event and writes a clarification task', () => {
    const out = emitIncompleteSpecDecision({
      workDir,
      fromPath: '.specify/specs/auth-feature/',
      reason: 'tasks.md missing',
    });
    expect(out.decisionId).toMatch(/^DEC-\d{4,}$/);
    expect(out.clarificationTaskFile).toBeTruthy();
    expect(existsSync(out.clarificationTaskFile!)).toBe(true);

    const taskContent = readFileSync(out.clarificationTaskFile!, 'utf8');
    expect(taskContent).toContain('id: IMPCLARIFY-1');
    expect(taskContent).toContain('incomplete-spec');
    expect(taskContent).toContain('spec-kit-bridge');
    expect(taskContent).toContain('/speckit.tasks');

    const eventLog = readFileSync(resolveEventLogPath(workDir), 'utf8');
    expect(eventLog).toContain('"type":"decision-opened"');
    expect(eventLog).toContain('"source":"subagent-escalation"');
    expect(eventLog).toContain('incomplete spec');
  });

  it('skips the Decision event but still writes a task when the catalog flag is off', () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    const out = emitIncompleteSpecDecision({
      workDir,
      fromPath: '.specify/specs/x/',
      reason: 'tasks.md missing',
    });
    expect(out.decisionId).toBeNull();
    expect(out.clarificationTaskFile).toBeTruthy();
    expect(existsSync(resolveEventLogPath(workDir))).toBe(false);
  });

  it('emitting twice allocates IMPCLARIFY-2 the second time', () => {
    const a = emitIncompleteSpecDecision({
      workDir,
      fromPath: 'a/',
      reason: 'missing',
    });
    const b = emitIncompleteSpecDecision({
      workDir,
      fromPath: 'b/',
      reason: 'missing',
    });
    expect(readFileSync(a.clarificationTaskFile!, 'utf8')).toContain('id: IMPCLARIFY-1');
    expect(readFileSync(b.clarificationTaskFile!, 'utf8')).toContain('id: IMPCLARIFY-2');
  });
});

describe('emitUnknownSchemaDecision', () => {
  let workDir: string;
  let prevFlag: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'import-spec-decisions-uschema-'));
    prevFlag = process.env.AI_SDLC_DECISION_CATALOG;
    delete process.env.AI_SDLC_DECISION_CATALOG;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
    else process.env.AI_SDLC_DECISION_CATALOG = prevFlag;
  });

  it('emits decision-opened + upgrade-framework clarification task', () => {
    const out = emitUnknownSchemaDecision({
      workDir,
      fromPath: '.specify/specs/x/',
      tasksMdPath: '.specify/specs/x/tasks.md',
    });
    expect(out.decisionId).toMatch(/^DEC-\d{4,}$/);
    const content = readFileSync(out.clarificationTaskFile!, 'utf8');
    expect(content).toContain('upgrade-framework');
    expect(content).toContain('upstream-schema-unknown');
    expect(content).toContain('parser.ts');
  });
});
