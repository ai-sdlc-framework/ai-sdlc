/**
 * DoR decision-point moment (AISDLC-785 / RFC-0053 surfacing protocol, moment 5).
 *
 * Before dispatch, the DoR gate asks retrieval for open questions and
 * contradictions on the task's references and body, then files each one in
 * the Decision Catalog (RFC-0035) with a `contextRef` back to the knowledge
 * entry and emits a `DorDecisionPointRouted` event per routed finding.
 *
 * The engine blocks nothing: this module never changes the DoR verdict. A
 * retrieval failure or an empty index yields an empty result. A task with
 * `blocked.reason` (the upstream-OQ gate override) is not routed.
 */

import { join } from 'node:path';
import { loadKnowledgeConfig } from '../knowledge/config.js';
import { readEntries } from '../knowledge/store.js';
import { queryIndex } from '../knowledge/retrieval/service.js';
import {
  decisionCatalogDisabledMessage,
  isDecisionCatalogEnabled,
} from '../decisions/feature-flag.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  nextDecisionId,
  withEventLogLock,
  type ReadEventsOpts,
} from '../decisions/event-log.js';
import { listDecisions } from '../decisions/projection.js';
import type { DecisionOption } from '../decisions/decision-record.js';
import {
  extractBlockedReason,
  extractRfcIdsFromBody,
  extractRfcReferences,
} from './upstream-oq-gate.js';

export type DecisionPointKind = 'open-question' | 'contradiction';

export interface DecisionPointFinding {
  kind: DecisionPointKind;
  /** Knowledge entry id the finding came from. */
  entryId: string;
  summary: string;
  citations: string[];
}

/** Retrieval seam: a stub index in tests, the sqlite index by default. */
export type DecisionPointRetrieval = (query: string) => Promise<DecisionPointFinding[]>;

export interface DorDecisionPointRoutedEvent {
  eventType: 'DorDecisionPointRouted';
  taskId: string;
  kind: DecisionPointKind;
  entryId: string;
  decisionId: string;
  contextRef: string;
}

export interface DecisionPointInput {
  taskId: string;
  frontmatter: string;
  body: string;
  workDir: string;
  retrieval?: DecisionPointRetrieval;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  logOpts?: ReadEventsOpts;
}

export interface DecisionPointResult {
  findings: DecisionPointFinding[];
  routed: DorDecisionPointRoutedEvent[];
  skippedDuplicates: number;
  /** Why nothing was routed, when that is not simply "no findings". */
  skippedReason?: string;
}

export function decisionPointOptions(): DecisionOption[] {
  return [
    {
      id: 'provide-answer',
      description: 'Answer the question or resolve the contradiction before dispatch',
      consequences: ['Knowledge entry is updated or superseded', 'Task proceeds with the answer'],
    },
    {
      id: 'proceed-as-is',
      description: 'Acknowledge the finding and dispatch the task unchanged',
      consequences: ['Task dispatched; acknowledgement is recorded in the catalog'],
    },
  ];
}

export function buildRetrievalQuery(
  input: Pick<DecisionPointInput, 'frontmatter' | 'body'>,
): string {
  const refs = new Set<string>([
    ...extractRfcReferences(input.frontmatter),
    ...extractRfcIdsFromBody(input.body),
  ]);
  return [...refs, input.body].join(' ').trim();
}

/** Default retrieval: the sqlite index, with hits classified from the entries on disk. */
export function createDefaultRetrieval(projectRoot: string): DecisionPointRetrieval {
  return async (query) => {
    const hits = await queryIndex(projectRoot, { text: query });
    if (hits.length === 0) return [];
    const k = loadKnowledgeConfig(projectRoot);
    const entries = [k.trackedRoot, k.protectedRoot].flatMap((r) =>
      readEntries(join(projectRoot, r)),
    );
    const byId = new Map(entries.map((e) => [e.id, e]));
    const out: DecisionPointFinding[] = [];
    for (const h of hits) {
      const e = byId.get(h.id);
      if (!e) continue;
      const kind: DecisionPointKind | null = e.relations.some((r) => r.type === 'contradicts')
        ? 'contradiction'
        : e.type === 'question'
          ? 'open-question'
          : null;
      if (kind) out.push({ kind, entryId: e.id, summary: e.value, citations: h.citations });
    }
    return out;
  };
}

export async function routeDecisionPoint(input: DecisionPointInput): Promise<DecisionPointResult> {
  const empty: DecisionPointResult = { findings: [], routed: [], skippedDuplicates: 0 };
  if (extractBlockedReason(input.frontmatter) !== null) {
    return { ...empty, skippedReason: 'blocked.reason override' };
  }
  const env = input.env ?? process.env;
  if (!isDecisionCatalogEnabled(env)) {
    return { ...empty, skippedReason: decisionCatalogDisabledMessage() };
  }
  let findings: DecisionPointFinding[];
  try {
    const retrieval = input.retrieval ?? createDefaultRetrieval(input.workDir);
    findings = await retrieval(buildRetrievalQuery(input));
  } catch (err) {
    return { ...empty, skippedReason: `retrieval failed: ${(err as Error).message}` };
  }
  if (findings.length === 0) return empty;

  const logOpts: ReadEventsOpts = input.logOpts ?? { workDir: input.workDir };
  const scope = `issue:${input.taskId}`;
  const routed: DorDecisionPointRoutedEvent[] = [];
  let skippedDuplicates = 0;
  try {
    withEventLogLock(logOpts, () => {
      const seen = new Set(
        listDecisions(logOpts)
          .decisions.filter((d) => d.metadata.scope === scope)
          .map((d) => `${d.spec.contextRef ?? ''}|${d.spec.summary}`),
      );
      for (const f of findings) {
        const contextRef = `knowledge:${f.entryId}`;
        const summary = `[${f.kind}] ${f.summary}`;
        if (seen.has(`${contextRef}|${summary}`)) {
          skippedDuplicates += 1;
          continue;
        }
        const decisionId = nextDecisionId(logOpts);
        appendDecisionEvent(
          makeDecisionOpenedEvent({
            decisionId,
            source: f.kind === 'open-question' ? 'rfc-open-question' : 'emergent-finding',
            scope,
            summary,
            body:
              `Surfaced at the DoR decision point for \`${input.taskId}\` from knowledge entry ` +
              `\`${f.entryId}\`` +
              (f.citations.length ? ` (sources: ${f.citations.join(', ')})` : '') +
              '.',
            reversible: true,
            options: decisionPointOptions(),
            contextRef,
            now: input.now,
          }),
          logOpts,
        );
        seen.add(`${contextRef}|${summary}`);
        routed.push({
          eventType: 'DorDecisionPointRouted',
          taskId: input.taskId,
          kind: f.kind,
          entryId: f.entryId,
          decisionId,
          contextRef,
        });
      }
    });
  } catch (err) {
    return {
      findings,
      routed,
      skippedDuplicates,
      skippedReason: `routing failed: ${(err as Error).message}`,
    };
  }
  return { findings, routed, skippedDuplicates };
}
