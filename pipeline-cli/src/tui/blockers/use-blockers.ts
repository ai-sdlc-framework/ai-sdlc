/**
 * useBlockers React hook — RFC-0023 §8 / AISDLC-178.3.
 *
 * Consumes the Phase 2 data sources (`useBacklogTasks`, `useGhPrs`) and runs
 * the Phase 3 `detectBlockers` logic, returning a sorted list of
 * `BlockerItem` records the BlockersPane renders.
 *
 * The hook is stateless relative to the data sources — every poll cycle the
 * full detector runs from scratch so suppression/escalation markers are
 * always re-evaluated from the current file content.
 */

import { useEffect, useRef, useState } from 'react';

import {
  BACKLOG_WALKER_POLL_INTERVAL_MS,
  useBacklogTasks,
  type BacklogTask,
  type ReadBacklogTasksOpts,
  type ReadBacklogTasksResult,
} from '../sources/backlog-walker.js';
import {
  GH_PR_POLL_INTERVAL_MS,
  useGhPrs,
  type FetchGhPrsOpts,
  type FetchGhPrsResult,
  type GhPrSummary,
} from '../sources/gh-pr-cache.js';
import type { SourceErrorKind } from '../sources/types.js';
import {
  detectBlockers,
  readTaskBody,
  type BlockerItem,
  type DetectBlockersOpts,
} from './detector.js';

export interface UseBlockersOpts {
  /** Project root for backlog walker. Defaults `process.cwd()`. */
  workDir?: string;
  /** Backlog poll cadence ms. Defaults 30s. */
  backlogIntervalMs?: number;
  /** PR poll cadence ms. Defaults 60s. */
  prIntervalMs?: number;
  /**
   * Inject a body reader for tests.
   * Defaults to the real fs reader (`readTaskBody`).
   */
  bodyReader?: (filePath: string) => string;
  /**
   * Override the full backlog walker (tests). When provided the hook uses a
   * simple polling loop wrapping this walker rather than `useBacklogTasks`.
   */
  taskWalker?: (opts: ReadBacklogTasksOpts) => ReadBacklogTasksResult;
  /**
   * Override the full PR fetcher (tests). When provided the hook uses a
   * simple polling loop rather than `useGhPrs`.
   */
  prFetcher?: (opts: FetchGhPrsOpts) => FetchGhPrsResult;
  /**
   * Override the detector (tests). Defaults to `detectBlockers`.
   */
  detector?: (opts: DetectBlockersOpts) => BlockerItem[];
  /** Clock for staleness. Defaults `new Date()`. */
  clock?: () => Date;
}

export interface UseBlockersState {
  /** Sorted list of decision-pending items. */
  items: BlockerItem[];
  /** First non-null error from any data source, or null. */
  error: SourceErrorKind | null;
  /** Wall-clock of most-recent successful detector run. */
  lastFetched: Date | null;
}

// Normalised intermediate shape shared between real hooks and test stubs.
interface TaskFeed {
  tasks: BacklogTask[];
  error: SourceErrorKind | null;
}

interface PrFeed {
  prs: GhPrSummary[];
  error: SourceErrorKind | null;
}

/**
 * React hook — polls backlog tasks + open PRs on separate cadences,
 * runs the detector on every update, and returns the merged sorted list.
 *
 * Internally the hook uses a dependency-injection pattern so unit tests
 * can inject stub walkers/fetchers without needing a React render tree.
 */
export function useBlockers(opts: UseBlockersOpts = {}): UseBlockersState {
  const {
    workDir,
    backlogIntervalMs = BACKLOG_WALKER_POLL_INTERVAL_MS,
    prIntervalMs = GH_PR_POLL_INTERVAL_MS,
    bodyReader = readTaskBody,
    taskWalker,
    prFetcher,
    detector = detectBlockers,
    clock = (): Date => new Date(),
  } = opts;

  // ── Task feed ───────────────────────────────────────────────────────────
  // Two branches share a common `TaskFeed` shape:
  //   A. Test path: inject `taskWalker` → drive a simple setInterval loop.
  //   B. Real path: mount `useBacklogTasks` and map its SourceState shape.

  const taskWalkerRef = useRef(taskWalker);
  taskWalkerRef.current = taskWalker;

  const [injectedTaskFeed, setInjectedTaskFeed] = useState<TaskFeed>({ tasks: [], error: null });

  useEffect(() => {
    if (!taskWalkerRef.current) return;
    let cancelled = false;
    const tick = (): void => {
      const result = taskWalkerRef.current!({ workDir });
      if (!cancelled) setInjectedTaskFeed({ tasks: result.tasks, error: result.error });
    };
    tick();
    const h = setInterval(tick, backlogIntervalMs);
    return (): void => {
      cancelled = true;
      clearInterval(h);
    };
  }, [workDir, backlogIntervalMs]);

  // useBacklogTasks must always be called (Rules of Hooks). We pass a dummy
  // walker when the injected path is active so it never fires actual I/O.
  const dummyTaskWalker = useRef((): ReadBacklogTasksResult => ({ tasks: [], error: null }));
  const realTaskState = useBacklogTasks(
    taskWalker
      ? { workDir, intervalMs: 999_999_999, walker: dummyTaskWalker.current }
      : { workDir, intervalMs: backlogIntervalMs },
  );

  const taskFeed: TaskFeed = taskWalker
    ? injectedTaskFeed
    : { tasks: realTaskState.data, error: realTaskState.error };

  // ── PR feed ─────────────────────────────────────────────────────────────
  const prFetcherRef = useRef(prFetcher);
  prFetcherRef.current = prFetcher;

  const [injectedPrFeed, setInjectedPrFeed] = useState<PrFeed>({ prs: [], error: null });

  useEffect(() => {
    if (!prFetcherRef.current) return;
    let cancelled = false;
    const tick = (): void => {
      const result = prFetcherRef.current!({ cwd: workDir });
      if (!cancelled) setInjectedPrFeed({ prs: result.prs, error: result.error });
    };
    tick();
    const h = setInterval(tick, prIntervalMs);
    return (): void => {
      cancelled = true;
      clearInterval(h);
    };
  }, [workDir, prIntervalMs]);

  const dummyPrFetcher = useRef((): FetchGhPrsResult => ({ prs: [], error: null }));
  const realPrState = useGhPrs(
    prFetcher
      ? { cwd: workDir, intervalMs: 999_999_999, fetcher: dummyPrFetcher.current }
      : { cwd: workDir, intervalMs: prIntervalMs },
  );

  const prFeed: PrFeed = prFetcher
    ? injectedPrFeed
    : { prs: realPrState.data, error: realPrState.error };

  // ── Detector run ────────────────────────────────────────────────────────
  const detectorRef = useRef(detector);
  detectorRef.current = detector;
  const bodyReaderRef = useRef(bodyReader);
  bodyReaderRef.current = bodyReader;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const [state, setState] = useState<UseBlockersState>({
    items: [],
    error: null,
    lastFetched: null,
  });

  const { tasks, error: taskError } = taskFeed;
  const { prs, error: prError } = prFeed;

  useEffect(() => {
    const items = detectorRef.current({
      tasks,
      prs,
      bodyReader: bodyReaderRef.current,
      now: clockRef.current(),
    });
    setState({
      items,
      error: taskError ?? prError ?? null,
      lastFetched: clockRef.current(),
    });
  }, [tasks, prs, taskError, prError]);

  return state;
}
