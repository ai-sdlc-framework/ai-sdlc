#!/usr/bin/env node
/**
 * CLI entry point for issue admission scoring.
 *
 * Scores an issue (GitHub or Backlog.md) using the Product Priority
 * Algorithm (RFC-0008 §A.6 admission-subset composite) and outputs a
 * JSON verdict indicating whether it should enter the pipeline.
 *
 * GitHub usage:
 *   admit --title "..." --body-file /tmp/body.txt --issue-number 42 \
 *     --labels '["bug"]' --reactions 3 --comments 2 --created-at 2026-01-01T00:00:00Z
 *
 * Backlog usage:
 *   admit --tracker backlog --task-id AISDLC-42 [--config-root /repo]
 *   admit --tracker backlog --task-file /path/to/aisdlc-42.md
 *
 * Optional RFC-0008 flags (stateless by default):
 *   --enrich-from-state              Load .ai-sdlc/ config + state store,
 *                                     resolve refs, and populate enrichment
 *                                     context (C2/C3/C4/C5).
 *   --config-root <path>              Override the directory whose .ai-sdlc/
 *                                     and state.db are consulted. Defaults
 *                                     to a walk-up from --body-file or cwd.
 *   --design-system-ref <name>        Override DSB selection by name.
 *   --autonomy-policy-ref <name>      Override AutonomyPolicy selection.
 *   --did-ref <name>                  Override DesignIntentDocument selection.
 *   --author-login <handle>           Issue author handle (C5 match).
 *   --code-area <path>                Code area identifier (C3 lookup).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_CONFIG_DIR_NAME,
  loadBacklogTaskFromRoot,
  loadConfigAsync,
  loadSoulTracks,
  mapBacklogTaskToAdmissionInput,
  parseBacklogTask,
  resolveRepoRoot,
  scoreIssueForAdmission,
  enrichAdmissionInput,
  StateStore,
  type AdmissionInput,
  type AdmissionThresholds,
  type BacklogAdmissionMapping,
  type EnrichmentContext,
} from '@ai-sdlc/orchestrator';
import type {
  AutonomyPolicy,
  DesignIntentDocument,
  DesignSystemBinding,
  PriorityInput,
} from '@ai-sdlc/reference';
import { assertSafeReadPath, UnsafePathError } from './safe-path.js';

// ── Arg parsing ──────────────────────────────────────────────────────

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.indexOf(flag) !== -1;
}

type Tracker = 'github' | 'backlog' | 'auto';

interface AdmitArgs {
  tracker: Tracker;
  title?: string;
  body: string;
  bodyFile?: string;
  taskId?: string;
  taskFile?: string;
  issueNumber?: number;
  labels: string[];
  reactions: number;
  comments: number;
  createdAt?: string;
  authorAssociation: string;
  authorLogin?: string;
  codeArea?: string;
  enrichFromState: boolean;
  configRoot?: string;
  designSystemRef?: string;
  autonomyPolicyRef?: string;
  didRef?: string;
  maintainers?: string[];
}

function parseArgs(argv: string[]): AdmitArgs {
  const trackerArg = (getArg(argv, '--tracker') as Tracker | undefined) ?? 'auto';
  const taskId = getArg(argv, '--task-id');
  const taskFile = getArg(argv, '--task-file');
  const title = getArg(argv, '--title') ?? process.env.ISSUE_TITLE;
  const bodyFile = getArg(argv, '--body-file');
  const issueNumberStr = getArg(argv, '--issue-number');
  const labelsStr = getArg(argv, '--labels');
  const reactionsStr = getArg(argv, '--reactions');
  const commentsStr = getArg(argv, '--comments');
  const createdAt = getArg(argv, '--created-at');
  const authorAssociation = getArg(argv, '--author-association') ?? 'NONE';
  const authorLogin = getArg(argv, '--author-login');
  const codeArea = getArg(argv, '--code-area');
  const configRoot = getArg(argv, '--config-root');
  const designSystemRef = getArg(argv, '--design-system-ref');
  const autonomyPolicyRef = getArg(argv, '--autonomy-policy-ref');
  const didRef = getArg(argv, '--did-ref');
  const enrichFromState = hasFlag(argv, '--enrich-from-state');

  // Tracker auto-detection
  let tracker: Tracker = trackerArg;
  if (tracker === 'auto') {
    if (taskId || taskFile) tracker = 'backlog';
    else tracker = 'github';
  }

  // Validation per tracker
  if (tracker === 'backlog') {
    if (!taskId && !taskFile) {
      console.error('Usage: admit --tracker backlog --task-id <id> [--config-root <path>]');
      console.error('       admit --tracker backlog --task-file <path>');
      process.exit(1);
    }
  } else if (!title || !issueNumberStr) {
    console.error('Usage: admit --title "..." --body-file /path --issue-number N');
    console.error(
      '       --labels \'["bug"]\' --reactions N --comments N --created-at ISO --author-association OWNER',
    );
    console.error(
      '       [--enrich-from-state] [--config-root PATH] [--design-system-ref NAME] [--autonomy-policy-ref NAME] [--did-ref NAME]',
    );
    console.error('       [--author-login HANDLE] [--code-area PATH]');
    process.exit(1);
  }

  let labels: string[] = [];
  if (labelsStr) {
    try {
      labels = JSON.parse(labelsStr);
    } catch {
      labels = [];
    }
  }

  return {
    tracker,
    title,
    body: '',
    bodyFile,
    taskId,
    taskFile,
    issueNumber: issueNumberStr ? Number(issueNumberStr) : undefined,
    labels,
    reactions: Number(reactionsStr ?? '0'),
    comments: Number(commentsStr ?? '0'),
    createdAt,
    authorAssociation,
    authorLogin,
    codeArea,
    enrichFromState,
    configRoot,
    designSystemRef,
    autonomyPolicyRef,
    didRef,
  };
}

// ── Config root resolution ───────────────────────────────────────────

function findUpwards(start: string, marker: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function resolveConfigRoot(
  args: AdmitArgs,
  cwd: string,
): { configRoot: string; source: 'flag' | 'body-file' | 'task-file' | 'cwd-walk' | 'fallback' } {
  if (args.configRoot) {
    return { configRoot: resolve(args.configRoot), source: 'flag' };
  }
  if (args.taskFile) {
    const fromTask = findUpwards(dirname(args.taskFile), DEFAULT_CONFIG_DIR_NAME);
    if (fromTask) return { configRoot: fromTask, source: 'task-file' };
  }
  if (args.bodyFile && isAbsolute(args.bodyFile)) {
    const fromBody = findUpwards(dirname(args.bodyFile), DEFAULT_CONFIG_DIR_NAME);
    if (fromBody) return { configRoot: fromBody, source: 'body-file' };
  }
  const fromCwd = findUpwards(cwd, DEFAULT_CONFIG_DIR_NAME);
  if (fromCwd) return { configRoot: fromCwd, source: 'cwd-walk' };
  return { configRoot: cwd, source: 'fallback' };
}

// ── Resource selection ───────────────────────────────────────────────

function selectDsb(
  list: DesignSystemBinding[] | undefined,
  ref: string | undefined,
): DesignSystemBinding | undefined {
  if (!list?.length) return undefined;
  if (ref) return list.find((d) => d.metadata.name === ref);
  return list[0];
}

function selectDid(
  list: DesignIntentDocument[] | undefined,
  ref: string | undefined,
): DesignIntentDocument | undefined {
  if (!list?.length) return undefined;
  if (ref) return list.find((d) => d.metadata.name === ref);
  return list[0];
}

function selectAutonomyPolicy(
  policy: AutonomyPolicy | undefined,
  ref: string | undefined,
): AutonomyPolicy | undefined {
  if (!policy) return undefined;
  if (ref && policy.metadata.name !== ref) return undefined;
  return policy;
}

// ── Backlog path ─────────────────────────────────────────────────────

function loadBacklogMapping(args: AdmitArgs, configRoot: string): BacklogAdmissionMapping {
  let snapshot;
  if (args.taskFile) {
    const safe = assertSafeReadPath(args.taskFile, configRoot);
    snapshot = parseBacklogTask(readFileSync(safe, 'utf-8'), safe);
  } else if (args.taskId) {
    snapshot = loadBacklogTaskFromRoot(configRoot, args.taskId);
    if (!snapshot) {
      console.error(
        `Backlog task ${args.taskId} not found under ${configRoot}/backlog/{tasks,completed}`,
      );
      process.exit(1);
    }
  } else {
    console.error('Backlog mode requires --task-id or --task-file');
    process.exit(1);
  }
  const soulTracks = loadSoulTracks(configRoot);
  return mapBacklogTaskToAdmissionInput(snapshot, {
    soulTracks,
    maintainers: args.maintainers,
  });
}

// ── GitHub path ──────────────────────────────────────────────────────

function buildGitHubAdmissionInput(args: AdmitArgs, workDir: string): AdmissionInput {
  let body = '';
  if (args.bodyFile) {
    try {
      const safe = assertSafeReadPath(args.bodyFile, workDir);
      body = readFileSync(safe, 'utf-8');
    } catch (err) {
      if (err instanceof UnsafePathError) {
        console.error(err.message);
        process.exit(1);
      }
      body = '';
    }
  }
  return {
    issueNumber: args.issueNumber!,
    title: args.title!,
    body,
    labels: args.labels,
    reactionCount: args.reactions,
    commentCount: args.comments,
    createdAt: args.createdAt ?? new Date().toISOString(),
    authorAssociation: args.authorAssociation as AdmissionInput['authorAssociation'],
    ...(args.authorLogin ? { authorLogin: args.authorLogin } : {}),
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cwd = await resolveRepoRoot();
  const { configRoot, source: configSource } = resolveConfigRoot(args, cwd);

  // Build admission input + optional priority overrides per tracker
  let admissionInput: AdmissionInput;
  let priorityOverrides: Partial<PriorityInput> | undefined;
  let backlogMapping: BacklogAdmissionMapping | undefined;

  if (args.tracker === 'backlog') {
    backlogMapping = loadBacklogMapping(args, configRoot);
    admissionInput = backlogMapping.input;
    priorityOverrides = backlogMapping.priorityInputOverrides;
  } else {
    admissionInput = buildGitHubAdmissionInput(args, configRoot);
  }

  // Load priority policy thresholds from pipeline.yaml
  let thresholds: AdmissionThresholds = {
    minimumScore: 0.05,
    minimumConfidence: 0.2,
  };

  let enrichedInput = admissionInput;
  let resolvedDsbName: string | undefined;
  let resolvedDidName: string | undefined;
  let resolvedAutonomyPolicyName: string | undefined;

  try {
    const configDir = join(configRoot, DEFAULT_CONFIG_DIR_NAME);
    const config = await loadConfigAsync(configDir);
    const policy = config.pipeline?.spec?.priorityPolicy;
    if (policy) {
      thresholds = {
        minimumScore: policy.minimumScore ?? thresholds.minimumScore,
        minimumConfidence: policy.minimumConfidence ?? thresholds.minimumConfidence,
      };
    }

    if (args.enrichFromState) {
      const dsb = selectDsb(config.designSystemBindings, args.designSystemRef);
      const did = selectDid(config.designIntentDocuments, args.didRef);
      const autonomyPolicy = selectAutonomyPolicy(config.autonomyPolicy, args.autonomyPolicyRef);
      resolvedDsbName = dsb?.metadata.name;
      resolvedDidName = did?.metadata.name;
      resolvedAutonomyPolicyName = autonomyPolicy?.metadata.name;

      const stateDbPath = join(configRoot, '.ai-sdlc', 'state.db');
      let stateStore: StateStore | undefined;
      try {
        stateStore = StateStore.open(stateDbPath);
      } catch {
        // State DB may not exist yet — enrichment degrades gracefully.
      }

      const ctx: EnrichmentContext = {
        ...(stateStore ? { stateStore } : {}),
        ...(dsb ? { designSystemBinding: dsb } : {}),
        ...(did ? { designIntentDocument: did } : {}),
        ...(autonomyPolicy ? { autonomyPolicy } : {}),
        ...(args.codeArea ? { codeArea: args.codeArea } : {}),
      };

      enrichedInput = enrichAdmissionInput(admissionInput, ctx);
      stateStore?.close();
    }
  } catch {
    console.error('Warning: could not load pipeline config, using default thresholds');
  }

  // Provenance line on stderr — makes "wrong product enrichment"
  // detectable when running cli-admit from one repo against another's
  // tracker (the silent failure mode the bug fix targets).
  if (configSource === 'fallback') {
    console.error(
      `WARN: enrichment context resolved to ${configRoot} via fallback — confirm this is the right product`,
    );
  }
  console.error(
    JSON.stringify({
      provenance: {
        tracker: args.tracker,
        configRoot,
        configSource,
        designSystemBinding: resolvedDsbName,
        designIntentDocument: resolvedDidName,
        autonomyPolicy: resolvedAutonomyPolicyName,
      },
    }),
  );

  const result = scoreIssueForAdmission(enrichedInput, thresholds, undefined, {
    ...(priorityOverrides ? { priorityInputOverrides: priorityOverrides } : {}),
  });

  // Attach quality flags from the Backlog mapping so renderers can
  // surface them without reaching back into the snapshot.
  if (backlogMapping?.qualityFlags.length) {
    (result as unknown as Record<string, unknown>).qualityFlags = backlogMapping.qualityFlags;
  }

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
