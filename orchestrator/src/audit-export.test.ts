import { describe, it, expect } from 'vitest';
import { exportAuditEntries, generateComplianceReport } from './audit-export.js';
import { createAuditLog } from '@ai-sdlc/reference';
import type { AuditEntry } from '@ai-sdlc/reference';

function makeEntries(): AuditEntry[] {
  const log = createAuditLog();
  log.record({
    actor: 'agent-1',
    action: 'execute',
    resource: 'pipeline/build',
    decision: 'allowed',
  });
  log.record({
    actor: 'agent-2',
    action: 'deploy',
    resource: 'pipeline/deploy',
    decision: 'allowed',
  });
  log.record({
    actor: 'admin',
    action: 'override',
    resource: 'gate/quality',
    decision: 'overridden',
  });
  return [...log.entries()];
}

describe('exportAuditEntries', () => {
  it('exports as JSON', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, { format: 'json' });

    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].actor).toBe('agent-1');
    expect(parsed[0].hash).toBeTruthy(); // integrity included by default
  });

  it('exports as JSON without integrity fields', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, { format: 'json', includeIntegrity: false });

    const parsed = JSON.parse(result);
    expect(parsed[0].hash).toBeUndefined();
    expect(parsed[0].previousHash).toBeUndefined();
  });

  it('exports as JSONL', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, { format: 'jsonl' });

    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first.actor).toBe('agent-1');
  });

  it('exports as CSV', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, { format: 'csv' });

    const lines = result.split('\n');
    expect(lines[0]).toBe('id,timestamp,actor,action,resource,decision,hash,previousHash');
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[1]).toContain('agent-1');
  });

  it('exports CSV without integrity fields', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, { format: 'csv', includeIntegrity: false });

    const lines = result.split('\n');
    expect(lines[0]).toBe('id,timestamp,actor,action,resource,decision');
  });

  it('applies filter before export', () => {
    const entries = makeEntries();
    const result = exportAuditEntries(entries, {
      format: 'json',
      filter: { actor: 'agent-1' },
    });

    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].actor).toBe('agent-1');
  });

  it('CSV escapes values with commas', () => {
    const log = createAuditLog();
    log.record({
      actor: 'agent,special',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    });

    const result = exportAuditEntries(log.entries(), { format: 'csv' });
    const lines = result.split('\n');
    expect(lines[1]).toContain('"agent,special"');
  });
});

describe('generateComplianceReport', () => {
  it('generates a compliance report', () => {
    const auditLog = createAuditLog();
    auditLog.record({
      actor: 'agent-1',
      action: 'execute',
      resource: 'pipeline/build',
      decision: 'allowed',
    });
    auditLog.record({
      actor: 'agent-2',
      action: 'deploy',
      resource: 'pipeline/deploy',
      decision: 'allowed',
    });
    auditLog.record({
      actor: 'admin',
      action: 'override',
      resource: 'gate/quality',
      decision: 'overridden',
    });

    const report = generateComplianceReport({
      title: 'Q1 Audit Report',
      auditLog,
    });

    expect(report.title).toBe('Q1 Audit Report');
    expect(report.entryCount).toBe(3);
    expect(report.actorSummary['agent-1']).toBe(1);
    expect(report.actorSummary['admin']).toBe(1);
    expect(report.actionSummary['execute']).toBe(1);
    expect(report.actionSummary['deploy']).toBe(1);
    expect(report.decisionSummary['allowed']).toBe(2);
    expect(report.decisionSummary['overridden']).toBe(1);
    expect(report.generatedAt).toBeTruthy();
    expect(report.entries).toHaveLength(3);
  });

  it('applies filter to report', () => {
    const auditLog = createAuditLog();
    auditLog.record({ actor: 'agent-1', action: 'execute', resource: 'r', decision: 'allowed' });
    auditLog.record({ actor: 'agent-2', action: 'execute', resource: 'r', decision: 'denied' });

    const report = generateComplianceReport({
      title: 'Filtered Report',
      auditLog,
      filter: { decision: 'denied' },
    });

    expect(report.entryCount).toBe(1);
    expect(report.decisionSummary['denied']).toBe(1);
  });

  it('includes integrity verification when requested', () => {
    const auditLog = createAuditLog();
    auditLog.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    const report = generateComplianceReport({
      title: 'Integrity Report',
      auditLog,
      verifyIntegrity: true,
    });

    expect(report.integrityResult).toBeDefined();
    expect(report.integrityResult!.valid).toBe(true);
  });

  it('omits integrity when not requested', () => {
    const auditLog = createAuditLog();
    auditLog.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    const report = generateComplianceReport({
      title: 'No Integrity',
      auditLog,
    });

    expect(report.integrityResult).toBeUndefined();
  });
});
