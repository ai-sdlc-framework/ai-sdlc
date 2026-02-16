/**
 * GET /api/codebase — codebase complexity profiles and hotspots.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';

export interface CodebaseResponse {
  profiles: Array<{
    repoPath: string;
    score: number;
    filesCount: number;
    modulesCount: number;
    dependencyCount: number;
    analyzedAt?: string;
  }>;
  hotspots: Array<{
    filePath: string;
    churnRate: number;
    complexity: number;
    commitCount: number;
    lastModified?: string;
  }>;
}

export async function GET(): Promise<NextResponse<CodebaseResponse>> {
  const store = getStateStore();

  const profiles = store.getDatabase()
    .prepare(
      `SELECT repo_path, score, files_count, modules_count, dependency_count, analyzed_at
       FROM complexity_profiles ORDER BY analyzed_at DESC LIMIT 10`,
    )
    .all() as Array<Record<string, unknown>>;

  const hotspots = store.getDatabase()
    .prepare(
      `SELECT file_path, churn_rate, complexity, commit_count, last_modified
       FROM hotspots ORDER BY churn_rate DESC LIMIT 50`,
    )
    .all() as Array<Record<string, unknown>>;

  return NextResponse.json({
    profiles: profiles.map((r) => ({
      repoPath: r.repo_path as string,
      score: r.score as number,
      filesCount: (r.files_count as number) || 0,
      modulesCount: (r.modules_count as number) || 0,
      dependencyCount: (r.dependency_count as number) || 0,
      analyzedAt: r.analyzed_at as string | undefined,
    })),
    hotspots: hotspots.map((r) => ({
      filePath: r.file_path as string,
      churnRate: r.churn_rate as number,
      complexity: r.complexity as number,
      commitCount: (r.commit_count as number) || 0,
      lastModified: r.last_modified as string | undefined,
    })),
  });
}
