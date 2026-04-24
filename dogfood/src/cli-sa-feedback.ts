#!/usr/bin/env node
/**
 * sa-feedback — record SA scoring feedback signals (RFC-0008 §B.8).
 *
 * Usage:
 *   sa-feedback record --did <name> --issue <N> --dimension SA-1|SA-2 --signal accept|dismiss|escalate [--principal HANDLE] [--category CAT]
 *   sa-feedback precision [--dimension SA-1|SA-2] [--since ISO]
 *   sa-feedback hot-categories [--min-samples N]
 *
 * The state DB lives at `.ai-sdlc/state.db` — created on first use.
 */

import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { DEFAULT_CONFIG_DIR_NAME, StateStore, resolveRepoRoot } from '@ai-sdlc/orchestrator';
import { SAFeedbackStore, type SaDimension, type FeedbackSignal } from '@ai-sdlc/orchestrator';

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

type Subcommand = 'record' | 'precision' | 'hot-categories';

function parseSubcommand(argv: string[]): Subcommand | undefined {
  const first = argv[2];
  if (first === 'record' || first === 'precision' || first === 'hot-categories') {
    return first;
  }
  return undefined;
}

async function openFeedbackStore(): Promise<{
  feedback: SAFeedbackStore;
  store: StateStore;
}> {
  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const dbPath = join(configDir, 'state.db');
  const store = StateStore.open(dbPath);
  return { feedback: new SAFeedbackStore(store), store };
}

function requireEnum<T extends string>(
  value: string | undefined,
  options: readonly T[],
  flag: string,
): T {
  if (!value || !options.includes(value as T)) {
    console.error(`--${flag} must be one of: ${options.join(', ')}`);
    process.exit(1);
  }
  return value as T;
}

async function cmdRecord(argv: string[]): Promise<void> {
  const didName = getArg(argv, '--did');
  const issueStr = getArg(argv, '--issue');
  const dimension = requireEnum<SaDimension>(
    getArg(argv, '--dimension'),
    ['SA-1', 'SA-2'],
    'dimension',
  );
  const signal = requireEnum<FeedbackSignal>(
    getArg(argv, '--signal'),
    ['accept', 'dismiss', 'escalate', 'override'],
    'signal',
  );
  const principal = getArg(argv, '--principal');
  const category = getArg(argv, '--category');
  const notes = getArg(argv, '--notes');

  if (!didName || !issueStr) {
    console.error(
      'Usage: sa-feedback record --did <name> --issue <N> --dimension SA-1|SA-2 --signal accept|dismiss|escalate',
    );
    process.exit(1);
  }
  const issueNumber = Number(issueStr);
  if (!Number.isFinite(issueNumber)) {
    console.error('--issue must be a number');
    process.exit(1);
  }

  const { feedback, store } = await openFeedbackStore();
  try {
    const id = feedback.record({
      didName,
      issueNumber,
      dimension,
      signal,
      principal,
      category,
      notes,
    });
    console.log(`recorded feedback event #${id} (${dimension} ${signal})`);
  } finally {
    store.close();
  }
}

async function cmdPrecision(argv: string[]): Promise<void> {
  const dimensionArg = getArg(argv, '--dimension');
  const dimension =
    dimensionArg === undefined
      ? undefined
      : requireEnum<SaDimension>(dimensionArg, ['SA-1', 'SA-2'], 'dimension');
  const since = getArg(argv, '--since');

  const { feedback, store } = await openFeedbackStore();
  try {
    const structural = feedback.structuralPrecision({ dimension, since });
    const llm = feedback.llmPrecision({ dimension, since });
    const suffix = dimension ? ` [${dimension}]` : '';
    console.log(`Structural precision${suffix}:`);
    console.log(`  sample size: ${structural.sampleSize}`);
    console.log(`  correct:     ${structural.correct}`);
    console.log(`  precision:   ${(structural.precision * 100).toFixed(1)}%`);
    console.log('');
    console.log(`LLM precision${suffix}:`);
    console.log(`  sample size: ${llm.sampleSize}`);
    console.log(`  correct:     ${llm.correct}`);
    console.log(`  precision:   ${(llm.precision * 100).toFixed(1)}%`);
  } finally {
    store.close();
  }
}

async function cmdHotCategories(argv: string[]): Promise<void> {
  const minStr = getArg(argv, '--min-samples');
  const min = minStr ? Number(minStr) : 3;
  const since = getArg(argv, '--since');

  const { feedback, store } = await openFeedbackStore();
  try {
    const rows = feedback.highFalsePositiveCategories({ since }, min);
    if (rows.length === 0) {
      console.log('No categories meet the minimum sample-size threshold.');
      return;
    }
    console.log('Category             FP rate    Samples  FP count');
    console.log('-------------------  -------    -------  --------');
    for (const r of rows) {
      console.log(
        `${r.category.padEnd(20)} ${(r.falsePositiveRate * 100).toFixed(1).padStart(5)}%    ${String(r.sampleSize).padStart(7)}  ${String(r.falsePositiveCount).padStart(8)}`,
      );
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const sub = parseSubcommand(process.argv);
  if (!sub) {
    console.error('Usage: sa-feedback {record|precision|hot-categories} [options]');
    process.exit(1);
  }

  switch (sub) {
    case 'record':
      await cmdRecord(process.argv);
      return;
    case 'precision':
      await cmdPrecision(process.argv);
      return;
    case 'hot-categories':
      await cmdHotCategories(process.argv);
      return;
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('cli-sa-feedback.js') ||
    process.argv[1].endsWith('cli-sa-feedback.ts'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// Re-export helpers for in-process test coverage.
export {
  openFeedbackStore as _openFeedbackStore,
  cmdRecord as _cmdRecord,
  cmdPrecision as _cmdPrecision,
  cmdHotCategories as _cmdHotCategories,
};
