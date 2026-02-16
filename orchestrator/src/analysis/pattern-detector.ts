/**
 * Heuristic architectural pattern detection.
 * Detects hexagonal, layered, event-driven, MVC, microservices patterns.
 */

import type { FileInfo, ModuleInfo, ArchitecturalPattern } from './types.js';

interface PatternSignal {
  name: string;
  dirPatterns: RegExp[];
  filePatterns: RegExp[];
  description: (evidence: string[]) => string;
}

const PATTERN_SIGNALS: PatternSignal[] = [
  {
    name: 'hexagonal',
    dirPatterns: [/(?:^|\/)(?:adapters?|ports?|domain|infrastructure|application)\/?/i],
    filePatterns: [/(?:adapter|port|gateway|repository)\.\w+$/i],
    description: (ev) => `Ports and adapters detected in ${ev.slice(0, 3).join(', ')}`,
  },
  {
    name: 'layered',
    dirPatterns: [/(?:^|\/)(?:controllers?|services?|repositories?|models?|middleware)\/?/i],
    filePatterns: [/(?:controller|service|repository|model|middleware)\.\w+$/i],
    description: (ev) => `Layered architecture in ${ev.slice(0, 3).join(', ')}`,
  },
  {
    name: 'event-driven',
    dirPatterns: [/(?:^|\/)(?:events?|handlers?|listeners?|subscribers?|emitters?)\/?/i],
    filePatterns: [/(?:event|handler|listener|subscriber|emitter|bus)\.\w+$/i],
    description: (ev) => `Event-driven patterns in ${ev.slice(0, 3).join(', ')}`,
  },
  {
    name: 'mvc',
    dirPatterns: [/(?:^|\/)(?:views?|controllers?|models?)\/?/i],
    filePatterns: [/(?:view|controller|model)\.\w+$/i],
    description: (ev) => `MVC structure in ${ev.slice(0, 3).join(', ')}`,
  },
  {
    name: 'plugin-based',
    dirPatterns: [/(?:^|\/)(?:plugins?|extensions?|addons?|modules?)\/?/i],
    filePatterns: [/(?:plugin|extension|addon)\.\w+$/i],
    description: (ev) => `Plugin architecture in ${ev.slice(0, 3).join(', ')}`,
  },
];

/**
 * Detect architectural patterns from file and module structure.
 */
export function detectPatterns(files: FileInfo[], modules: ModuleInfo[]): ArchitecturalPattern[] {
  const patterns: ArchitecturalPattern[] = [];
  const totalFiles = files.length;
  if (totalFiles === 0) return patterns;

  for (const signal of PATTERN_SIGNALS) {
    const evidence: string[] = [];

    // Check directory/module names
    for (const mod of modules) {
      for (const re of signal.dirPatterns) {
        if (re.test(mod.path)) {
          evidence.push(mod.path);
        }
      }
    }

    // Check file paths
    for (const file of files) {
      for (const re of signal.dirPatterns) {
        if (re.test(file.relativePath) && !evidence.includes(file.relativePath)) {
          evidence.push(file.relativePath);
        }
      }
      for (const re of signal.filePatterns) {
        if (re.test(file.relativePath) && !evidence.includes(file.relativePath)) {
          evidence.push(file.relativePath);
        }
      }
    }

    if (evidence.length === 0) continue;

    // Confidence based on evidence density
    const confidence = Math.min(evidence.length / Math.max(totalFiles * 0.1, 3), 1);
    const rounded = Math.round(confidence * 100) / 100;

    if (rounded >= 0.1) {
      patterns.push({
        name: signal.name,
        confidence: rounded,
        description: signal.description(evidence),
        evidence: evidence.slice(0, 10),
      });
    }
  }

  // Sort by confidence descending
  patterns.sort((a, b) => b.confidence - a.confidence);
  return patterns;
}
