import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuditScheduler } from './audit-scheduler.js';
import { createAuditLog } from '@ai-sdlc/reference';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('AuditScheduler', () => {
  it('starts and stops cleanly', () => {
    const auditLog = createAuditLog();
    const scheduler = createAuditScheduler({ auditLog });

    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it('runs integrity checks on interval', () => {
    const auditLog = createAuditLog();
    auditLog.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    const onSuccess = vi.fn();
    const scheduler = createAuditScheduler({
      auditLog,
      verifyIntervalMs: 1000,
      onIntegritySuccess: onSuccess,
    });

    scheduler.start();

    vi.advanceTimersByTime(3500);

    expect(onSuccess).toHaveBeenCalledTimes(3);
    expect(scheduler.checkCount).toBe(3);

    scheduler.stop();
  });

  it('calls onIntegrityFailure when chain is broken', () => {
    // Create a mock audit log with a failing integrity check
    const mockLog = {
      record: vi.fn(),
      entries: () => [],
      query: () => [],
      verifyIntegrity: () => ({ valid: false, brokenAt: 2 }),
    };

    const onFailure = vi.fn();
    const scheduler = createAuditScheduler({
      auditLog: mockLog,
      verifyIntervalMs: 500,
      onIntegrityFailure: onFailure,
    });

    scheduler.start();
    vi.advanceTimersByTime(600);

    expect(onFailure).toHaveBeenCalledWith({ valid: false, brokenAt: 2 });

    scheduler.stop();
  });

  it('performs manual integrity check', () => {
    const auditLog = createAuditLog();
    auditLog.record({ actor: 'a', action: 'x', resource: 'r', decision: 'allowed' });

    const scheduler = createAuditScheduler({ auditLog });

    const result = scheduler.verify();

    expect(result.valid).toBe(true);
    expect(scheduler.checkCount).toBe(1);
  });

  it('triggers key rotation on interval', () => {
    const auditLog = createAuditLog();
    const onRotation = vi.fn();

    const scheduler = createAuditScheduler({
      auditLog,
      verifyIntervalMs: 10_000,
      rotationIntervalMs: 2000,
      onRotation,
    });

    scheduler.start();
    vi.advanceTimersByTime(5000);

    expect(onRotation).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('does not start rotation timer if interval is 0', () => {
    const auditLog = createAuditLog();
    const onRotation = vi.fn();

    const scheduler = createAuditScheduler({
      auditLog,
      rotationIntervalMs: 0,
      onRotation,
    });

    scheduler.start();
    vi.advanceTimersByTime(100_000);

    expect(onRotation).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('is idempotent on start/stop', () => {
    const auditLog = createAuditLog();
    const scheduler = createAuditScheduler({ auditLog });

    scheduler.start();
    scheduler.start(); // double start
    expect(scheduler.running).toBe(true);

    scheduler.stop();
    scheduler.stop(); // double stop
    expect(scheduler.running).toBe(false);
  });
});
