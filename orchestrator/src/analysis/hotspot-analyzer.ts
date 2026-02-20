/**
 * Git log churn analysis + file complexity heuristic → composite hotspot score.
 * Complexity heuristic: lineCount * 0.6 + importCount * 0.4, normalized to 1-10.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileInfo, Hotspot, ImportStatement } from './types.js';
import { DEFAULT_GIT_HISTORY_DAYS, DEFAULT_HOTSPOT_THRESHOLD } from '../defaults.js';

const execFileAsync = promisify(execFile);

interface ChurnEntry {
  filePath: string;
  commitCount: number;
  lastModified?: string;
}

/**
 * Run `git log` to get file churn data.
 */
export async function getFileChurn(
  repoPath: string,
  historyDays: number = DEFAULT_GIT_HISTORY_DAYS,
): Promise<ChurnEntry[]> {
  try {
    const since = `${historyDays} days ago`;
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--format=', '--name-only', `--since=${since}`],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );

    const counts = new Map<string, number>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }

    // Get last modified dates
    const entries: ChurnEntry[] = [];
    for (const [filePath, commitCount] of counts) {
      entries.push({ filePath, commitCount });
    }

    return entries;
  } catch {
    // Not a git repo or git not available
    return [];
  }
}

/**
 * Compute file complexity as a heuristic: lineCount * 0.6 + importCount * 0.4.
 * Normalized to 1-10 scale.
 */
export function computeFileComplexity(lineCount: number, importCount: number): number {
  // Raw score: weighted sum
  const raw = lineCount * 0.6 + importCount * 0.4;

  // Normalize to 1-10 using a logarithmic scale
  // ~50 lines + 5 imports ≈ 3, ~200 lines + 20 imports ≈ 5, ~500+ lines + 30+ imports ≈ 8+
  const normalized = (Math.log2(raw + 1) / Math.log2(500)) * 10;
  return Math.max(1, Math.min(10, Math.round(normalized)));
}

/**
 * Analyze hotspots: files with high churn and/or high complexity.
 */
export async function analyzeHotspots(
  repoPath: string,
  files: FileInfo[],
  importsByFile: Map<string, ImportStatement[]>,
  options?: { historyDays?: number; threshold?: number },
): Promise<Hotspot[]> {
  const historyDays = options?.historyDays ?? DEFAULT_GIT_HISTORY_DAYS;
  const threshold = options?.threshold ?? DEFAULT_HOTSPOT_THRESHOLD;

  const churnEntries = await getFileChurn(repoPath, historyDays);
  const churnMap = new Map(churnEntries.map((e) => [e.filePath, e]));

  // Total commits to compute churn rate
  const totalCommits = churnEntries.reduce((sum, e) => sum + e.commitCount, 0);

  const hotspots: Hotspot[] = [];

  for (const file of files) {
    const churn = churnMap.get(file.relativePath);
    const commitCount = churn?.commitCount ?? 0;
    const churnRate = totalCommits > 0 ? commitCount / totalCommits : 0;

    const imports = importsByFile.get(file.relativePath) ?? [];
    const complexity = computeFileComplexity(file.lineCount, imports.length);

    // Composite score: churnRate * 0.5 + normalizedComplexity * 0.5
    const normalizedComplexity = complexity / 10;
    const compositeScore = churnRate * 0.5 + normalizedComplexity * 0.5;

    if (compositeScore >= threshold || complexity >= 7) {
      hotspots.push({
        filePath: file.relativePath,
        churnRate: Math.round(churnRate * 1000) / 1000,
        complexity,
        commitCount,
        lastModified: churn?.lastModified,
      });
    }
  }

  // Sort by composite score descending
  hotspots.sort((a, b) => {
    const scoreA = a.churnRate * 0.5 + (a.complexity / 10) * 0.5;
    const scoreB = b.churnRate * 0.5 + (b.complexity / 10) * 0.5;
    return scoreB - scoreA;
  });

  return hotspots;
}
