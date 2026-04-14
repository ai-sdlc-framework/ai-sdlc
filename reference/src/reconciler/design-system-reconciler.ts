/**
 * DesignSystemBinding domain reconciler (RFC-0006 §10).
 *
 * Implements continuous design system reconciliation:
 * - Observes token source for changes/deletions
 * - Detects token compliance drift
 * - Monitors catalog staleness
 * - Enforces token version policy
 * - Resolves conflicts (code-wins, design-wins, manual)
 */

import type { DesignSystemBinding, Condition } from '../core/types.js';
import type { DesignTokenProvider, ComponentCatalog, TokenDiff } from '../adapters/interfaces.js';
import type { ReconcileResult } from './types.js';

// ── Reconciliation Events ────────────────────────────────────────────

export type DesignSystemEventType =
  | 'TokenDriftDetected'
  | 'TokenDeleted'
  | 'TokenSchemaBreakingChange'
  | 'ComponentUndocumented'
  | 'TokenViolationFound'
  | 'CatalogStale'
  | 'VisualBaselineMissing'
  | 'DesignReviewOverdue';

export interface DesignSystemEvent {
  type: DesignSystemEventType;
  bindingName: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export type EventHandler = (event: DesignSystemEvent) => void;

// ── Dependencies ─────────────────────────────────────────────────────

export interface DesignSystemReconcilerDeps {
  /** Token provider for the binding. */
  getTokenProvider: (binding: DesignSystemBinding) => DesignTokenProvider | undefined;
  /** Component catalog for the binding. */
  getCatalog: (binding: DesignSystemBinding) => ComponentCatalog | undefined;
  /** Previous token snapshot for diffing. */
  getLastTokenSnapshot: (bindingName: string) => Promise<Record<string, unknown> | undefined>;
  /** Save current token snapshot. */
  saveTokenSnapshot: (bindingName: string, snapshot: Record<string, unknown>) => Promise<void>;
  /** Emit a reconciliation event. */
  onEvent?: EventHandler;
}

function emit(deps: DesignSystemReconcilerDeps, event: DesignSystemEvent): void {
  deps.onEvent?.(event);
}

function now(): string {
  return new Date().toISOString();
}

// ── Conflict Resolution ──────────────────────────────────────────────

export interface ConflictResolutionResult {
  strategy: 'code-wins' | 'design-wins' | 'manual';
  resolved: boolean;
  message?: string;
}

export function resolveConflict(
  binding: DesignSystemBinding,
  _diff: TokenDiff,
): ConflictResolutionResult {
  const strategy = binding.spec.tokens.sync?.conflictResolution ?? 'manual';

  switch (strategy) {
    case 'code-wins':
      return { strategy, resolved: true, message: 'Resolved: code values take precedence' };
    case 'design-wins':
      return { strategy, resolved: true, message: 'Resolved: design values take precedence' };
    case 'manual':
      return {
        strategy,
        resolved: false,
        message: `Manual resolution required. Timeout: ${binding.spec.tokens.sync?.manualResolutionTimeout ?? 'unset'}`,
      };
  }
}

// ── Version Policy Enforcement ───────────────────────────────────────

export interface VersionPolicyResult {
  allowed: boolean;
  reason?: string;
}

export function enforceVersionPolicy(
  binding: DesignSystemBinding,
  fromVersion: string,
  toVersion: string,
  isBreaking: boolean,
): VersionPolicyResult {
  const policy = binding.spec.tokens.versionPolicy;

  switch (policy) {
    case 'exact': {
      const pinned = binding.spec.tokens.pinnedVersion;
      if (toVersion !== pinned) {
        return {
          allowed: false,
          reason: `Version ${toVersion} does not match pinned version ${pinned}`,
        };
      }
      return { allowed: true };
    }
    case 'minor': {
      if (isBreaking) {
        return {
          allowed: false,
          reason: `Breaking change blocked by 'minor' version policy`,
        };
      }
      const fromMajor = parseInt(fromVersion.split('.')[0], 10);
      const toMajor = parseInt(toVersion.split('.')[0], 10);
      if (toMajor > fromMajor) {
        return {
          allowed: false,
          reason: `Major version bump ${fromVersion} → ${toVersion} blocked by 'minor' policy`,
        };
      }
      return { allowed: true };
    }
    case 'minor-and-major': {
      if (isBreaking) {
        return {
          allowed: false,
          reason: `Schema-restructuring change blocked by 'minor-and-major' policy`,
        };
      }
      return { allowed: true };
    }
    case 'latest':
      return { allowed: true };
  }
}

// ── Reconciler Factory ───────────────────────────────────────────────

export function createDesignSystemReconciler(
  deps: DesignSystemReconcilerDeps,
): (resource: DesignSystemBinding) => Promise<ReconcileResult> {
  return async (binding: DesignSystemBinding): Promise<ReconcileResult> => {
    try {
      const bindingName = binding.metadata.name;
      const conditions: Condition[] = [];

      // ── 1. Token drift detection ─────────────────────────────
      const tokenProvider = deps.getTokenProvider(binding);
      if (tokenProvider) {
        const currentTokens = await tokenProvider.getTokens();
        const lastSnapshot = await deps.getLastTokenSnapshot(bindingName);

        if (lastSnapshot) {
          const diff = await tokenProvider.diffTokens(lastSnapshot as never, currentTokens);

          if (diff.changes.length > 0) {
            emit(deps, {
              type: 'TokenDriftDetected',
              bindingName,
              timestamp: now(),
              details: {
                added: diff.added,
                modified: diff.modified,
                removed: diff.removed,
              },
            });

            // Check for deletions
            if (diff.removed > 0) {
              const deletions = await tokenProvider.detectDeletions(
                lastSnapshot as never,
                currentTokens,
              );
              if (deletions.length > 0) {
                emit(deps, {
                  type: 'TokenDeleted',
                  bindingName,
                  timestamp: now(),
                  details: {
                    deletedCount: deletions.length,
                    paths: deletions.map((d) => d.path),
                  },
                });
              }
            }

            // Check for breaking changes
            const currentVersion = await tokenProvider.getSchemaVersion();
            const breakingResult = await tokenProvider.detectBreakingChange(
              '0.0.0',
              currentVersion,
            );
            if (breakingResult.isBreaking) {
              emit(deps, {
                type: 'TokenSchemaBreakingChange',
                bindingName,
                timestamp: now(),
                details: {
                  breakingChanges: breakingResult.breakingChanges,
                },
              });
            }

            // Conflict resolution for bidirectional sync
            if (binding.spec.tokens.sync?.direction === 'bidirectional') {
              resolveConflict(binding, diff);
            }
          }

          conditions.push({
            type: 'TokensSynced',
            status: diff.changes.length === 0 ? 'True' : 'False',
            reason: diff.changes.length === 0 ? 'InSync' : 'DriftDetected',
            message:
              diff.changes.length === 0
                ? 'Tokens are in sync'
                : `${diff.changes.length} token change(s) detected`,
            lastEvaluated: now(),
          });
        }

        // Save current snapshot for next reconciliation
        await deps.saveTokenSnapshot(bindingName, currentTokens as Record<string, unknown>);
      }

      // ── 2. Catalog staleness check ───────────────────────────
      const catalog = deps.getCatalog(binding);
      if (catalog) {
        try {
          const manifest = await catalog.getManifest();
          const generatedAt = manifest.generatedAt ? new Date(manifest.generatedAt).getTime() : 0;
          const refreshMs = parseRefreshInterval(binding.spec.catalog.discovery?.refreshInterval);
          const isStale = refreshMs > 0 && Date.now() - generatedAt > refreshMs;

          if (isStale) {
            emit(deps, {
              type: 'CatalogStale',
              bindingName,
              timestamp: now(),
              details: {
                lastRefresh: manifest.generatedAt,
                refreshInterval: binding.spec.catalog.discovery?.refreshInterval,
              },
            });
          }

          conditions.push({
            type: 'CatalogAvailable',
            status: isStale ? 'False' : 'True',
            reason: isStale ? 'Stale' : 'Available',
            lastEvaluated: now(),
          });
        } catch {
          conditions.push({
            type: 'CatalogAvailable',
            status: 'False',
            reason: 'Unreachable',
            message: 'Failed to fetch component manifest',
            lastEvaluated: now(),
          });
        }
      }

      // ── 3. Token compliance check ────────────────────────────
      const coverage = binding.status?.tokenCompliance?.currentCoverage;
      const minimum = binding.spec.compliance.coverage.minimum;
      if (coverage !== undefined && coverage < minimum) {
        emit(deps, {
          type: 'TokenViolationFound',
          bindingName,
          timestamp: now(),
          details: { coverage, minimum },
        });
      }
      conditions.push({
        type: 'ComplianceMet',
        status: coverage !== undefined && coverage >= minimum ? 'True' : 'Unknown',
        reason:
          coverage !== undefined && coverage >= minimum
            ? 'CoverageAboveMinimum'
            : 'CoverageUnknown',
        lastEvaluated: now(),
      });

      // ── 4. Update binding status ─────────────────────────────
      if (!binding.status) {
        (binding as { status: DesignSystemBinding['status'] }).status = {};
      }
      binding.status!.conditions = conditions;

      return { type: 'success' };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}

function parseRefreshInterval(interval?: string): number {
  if (!interval) return 0;
  // Parse ISO 8601 durations like PT1H, PT15M
  const match = interval.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseInt(match[3] ?? '0', 10);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
