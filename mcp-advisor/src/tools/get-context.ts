import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildCodebaseContext,
  formatContextForPrompt,
  findRelevantEpisodes,
  formatEpisodicContext,
  type CodebaseProfile,
} from '@ai-sdlc/orchestrator';
import type { ServerDeps } from '../types.js';

const SECTION_NAMES = ['profile', 'conventions', 'hotspots', 'patterns', 'history'] as const;
type Section = typeof SECTION_NAMES[number];

export interface GetContextResult {
  markdown: string;
  sections: string[];
}

export function handleGetContext(
  deps: ServerDeps,
  input: { sessionId?: string; sections?: Section[] },
): GetContextResult {
  const session = input.sessionId
    ? deps.sessions.get(input.sessionId)
    : deps.sessions.getActive();

  const requestedSections = input.sections ?? [...SECTION_NAMES];
  const parts: string[] = [];

  // Profile + patterns (derived from complexity profile)
  if (requestedSections.includes('profile') || requestedSections.includes('patterns')) {
    const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
    if (profile) {
      // Parse raw data if available to reconstruct CodebaseProfile
      const rawData = (profile.rawData ? safeJsonParse(profile.rawData) : undefined) as Record<string, unknown> | undefined;
      const hotspots = (profile.hotspots ? safeJsonParse(profile.hotspots) : []) as CodebaseProfile['hotspots'];
      const patterns = (profile.architecturalPatterns ? safeJsonParse(profile.architecturalPatterns) : []) as CodebaseProfile['architecturalPatterns'];
      const conventions = (profile.conventionsData ? safeJsonParse(profile.conventionsData) : []) as CodebaseProfile['conventions'];

      const codebaseProfile: CodebaseProfile = {
        repoPath: profile.repoPath,
        score: profile.score,
        filesCount: profile.filesCount ?? 0,
        modulesCount: profile.modulesCount ?? 0,
        dependencyCount: profile.dependencyCount ?? 0,
        modules: (rawData?.modules ?? []) as CodebaseProfile['modules'],
        moduleGraph: (rawData?.moduleGraph ?? { modules: [], edges: [], externalDependencies: [], cycles: [] }) as CodebaseProfile['moduleGraph'],
        architecturalPatterns: patterns,
        hotspots,
        conventions,
        analyzedAt: profile.analyzedAt ?? new Date().toISOString(),
      };
      const ctx = buildCodebaseContext(codebaseProfile);
      parts.push(formatContextForPrompt(ctx));
    }
  }

  // Conventions from store
  if (requestedSections.includes('conventions')) {
    const conventions = deps.store.getConventions();
    if (conventions.length > 0) {
      const lines = ['## Project Conventions', ''];
      for (const c of conventions) {
        lines.push(`- **${c.category}**: ${c.pattern}`);
      }
      parts.push(lines.join('\n'));
    }
  }

  // Hotspots
  if (requestedSections.includes('hotspots')) {
    const hotspots = deps.store.getHotspots(deps.repoPath, 20);
    if (hotspots.length > 0) {
      const lines = ['## File Hotspots', ''];
      for (const h of hotspots.slice(0, 10)) {
        lines.push(`- \`${h.filePath}\` — churn: ${h.churnRate}, complexity: ${h.complexity}`);
      }
      parts.push(lines.join('\n'));
    }
  }

  // History (episodic memory)
  if (requestedSections.includes('history')) {
    const issueNumber = session?.linkedIssue ?? undefined;
    const episodes = findRelevantEpisodes(deps.store, { issueNumber });
    const formatted = formatEpisodicContext(episodes);
    if (formatted) {
      parts.push(formatted);
    }
  }

  return {
    markdown: parts.join('\n\n'),
    sections: requestedSections,
  };
}

export function registerGetContext(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'get_context',
    'Get rich codebase context: architecture, conventions, hotspots, and history.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      sections: z.array(z.enum(SECTION_NAMES)).optional().describe('Sections to include'),
    },
    async ({ sessionId, sections }) => {
      const result = handleGetContext(deps, { sessionId, sections });
      return { content: [{ type: 'text' as const, text: result.markdown || 'No context available.' }] };
    },
  );
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
