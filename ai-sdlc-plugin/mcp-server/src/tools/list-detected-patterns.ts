import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../types.js';

export function registerListDetectedPatterns(server: McpServer, _deps: ToolDeps): void {
  server.tool(
    'list_detected_patterns',
    'List workflow patterns detected from tool call telemetry',
    {
      since: z.string().optional().describe('ISO date to filter events from (e.g. 2026-01-01)'),
      limit: z.number().optional().describe('Maximum number of patterns to return (default: 20)'),
    },
    async ({ since, limit }) => {
      const jsonlPath = join(homedir(), '.claude', 'usage-data', 'tool-sequences.jsonl');

      if (!existsSync(jsonlPath)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No telemetry data found at ~/.claude/usage-data/tool-sequences.jsonl. Run a few Claude Code sessions with the AI-SDLC plugin to collect data.',
            },
          ],
        };
      }

      try {
        const raw = readFileSync(jsonlPath, 'utf-8');
        const lines = raw.trim().split('\n');

        let events = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (since) {
          const sinceDate = new Date(since);
          events = events.filter((e) => new Date(e.ts) >= sinceDate);
        }

        // Group by session
        const sessions = new Map<string, string[]>();
        for (const e of events) {
          const sid = e.sid;
          if (!sessions.has(sid)) sessions.set(sid, []);
          sessions.get(sid)!.push(e.action);
        }

        // Simple frequency count of 3-grams across sessions
        const ngramCounts = new Map<string, { count: number; sessions: Set<string> }>();

        for (const [sid, actions] of sessions) {
          if (actions.length < 3) continue;
          const seen = new Set<string>();
          for (let i = 0; i <= actions.length - 3; i++) {
            const gram = actions.slice(i, i + 3).join(' → ');
            if (seen.has(gram)) continue;
            seen.add(gram);
            if (!ngramCounts.has(gram)) ngramCounts.set(gram, { count: 0, sessions: new Set() });
            const entry = ngramCounts.get(gram)!;
            entry.count++;
            entry.sessions.add(sid);
          }
        }

        // Filter to patterns appearing in 2+ sessions
        const patterns = [...ngramCounts.entries()]
          .filter(([, v]) => v.sessions.size >= 2)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, limit || 20);

        if (patterns.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Analyzed ${events.length} events across ${sessions.size} sessions. No repeated patterns found yet (need 2+ sessions with the same 3-step sequence).`,
              },
            ],
          };
        }

        const table = patterns
          .map(
            ([gram, v], i) =>
              `${i + 1}. **${gram}** — ${v.count} occurrences across ${v.sessions.size} sessions`,
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `# Detected Workflow Patterns\n\nAnalyzed ${events.length} events across ${sessions.size} sessions.\n\n${table}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Error analyzing patterns: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
