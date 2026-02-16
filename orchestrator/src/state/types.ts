/**
 * State store types for the SQLite-backed persistence layer.
 */

export interface ComplexityProfile {
  id?: number;
  repoPath: string;
  score: number;
  filesCount?: number;
  modulesCount?: number;
  dependencyCount?: number;
  analyzedAt?: string;
  rawData?: string;
}

export interface EpisodicRecord {
  id?: number;
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  outcome: string;
  durationMs?: number;
  filesChanged?: number;
  errorMessage?: string;
  metadata?: string;
  createdAt?: string;
}

export interface AutonomyLedgerEntry {
  id?: number;
  agentName: string;
  currentLevel: number;
  totalTasks: number;
  successCount: number;
  failureCount: number;
  lastTaskAt?: string;
  metrics?: string;
}

export type PipelineRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PipelineRun {
  id?: number;
  runId: string;
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  status: PipelineRunStatus;
  currentStage?: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  gateResults?: string;
}

export interface Convention {
  id?: number;
  category: string;
  pattern: string;
  confidence?: number;
  examples?: string;
  detectedAt?: string;
}
