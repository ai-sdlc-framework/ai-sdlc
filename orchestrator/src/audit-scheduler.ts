/**
 * Periodic audit integrity verification and key rotation scheduler.
 */

import type { AuditLog, IntegrityResult } from '@ai-sdlc/reference';

export interface AuditSchedulerConfig {
  /** Audit log to verify. */
  auditLog: AuditLog;
  /** Interval in ms between integrity checks (defaults to 60000). */
  verifyIntervalMs?: number;
  /** Callback when integrity check fails. */
  onIntegrityFailure?: (result: IntegrityResult) => void;
  /** Callback when integrity check succeeds. */
  onIntegritySuccess?: (result: IntegrityResult) => void;
  /** Optional key rotation callback (called on rotation interval). */
  onRotation?: () => void;
  /** Interval in ms between key rotations (0 = disabled). */
  rotationIntervalMs?: number;
}

export interface AuditScheduler {
  /** Start the scheduler. */
  start(): void;
  /** Stop the scheduler. */
  stop(): void;
  /** Run a manual integrity check. */
  verify(): IntegrityResult;
  /** Whether the scheduler is currently running. */
  readonly running: boolean;
  /** Number of checks performed. */
  readonly checkCount: number;
}

export function createAuditScheduler(config: AuditSchedulerConfig): AuditScheduler {
  const verifyIntervalMs = config.verifyIntervalMs ?? 60_000;
  const rotationIntervalMs = config.rotationIntervalMs ?? 0;

  let verifyTimer: ReturnType<typeof setInterval> | null = null;
  let rotationTimer: ReturnType<typeof setInterval> | null = null;
  let _running = false;
  let _checkCount = 0;

  function verify(): IntegrityResult {
    _checkCount++;
    const result = config.auditLog.verifyIntegrity();
    if (result.valid) {
      config.onIntegritySuccess?.(result);
    } else {
      config.onIntegrityFailure?.(result);
    }
    return result;
  }

  return {
    start() {
      if (_running) return;
      _running = true;

      verifyTimer = setInterval(verify, verifyIntervalMs);

      if (rotationIntervalMs > 0 && config.onRotation) {
        rotationTimer = setInterval(config.onRotation, rotationIntervalMs);
      }
    },

    stop() {
      _running = false;
      if (verifyTimer) {
        clearInterval(verifyTimer);
        verifyTimer = null;
      }
      if (rotationTimer) {
        clearInterval(rotationTimer);
        rotationTimer = null;
      }
    },

    verify,

    get running() {
      return _running;
    },

    get checkCount() {
      return _checkCount;
    },
  };
}
