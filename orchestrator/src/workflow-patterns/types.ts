/**
 * Types for the workflow pattern detection system.
 */

export interface CanonicalStep {
  tool: string;
  action: string;
  /** Category for grouping: read, write, test, build, git, search, other */
  category: 'read' | 'write' | 'test' | 'build' | 'git' | 'search' | 'other';
}

export interface NGram {
  steps: CanonicalStep[];
  hash: string;
  sessionId: string;
}

export interface DetectedPattern {
  hash: string;
  steps: CanonicalStep[];
  frequency: number;
  sessionCount: number;
  confidence: number;
  patternType: 'command-sequence' | 'copy-paste-cycle' | 'periodic-task';
  suggestedArtifactType: 'command' | 'skill' | 'hook' | 'workflow';
  firstSeen: string;
  lastSeen: string;
  exampleSessionIds: string[];
}

export interface DetectionOptions {
  minSequenceLength: number;
  maxSequenceLength: number;
  minFrequency: number;
  minSessionCount: number;
  minConfidence: number;
  projectFilter?: string;
  since?: string;
}

export const DEFAULT_DETECTION_OPTIONS: DetectionOptions = {
  minSequenceLength: 3,
  maxSequenceLength: 8,
  minFrequency: 3,
  minSessionCount: 3,
  minConfidence: 0.6,
};

/** Raw tool sequence entry from the JSONL file. */
export interface RawToolSequenceEntry {
  ts: string;
  sid: string;
  tool: string;
  action: string;
  project: string;
}

/** Session metadata from Claude Code usage data. */
export interface SessionMeta {
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_counts: Record<string, number>;
  git_commits: number;
  git_pushes: number;
  first_prompt: string;
  tool_errors: number;
  lines_added: number;
  files_modified: number;
}
