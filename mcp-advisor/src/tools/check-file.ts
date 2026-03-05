import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../types.js';

export interface CheckFileResult {
  filePath: string;
  isHotspot: boolean;
  isBlocked: boolean;
  crossesModuleBoundary: boolean;
  warnings: string[];
}

export function handleCheckFile(
  deps: ServerDeps,
  input: { sessionId?: string; filePath: string },
): CheckFileResult {
  const warnings: string[] = [];
  let isHotspot = false;
  let isBlocked = false;
  let crossesModuleBoundary = false;

  // Check hotspots
  const hotspots = deps.store.getHotspots(deps.repoPath, 100);
  const matchingHotspot = hotspots.find(
    (h) => h.filePath === input.filePath || input.filePath.endsWith(h.filePath),
  );
  if (matchingHotspot) {
    isHotspot = true;
    warnings.push(
      `This file is a hotspot (churn: ${matchingHotspot.churnRate}, complexity: ${matchingHotspot.complexity}). Extra care recommended.`,
    );
  }

  // Check blocked paths from complexity profile raw data
  const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
  if (profile?.rawData) {
    try {
      const raw = JSON.parse(profile.rawData);
      const blockedPaths: string[] = raw.blockedPaths ?? [];
      if (blockedPaths.some((bp) => input.filePath.startsWith(bp) || input.filePath.includes(bp))) {
        isBlocked = true;
        warnings.push('This file is in a blocked path. Modifications may be restricted by policy.');
      }
    } catch {
      // raw data not parseable
    }
  }

  // Check blocked paths from autonomy policy config
  if (deps.config?.autonomyPolicy) {
    const policy = deps.config.autonomyPolicy;
    // Check all levels' blocked paths
    for (const level of policy.spec.levels) {
      const blockedPaths = level.guardrails.blockedPaths ?? [];
      for (const bp of blockedPaths) {
        const base = bp.replace(/\/?\*\*$/, '');
        if (
          input.filePath === base ||
          input.filePath.startsWith(base.endsWith('/') ? base : `${base}/`)
        ) {
          isBlocked = true;
          crossesModuleBoundary = true;
          warnings.push(
            `File matches blocked path "${bp}" per autonomy policy (level ${level.level}).`,
          );
          break;
        }
      }
    }
  }

  // Check module graph from complexity profile
  const profile2 = deps.store.getLatestComplexityProfile(deps.repoPath);
  if (profile2?.rawData) {
    try {
      const raw = JSON.parse(profile2.rawData);
      if (raw.moduleGraph?.modules) {
        const fileModule = (raw.moduleGraph.modules as Array<{ path: string; name?: string }>).find(
          (m) => input.filePath.startsWith(m.path),
        );
        if (fileModule) {
          warnings.push(
            `File is in module "${fileModule.name ?? fileModule.path}". Cross-module changes need extra review.`,
          );
        }
      }
    } catch {
      // raw data not parseable
    }
  }

  return {
    filePath: input.filePath,
    isHotspot,
    isBlocked,
    crossesModuleBoundary,
    warnings,
  };
}

export function registerCheckFile(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'check_file',
    'Check if a file is a hotspot, blocked, or crosses module boundaries. Advisory only.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      filePath: z.string().describe('File path to check'),
    },
    async ({ sessionId, filePath }) => {
      const result = handleCheckFile(deps, { sessionId, filePath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
