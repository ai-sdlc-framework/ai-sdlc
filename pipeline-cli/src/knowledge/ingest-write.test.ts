/** The one ingest write path (AISDLC-1456): create new, re-ingest existing, count every status. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countIngestWrite, emptyIngestCounts, ingestEntry } from './ingest-write.js';
import { openKnowledgeStore } from './knowledge-store.js';
import { readKnowledgeLog } from './log.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let root: string;
afterEach(() => removeFixtureDir(root));
const P = 'agent:task:AISDLC-1456';

describe('ingestEntry', () => {
  it('creates a new entry, re-ingests an existing one, and logs each once', async () => {
    root = mkdtempSync(join(tmpdir(), 'ingest-write-'));
    const store = openKnowledgeStore({ backend: 'files', trackedRoot: 'kb' }, root);
    const entry = (value: string) => ({ fields: { id: 'a', trunk: 'systems', value }, body: '' });
    const opts = { scope: 'tracked' as const, path: 'systems/a.md', principal: P };
    const counts = emptyIngestCounts();
    const lines: string[] = [];
    const report = (l: string): number => lines.push(l);
    countIngestWrite(
      counts,
      await ingestEntry(store, entry('one'), { ...opts, exists: false }),
      report,
    );
    countIngestWrite(
      counts,
      await ingestEntry(store, entry('two'), { ...opts, exists: true }),
      report,
    );
    // a stale "does not exist" answer is rejected by create, never an overwrite
    countIngestWrite(
      counts,
      await ingestEntry(store, entry('three'), { ...opts, exists: false }),
      report,
    );
    expect(counts).toEqual({ created: 1, updated: 1, proposed: 0, rejected: 1 });
    expect(lines).toEqual(["rejected a: 'systems/a.md' exists"]);
    expect(store.get('a')?.fields.value).toBe('two');
    expect(readKnowledgeLog(join(root, 'kb')).map((e) => e.event)).toEqual([
      'created',
      'reingested',
    ]);
  });

  it('counts a proposal apart from applied writes and reports a reasonless rejection', () => {
    const counts = emptyIngestCounts();
    const lines: string[] = [];
    countIngestWrite(counts, { id: 'p', path: '', created: false, status: 'proposed' }, (l) =>
      lines.push(l),
    );
    countIngestWrite(counts, { id: 'r', path: '', created: false, status: 'rejected' }, (l) =>
      lines.push(l),
    );
    expect(counts).toEqual({ created: 0, updated: 0, proposed: 1, rejected: 1 });
    expect(lines).toEqual(['rejected r: no reason given']);
  });
});
