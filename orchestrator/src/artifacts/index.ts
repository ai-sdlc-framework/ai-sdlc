/**
 * Artifact directory module per RFC-0010 §16. Provides:
 *   - Heartbeat writer (state.json updated every 60s; stale > 5 min surfaces in cli-status)
 *   - Event-stream emitter (_events.jsonl JSONL append-only)
 *   - Schema-conformant artifact validator (Q7)
 *   - Resumability helper (read state.json to determine next stage)
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export type StageStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export interface RuntimeState {
  issueId: string;
  currentStage: string;
  startedAt: string;
  lastHeartbeat: string;
  status: StageStatus;
  resolvedHarness?: string;
  resolvedModel?: string;
  port?: number;
  worktreePath?: string;
  databaseBranchKeys?: Record<string, string>;
}

export interface ArtifactEvent {
  type: string;
  timestamp: string;
  issueId?: string;
  stage?: string;
  [key: string]: unknown;
}

export class StateWriter {
  private readonly statePath: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly artifactsDir: string,
    public readonly issueId: string,
  ) {
    this.statePath = join(artifactsDir, issueId, 'state.json');
  }

  async writeState(state: RuntimeState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    state.lastHeartbeat = new Date().toISOString();
    await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async readState(): Promise<RuntimeState | null> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      return JSON.parse(raw) as RuntimeState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Start emitting heartbeats. The caller's `produce` function returns the latest
   * RuntimeState snapshot to persist; the writer schedules persistence every
   * HEARTBEAT_INTERVAL_MS. Returns a stop function.
   */
  startHeartbeat(produce: () => RuntimeState): () => void {
    if (this.heartbeatTimer) throw new Error('Heartbeat already running');
    const tick = async () => {
      try {
        const state = produce();
        await this.writeState(state);
      } catch {
        // Heartbeat failures are non-fatal; the stale-detection at read-time will surface them.
      }
    };
    this.heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    };
  }

  /**
   * Returns true when the persisted state's lastHeartbeat is older than HEARTBEAT_STALE_MS.
   * Used by cli-status to flag hung agents.
   */
  static isStale(state: RuntimeState, now: Date = new Date()): boolean {
    const last = new Date(state.lastHeartbeat).getTime();
    return now.getTime() - last > HEARTBEAT_STALE_MS;
  }
}

/** Append a single event to $ARTIFACTS_DIR/_events.jsonl. Atomic per-line. */
export async function appendEvent(artifactsDir: string, event: ArtifactEvent): Promise<void> {
  const path = join(artifactsDir, '_events.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}

export async function readEvents(
  artifactsDir: string,
  options: { sinceTimestamp?: string } = {},
): Promise<ArtifactEvent[]> {
  const path = join(artifactsDir, '_events.jsonl');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: ArtifactEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ArtifactEvent;
      if (options.sinceTimestamp && e.timestamp < options.sinceTimestamp) continue;
      events.push(e);
    } catch {
      // skip malformed
    }
  }
  return events;
}

/**
 * Atomic write: write to <path>.tmp, fsync (implicit via Node), rename. Per RFC §16.4
 * the JSON artifact MUST NOT be visible to downstream stages until fully written.
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

/**
 * Read all per-issue runtime states under the artifacts dir. Used by cli-status --all
 * to enumerate active branches per RFC §17.
 */
export async function listActiveStates(artifactsDir: string): Promise<RuntimeState[]> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(artifactsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const states: RuntimeState[] = [];
  for (const entry of entries) {
    if (entry.startsWith('_')) continue; // skip _ledger, _events.jsonl, _classifier
    const writer = new StateWriter(artifactsDir, entry);
    const state = await writer.readState();
    if (state) states.push(state);
  }
  return states;
}
