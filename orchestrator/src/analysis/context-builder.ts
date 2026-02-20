/**
 * Build CodebaseContext from a CodebaseProfile for agent prompt injection.
 */

import type { CodebaseProfile, CodebaseContext } from './types.js';

/**
 * Build architecture summary string from profile patterns.
 */
function buildArchitectureSummary(profile: CodebaseProfile): string {
  if (profile.architecturalPatterns.length === 0) {
    return 'No dominant architectural patterns detected.';
  }

  const lines: string[] = [];
  for (const pattern of profile.architecturalPatterns.slice(0, 3)) {
    const pct = Math.round(pattern.confidence * 100);
    lines.push(
      `This codebase uses a ${pattern.name} architecture (${pct}% confidence). ${pattern.description}.`,
    );
  }
  return lines.join(' ');
}

/**
 * Build conventions summary string from profile conventions.
 */
function buildConventionsSummary(profile: CodebaseProfile): string {
  if (profile.conventions.length === 0) {
    return 'No conventions detected.';
  }

  const lines: string[] = [];
  for (const conv of profile.conventions) {
    lines.push(`- **${conv.category}**: ${conv.pattern}`);
  }
  return lines.join('\n');
}

/**
 * Build hotspots summary string from profile hotspots.
 */
function buildHotspotsSummary(profile: CodebaseProfile): string {
  if (profile.hotspots.length === 0) {
    return 'No hotspots detected.';
  }

  const lines: string[] = [];
  for (const spot of profile.hotspots.slice(0, 5)) {
    const churnPct = Math.round(spot.churnRate * 100);
    lines.push(`- \`${spot.filePath}\` — churn: ${churnPct}%, complexity: ${spot.complexity}/10`);
  }
  return lines.join('\n');
}

/**
 * Build a CodebaseContext from a CodebaseProfile.
 * This is injected into agent prompts as the "## Codebase Context" section.
 */
export function buildCodebaseContext(profile: CodebaseProfile): CodebaseContext {
  return {
    score: profile.score,
    filesCount: profile.filesCount,
    modulesCount: profile.modulesCount,
    dependencyCount: profile.dependencyCount,
    architectureSummary: buildArchitectureSummary(profile),
    conventionsSummary: buildConventionsSummary(profile),
    hotspotsSummary: buildHotspotsSummary(profile),
  };
}

/**
 * Format a CodebaseContext into a markdown section for prompt injection.
 */
export function formatContextForPrompt(ctx: CodebaseContext): string {
  const lines = [
    '## Codebase Context',
    `Complexity: ${ctx.score}/10 | ${ctx.filesCount} files | ${ctx.modulesCount} modules | ${ctx.dependencyCount} dependencies`,
    '',
    '### Architecture',
    ctx.architectureSummary,
    '',
    '### Conventions (follow these)',
    ctx.conventionsSummary,
    '',
    '### Hotspots (extra care required)',
    ctx.hotspotsSummary,
  ];
  return lines.join('\n');
}
