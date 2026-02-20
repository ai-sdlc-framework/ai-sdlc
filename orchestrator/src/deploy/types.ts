/**
 * Deployment target types shared across all deployment providers.
 */

export interface DeploymentTargetConfig {
  /** Target name identifier. */
  name: string;
  /** Target provider type. */
  provider: 'kubernetes' | 'vercel' | 'flyio';
  /** Provider-specific configuration. */
  config: Record<string, unknown>;
}

export interface HealthCheckConfig {
  /** URL to check for health. */
  url: string;
  /** Expected HTTP status code (defaults to 200). */
  expectedStatus?: number;
  /** Timeout in milliseconds (defaults to 5000). */
  timeoutMs?: number;
  /** Number of consecutive healthy checks required (defaults to 3). */
  healthyThreshold?: number;
}

export type DeploymentState =
  | 'pending'
  | 'deploying'
  | 'healthy'
  | 'unhealthy'
  | 'rolled-back'
  | 'failed';

export interface DeploymentResult {
  id: string;
  state: DeploymentState;
  url?: string;
  version: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface DeploymentTarget {
  /** Deploy a new version. */
  deploy(version: string, environment: string): Promise<DeploymentResult>;
  /** Get the current deployment status. */
  getStatus(id: string): Promise<DeploymentResult>;
  /** Rollback to a previous version. */
  rollback(id: string): Promise<DeploymentResult>;
}

/** Shell command executor for CLI mode. */
export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** HTTP client for API mode. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
