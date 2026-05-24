/**
 * Failure-mode emitters for the spec-kit import path.
 *
 * RFC-0036 OQ-1 (incomplete spec) + OQ-11 (unknown schema) both route
 * through RFC-0035's Decision Catalog: emit a `decision-opened` event
 * AND create a clarification task in the backlog so the operator's next
 * triage pass sees the failure surface. Phase 4 stops at this surface —
 * the eventual auto-resolution wires in when RFC-0035 Phase 1 ships
 * (catalog Stage A/B/C classification).
 *
 * Both emitters are non-blocking by design: the import path keeps
 * running on whatever else IS dispatchable. Compositional with RFC-0035
 * G0 (non-blocking pipeline contract).
 *
 * @module import-spec/decisions
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendDecisionEvent,
  isDecisionCatalogEnabled,
  makeDecisionOpenedEvent,
  nextDecisionId,
  withEventLogLock,
} from '../decisions/index.js';

import { nextTaskNumber, slugify } from './task-writer.js';

export interface IncompleteSpecArgs {
  workDir: string;
  /** Path the operator passed to `--from`. */
  fromPath: string;
  /** Why the spec was incomplete (e.g. `tasks.md missing`). */
  reason: string;
}

export interface UnknownSchemaArgs {
  workDir: string;
  /** Path the operator passed to `--from`. */
  fromPath: string;
  /** Path of the `tasks.md` whose schema couldn't be recognised. */
  tasksMdPath: string;
}

export interface DecisionEmitOutcome {
  /** Allocated DEC-NNNN id, or null when the catalog feature flag is off. */
  decisionId: string | null;
  /** Backlog task created as the clarification ask, or null on skip. */
  clarificationTaskFile: string | null;
}

/**
 * Emit `Decision: incomplete-spec-detected` per OQ-1 — spec-kit project
 * lacking `tasks.md`. Creates the catalog event + a backlog clarification
 * task asking the operator to run `/speckit.tasks` upstream and re-import.
 */
export function emitIncompleteSpecDecision(args: IncompleteSpecArgs): DecisionEmitOutcome {
  const summary = `Spec-kit import: incomplete spec at ${args.fromPath}`;
  const body = [
    `\`cli-import-spec\` was asked to import from \`${args.fromPath}\` but the upstream`,
    `spec-kit project is incomplete: ${args.reason}.`,
    '',
    `Per RFC-0036 OQ-1 the bridge reads \`tasks.md\` ONLY — no fallback to \`spec.md\`.`,
    `Selected over fallback because incomplete-spec fallbacks cause incomplete implementations,`,
    `the exact failure mode the framework's quality contract prevents.`,
    '',
    `Recommended upstream action: run \`/speckit.tasks\` in the spec-kit project and re-run`,
    `\`cli-import-spec --from ${args.fromPath}\`.`,
  ].join('\n');

  return emitImportDecision({
    workDir: args.workDir,
    decisionScope: `import-spec:${args.fromPath}`,
    decisionSummary: summary,
    decisionBody: body,
    options: [
      {
        id: 'opt-rerun-speckit-tasks',
        description: 'Run /speckit.tasks upstream and re-import',
      },
      {
        id: 'opt-abandon-import',
        description: 'Abandon this import (upstream is not yet ready)',
      },
    ],
    clarificationTitle: `Spec-kit incomplete spec: run /speckit.tasks for ${args.fromPath}`,
    clarificationBody: [
      `# Upstream clarification needed`,
      '',
      `\`cli-import-spec --from ${args.fromPath}\` could not proceed because:`,
      '',
      `> ${args.reason}`,
      '',
      `Action: run \`/speckit.tasks\` in the upstream spec-kit project to produce`,
      `\`tasks.md\`, then re-run the import.`,
      '',
      `Filed by RFC-0036 Phase 4 (AISDLC-329).`,
    ].join('\n'),
    clarificationLabels: ['spec-kit-bridge', 'upstream-clarification', 'incomplete-spec'],
  });
}

