import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListDetectedPatterns } from './list-detected-patterns.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

describe('list_detected_patterns', () => {
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  beforeEach(() => {
    const server = {
      tool: vi.fn((_name, _desc, _schema, handler) => {
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerListDetectedPatterns(server, { projectDir: '/test/project' });
  });

  it('returns "no telemetry data" when file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await registeredHandler({});
    expect(result.content[0].text).toContain('No telemetry data found');
  });

  it('returns patterns when file exists with repeated 3-grams across 2+ sessions', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Two sessions with the same 3-step sequence: read -> edit -> commit
    const lines = [
      JSON.stringify({ sid: 'session-1', action: 'read', ts: '2026-03-01T10:00:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'edit', ts: '2026-03-01T10:01:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'commit', ts: '2026-03-01T10:02:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'read', ts: '2026-03-02T10:00:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'edit', ts: '2026-03-02T10:01:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'commit', ts: '2026-03-02T10:02:00Z' }),
    ].join('\n');

    vi.mocked(fs.readFileSync).mockReturnValue(lines);

    const result = await registeredHandler({});
    const text = result.content[0].text;

    expect(text).toContain('Detected Workflow Patterns');
    expect(text).toContain('read \u2192 edit \u2192 commit');
    expect(text).toContain('2 sessions');
  });

  it('returns "no patterns found" when events exist but no repeats across sessions', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Two sessions with different sequences -- no 3-gram repeats across sessions
    const lines = [
      JSON.stringify({ sid: 'session-1', action: 'read', ts: '2026-03-01T10:00:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'edit', ts: '2026-03-01T10:01:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'commit', ts: '2026-03-01T10:02:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'search', ts: '2026-03-02T10:00:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'grep', ts: '2026-03-02T10:01:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'open', ts: '2026-03-02T10:02:00Z' }),
    ].join('\n');

    vi.mocked(fs.readFileSync).mockReturnValue(lines);

    const result = await registeredHandler({});
    const text = result.content[0].text;

    expect(text).toContain('No repeated patterns found');
  });

  it('filters events by the since parameter', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Session-1 is old (before the since date), session-2 and session-3 are recent
    const lines = [
      JSON.stringify({ sid: 'session-1', action: 'read', ts: '2025-01-01T10:00:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'edit', ts: '2025-01-01T10:01:00Z' }),
      JSON.stringify({ sid: 'session-1', action: 'commit', ts: '2025-01-01T10:02:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'search', ts: '2026-03-15T10:00:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'grep', ts: '2026-03-15T10:01:00Z' }),
      JSON.stringify({ sid: 'session-2', action: 'open', ts: '2026-03-15T10:02:00Z' }),
      JSON.stringify({ sid: 'session-3', action: 'search', ts: '2026-03-16T10:00:00Z' }),
      JSON.stringify({ sid: 'session-3', action: 'grep', ts: '2026-03-16T10:01:00Z' }),
      JSON.stringify({ sid: 'session-3', action: 'open', ts: '2026-03-16T10:02:00Z' }),
    ].join('\n');

    vi.mocked(fs.readFileSync).mockReturnValue(lines);

    // With since=2026-03-01, session-1 is excluded. session-2 and session-3 share "search -> grep -> open"
    const result = await registeredHandler({ since: '2026-03-01' });
    const text = result.content[0].text;

    expect(text).toContain('Detected Workflow Patterns');
    expect(text).toContain('search \u2192 grep \u2192 open');
    // Should NOT contain the old session's pattern
    expect(text).not.toContain('read \u2192 edit \u2192 commit');
  });
});
