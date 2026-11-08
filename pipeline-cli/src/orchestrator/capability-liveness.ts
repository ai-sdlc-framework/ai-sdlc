/**
 * Capability liveness for the orchestrator tick (RFC-0049 section 9.3).
 *
 * Each tick: read the capabilities this repository requires from the base ref, and for
 * each one that is degraded or never observed file one Decision and emit a
 * `CapabilityDegraded` event. A capability gets at most one Decision per UTC day and none
 * while an earlier one is still open. Nothing is ever blocked: this function never throws
 * and the tick does not depend on its result.
 *
 * @module orchestrator/capability-liveness
 */

import {
  loadRequiredCapabilities,
  readCapabilityState,
  type CapabilityStateRow,
} from '@ai-sdlc/reference';
import {
  appendDecisionEvent,
  isDecisionCatalogEnabled,
  listDecisions,
  makeDecisionOpenedEvent,
  nextDecisionId,
  withEventLogLock,
  type DecisionOption,
} from '../decisions/index.js';
import { now as clockNow } from '../clock.js';
import { escapeForDecision } from './routing-revert.js';
import type { OrchestratorEvent } from './events.js';

/** Scope prefix of every capability Decision; the capability id follows. */
export const CAPABILITY_SCOPE_PREFIX = 'capability:';

const OPEN_LIFECYCLES = new Set(['proposed', 'open', 'deferred']);

const OPTIONS: DecisionOption[] = [
  {
    id: 'wire-capability',
    description: 'Configure the capability so it runs for real instead of its fallback',
    consequences: ['The capability reports live on its next run and this Decision stops recurring'],
  },
  {
    id: 'drop-requirement',
    description: 'Remove the capability from spec.required in .ai-sdlc/capabilities.yaml',
    consequences: [
      'The doctor check and this Decision stop covering it; the fallback keeps running',
    ],
  },
];

export interface CapabilityLivenessOpts {
  workDir: string;
  artifactsDir: string;
  emit: (event: Omit<OrchestratorEvent, 'ts'>) => void;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Test injection: the required capability ids. Defaults to the base-ref file. */
  readRequired?: () => string[];
  /** Test injection: the capability state rows. Defaults to the artifacts state file. */
  readState?: () => CapabilityStateRow[];
}

export interface CapabilityLivenessResult {
  /** Required capabilities that are degraded or never observed. */
  degraded: string[];
  /** Decision ids filed by this call. */
  filed: string[];
}

function decisionBody(row: { id: string; status: string; reason?: string }): string {
  const id = escapeForDecision(row.id);
  return [
    `Required capability \`${id}\` is ${row.status}.`,
    row.reason ? `Last degraded reason: ${escapeForDecision(row.reason)}.` : '',
    'Nothing is blocked: the capability runs its fallback. See docs/operations/capability-liveness.md.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Never throws. */
export function runCapabilityLiveness(opts: CapabilityLivenessOpts): CapabilityLivenessResult {
  const result: CapabilityLivenessResult = { degraded: [], filed: [] };
  try {
    const required = (
      opts.readRequired ?? (() => loadRequiredCapabilities({ workDir: opts.workDir }))
    )();
    if (required.length === 0) return result;
    const rows = (opts.readState ?? (() => readCapabilityState(opts.artifactsDir)))();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = opts.now ?? clockNow();
    const day = now.toISOString().slice(0, 10);
    const env = opts.env ?? process.env;

    for (const id of required) {
      const row = byId.get(id);
      const status = row?.status ?? 'never-observed';
      if (status !== 'degraded' && status !== 'never-observed') continue;
      result.degraded.push(id);
      if (!isDecisionCatalogEnabled(env)) continue;
      try {
        const scope = `${CAPABILITY_SCOPE_PREFIX}${id}`;
        const decisionId = withEventLogLock({ workDir: opts.workDir }, () => {
          const existing = listDecisions({ workDir: opts.workDir }).decisions.filter(
            (d) => d.metadata.scope === scope,
          );
          if (
            existing.some(
              (d) => OPEN_LIFECYCLES.has(d.status.lifecycle) || d.metadata.created.startsWith(day),
            )
          ) {
            return undefined;
          }
          const newId = nextDecisionId({ workDir: opts.workDir });
          appendDecisionEvent(
            makeDecisionOpenedEvent({
              decisionId: newId,
              source: 'framework-calibration',
              scope,
              summary: `Required capability ${escapeForDecision(id)} is ${status}`,
              body: decisionBody({ id, status, reason: row?.lastDegradedReason }),
              reversible: true,
              priority: 'low',
              options: OPTIONS,
              by: 'framework:capability-liveness',
              now,
            }),
            { workDir: opts.workDir },
          );
          return newId;
        });
        if (decisionId) {
          result.filed.push(decisionId);
          opts.emit({
            type: 'CapabilityDegraded',
            capabilityId: id,
            capabilityStatus: status,
            ...(row?.lastDegradedReason ? { reason: row.lastDegradedReason } : {}),
          });
        }
      } catch {
        // Decision filing is best effort; the next tick tries again.
      }
    }
  } catch {
    // Liveness reporting never disturbs the tick.
  }
  return result;
}