/**
 * Emit `Decision: upstream-schema-unknown` per OQ-11 — `tasks.md` exists
 * but its layout doesn't match any spec-kit schema the parser recognises.
 * Creates the catalog event + a backlog upgrade-framework task asking the
 * operator to bump ai-sdlc support for the new spec-kit version.
 */
export function emitUnknownSchemaDecision(args: UnknownSchemaArgs): DecisionEmitOutcome {
  const summary = `Spec-kit import: unknown schema in ${args.tasksMdPath}`;
  const body = [
    `\`cli-import-spec\` could not auto-detect the spec-kit schema for`,
    `\`${args.tasksMdPath}\`.`,
    '',
    `Per RFC-0036 OQ-11 the bridge refuses unknown formats — strict default,`,
    `routed through the Decision Catalog so it never blocks the pipeline.`,
    '',
    `Recommended action: confirm the upstream spec-kit version, then upgrade`,
    `ai-sdlc's parser (\`pipeline-cli/src/import-spec/parser.ts\`) to recognise`,
    `the new layout.`,
  ].join('\n');

  return emitImportDecision({
    workDir: args.workDir,
    decisionScope: `import-spec:${args.fromPath}`,
    decisionSummary: summary,
    decisionBody: body,
    options: [
      {
        id: 'opt-upgrade-parser',
        description: 'Upgrade ai-sdlc parser to support the new spec-kit version',
      },
      {
        id: 'opt-pin-spec-kit-version',
        description: 'Pin the upstream spec-kit project to a supported version',
      },
    ],
    clarificationTitle: `Upgrade ai-sdlc parser: spec-kit schema unknown at ${args.tasksMdPath}`,
    clarificationBody: [
      `# Upgrade ai-sdlc to support newer spec-kit`,
      '',
      `\`cli-import-spec\` could not auto-detect the spec-kit schema at`,
      `\`${args.tasksMdPath}\`.`,
      '',
      `Action: extend \`pipeline-cli/src/import-spec/parser.ts\` with a new`,
      `\`SpecKitSchemaVersion\` branch covering the upstream layout.`,
      '',
      `Filed by RFC-0036 Phase 4 (AISDLC-329).`,
    ].join('\n'),
    clarificationLabels: ['spec-kit-bridge', 'upgrade-framework', 'upstream-schema-unknown'],
  });
}

// ── Shared helper ────────────────────────────────────────────────────────────

interface EmitImportDecisionArgs {
  workDir: string;
  decisionScope: string;
  decisionSummary: string;
  decisionBody: string;
  options: { id: string; description: string }[];
  clarificationTitle: string;
  clarificationBody: string;
  clarificationLabels: string[];
}

function emitImportDecision(args: EmitImportDecisionArgs): DecisionEmitOutcome {
  let decisionId: string | null = null;
  if (isDecisionCatalogEnabled()) {
    withEventLogLock({ workDir: args.workDir }, () => {
      const id = nextDecisionId({ workDir: args.workDir });
      const event = makeDecisionOpenedEvent({
        decisionId: id,
        source: 'subagent-escalation',
        scope: args.decisionScope,
        summary: args.decisionSummary,
        body: args.decisionBody,
        options: args.options,
      });
      appendDecisionEvent(event, { workDir: args.workDir });
      decisionId = id;
    });
  }

  const clarificationTaskFile = writeClarificationTask(
    args.workDir,
    args.clarificationTitle,
    args.clarificationBody,
    args.clarificationLabels,
  );

  return { decisionId, clarificationTaskFile };
}

function writeClarificationTask(
  workDir: string,
  title: string,
  body: string,
  labels: string[],
): string {
  const prefix = 'IMPCLARIFY';
  const num = nextTaskNumber(workDir, prefix);
  const id = `${prefix}-${num}`;
  const tasksDir = join(workDir, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const fileName = `${id.toLowerCase()} - ${slugify(title)}.md`;
  const filePath = join(tasksDir, fileName);
  const content = [
    '---',
    `id: ${id}`,
    `title: ${title.includes(':') ? `'${title.replace(/'/g, "''")}'` : title}`,
    "status: 'To Do'",
    'assignee: []',
    'labels:',
    ...labels.map((l) => `  - ${l}`),
    'dependencies: []',
    'references: []',
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}
