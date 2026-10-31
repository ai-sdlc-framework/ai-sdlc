import { describe, expect, it } from 'vitest';
import {
  buildRecord,
  recordFileFor,
  removeRecords,
  writeRecords,
  type RecordFs,
} from './activation.js';

describe('activation records', () => {
  it('builds a record and its per-pid path', () => {
    const r = buildRecord(42, '0.1.0', ['/a'], new Date('2026-10-29T16:37:00Z'));
    expect(r).toEqual({
      pid: 42,
      version: '0.1.0',
      activatedAt: '2026-10-29T16:37:00.000Z',
      folders: ['/a'],
    });
    expect(recordFileFor('/repo', 42)).toBe(
      '/repo/.ai-sdlc/dispatch/vscode-hierarchy-windows/42.json',
    );
  });

  it('writes to each root, skipping failures, and removes quietly', () => {
    const files = new Map<string, string>();
    const fs: RecordFs = {
      write: (f, t) => {
        if (f.startsWith('/ro')) throw new Error('EROFS');
        files.set(f, t);
      },
      remove: (f) => {
        if (!files.delete(f)) throw new Error('ENOENT');
      },
    };
    const rec = buildRecord(1, '0.1.0', ['/a'], new Date(0));
    const written = writeRecords(['/a', '/ro'], rec, fs);
    expect(written).toHaveLength(1);
    expect(JSON.parse(files.get(written[0])!).version).toBe('0.1.0');
    removeRecords([...written, '/missing'], fs);
    expect(files.size).toBe(0);
  });
});
