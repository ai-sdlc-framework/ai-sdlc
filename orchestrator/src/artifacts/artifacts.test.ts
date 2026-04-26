import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StateWriter,
  appendEvent,
  readEvents,
  atomicWriteJson,
  listActiveStates,
  HEARTBEAT_STALE_MS,
  type RuntimeState,
} from './index.js';

describe('StateWriter', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'state-writer-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes and reads RuntimeState round-trip', async () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-247');
    const state: RuntimeState = {
      issueId: 'AISDLC-247',
      currentStage: 'plan',
      startedAt: '2026-04-26T12:00:00Z',
      lastHeartbeat: '2026-04-26T12:00:00Z',
      status: 'running',
    };
    await writer.writeState(state);
    const read = await writer.readState();
    expect(read?.issueId).toBe('AISDLC-247');
    expect(read?.currentStage).toBe('plan');
    expect(read?.lastHeartbeat).toBeTruthy();
  });

  it('readState returns null when no state exists', async () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-999');
    expect(await writer.readState()).toBeNull();
  });

  it('isStale returns true when lastHeartbeat is older than HEARTBEAT_STALE_MS', () => {
    const stale: RuntimeState = {
      issueId: 'x',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString(),
      status: 'running',
    };
    expect(StateWriter.isStale(stale)).toBe(true);
  });

  it('isStale returns false for fresh heartbeats', () => {
    const fresh: RuntimeState = {
      issueId: 'x',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    };
    expect(StateWriter.isStale(fresh)).toBe(false);
  });
});

describe('appendEvent / readEvents', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'events-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('appends events as JSONL and reads them back', async () => {
    await appendEvent(tmpRoot, { type: 'started', timestamp: '2026-04-26T12:00:00Z' });
    await appendEvent(tmpRoot, { type: 'completed', timestamp: '2026-04-26T12:01:00Z' });
    const events = await readEvents(tmpRoot);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('started');
    expect(events[1].type).toBe('completed');
  });

  it('readEvents returns [] when no events have been written', async () => {
    expect(await readEvents(tmpRoot)).toEqual([]);
  });

  it('readEvents filters by sinceTimestamp', async () => {
    await appendEvent(tmpRoot, { type: 'a', timestamp: '2026-04-26T10:00:00Z' });
    await appendEvent(tmpRoot, { type: 'b', timestamp: '2026-04-26T12:00:00Z' });
    await appendEvent(tmpRoot, { type: 'c', timestamp: '2026-04-26T14:00:00Z' });
    const events = await readEvents(tmpRoot, { sinceTimestamp: '2026-04-26T11:00:00Z' });
    expect(events.map((e) => e.type)).toEqual(['b', 'c']);
  });

  it('readEvents skips malformed lines silently', async () => {
    const path = join(tmpRoot, '_events.jsonl');
    await writeFile(
      path,
      '{"type":"ok","timestamp":"2026-01-01"}\nnot-json\n{"type":"ok2","timestamp":"2026-01-02"}\n',
    );
    const events = await readEvents(tmpRoot);
    expect(events).toHaveLength(2);
  });
});

describe('atomicWriteJson', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'atomic-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes via tmp + rename, leaving the final file with valid JSON', async () => {
    const path = join(tmpRoot, 'AISDLC-1', 'plan.json');
    await atomicWriteJson(path, { foo: 'bar', n: 42 });
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.foo).toBe('bar');
    expect(parsed.n).toBe(42);
  });
});

describe('listActiveStates', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'list-states-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns all per-issue runtime states; skips _-prefixed entries', async () => {
    const a = new StateWriter(tmpRoot, 'AISDLC-1');
    const b = new StateWriter(tmpRoot, 'AISDLC-2');
    await a.writeState({
      issueId: 'AISDLC-1',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    });
    await b.writeState({
      issueId: 'AISDLC-2',
      currentStage: 'implement',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    });
    // System dirs that should be skipped
    await appendEvent(tmpRoot, { type: 'ignored', timestamp: '2026-01-01' });

    const states = await listActiveStates(tmpRoot);
    expect(states.map((s) => s.issueId).sort()).toEqual(['AISDLC-1', 'AISDLC-2']);
  });

  it('returns [] when artifacts dir does not exist', async () => {
    expect(await listActiveStates(join(tmpRoot, 'nope'))).toEqual([]);
  });
});
